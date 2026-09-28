use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub type AppResult<T> = Result<T, String>;
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub revision: u64,
    pub connection: ConnectionSettings,
    pub rules: Rules,
    pub departments: Vec<Department>,
    pub people: Vec<Person>,
    pub shifts: Vec<Shift>,
    pub query: DateRange,
}
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            revision: 0,
            connection: ConnectionSettings::default(),
            rules: Rules::default(),
            departments: vec![Department {
                id: id(),
                name: "未分类".into(),
                is_system: true,
            }],
            people: vec![],
            shifts: vec![Shift::default()],
            query: DateRange::default(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionSettings {
    pub ip_address: String,
    pub port: u16,
    pub comm_key: i32,
    pub machine_number: i32,
}
impl Default for ConnectionSettings {
    fn default() -> Self {
        Self {
            ip_address: String::new(),
            port: 4370,
            comm_key: 0,
            machine_number: 1,
        }
    }
}
impl ConnectionSettings {
    pub fn validate(&self, require_ip: bool) -> AppResult<()> {
        if (require_ip || !self.ip_address.is_empty())
            && self.ip_address.parse::<std::net::Ipv4Addr>().is_err()
        {
            return Err("请输入有效的设备 IPv4 地址".into());
        }
        if self.port == 0
            || !(0..=999999).contains(&self.comm_key)
            || !(1..=255).contains(&self.machine_number)
        {
            return Err("端口须为 1–65535，通讯密码为 0–999999，机器号为 1–255".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeWindow {
    pub start: String,
    pub end: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
    pub late_early_threshold_minutes: u32,
    pub debug_details_enabled: bool,
    pub windows: [TimeWindow; 4],
}
impl Default for Rules {
    fn default() -> Self {
        Self {
            late_early_threshold_minutes: 30,
            debug_details_enabled: false,
            windows: [
                ("07:00", "10:30"),
                ("11:30", "13:00"),
                ("13:01", "15:30"),
                ("17:00", "18:30"),
            ]
            .map(|(start, end)| TimeWindow {
                start: start.into(),
                end: end.into(),
            }),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Department {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub is_system: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub device_user_id: String,
    pub full_name: String,
    #[serde(default)]
    pub grade: String,
    pub department_id: String,
    pub shift_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shift {
    pub id: String,
    pub name: String,
    pub days: Vec<ShiftDay>,
}
impl Default for Shift {
    fn default() -> Self {
        Self {
            id: id(),
            name: "标准工作日".into(),
            days: (0..7).map(ShiftDay::new).collect(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftDay {
    pub day_of_week: u32,
    pub morning_enabled: bool,
    pub morning_start: String,
    pub morning_end: String,
    pub afternoon_enabled: bool,
    pub afternoon_start: String,
    pub afternoon_end: String,
}
impl ShiftDay {
    pub fn new(day: u32) -> Self {
        Self {
            day_of_week: day,
            morning_enabled: (1..=5).contains(&day),
            morning_start: "09:00".into(),
            morning_end: "12:00".into(),
            afternoon_enabled: (1..=5).contains(&day),
            afternoon_start: "14:00".into(),
            afternoon_end: "17:30".into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
}
impl Default for DateRange {
    fn default() -> Self {
        let end_date = today();
        Self {
            start_date: end_date.with_day(1).unwrap(),
            end_date,
        }
    }
}
impl DateRange {
    pub fn validate(&self) -> AppResult<()> {
        if self.end_date < self.start_date {
            return Err("结束日期不能早于开始日期".into());
        }
        if (self.end_date - self.start_date).num_days() > 366 {
            return Err("单次查询范围最多 367 天，请分段查询".into());
        }
        if self.start_date.year() < 1970 || self.end_date.year() > 2200 {
            return Err("日期须在 1970–2200 年之间".into());
        }
        Ok(())
    }
    pub fn contains(&self, date: NaiveDate) -> bool {
        date >= self.start_date && date <= self.end_date
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    #[serde(default)]
    pub id: i64,
    pub user_id: String,
    pub timestamp: NaiveDateTime,
    #[serde(default)]
    pub verify_mode: i32,
    #[serde(default)]
    pub in_out_mode: i32,
    #[serde(default)]
    pub work_code: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub device_user_id: String,
    pub date: NaiveDate,
    pub punches: [Option<NaiveTime>; 4],
    pub exempt: [bool; 2],
    #[serde(default)]
    pub note: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub device_user_id: String,
    pub person_name: String,
    pub department_name: String,
    pub date: NaiveDate,
    pub scheduled: [Option<NaiveTime>; 4],
    pub punches: [Option<NaiveTime>; 4],
    pub exempt: [bool; 2],
    pub late: [bool; 2],
    pub early: [bool; 2],
    pub absent: [bool; 2],
    pub hours: f64,
    pub reviewed: bool,
    pub note: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Statistic {
    pub device_user_id: String,
    pub person_name: String,
    pub department_name: String,
    pub grade: String,
    pub expected_days: f64,
    pub actual_days: f64,
    pub late_count: u32,
    pub early_leave_count: u32,
    pub absent_days: f64,
    pub attendance_hours: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsResult {
    pub rows: Vec<Statistic>,
    pub details: Vec<Detail>,
    pub warnings: Vec<String>,
    pub range: DateRange,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub config: AppConfig,
    pub logs: Vec<LogRecord>,
    pub reviews: Vec<Review>,
    #[serde(default)]
    pub coverage: Vec<DateRange>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub config: AppConfig,
    pub log_count: usize,
    pub review_count: usize,
    pub data_directory: String,
    pub legacy_path: Option<String>,
    pub coverage: Vec<DateRange>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub range: DateRange,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub department_ids: Vec<String>,
    #[serde(default)]
    pub page: u32,
    pub page_size: u32,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogView {
    #[serde(flatten)]
    pub record: LogRecord,
    pub person_name: String,
    pub department_name: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub records: Vec<LogView>,
    pub total: usize,
}

pub fn clock(value: &str) -> AppResult<NaiveTime> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .map_err(|_| format!("无效时间：{value}，请使用 HH:mm"))
}
fn unique(values: impl Iterator<Item = String>, label: &str) -> AppResult<()> {
    let mut seen = HashSet::new();
    for value in values {
        if value.trim().is_empty() || !seen.insert(value.to_lowercase()) {
            return Err(format!("{label}为空或重复"));
        }
    }
    Ok(())
}
impl AppConfig {
    pub fn validate(&mut self) -> AppResult<()> {
        self.connection.ip_address = self.connection.ip_address.trim().into();
        self.connection.validate(false)?;
        self.query.validate()?;
        if self.rules.late_early_threshold_minutes > 240 {
            return Err("迟到/早退阈值须在 0–240 分钟之间".into());
        }
        let mut last = None;
        for window in &self.rules.windows {
            let (start, end) = (clock(&window.start)?, clock(&window.end)?);
            if end < start || last.is_some_and(|l| start <= l) {
                return Err("打卡窗口须按时间排列，且不能重叠或跨天".into());
            }
            last = Some(end);
        }
        if self.departments.iter().filter(|d| d.is_system).count() != 1 {
            return Err("必须保留一个系统未分类部门".into());
        }
        unique(self.departments.iter().map(|d| d.id.clone()), "部门 ID")?;
        unique(self.shifts.iter().map(|s| s.id.clone()), "班次 ID")?;
        unique(self.people.iter().map(|p| p.id.clone()), "人员 ID")?;
        for d in &mut self.departments {
            d.name = d.name.trim().into();
        }
        unique(self.departments.iter().map(|d| d.name.clone()), "部门名称")?;
        for s in &mut self.shifts {
            s.name = s.name.trim().into();
            if s.name.is_empty() || s.days.len() != 7 {
                return Err("班次需要名称和完整的七天安排".into());
            }
            let mut days = HashSet::new();
            for d in &s.days {
                if d.day_of_week > 6 || !days.insert(d.day_of_week) {
                    return Err("班次星期不能重复".into());
                }
                for (enabled, start, end) in [
                    (d.morning_enabled, &d.morning_start, &d.morning_end),
                    (d.afternoon_enabled, &d.afternoon_start, &d.afternoon_end),
                ] {
                    if enabled && clock(end)? <= clock(start)? {
                        return Err(format!(
                            "{}：下班时间必须晚于上班时间，不支持跨天班次",
                            s.name
                        ));
                    }
                }
                if d.morning_enabled
                    && d.afternoon_enabled
                    && clock(&d.morning_end)? >= clock(&d.afternoon_start)?
                {
                    return Err(format!("{}：两个时段不能重叠", s.name));
                }
            }
        }
        for p in &mut self.people {
            p.device_user_id = p.device_user_id.trim().into();
            p.full_name = p.full_name.trim().into();
            p.grade = p.grade.trim().into();
            if p.full_name.is_empty() || p.device_user_id.len() > 128 {
                return Err("人员姓名不能为空，设备 ID 最多 128 字节".into());
            }
            if !self.departments.iter().any(|d| d.id == p.department_id) {
                return Err(format!("{}的部门不存在", p.full_name));
            }
            if p.shift_id
                .as_ref()
                .is_some_and(|id| !self.shifts.iter().any(|s| &s.id == id))
            {
                return Err(format!("{}的班次不存在", p.full_name));
            }
        }
        unique(
            self.people.iter().map(|p| p.device_user_id.clone()),
            "设备人员 ID",
        )?;
        Ok(())
    }
}
