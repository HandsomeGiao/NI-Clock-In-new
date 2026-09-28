//! The four-window rules intentionally match the last C# implementation.
//! All timestamps are device-local wall times; converting them to UTC would change attendance dates.
use crate::models::*;
use chrono::{Datelike, Duration, NaiveDate, NaiveTime};
use std::collections::HashMap;

pub fn calculate(
    config: &AppConfig,
    logs: &[LogRecord],
    reviews: &[Review],
    range: &DateRange,
    departments: &[String],
) -> AppResult<StatisticsResult> {
    range.validate()?;
    let windows = config
        .rules
        .windows
        .iter()
        .map(|w| Ok((clock(&w.start)?, clock(&w.end)?)))
        .collect::<AppResult<Vec<_>>>()?;
    let mut punches: HashMap<(String, NaiveDate), Vec<NaiveTime>> = HashMap::new();
    for log in logs.iter().filter(|l| range.contains(l.timestamp.date())) {
        punches
            .entry((log.user_id.to_lowercase(), log.timestamp.date()))
            .or_default()
            .push(log.timestamp.time());
    }
    for times in punches.values_mut() {
        times.sort_unstable();
        times.dedup();
    }
    let review_map: HashMap<_, _> = reviews
        .iter()
        .map(|r| ((r.device_user_id.to_lowercase(), r.date), r))
        .collect();
    let mut rows = Vec::new();
    let mut details = Vec::new();
    let mut unassigned = 0;
    for person in config
        .people
        .iter()
        .filter(|p| departments.is_empty() || departments.contains(&p.department_id))
    {
        let Some(shift) = config
            .shifts
            .iter()
            .find(|s| Some(&s.id) == person.shift_id.as_ref())
        else {
            unassigned += 1;
            continue;
        };
        let department_name = config
            .departments
            .iter()
            .find(|d| d.id == person.department_id)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| "未分类".into());
        let mut row = Statistic {
            device_user_id: person.device_user_id.clone(),
            person_name: person.full_name.clone(),
            department_name: department_name.clone(),
            grade: person.grade.clone(),
            ..Statistic::default()
        };
        let mut has_schedule = false;
        for date in range
            .start_date
            .iter_days()
            .take_while(|d| *d <= range.end_date)
        {
            let Some(day) = shift
                .days
                .iter()
                .find(|d| d.day_of_week == date.weekday().num_days_from_sunday())
            else {
                continue;
            };
            if !day.morning_enabled && !day.afternoon_enabled {
                continue;
            }
            has_schedule = true;
            let mut detail = Detail {
                device_user_id: person.device_user_id.clone(),
                person_name: person.full_name.clone(),
                department_name: department_name.clone(),
                date,
                scheduled: [None; 4],
                punches: [None; 4],
                exempt: [!day.morning_enabled, !day.afternoon_enabled],
                late: [false; 2],
                early: [false; 2],
                absent: [false; 2],
                hours: 0.0,
                reviewed: false,
                note: String::new(),
            };
            if day.morning_enabled {
                detail.scheduled[0] = Some(clock(&day.morning_start)?);
                detail.scheduled[1] = Some(clock(&day.morning_end)?);
            }
            if day.afternoon_enabled {
                detail.scheduled[2] = Some(clock(&day.afternoon_start)?);
                detail.scheduled[3] = Some(clock(&day.afternoon_end)?);
            }
            if let Some(times) = punches.get(&(person.device_user_id.to_lowercase(), date)) {
                for (i, (start, end)) in windows.iter().enumerate() {
                    if detail.scheduled[i].is_none() {
                        continue;
                    }
                    let mut valid = times.iter().copied().filter(|t| t >= start && t <= end);
                    detail.punches[i] = if i % 2 == 0 {
                        valid.next()
                    } else {
                        valid.next_back()
                    };
                }
            }
            if let Some(review) = review_map.get(&(person.device_user_id.to_lowercase(), date)) {
                detail.punches = review.punches;
                detail.exempt = [
                    review.exempt[0] || !day.morning_enabled,
                    review.exempt[1] || !day.afternoon_enabled,
                ];
                detail.reviewed = true;
                detail.note = review.note.clone();
            }
            recalculate(&mut detail, config.rules.late_early_threshold_minutes);
            for i in 0..2 {
                if detail.scheduled[i * 2].is_some() && !detail.exempt[i] {
                    row.expected_days += 0.5;
                    if detail.absent[i] {
                        row.absent_days += 0.5;
                    } else {
                        row.actual_days += 0.5;
                    }
                }
                row.late_count += u32::from(detail.late[i]);
                row.early_leave_count += u32::from(detail.early[i]);
            }
            row.attendance_hours += detail.hours;
            details.push(detail);
        }
        if has_schedule {
            row.attendance_hours = round_hours(row.attendance_hours);
            rows.push(row);
        }
    }
    rows.sort_by(|a, b| {
        a.department_name
            .cmp(&b.department_name)
            .then_with(|| b.attendance_hours.total_cmp(&a.attendance_hours))
            .then(a.person_name.cmp(&b.person_name))
    });
    details.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then(a.department_name.cmp(&b.department_name))
            .then(a.person_name.cmp(&b.person_name))
    });
    let mut warnings = Vec::new();
    if unassigned > 0 {
        warnings.push(format!("{unassigned} 位人员未分配班次，不参与统计。"));
    }
    let unknown = logs
        .iter()
        .filter(|l| {
            !config
                .people
                .iter()
                .any(|p| p.device_user_id.eq_ignore_ascii_case(&l.user_id))
        })
        .count();
    if unknown > 0 {
        warnings.push(format!("{unknown} 条原始记录尚未匹配人员，不参与统计。"));
    }
    if logs.is_empty() {
        warnings.push(
            "当前范围没有原始打卡记录；已排班且未免考勤的时段将计为缺勤，请确认数据完整。".into(),
        );
    }
    Ok(StatisticsResult {
        rows,
        details,
        warnings,
        range: range.clone(),
    })
}

