use calamine::{open_workbook, Data, Reader, Xlsx};
use ni_clock_in_lib::{attendance::calculate, exchange, models::*, store::Store};

fn fixture() -> (AppConfig, DateRange) {
    let mut config = AppConfig::default();
    config.people.push(Person {
        id: "person-1".into(),
        device_user_id: "001".into(),
        full_name: "测试人员".into(),
        grade: String::new(),
        department_id: config.departments[0].id.clone(),
        shift_id: Some(config.shifts[0].id.clone()),
    });
    let range = DateRange {
        start_date: "2026-04-06".parse().unwrap(),
        end_date: "2026-04-06".parse().unwrap(),
    };
    config
        .default_attendance_periods
        .push(DefaultAttendancePeriod {
            id: "setting-1".into(),
            person_ids: vec![config.people[0].id.clone()],
            range: range.clone(),
            periods: [true, false],
            weekly_periods: None,
            note: "外出培训".into(),
        });
    (config, range)
}

#[test]
fn missing_punches_count_as_scheduled_attendance_without_fabricating_logs() {
    let (config, range) = fixture();
    let result = calculate(&config, &[], &[], &range, &[]).unwrap();
    let row = &result.rows[0];
    assert_eq!(
        (row.expected_days, row.actual_days, row.absent_days),
        (1.0, 0.5, 0.5)
    );
    assert_eq!(row.attendance_hours, 3.0);
    assert_eq!((row.late_count, row.early_leave_count), (0, 0));
    assert_eq!(result.details[0].punches, [None; 4]);
    assert_eq!(result.details[0].default_attendance, [true, false]);
    assert_eq!(result.details[0].default_attendance_note, "外出培训");
    assert!(!result.details[0].reviewed);
}

#[test]
fn existing_punches_other_half_and_removing_settings_keep_original_rules() {
    let (mut config, range) = fixture();
    let logs: Vec<_> = ["09:45:00", "11:30:00", "14:45:00", "17:00:00"]
        .iter()
        .map(|time| LogRecord {
            id: 0,
            user_id: "001".into(),
            timestamp: format!("2026-04-06T{time}").parse().unwrap(),
            verify_mode: 1,
            in_out_mode: 0,
            work_code: 0,
        })
        .collect();
    let mut original = config.clone();
    original.default_attendance_periods.clear();
    let baseline = calculate(&original, &logs, &[], &range, &[]).unwrap();
    let result = calculate(&config, &logs, &[], &range, &[]).unwrap();
    assert_eq!(result.details[0].punches, baseline.details[0].punches);
    assert_eq!(result.details[0].late, [false, true]);
    assert_eq!(result.rows[0].attendance_hours, 5.25);
    assert_eq!(result.rows[0].expected_days, baseline.rows[0].expected_days);
    config.default_attendance_periods.clear();
    assert_eq!(
        serde_json::to_value(calculate(&config, &logs, &[], &range, &[]).unwrap()).unwrap(),
        serde_json::to_value(baseline).unwrap()
    );
}

#[test]
fn overlapping_settings_are_unioned_and_manual_exemption_still_wins() {
    let (mut config, range) = fixture();
    config.default_attendance_periods[0].periods = [true, true];
    let mut overlapping = config.default_attendance_periods[0].clone();
    overlapping.id = "setting-2".into();
    config.default_attendance_periods.push(overlapping);
    let full = calculate(&config, &[], &[], &range, &[]).unwrap();
    assert_eq!(full.rows[0].actual_days, 1.0);
    assert_eq!(full.rows[0].attendance_hours, 6.5);
    assert_eq!(full.details[0].default_attendance_note, "外出培训");
    let review = Review {
        device_user_id: "001".into(),
        date: range.start_date,
        punches: [Some(clock("10:00").unwrap()), None, None, None],
        exempt: [false, true],
        note: "下午请假".into(),
    };
    let result = calculate(&config, &[], &[review], &range, &[]).unwrap();
    let row = &result.rows[0];
    assert_eq!(
        (row.expected_days, row.actual_days, row.attendance_hours),
        (0.5, 0.5, 3.0)
    );
    assert_eq!(result.details[0].default_attendance, [true, false]);
    assert_eq!(result.details[0].punches[0], Some(clock("10:00").unwrap()));
    assert_eq!(result.details[0].note, "下午请假");
}

