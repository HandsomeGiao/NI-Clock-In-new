use crate::{attendance::round_hours, models::*};
use calamine::{open_workbook_auto, Data, Reader};
use chrono::{Local, NaiveDateTime};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    io::Write,
    path::Path,
};

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    file.write_all(bytes).map_err(err)?;
    file.as_file().sync_all().map_err(err)?;
    file.persist(path).map_err(err)?;
    Ok(())
}
pub fn write_json(path: &Path, value: &impl serde::Serialize) -> AppResult<()> {
    atomic_write(path, &serde_json::to_vec_pretty(value).map_err(err)?)
}
fn read_bytes(path: &Path) -> AppResult<Vec<u8>> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    if metadata.len() > 100 * 1024 * 1024 {
        return Err("单个导入文件不能超过 100 MB".into());
    }
    std::fs::read(path).map_err(err)
}
fn read_text(path: &Path) -> AppResult<String> {
    let bytes = read_bytes(path)?;
    let encoding = if bytes.starts_with(&[0xff, 0xfe]) {
        Some(encoding_rs::UTF_16LE)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    };
    let text = if let Some(encoding) = encoding {
        let (text, _, bad) = encoding.decode(&bytes);
        if bad {
            return Err("文本编码损坏".into());
        }
        text.into_owned()
    } else if let Ok(text) = std::str::from_utf8(&bytes) {
        text.to_string()
    } else {
        let (text, _, bad) = encoding_rs::GB18030.decode(&bytes);
        if bad {
            return Err("无法识别文件编码，请转换为 UTF-8".into());
        }
        text.into_owned()
    };
    Ok(text.trim_start_matches('\u{feff}').into())
}
fn read_json(path: &Path) -> AppResult<Value> {
    serde_json::from_str(&read_text(path)?)
        .map_err(|e| format!("{} 不是有效 JSON：{e}", path.display()))
}
fn camelize(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let mut chars = key.chars();
                    let first = chars.next().unwrap_or_default();
                    (
                        format!("{}{}", first.to_lowercase(), chars.as_str()),
                        camelize(value),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(camelize).collect()),
        value => value,
    }
}
pub fn read_legacy(directory: &Path) -> AppResult<Backup> {
    let directory = if directory.join("app-state.json").is_file() {
        directory.to_path_buf()
    } else {
        directory.join("data")
    };
    let mut value = camelize(read_json(&directory.join("app-state.json"))?);
    for field in ["startDate", "endDate"] {
        if let Some(date) = value["query"][field].as_str() {
            value["query"][field] = Value::String(date.chars().take(10).collect());
        }
    }
    if let Some(shifts) = value["shifts"].as_array_mut() {
        for shift in shifts {
            if let Some(days) = shift["days"].as_array_mut() {
                for day in days {
                    if let Some(name) = day["dayOfWeek"].as_str() {
                        let index = [
                            "Sunday",
                            "Monday",
                            "Tuesday",
                            "Wednesday",
                            "Thursday",
                            "Friday",
                            "Saturday",
                        ]
                        .iter()
                        .position(|d| d.eq_ignore_ascii_case(name))
                        .ok_or_else(|| format!("未知星期：{name}"))?;
                        day["dayOfWeek"] = Value::from(index);
                    }
                }
            }
        }
    }
    let mut config: AppConfig =
        serde_json::from_value(value).map_err(|e| format!("旧版配置格式不正确：{e}"))?;
    config.validate()?;
    let mut logs = Vec::new();
    let mut coverage = Vec::new();
    let mut reviews = Vec::new();
    let cache_path = directory.join("attendance-log-cache.json");
    if cache_path.is_file() {
        let value = camelize(read_json(&cache_path)?);
        if let Some(records) = value["records"].as_array() {
            for record in records {
                if record["timestamp"].is_null() {
                    continue;
                }
                logs.push(
                    serde_json::from_value::<LogRecord>(record.clone())
                        .map_err(|e| format!("旧日志记录无效：{e}"))?,
                );
            }
        }
        let dates = |key: &str| -> AppResult<chrono::NaiveDate> {
            value[key]
                .as_str()
                .and_then(|s| s.get(..10))
                .ok_or_else(|| "旧日志缓存缺少日期范围".to_string())?
                .parse()
                .map_err(err)
        };
        coverage.push(DateRange {
            start_date: dates("startDate")?,
            end_date: dates("endDate")?,
        });
    }
    let review_path = directory.join("attendance-detail-review-cache.json");
    if review_path.is_file() {
        let value = camelize(read_json(&review_path)?);
        for item in value["details"]
            .as_array()
            .ok_or("旧版人工修正缺少 Details 数组")?
        {
            let read_punch = |key: &str| -> AppResult<Option<chrono::NaiveTime>> {
                if item[key].is_null() {
                    Ok(None)
                } else {
                    Ok(Some(
                        item[key]
                            .as_str()
                            .ok_or("修正时间无效")?
                            .parse::<NaiveDateTime>()
                            .map_err(err)?
                            .time(),
                    ))
                }
            };
            reviews.push(Review {
                device_user_id: item["deviceUserId"]
                    .as_str()
                    .ok_or("修正缺少人员 ID")?
                    .into(),
                date: item["date"]
                    .as_str()
                    .and_then(|s| s.get(..10))
                    .ok_or("修正缺少日期")?
                    .parse()
                    .map_err(err)?,
                punches: [
                    read_punch("punchMorningStart")?,
                    read_punch("punchMorningEnd")?,
                    read_punch("punchAfternoonStart")?,
                    read_punch("punchAfternoonEnd")?,
                ],
                exempt: [
                    item["isMorningExempt"].as_bool().unwrap_or(false),
                    item["isAfternoonExempt"].as_bool().unwrap_or(false),
                ],
                note: "从旧版导入".into(),
            });
        }
    }
    Ok(Backup {
        format: "ni-clock-in".into(),
        version: 1,
        created_at: Local::now().to_rfc3339(),
        config,
        logs,
        reviews,
        coverage,
    })
}
pub fn read_backup(path: &Path) -> AppResult<Backup> {
    serde_json::from_value(read_json(path)?).map_err(|e| format!("备份格式无效：{e}"))
}

