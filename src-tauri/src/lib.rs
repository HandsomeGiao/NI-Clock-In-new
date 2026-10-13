pub mod attendance;
mod commands;
mod device;
pub mod exchange;
pub mod models;
pub mod store;

use std::sync::Mutex;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let executable = std::env::current_exe()?;
            let executable_dir = executable
                .parent()
                .ok_or_else(|| std::io::Error::other("无法确定程序所在目录"))?;
            let data_dir = executable_dir.to_path_buf();
            // Only debug builds allow isolated test/development data directories.
            #[cfg(debug_assertions)]
            let data_dir = std::env::var_os("NI_CLOCK_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(data_dir);
            let store = store::Store::open(&data_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "无法在程序目录 {} 保存数据：{error}。请将完整程序文件夹放到有写入权限的位置。",
                    data_dir.display()
                ))
            })?;
            app.manage(Mutex::new(store));
            let resource_dir = app.path().resource_dir()?;
            app.manage(device::DeviceWorker::new(resource_dir));
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(data_dir.join("webview"))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::data_directory,
            commands::save_config,
            commands::query_logs,
            commands::calculate,
            commands::save_review,
            commands::reset_reviews,
            commands::import_legacy,
            commands::import_people,
            commands::import_logs,
            commands::export_logs,
            commands::export_statistics,
            commands::merge_monthly,
            commands::export_backup,
            commands::restore_backup,
            commands::device_status,
            commands::connect_device,
            commands::disconnect_device,
            commands::download_logs
        ])
        .run(tauri::generate_context!())
        .expect("NI 考勤启动失败");
}