#[test]
fn date_boundaries_people_departments_and_unscheduled_days_are_respected() {
    let (mut config, mut range) = fixture();
    config.departments.push(Department {
        id: "other".into(),
        name: "其他部门".into(),
        is_system: false,
    });
    let mut other = config.people[0].clone();
    other.id = "person-2".into();
    other.device_user_id = "002".into();
    other.department_id = "other".into();
    config.people.push(other);
    range.end_date = "2026-04-12".parse().unwrap();
    config.default_attendance_periods[0].range = DateRange {
        start_date: "2026-04-07".parse().unwrap(),
        end_date: "2026-04-09".parse().unwrap(),
    };
    config.default_attendance_periods[0].periods = [false, true];
    let result = calculate(&config, &[], &[], &range, &[]).unwrap();
    let row = result
        .rows
        .iter()
        .find(|r| r.device_user_id == "001")
        .unwrap();
    assert_eq!(
        (
            row.expected_days,
            row.actual_days,
            row.absent_days,
            row.attendance_hours
        ),
        (5.0, 1.5, 3.5, 10.5)
    );
    assert_eq!(
        result
            .rows
            .iter()
            .find(|r| r.device_user_id == "002")
            .unwrap()
            .actual_days,
        0.0
    );
    assert_eq!(result.details.len(), 10);
    assert!(calculate(&config, &[], &[], &range, &["other".into()])
        .unwrap()
        .details
        .iter()
        .all(|d| d.default_attendance == [false; 2]));
    config.default_attendance_periods[0].range = range.clone();
    config.default_attendance_periods[0].periods = [true, true];
    config.shifts[0].days[1].morning_enabled = false;
    config.shifts[0].days[1].afternoon_start = "13:30".into();
    config.shifts[0].days[1].afternoon_end = "18:15".into();
    let result = calculate(&config, &[], &[], &range, &[]).unwrap();
    let monday = result
        .details
        .iter()
        .find(|d| d.device_user_id == "001" && d.date == range.start_date)
        .unwrap();
    assert_eq!(monday.default_attendance, [true, true]);
    assert_eq!(monday.hours, 7.75);
    config.people[0].shift_id = None;
    assert!(calculate(&config, &[], &[], &range, &[])
        .unwrap()
        .rows
        .iter()
        .all(|r| r.device_user_id != "001"));
}

#[test]
fn weekday_defaults_count_disabled_halves_without_changing_the_shift() {
    let (mut config, mut range) = fixture();
    range.end_date = "2026-04-12".parse().unwrap();
    for day in &mut config.shifts[0].days {
        day.morning_enabled = false;
        day.afternoon_enabled = false;
    }
    let original_shift = serde_json::to_value(&config.shifts[0]).unwrap();
    let mut weekly = [[false; 2]; 7];
    weekly[3][1] = true;
    weekly[4][1] = true;
    config.default_attendance_periods[0].range = range.clone();
    config.default_attendance_periods[0].weekly_periods = Some(weekly);
    let result = calculate(&config, &[], &[], &range, &[]).unwrap();
    assert_eq!(result.details.len(), 2);
    let row = &result.rows[0];
    assert_eq!(
        (row.expected_days, row.actual_days, row.attendance_hours),
        (1.0, 1.0, 7.0)
    );
    assert_eq!(row.absent_days, 0.0);
    assert!(result
        .details
        .iter()
        .all(|d| d.default_attendance == [false, true] && d.hours == 3.5));
    assert_eq!(
        serde_json::to_value(&config.shifts[0]).unwrap(),
        original_shift
    );
    config.default_attendance_periods.clear();
    assert!(calculate(&config, &[], &[], &range, &[])
        .unwrap()
        .rows
        .is_empty());
}