pub fn import_people(
    path: &Path,
    department_id: &str,
    config: &mut AppConfig,
) -> AppResult<ImportSummary> {
    if !config.departments.iter().any(|d| d.id == department_id) {
        return Err("目标部门不存在".into());
    }
    let text = read_text(path)?;
    let mut summary = ImportSummary::default();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let pair = if let Some(delimiter) = [',', '，', ';', '；', '\t']
            .into_iter()
            .find(|d| line.contains(*d))
        {
            if delimiter.is_ascii() {
                let mut reader = csv::ReaderBuilder::new()
                    .has_headers(false)
                    .delimiter(delimiter as u8)
                    .trim(csv::Trim::All)
                    .from_reader(line.as_bytes());
                reader
                    .records()
                    .next()
                    .and_then(Result::ok)
                    .filter(|r| r.len() >= 2)
                    .map(|r| (r[0].to_string(), r[1].to_string()))
            } else {
                line.split_once(delimiter)
                    .map(|(a, b)| (a.trim().into(), b.trim().into()))
            }
        } else {
            line.split_once(char::is_whitespace)
                .map(|(a, b)| (a.trim().into(), b.trim().into()))
        };
        let Some((user_id, name)) = pair.filter(|(a, b)| !a.is_empty() && !b.is_empty()) else {
            summary.skipped += 1;
            if summary.warnings.len() < 10 {
                summary
                    .warnings
                    .push(format!("第 {} 行缺少设备 ID 或姓名", i + 1));
            }
            continue;
        };
        if ["userid", "deviceuserid", "deviceid", "设备id", "设备人员id"]
            .contains(&user_id.to_lowercase().as_str())
            && ["姓名", "name", "fullname", "personname"].contains(&name.to_lowercase().as_str())
        {
            continue;
        }
        if let Some(person) = config
            .people
            .iter_mut()
            .find(|p| p.device_user_id.eq_ignore_ascii_case(&user_id))
        {
            person.full_name = name;
            person.department_id = department_id.into();
            summary.updated += 1;
        } else {
            config.people.push(Person {
                id: id(),
                device_user_id: user_id,
                full_name: name,
                grade: String::new(),
                department_id: department_id.into(),
                shift_id: None,
            });
            summary.added += 1;
        }
    }
    config.validate()?;
    if summary.added + summary.updated == 0 {
        return Err("没有找到有效人员，请使用每行「设备ID 姓名」格式".into());
    }
    Ok(summary)
}
pub fn read_logs_csv(path: &Path) -> AppResult<Vec<LogRecord>> {
    let text = read_text(path)?;
    let mut reader = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let headers = reader.headers().map_err(err)?.clone();
    let column = |names: &[&str]| {
        headers
            .iter()
            .position(|h| names.iter().any(|n| h.eq_ignore_ascii_case(n)))
    };
    let user =
        column(&["UserId", "DeviceUserId", "设备ID", "设备人员ID"]).ok_or("CSV 缺少 UserId 列")?;
    let time = column(&["Timestamp", "打卡时间"]).ok_or("CSV 缺少 Timestamp 列")?;
    let (verify, mode, work) = (
        column(&["VerifyMode", "验证方式"]),
        column(&["InOutMode", "打卡状态"]),
        column(&["WorkCode", "工作代码"]),
    );
    let mut logs = Vec::new();
    for (i, record) in reader.records().enumerate() {
        let record = record.map_err(|e| format!("CSV 第 {} 行：{e}", i + 2))?;
        let raw_time = record.get(time).unwrap_or_default();
        let timestamp = raw_time
            .parse::<NaiveDateTime>()
            .or_else(|_| NaiveDateTime::parse_from_str(raw_time, "%Y-%m-%d %H:%M:%S"))
            .map_err(|_| format!("第 {} 行时间无效：{raw_time}", i + 2))?;
        let number = |column: Option<usize>| -> AppResult<i32> {
            match column.and_then(|c| record.get(c)).filter(|s| !s.is_empty()) {
                Some(n) => n
                    .parse()
                    .map_err(|_| format!("第 {} 行包含无效数字", i + 2)),
                None => Ok(0),
            }
        };
        let user_id = record.get(user).unwrap_or_default();
        let user_id = user_id
            .strip_prefix('\'')
            .filter(|s| dangerous_csv(s))
            .unwrap_or(user_id);
        logs.push(LogRecord {
            id: 0,
            user_id: user_id.into(),
            timestamp,
            verify_mode: number(verify)?,
            in_out_mode: number(mode)?,
            work_code: number(work)?,
        });
    }
    if logs.is_empty() {
        return Err("CSV 中没有打卡记录".into());
    }
    Ok(logs)
}
fn dangerous_csv(text: &str) -> bool {
    text.starts_with(['=', '+', '-', '@', '\t', '\r'])
}
fn csv_text(text: &str) -> String {
    if dangerous_csv(text) {
        format!("'{text}")
    } else {
        text.into()
    }
}
pub fn export_logs(path: &Path, logs: &[LogView]) -> AppResult<()> {
    let mut writer = csv::Writer::from_writer(vec![0xef, 0xbb, 0xbf]);
    writer
        .write_record([
            "Sequence",
            "UserId",
            "PersonName",
            "Department",
            "VerifyMode",
            "InOutMode",
            "Timestamp",
            "WorkCode",
        ])
        .map_err(err)?;
    for (i, log) in logs.iter().enumerate() {
        writer
            .write_record([
                (i + 1).to_string(),
                csv_text(&log.record.user_id),
                csv_text(&log.person_name),
                csv_text(&log.department_name),
                log.record.verify_mode.to_string(),
                log.record.in_out_mode.to_string(),
                log.record.timestamp.format("%Y-%m-%d %H:%M:%S").to_string(),
                log.record.work_code.to_string(),
            ])
            .map_err(err)?;
    }
    atomic_write(path, &writer.into_inner().map_err(err)?)
}