pub fn recalculate(detail: &mut Detail, threshold: u32) {
    detail.hours = 0.0;
    let allowance = Duration::minutes(threshold as i64);
    for i in 0..2 {
        detail.late[i] = false;
        detail.early[i] = false;
        detail.absent[i] = false;
        let (Some(start), Some(end)) = (detail.scheduled[i * 2], detail.scheduled[i * 2 + 1])
        else {
            continue;
        };
        if detail.exempt[i] {
            continue;
        }
        let (first, last) = (detail.punches[i * 2], detail.punches[i * 2 + 1]);
        // Compare signed durations, avoiding midnight wrapping when the threshold is large.
        detail.late[i] = first.is_some_and(|t| t.signed_duration_since(start) > allowance);
        detail.early[i] = last.is_some_and(|t| end.signed_duration_since(t) > allowance);
        detail.absent[i] = first.is_none() && last.is_none();
        if !detail.absent[i] {
            detail.hours += (last.unwrap_or(end) - first.unwrap_or(start))
                .num_seconds()
                .max(0) as f64
                / 3600.0;
        }
    }
}
pub fn round_hours(hours: f64) -> f64 {
    (hours * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (AppConfig, DateRange) {
        let mut config = AppConfig::default();
        config.people.push(Person {
            id: id(),
            device_user_id: "001".into(),
            full_name: "测试人员".into(),
            grade: "".into(),
            department_id: config.departments[0].id.clone(),
            shift_id: Some(config.shifts[0].id.clone()),
        });
        (
            config,
            DateRange {
                start_date: "2026-04-06".parse().unwrap(),
                end_date: "2026-04-06".parse().unwrap(),
            },
        )
    }
    fn logs(times: &[&str]) -> Vec<LogRecord> {
        times
            .iter()
            .map(|t| LogRecord {
                id: 0,
                user_id: "001".into(),
                timestamp: format!("2026-04-06T{t}").parse().unwrap(),
                verify_mode: 1,
                in_out_mode: 0,
                work_code: 0,
            })
            .collect()
    }
    #[test]
    fn boundary_selection_and_hours_match_legacy() {
        let (c, r) = fixture();
        let result = calculate(
            &c,
            &logs(&[
                "08:55:00", "09:10:00", "11:40:00", "12:03:00", "13:50:00", "17:35:00",
            ]),
            &[],
            &r,
            &[],
        )
        .unwrap();
        let row = &result.rows[0];
        assert_eq!(
            (
                row.expected_days,
                row.actual_days,
                row.late_count,
                row.early_leave_count
            ),
            (1.0, 1.0, 0, 0)
        );
        assert_eq!(row.attendance_hours, 6.88);
    }
    #[test]
    fn strict_threshold_and_missing_punch_fallback() {
        let (c, r) = fixture();
        let result = calculate(&c, &logs(&["09:30:00", "14:30:01"]), &[], &r, &[]).unwrap();
        assert_eq!(result.rows[0].late_count, 1);
        assert_eq!(result.rows[0].attendance_hours, 5.5);
        assert_eq!(result.rows[0].absent_days, 0.0);
    }
    #[test]
    fn absent_half_day_and_exempt_review() {
        let (c, r) = fixture();
        let input = logs(&["08:50:00"]);
        assert_eq!(
            calculate(&c, &input, &[], &r, &[]).unwrap().rows[0].absent_days,
            0.5
        );
        let review = Review {
            device_user_id: "001".into(),
            date: r.start_date,
            punches: [Some(clock("09:00").unwrap()), None, None, None],
            exempt: [false, true],
            note: "下午请假".into(),
        };
        let result = calculate(&c, &input, &[review], &r, &[]).unwrap();
        assert_eq!(
            (
                result.rows[0].expected_days,
                result.rows[0].actual_days,
                result.rows[0].attendance_hours
            ),
            (0.5, 0.5, 3.0)
        );
        assert!(result.details[0].reviewed);
    }
    #[test]
    fn noon_windows_and_seconds_are_not_rounded() {
        let (c, r) = fixture();
        let result = calculate(
            &c,
            &logs(&["13:00:00", "13:00:59", "13:01:00"]),
            &[],
            &r,
            &[],
        )
        .unwrap();
        assert_eq!(result.details[0].punches[1], Some(clock("13:00").unwrap()));
        assert_eq!(result.details[0].punches[2], Some(clock("13:01").unwrap()));
    }
    #[test]
    fn weekends_filters_and_unassigned_do_not_create_absence() {
        let (mut c, mut r) = fixture();
        r.start_date = "2026-04-11".parse().unwrap();
        r.end_date = r.start_date;
        assert!(calculate(&c, &[], &[], &r, &[]).unwrap().rows.is_empty());
        c.people[0].shift_id = None;
        assert_eq!(calculate(&c, &[], &[], &r, &[]).unwrap().warnings.len(), 2);
        assert!(calculate(&c, &[], &[], &r, &["other".into()])
            .unwrap()
            .rows
            .is_empty());
    }
}
