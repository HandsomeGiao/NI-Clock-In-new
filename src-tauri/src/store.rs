use crate::models::*;
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

fn db<T>(result: rusqlite::Result<T>) -> AppResult<T> {
    result.map_err(|e| format!("数据库操作失败：{e}"))
}
fn json<T: serde::Serialize>(value: &T) -> AppResult<String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

pub struct Store {
    conn: Connection,
    pub directory: PathBuf,
}
impl Store {
    pub fn open(directory: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(directory).map_err(|e| format!("无法创建数据目录：{e}"))?;
        let conn = db(Connection::open(directory.join("attendance.sqlite3")))?;
        db(conn.busy_timeout(std::time::Duration::from_secs(5)))?;
        let version: u32 = db(conn.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        if version > 1 {
            return Err("此数据库由更新版本创建，请升级程序后再打开".into());
        }
        db(conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL COLLATE NOCASE,
                timestamp TEXT NOT NULL, verify_mode INTEGER NOT NULL, in_out_mode INTEGER NOT NULL, work_code INTEGER NOT NULL,
                UNIQUE(user_id, timestamp, verify_mode, in_out_mode, work_code));
            CREATE INDEX IF NOT EXISTS logs_date ON logs(timestamp);
            CREATE TABLE IF NOT EXISTS reviews (user_id TEXT NOT NULL COLLATE NOCASE, date TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,date));
            CREATE TABLE IF NOT EXISTS coverage (start_date TEXT NOT NULL, end_date TEXT NOT NULL, PRIMARY KEY(start_date,end_date));
            PRAGMA user_version=1;"))?;
        let store = Self {
            conn,
            directory: directory.into(),
        };
        if db(store
            .conn
            .query_row("SELECT value FROM metadata WHERE key='config'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional())?
        .is_none()
        {
            db(store.conn.execute(
                "INSERT INTO metadata VALUES ('config',?1)",
                [json(&AppConfig::default())?],
            ))?;
        }
        store.config()?; // Corruption is surfaced, never replaced by an empty configuration.
        Ok(store)
    }
    pub fn config(&self) -> AppResult<AppConfig> {
        let text: String =
            db(self
                .conn
                .query_row("SELECT value FROM metadata WHERE key='config'", [], |r| {
                    r.get(0)
                }))?;
        let mut config: AppConfig =
            serde_json::from_str(&text).map_err(|e| format!("配置无法读取，请从备份恢复：{e}"))?;
        config.validate()?;
        Ok(config)
    }
    pub fn save_config(&mut self, mut config: AppConfig) -> AppResult<AppConfig> {
        config.validate()?;
        let current = self.config()?;
        if config.revision != current.revision {
            return Err("配置已更新，请刷新后重试，避免覆盖其他修改".into());
        }
        let system = current.departments.iter().find(|d| d.is_system).unwrap();
        if !config
            .departments
            .iter()
            .any(|d| d.id == system.id && d.is_system)
        {
            return Err("系统未分类部门不可删除或替换".into());
        }
        config.revision += 1;
        db(self.conn.execute(
            "UPDATE metadata SET value=?1 WHERE key='config'",
            [json(&config)?],
        ))?;
        Ok(config)
    }
    pub fn bootstrap(&self) -> AppResult<Bootstrap> {
        Ok(Bootstrap {
            config: self.config()?,
            log_count: db(self
                .conn
                .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get::<_, i64>(0)))?
                as usize,
            review_count: db(self
                .conn
                .query_row("SELECT COUNT(*) FROM reviews", [], |r| r.get::<_, i64>(0)))?
                as usize,
            data_directory: self.directory.to_string_lossy().into(),
            legacy_path: discover_legacy(),
            coverage: self.coverage()?,
        })
    }
    pub fn logs(&self, range: Option<&DateRange>) -> AppResult<Vec<LogRecord>> {
        if let Some(range) = range {
            range.validate()?;
        }
        let mut stmt = db(self.conn.prepare(
            "SELECT id,user_id,timestamp,verify_mode,in_out_mode,work_code FROM logs
            WHERE timestamp>=?1 AND timestamp<=?2 ORDER BY timestamp DESC,id DESC",
        ))?;
        let from = range
            .map(|r| format!("{}T00:00:00", r.start_date))
            .unwrap_or_default();
        let to = range
            .map(|r| format!("{}T23:59:59", r.end_date))
            .unwrap_or_else(|| "9999".into());
        let rows = db(stmt.query_map(params![from, to], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, i32>(4)?,
                row.get::<_, i32>(5)?,
            ))
        }))?;
        rows.map(|row| {
            let (id, user_id, time, verify_mode, in_out_mode, work_code) = db(row)?;
            Ok(LogRecord {
                id,
                user_id,
                timestamp: time.parse().map_err(|e| format!("日志时间损坏：{e}"))?,
                verify_mode,
                in_out_mode,
                work_code,
            })
        })
        .collect()
    }
    pub fn log_views(&self, query: &LogQuery) -> AppResult<Vec<LogView>> {
        let config = self.config()?;
        let people: HashMap<_, _> = config
            .people
            .iter()
            .map(|p| (p.device_user_id.to_lowercase(), p))
            .collect();
        let departments: HashMap<_, _> = config
            .departments
            .iter()
            .map(|d| (&d.id, &d.name))
            .collect();
        let search = query.search.trim().to_lowercase();
        Ok(self
            .logs(Some(&query.range))?
            .into_iter()
            .filter_map(|record| {
                let person = people.get(&record.user_id.to_lowercase());
                if !query.department_ids.is_empty()
                    && !person.is_some_and(|p| query.department_ids.contains(&p.department_id))
                {
                    return None;
                }
                let person_name = person
                    .map(|p| p.full_name.clone())
                    .unwrap_or_else(|| "未匹配人员".into());
                let department_name = person
                    .and_then(|p| departments.get(&p.department_id))
                    .map(|s| (*s).clone())
                    .unwrap_or_else(|| "—".into());
                if !search.is_empty()
                    && !format!("{} {} {}", record.user_id, person_name, department_name)
                        .to_lowercase()
                        .contains(&search)
                {
                    return None;
                }
                Some(LogView {
                    record,
                    person_name,
                    department_name,
                })
            })
            .collect())
    }
    pub fn query_logs(&self, query: &LogQuery) -> AppResult<LogPage> {
        if query.page_size == 0 || query.page_size > 500 {
            return Err("每页记录数须为 1–500".into());
        }
        let views = self.log_views(query)?;
        let total = views.len();
        Ok(LogPage {
            total,
            records: views
                .into_iter()
                .skip(query.page as usize * query.page_size as usize)
                .take(query.page_size as usize)
                .collect(),
        })
    }
    pub fn insert_logs(
        &mut self,
        records: &[LogRecord],
        coverage: Option<&DateRange>,
    ) -> AppResult<usize> {
        validate_logs(records)?;
        if let Some(r) = coverage {
            r.validate()?;
        }
        let tx = db(self.conn.transaction())?;
        let added = insert_records(&tx, records)?;
        if let Some(r) = coverage {
            db(tx.execute(
                "INSERT OR IGNORE INTO coverage VALUES (?1,?2)",
                params![r.start_date.to_string(), r.end_date.to_string()],
            ))?;
        }
        db(tx.commit())?;
        Ok(added)
    }
    pub fn reviews(&self) -> AppResult<Vec<Review>> {
        let mut stmt = db(self
            .conn
            .prepare("SELECT value FROM reviews ORDER BY date,user_id"))?;
        let rows = db(stmt.query_map([], |r| r.get::<_, String>(0)))?;
        rows.map(|r| {
            serde_json::from_str(&db(r)?).map_err(|e| format!("人工修正数据无法读取：{e}"))
        })
        .collect()
    }
    pub fn save_review(&mut self, review: &Review) -> AppResult<()> {
        validate_review(review)?;
        if !self.config()?.people.iter().any(|p| {
            p.device_user_id
                .eq_ignore_ascii_case(&review.device_user_id)
        }) {
            return Err("人员不存在，请刷新后重试".into());
        }
        db(self.conn.execute("INSERT INTO reviews VALUES (?1,?2,?3) ON CONFLICT(user_id,date) DO UPDATE SET value=excluded.value",
            params![review.device_user_id,review.date.to_string(),json(review)?]))?;
        Ok(())
    }
    pub fn reset_reviews(&mut self, range: &DateRange) -> AppResult<usize> {
        range.validate()?;
        db(self.conn.execute(
            "DELETE FROM reviews WHERE date>=?1 AND date<=?2",
            params![range.start_date.to_string(), range.end_date.to_string()],
        ))
    }
    pub fn coverage(&self) -> AppResult<Vec<DateRange>> {
        let mut stmt = db(self
            .conn
            .prepare("SELECT start_date,end_date FROM coverage ORDER BY start_date"))?;
        let rows =
            db(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?;
        rows.map(|r| {
            let (start, end) = db(r)?;
            Ok(DateRange {
                start_date: start.parse().map_err(|e| format!("覆盖日期损坏：{e}"))?,
                end_date: end.parse().map_err(|e| format!("覆盖日期损坏：{e}"))?,
            })
        })
        .collect()
    }
    pub fn calculate(
        &self,
        range: &DateRange,
        departments: &[String],
    ) -> AppResult<StatisticsResult> {
        let mut result = crate::attendance::calculate(
            &self.config()?,
            &self.logs(Some(range))?,
            &self.reviews()?,
            range,
            departments,
        )?;
        let coverage = self.coverage()?;
        let complete = range
            .start_date
            .iter_days()
            .take_while(|d| *d <= range.end_date)
            .all(|d| coverage.iter().any(|r| r.contains(d)));
        if !complete {
            result.warnings.push(
                "部分日期尚未从设备完整下载；CSV 导入也不保证完整性，请核对后再导出。".into(),
            );
        }
        Ok(result)
    }
    pub fn backup(&self) -> AppResult<Backup> {
        Ok(Backup {
            format: "ni-clock-in".into(),
            version: 1,
            created_at: Local::now().to_rfc3339(),
            config: self.config()?,
            logs: self.logs(None)?,
            reviews: self.reviews()?,
            coverage: self.coverage()?,
        })
    }
    pub fn install_backup(
        &mut self,
        mut backup: Backup,
        replace_all: bool,
    ) -> AppResult<ImportSummary> {
        if backup.format != "ni-clock-in" || backup.version != 1 {
            return Err("不支持的备份格式或版本".into());
        }
        backup.config.validate()?;
        validate_logs(&backup.logs)?;
        for review in &backup.reviews {
            validate_review(review)?;
        }
        for range in &backup.coverage {
            range.validate()?;
        }
        backup.config.revision = self.config()?.revision + 1;
        let safety_path = self.directory.join(format!(
            "before-import-{}.json",
            Local::now().format("%Y%m%d-%H%M%S-%f")
        ));
        crate::exchange::write_json(&safety_path, &self.backup()?)?;
        let tx = db(self.conn.transaction())?;
        if replace_all {
            db(tx.execute_batch("DELETE FROM logs; DELETE FROM reviews; DELETE FROM coverage;"))?;
        }
        db(tx.execute(
            "UPDATE metadata SET value=?1 WHERE key='config'",
            [json(&backup.config)?],
        ))?;
        let added = insert_records(&tx, &backup.logs)?;
        for r in &backup.reviews {
            db(tx.execute("INSERT INTO reviews VALUES (?1,?2,?3) ON CONFLICT(user_id,date) DO UPDATE SET value=excluded.value", params![r.device_user_id,r.date.to_string(),json(r)?]))?;
        }
        for r in &backup.coverage {
            db(tx.execute(
                "INSERT OR IGNORE INTO coverage VALUES (?1,?2)",
                params![r.start_date.to_string(), r.end_date.to_string()],
            ))?;
        }
        db(tx.commit())?;
        Ok(ImportSummary {
            added,
            updated: backup.config.people.len(),
            skipped: backup.logs.len() - added,
            warnings: vec![format!("导入前备份：{}", safety_path.display())],
        })
    }
}
fn insert_records(conn: &Connection, records: &[LogRecord]) -> AppResult<usize> {
    let mut stmt = db(conn.prepare("INSERT OR IGNORE INTO logs (user_id,timestamp,verify_mode,in_out_mode,work_code) VALUES (?1,?2,?3,?4,?5)"))?;
    let mut added = 0;
    for r in records {
        added += db(stmt.execute(params![
            r.user_id.trim(),
            r.timestamp.format("%Y-%m-%dT%H:%M:%S").to_string(),
            r.verify_mode,
            r.in_out_mode,
            r.work_code
        ]))?;
    }
    Ok(added)
}
fn validate_logs(records: &[LogRecord]) -> AppResult<()> {
    for r in records {
        if r.user_id.trim().is_empty() || r.user_id.len() > 128 {
            return Err("日志中存在无效设备人员 ID".into());
        }
        DateRange {
            start_date: r.timestamp.date(),
            end_date: r.timestamp.date(),
        }
        .validate()?;
    }
    Ok(())
}
fn validate_review(review: &Review) -> AppResult<()> {
    DateRange {
        start_date: review.date,
        end_date: review.date,
    }
    .validate()?;
    if review.device_user_id.trim().is_empty() || review.note.len() > 3000 {
        return Err("修正记录需要有效人员 ID，备注最多 1000 个汉字".into());
    }
    for i in [0, 2] {
        if let (Some(start), Some(end)) = (review.punches[i], review.punches[i + 1]) {
            if end < start {
                return Err("修正后的下班时间不能早于上班时间".into());
            }
        }
    }
    Ok(())
}
pub fn discover_legacy() -> Option<String> {
    let explicit = std::env::var_os("NI_CLOCK_LEGACY_DIR").map(PathBuf::from);
    let sibling = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .join("NI-Clock-In/data");
    explicit
        .or(cfg!(debug_assertions).then_some(sibling))
        .filter(|p| p.join("app-state.json").is_file())
        .map(|p| p.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logs_deduplicate_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let log = LogRecord {
            id: 0,
            user_id: "001".into(),
            timestamp: "2026-04-06T09:00:00".parse().unwrap(),
            verify_mode: 1,
            in_out_mode: 0,
            work_code: 0,
        };
        assert_eq!(
            store
                .insert_logs(&[log.clone(), log.clone()], None)
                .unwrap(),
            1
        );
        assert_eq!(store.insert_logs(&[log], None).unwrap(), 0);
        drop(store);
        assert_eq!(
            Store::open(dir.path())
                .unwrap()
                .bootstrap()
                .unwrap()
                .log_count,
            1
        );
    }
    #[test]
    fn invalid_import_and_stale_save_leave_data_intact() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let config = store.config().unwrap();
        store.save_config(config.clone()).unwrap();
        assert!(store.save_config(config).is_err());
        let mut backup = store.backup().unwrap();
        backup.config.departments.clear();
        assert!(store.install_backup(backup, true).is_err());
        assert_eq!(store.config().unwrap().departments.len(), 1);
    }
    #[test]
    fn reviews_persist_and_reset_only_requested_dates() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let mut c = store.config().unwrap();
        c.people.push(Person {
            id: id(),
            device_user_id: "A".into(),
            full_name: "测试".into(),
            grade: "".into(),
            department_id: c.departments[0].id.clone(),
            shift_id: None,
        });
        store.save_config(c).unwrap();
        for date in ["2026-04-06", "2026-04-07"] {
            store
                .save_review(&Review {
                    device_user_id: "A".into(),
                    date: date.parse().unwrap(),
                    punches: [None; 4],
                    exempt: [true; 2],
                    note: "请假".into(),
                })
                .unwrap();
        }
        assert_eq!(
            store
                .reset_reviews(&DateRange {
                    start_date: "2026-04-06".parse().unwrap(),
                    end_date: "2026-04-06".parse().unwrap()
                })
                .unwrap(),
            1
        );
        drop(store);
        assert_eq!(Store::open(dir.path()).unwrap().reviews().unwrap().len(), 1);
    }
}