pub fn export_statistics(
    path: &Path,
    rows: &[Statistic],
    details: &[Detail],
    range: Option<&DateRange>,
    kind: &str,
) -> AppResult<()> {
    if rows.is_empty() {
        return Err("没有可导出的统计结果".into());
    }
    let mut workbook = Workbook::new();
    let body = Format::new()
        .set_font_name("Microsoft YaHei")
        .set_font_size(11)
        .set_num_format("0.##");
    let heading = body
        .clone()
        .set_bold()
        .set_background_color(Color::RGB(0xEAF2EF))
        .set_font_color(Color::RGB(0x176A55));
    let department = heading
        .clone()
        .set_font_size(13)
        .set_align(FormatAlign::Left);
    let late = body.clone().set_background_color(Color::RGB(0xFFF0C2));
    let early = body.clone().set_background_color(Color::RGB(0xDDF2DF));
    let absent = body.clone().set_background_color(Color::RGB(0xFCE0DE));
    let sheet = workbook
        .add_worksheet()
        .set_name("Statistics")
        .map_err(err)?;
    sheet.set_column_width(0, 22).map_err(err)?;
    sheet.set_column_range_width(1, 6, 16).map_err(err)?;
    sheet.set_freeze_panes(2, 1).map_err(err)?;
    let mut sorted = rows.to_vec();
    sorted.sort_by(|a, b| {
        a.department_name
            .cmp(&b.department_name)
            .then_with(|| b.attendance_hours.total_cmp(&a.attendance_hours))
            .then(a.person_name.cmp(&b.person_name))
    });
    let mut line = 0;
    let mut previous = None;
    for row in &sorted {
        if previous != Some(&row.department_name) {
            if line > 0 {
                line += 1;
            }
            sheet
                .merge_range(line, 0, line, 6, &row.department_name, &department)
                .map_err(err)?;
            sheet.set_row_height(line, 28).map_err(err)?;
            line += 1;
            for (col, title) in [
                "姓名",
                "应到天数",
                "实到天数",
                "迟到次数",
                "早退次数",
                "缺勤天数",
                "工时 (时)",
            ]
            .iter()
            .enumerate()
            {
                sheet
                    .write_string_with_format(line, col as u16, *title, &heading)
                    .map_err(err)?;
            }
            line += 1;
            previous = Some(&row.department_name);
        }
        sheet
            .write_string_with_format(line, 0, &row.person_name, &body)
            .map_err(err)?;
        for (col, value, format) in [
            (1, row.expected_days, &body),
            (2, row.actual_days, &body),
            (
                3,
                row.late_count as f64,
                if row.late_count > 0 { &late } else { &body },
            ),
            (
                4,
                row.early_leave_count as f64,
                if row.early_leave_count > 0 {
                    &early
                } else {
                    &body
                },
            ),
            (
                5,
                row.absent_days,
                if row.absent_days > 0.0 {
                    &absent
                } else {
                    &body
                },
            ),
            (6, row.attendance_hours, &body),
        ] {
            sheet
                .write_number_with_format(line, col, value, format)
                .map_err(err)?;
        }
        sheet.set_row_height(line, 23).map_err(err)?;
        line += 1;
    }
    if !details.is_empty() {
        let sheet = workbook.add_worksheet().set_name("每日明细").map_err(err)?;
        let headers = [
            "部门",
            "姓名",
            "设备ID",
            "日期",
            "上午上班",
            "上午下班",
            "下午上班",
            "下午下班",
            "上午免考勤",
            "下午免考勤",
            "工时",
            "人工修正",
            "备注",
        ];
        for (col, title) in headers.iter().enumerate() {
            sheet
                .write_string_with_format(0, col as u16, *title, &heading)
                .map_err(err)?;
            sheet.set_column_width(col as u16, 18).map_err(err)?;
        }
        sheet.set_column_width(12, 36).map_err(err)?;
        sheet.set_freeze_panes(1, 2).map_err(err)?;
        for (index, d) in details.iter().enumerate() {
            let row = index as u32 + 1;
            let mut values = vec![
                d.department_name.clone(),
                d.person_name.clone(),
                d.device_user_id.clone(),
                d.date.to_string(),
            ];
            values.extend(d.punches.iter().map(|t| {
                t.map(|v| v.format("%H:%M:%S").to_string())
                    .unwrap_or_default()
            }));
            values.extend(
                d.exempt
                    .iter()
                    .map(|x| if *x { "是".into() } else { "否".into() }),
            );
            values.push(String::new());
            values.push(if d.reviewed {
                "是".into()
            } else {
                "否".into()
            });
            values.push(d.note.clone());
            for (col, value) in values.iter().enumerate() {
                sheet
                    .write_string_with_format(row, col as u16, value, &body)
                    .map_err(err)?;
            }
            sheet
                .write_number_with_format(row, 10, round_hours(d.hours), &body)
                .map_err(err)?;
        }
    }
    // Keep IDs and report boundaries out of the printed report, but preserve them for lossless monthly aggregation.
    let data = workbook.add_worksheet().set_name("NI_Data").map_err(err)?;
    data.set_hidden(true);
    data.write_string(0, 0, "ni-clock-in:1").map_err(err)?;
    data.write_string(0, 1, kind).map_err(err)?;
    if let Some(r) = range {
        data.write_string(0, 2, r.start_date.to_string())
            .map_err(err)?;
        data.write_string(0, 3, r.end_date.to_string())
            .map_err(err)?;
    }
    for (i, row) in sorted.iter().enumerate() {
        data.write_string(i as u32 + 1, 0, serde_json::to_string(row).map_err(err)?)
            .map_err(err)?;
    }
    atomic_write(path, &workbook.save_to_buffer().map_err(err)?)
}

