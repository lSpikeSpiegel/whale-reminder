mod commands;
mod config;
mod db;
mod error;
pub mod mcp;
mod repository;
mod scheduler;
mod tray;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // 数据库必须先于窗口初始化：窗口一显示，前端就会拉列表
            let connection = db::open()?;
            app.manage(db::Db(std::sync::Mutex::new(connection)));

            window::setup(&handle)?;
            init_autostart(&handle);
            tray::create(&handle)?;

            // 气泡和面板都是透明窗口，同样要抹掉 WebView2 的默认底色
            for label in ["bubble", "panel"] {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                }
            }

            scheduler::start(handle.clone());

            // 开发期自动打开待办面板，省得每次去托盘里点
            #[cfg(debug_assertions)]
            if let Some(panel) = app.get_webview_window("panel") {
                let _ = panel.show();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::create_task,
            commands::update_task,
            commands::complete_task,
            commands::answer_progress,
            commands::reopen_task,
            commands::delete_task,
            commands::snooze_task,
            commands::today_brief,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 首次运行时默认开启开机自启。
///
/// 用标记文件区分「从未设置过」和「用户主动关掉了」——
/// 否则每次启动都强行 enable，用户就永远关不掉。
fn init_autostart<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_autostart::ManagerExt;

    let marker = db::data_dir().join(".autostart-initialized");
    if marker.exists() {
        return;
    }

    let _ = app.autolaunch().enable();
    let _ = std::fs::write(&marker, "1");
}