#[test]
fn validation_and_legacy_configuration_are_backward_compatible() {
    let (config, _) = fixture();
    let mut old_json = serde_json::to_value(&config).unwrap();
    old_json
        .as_object_mut()
        .unwrap()
        .remove("defaultAttendancePeriods");
    let mut old: AppConfig = serde_json::from_value(old_json).unwrap();
    old.validate().unwrap();
    assert!(old.default_attendance_periods.is_empty());
    for invalid in 0..6 {
        let mut candidate = config.clone();
        let setting = &mut candidate.default_attendance_periods[0];
        match invalid {
            0 => setting.person_ids.clear(),
            1 => setting.periods = [false; 2],
            2 => setting.range.end_date = "2026-04-05".parse().unwrap(),
            3 => setting.range.end_date = "2027-04-08".parse().unwrap(),
            4 => setting.note = "字".repeat(1001),
            _ => setting.person_ids.push(setting.person_ids[0].clone()),
        }
        assert!(candidate.validate().is_err());
    }
    let mut duplicate = config.clone();
    duplicate
        .default_attendance_periods
        .push(duplicate.default_attendance_periods[0].clone());
    assert!(duplicate.validate().is_err());
    // Deleting an employee must remain possible, and reusing their device ID must not inherit settings.
    let mut replacement = config;
    replacement.people[0].id = "new-person".into();
    replacement.validate().unwrap();
    let range = replacement.default_attendance_periods[0].range.clone();
    assert_eq!(
        calculate(&replacement, &[], &[], &range, &[]).unwrap().rows[0].actual_days,
        0.0
    );
}

#[test]
fn settings_persist_in_database_and_backups_without_changing_review_reset() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (mut config, range) = fixture();
    config.departments = store.config().unwrap().departments;
    config.people[0].department_id = config.departments[0].id.clone();
    store.save_config(config).unwrap();
    let review = Review {
        device_user_id: "001".into(),
        date: range.start_date,
        punches: [None; 4],
        exempt: [false, true],
        note: "下午请假".into(),
    };
    store.save_review(&review).unwrap();
    assert_eq!(store.reset_reviews(&range).unwrap(), 1);
    assert_eq!(
        store.calculate(&range, &[]).unwrap().rows[0].actual_days,
        0.5
    );
    drop(store);
    let store = Store::open(directory.path()).unwrap();
    let path = directory.path().join("backup.json");
    exchange::write_json(&path, &store.backup().unwrap()).unwrap();
    let restored_directory = tempfile::tempdir().unwrap();
    let mut restored = Store::open(restored_directory.path()).unwrap();
    restored
        .install_backup(exchange::read_backup(&path).unwrap(), true)
        .unwrap();
    assert_eq!(
        restored.config().unwrap().default_attendance_periods.len(),
        1
    );
    assert_eq!(
        restored.calculate(&range, &[]).unwrap().rows[0].attendance_hours,
        3.0
    );
    assert!(restored.logs(None).unwrap().is_empty());
    assert!(restored.reviews().unwrap().is_empty());
    let mut old_backup = serde_json::to_value(store.backup().unwrap()).unwrap();
    old_backup["config"]
        .as_object_mut()
        .unwrap()
        .remove("defaultAttendancePeriods");
    restored
        .install_backup(serde_json::from_value(old_backup).unwrap(), true)
        .unwrap();
    assert_eq!(
        restored.calculate(&range, &[]).unwrap().rows[0].actual_days,
        0.0
    );
}

#[test]
fn excel_identifies_default_attendance_and_monthly_totals_include_it() {
    let (config, range) = fixture();
    let result = calculate(&config, &[], &[], &range, &[]).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("report.xlsx");
    exchange::export_statistics(&path, &result.rows, &result.details, Some(&range), "period")
        .unwrap();
    let mut workbook: Xlsx<_> = open_workbook(&path).unwrap();
    let sheet = workbook.worksheet_range("每日明细").unwrap();
    assert_eq!(
        sheet.get((0, 13)),
        Some(&Data::String("上午默认出勤".into()))
    );
    assert_eq!(sheet.get((1, 13)), Some(&Data::String("是".into())));
    assert_eq!(sheet.get((1, 14)), Some(&Data::String("否".into())));
    assert_eq!(sheet.get((1, 15)), Some(&Data::String("外出培训".into())));
    assert_eq!(sheet.get((1, 10)), Some(&Data::Float(3.0)));
    let monthly = exchange::merge_monthly(&[path.to_string_lossy().into_owned()]).unwrap();
    assert_eq!(
        (monthly[0].actual_days, monthly[0].attendance_hours),
        (0.5, 3.0)
    );
}