pub fn merge_monthly(paths: &[String]) -> AppResult<Vec<Statistic>> {
    if paths.is_empty() {
        return Err("请选择至少一个周报文件".into());
    }
    let mut totals: BTreeMap<String, Statistic> = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut ranges: Vec<DateRange> = Vec::new();
    for path in paths {
        let canonical = std::fs::canonicalize(path).map_err(err)?;
        if !seen.insert(canonical) {
            return Err("同一文件被重复选择，已停止汇总".into());
        }
        let mut workbook = open_workbook_auto(path).map_err(|e| format!("无法读取 {path}：{e}"))?;
        let rows = if let Ok(data) = workbook.worksheet_range("NI_Data") {
            let string = |row, col| {
                data.get_value((row, col))
                    .map(ToString::to_string)
                    .unwrap_or_default()
            };
            if string(0, 0) != "ni-clock-in:1" {
                return Err("不支持的 NI 报表版本".into());
            }
            if string(0, 1) == "monthly" {
                return Err("请选择周报；月度总表不能再次叠加".into());
            }
            let range = DateRange {
                start_date: string(0, 2).parse().map_err(err)?,
                end_date: string(0, 3).parse().map_err(err)?,
            };
            range.validate()?;
            if ranges
                .iter()
                .any(|r| r.start_date <= range.end_date && range.start_date <= r.end_date)
            {
                return Err("周报日期范围重叠，汇总会重复计数，已停止".into());
            }
            ranges.push(range);
            data.rows()
                .skip(1)
                .filter_map(|r| r.first())
                .filter(|c| **c != Data::Empty)
                .map(|v| serde_json::from_str::<Statistic>(&v.to_string()).map_err(err))
                .collect::<AppResult<Vec<_>>>()?
        } else {
            let data = workbook
                .worksheet_range_at(0)
                .ok_or("Excel 没有工作表")?
                .map_err(err)?;
            let mut department = String::new();
            let mut rows = Vec::new();
            for cells in data.rows() {
                let text = |i| cells.get(i).map(ToString::to_string).unwrap_or_default();
                let name = text(0);
                if name.trim().is_empty() || name == "姓名" {
                    continue;
                }
                if text(1).trim().is_empty() {
                    department = name;
                    continue;
                }
                if department.is_empty() {
                    return Err(format!("{path} 不是旧版按部门分组的周报格式"));
                }
                let number = |i| -> AppResult<f64> {
                    let text = text(i);
                    let text = text.trim();
                    if text.is_empty() {
                        Ok(0.0)
                    } else {
                        text.parse::<f64>()
                            .ok()
                            .filter(|n| n.is_finite() && *n >= 0.0)
                            .ok_or_else(|| format!("{path} 中 {name} 的第 {} 列数值无效", i + 1))
                    }
                };
                rows.push(Statistic {
                    department_name: department.clone(),
                    person_name: name.clone(),
                    expected_days: number(1)?,
                    actual_days: number(2)?,
                    late_count: number(3)? as u32,
                    early_leave_count: number(4)? as u32,
                    absent_days: number(5)?,
                    attendance_hours: number(6)?,
                    ..Statistic::default()
                });
            }
            if rows.is_empty() {
                return Err(format!("{path} 中未找到统计行"));
            }
            rows
        };
        for row in rows {
            // Legacy reports have no device IDs; the legacy-compatible key is department + name.
            let key = format!(
                "{}\u{1f}{}",
                row.department_name.to_lowercase(),
                row.person_name.to_lowercase()
            );
            if let Some(total) = totals.get_mut(&key) {
                if !total.device_user_id.is_empty()
                    && !row.device_user_id.is_empty()
                    && total.device_user_id != row.device_user_id
                {
                    return Err(format!(
                        "{}存在同名不同设备 ID，不能自动合并",
                        row.person_name
                    ));
                }
                total.expected_days += row.expected_days;
                total.actual_days += row.actual_days;
                total.late_count += row.late_count;
                total.early_leave_count += row.early_leave_count;
                total.absent_days += row.absent_days;
                total.attendance_hours += row.attendance_hours;
            } else {
                totals.insert(key, row);
            }
        }
    }
    Ok(totals
        .into_values()
        .map(|mut row| {
            row.attendance_hours = round_hours(row.attendance_hours);
            row
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_roundtrip_preserves_ids_and_neutralizes_formulas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs.csv");
        let record = LogRecord {
            id: 0,
            user_id: "001".into(),
            timestamp: "2026-04-06T09:00:00".parse().unwrap(),
            verify_mode: 1,
            in_out_mode: 0,
            work_code: 0,
        };
        export_logs(
            &path,
            &[LogView {
                record,
                person_name: "=HYPERLINK(\"x\")".into(),
                department_name: "研发,一组".into(),
            }],
        )
        .unwrap();
        assert_eq!(read_logs_csv(&path).unwrap()[0].user_id, "001");
        assert!(read_text(&path).unwrap().contains("'=HYPERLINK"));
    }
    #[test]
    fn xlsx_roundtrip_and_overlapping_report_detection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("week.xlsx");
        let rows = vec![Statistic {
            person_name: "测试人员".into(),
            department_name: "研发".into(),
            device_user_id: "001".into(),
            expected_days: 5.0,
            actual_days: 4.5,
            early_leave_count: 1,
            attendance_hours: 29.5,
            ..Statistic::default()
        }];
        let range = DateRange {
            start_date: "2026-04-06".parse().unwrap(),
            end_date: "2026-04-10".parse().unwrap(),
        };
        export_statistics(&path, &rows, &[], Some(&range), "period").unwrap();
        assert_eq!(
            merge_monthly(&[path.to_string_lossy().into()]).unwrap()[0].attendance_hours,
            29.5
        );
        let copy = dir.path().join("copy.xlsx");
        std::fs::copy(&path, &copy).unwrap();
        assert!(
            merge_monthly(&[path.to_string_lossy().into(), copy.to_string_lossy().into()])
                .unwrap_err()
                .contains("重叠")
        );
    }
    #[test]
    fn people_import_supports_bom_names_with_spaces_and_updates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("people.txt");
        std::fs::write(
            &path,
            "\u{feff}DeviceUserId,FullName\n001,张 三\n002 李四\n001,王 五\ninvalid",
        )
        .unwrap();
        let mut config = AppConfig::default();
        let dept = config.departments[0].id.clone();
        let result = import_people(&path, &dept, &mut config).unwrap();
        assert_eq!((result.added, result.updated, result.skipped), (2, 1, 1));
        assert_eq!(config.people[0].full_name, "王 五");
    }
}
