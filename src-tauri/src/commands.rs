use crate::{
    device::{DeviceStatus, DeviceWorker},
    exchange,
    models::*,
    store::Store,
};
use std::{path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

async fn with_store<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&mut Store) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<Store>>();
        let mut store = state
            .lock()
            .map_err(|_| "数据服务发生异常，请重启应用".to_string())?;
        action(&mut store)
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}
fn extension(path: &str, expected: &str) -> AppResult<()> {
    if Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case(expected))
    {
        Ok(())
    } else {
        Err(format!("文件名必须以 .{expected} 结尾"))
    }
}
#[tauri::command]
pub async fn bootstrap(app: AppHandle) -> AppResult<Bootstrap> {
    with_store(app, |s| s.bootstrap()).await
}
#[tauri::command]
pub async fn save_config(app: AppHandle, config: AppConfig) -> AppResult<AppConfig> {
    with_store(app, move |s| s.save_config(config)).await
}
#[tauri::command]
pub async fn query_logs(app: AppHandle, query: LogQuery) -> AppResult<LogPage> {
    with_store(app, move |s| s.query_logs(&query)).await
}
#[tauri::command]
pub async fn calculate(
    app: AppHandle,
    range: DateRange,
    department_ids: Vec<String>,
) -> AppResult<StatisticsResult> {
    with_store(app, move |s| s.calculate(&range, &department_ids)).await
}
#[tauri::command]
pub async fn save_review(app: AppHandle, review: Review) -> AppResult<()> {
    with_store(app, move |s| s.save_review(&review)).await
}
#[tauri::command]
pub async fn reset_reviews(app: AppHandle, range: DateRange) -> AppResult<usize> {
    with_store(app, move |s| s.reset_reviews(&range)).await
}
#[tauri::command]
pub async fn import_legacy(app: AppHandle, directory: String) -> AppResult<ImportSummary> {
    with_store(app, move |s| {
        s.install_backup(exchange::read_legacy(Path::new(&directory))?, false)
    })
    .await
}
#[tauri::command]
pub async fn import_people(
    app: AppHandle,
    path: String,
    department_id: String,
) -> AppResult<ImportSummary> {
    with_store(app, move |s| {
        let mut config = s.config()?;
        let report = exchange::import_people(Path::new(&path), &department_id, &mut config)?;
        s.save_config(config)?;
        Ok(report)
    })
    .await
}
#[tauri::command]
pub async fn import_logs(app: AppHandle, path: String) -> AppResult<ImportSummary> {
    with_store(app, move |s| {
        let logs = exchange::read_logs_csv(Path::new(&path))?;
        let added = s.insert_logs(&logs, None)?;
        Ok(ImportSummary {
            added,
            skipped: logs.len() - added,
            ..ImportSummary::default()
        })
    })
    .await
}
#[tauri::command]
pub async fn export_logs(app: AppHandle, path: String, query: LogQuery) -> AppResult<usize> {
    extension(&path, "csv")?;
    with_store(app, move |s| {
        let logs = s.log_views(&query)?;
        if logs.is_empty() {
            return Err("当前筛选范围没有日志".into());
        }
        exchange::export_logs(Path::new(&path), &logs)?;
        Ok(logs.len())
    })
    .await
}
#[tauri::command]
pub async fn export_statistics(
    app: AppHandle,
    path: String,
    range: DateRange,
    department_ids: Vec<String>,
) -> AppResult<usize> {
    extension(&path, "xlsx")?;
    with_store(app, move |s| {
        let result = s.calculate(&range, &department_ids)?;
        exchange::export_statistics(
            Path::new(&path),
            &result.rows,
            &result.details,
            Some(&range),
            "period",
        )?;
        Ok(result.rows.len())
    })
    .await
}
#[tauri::command]
pub async fn merge_monthly(paths: Vec<String>, path: String) -> AppResult<usize> {
    extension(&path, "xlsx")?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = Path::new(&path);
        if let Ok(output) = std::fs::canonicalize(output) {
            if paths
                .iter()
                .filter_map(|p| std::fs::canonicalize(p).ok())
                .any(|p| p == output)
            {
                return Err("月报输出文件不能覆盖输入周报".into());
            }
        }
        let rows = exchange::merge_monthly(&paths)?;
        exchange::export_statistics(output, &rows, &[], None, "monthly")?;
        Ok(rows.len())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_backup(app: AppHandle, path: String) -> AppResult<()> {
    extension(&path, "json")?;
    with_store(app, move |s| {
        exchange::write_json(Path::new(&path), &s.backup()?)
    })
    .await
}
#[tauri::command]
pub async fn restore_backup(app: AppHandle, path: String) -> AppResult<ImportSummary> {
    with_store(app, move |s| {
        s.install_backup(exchange::read_backup(Path::new(&path))?, true)
    })
    .await
}
#[tauri::command]
pub async fn device_status(worker: State<'_, DeviceWorker>) -> AppResult<DeviceStatus> {
    worker.status().await
}
#[tauri::command]
pub async fn connect_device(
    worker: State<'_, DeviceWorker>,
    settings: ConnectionSettings,
) -> AppResult<DeviceStatus> {
    worker.connect(settings).await
}
#[tauri::command]
pub async fn disconnect_device(worker: State<'_, DeviceWorker>) -> AppResult<DeviceStatus> {
    worker.disconnect().await
}
#[tauri::command]
pub async fn download_logs(
    app: AppHandle,
    worker: State<'_, DeviceWorker>,
    range: DateRange,
) -> AppResult<ImportSummary> {
    range.validate()?;
    let emitter = app.clone();
    let records = worker
        .download(range.clone(), move |progress| {
            let _ = emitter.emit("download-progress", progress);
        })
        .await?;
    with_store(app, move |s| {
        let added = s.insert_logs(&records, Some(&range))?;
        Ok(ImportSummary {
            added,
            skipped: records.len() - added,
            ..ImportSummary::default()
        })
    })
    .await
}
