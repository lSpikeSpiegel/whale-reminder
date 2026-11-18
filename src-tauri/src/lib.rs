mod backup;
mod color;
mod commands;
mod config;
mod db;
mod error;
mod fsutil;
// 系统级闲置时长（Windows 走 GetLastInputInfo），桌宠据此打盹
mod idle;
// 「甩出去」的滑行 / 反弹，纯几何
mod throw;
// 混合逻辑时钟。留下的 `millis()` / `counter()` 取数器只给单测用，
// 所以整个模块挂 allow——它们是对外可读的字段访问器，不是死代码。
#[allow(dead_code)]
mod hlc;
pub mod mcp;
mod overlay;
mod pet;
mod recur;
mod repository;
mod scanner;
mod scheduler;
mod settings;
// 呼出面板的全局快捷键。只有一条，绑定值存在 settings.json
mod shortcut;
// 写路径的统一入口（推进 HLC + 投 outbox），也被 repository 反过来调用
mod sync;
mod tools;
mod tray;
mod window;

#[cfg(test)]
mod testutil;

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
        .plugin(
            // 热键事件按下 / 松开各来一条，这里只放行按下——两条都处理的话，
            // 按一次 Alt+Space 会「打开又立刻收起」，看起来像完全没反应
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shortcut::on_pressed(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();

            // 数据库必须先于窗口初始化：窗口一显示，前端就会拉列表。
            // 走带恢复的入口：库坏了不静默重建，先隔离坏库再从备份恢复。
            let (connection, recovery) = db::open_or_recover()?;

            // 数据被动过就得留痕，用户以后能在历史里看到「某天启动时做过恢复」
            if !matches!(recovery, db::Recovery::Clean) {
                let payload = serde_json::to_string(&recovery).unwrap_or_default();
                let _ = connection.execute(
                    "INSERT INTO event_log (id, at, actor, action, payload)
                     VALUES (?1, ?2, 'system', 'db.recovered', ?3)",
                    rusqlite::params![db::new_id(), db::now_iso(), payload],
                );
                eprintln!("[whale] 数据库已自动恢复：{payload}");
            }

            app.manage(db::Db(std::sync::Mutex::new(connection)));

            window::setup(&handle)?;
            init_autostart(&handle);
            tray::create(&handle)?;
            // 面板窗口在 conf 里按出厂尺寸建好了，用户拖过的话换成他上次的尺寸
            tray::apply_saved_size(&handle);

            // 浮层是临时窗口，整屏截图存在这个状态里，关窗口即释放
            app.manage(overlay::OverlayState::default());
            app.manage(color::PickedColor::default());
            // 设置页录制新快捷键期间，热键回调要装死（别把面板收走）
            app.manage(shortcut::Capturing::default());

            // 气泡停留时长是用户设置，调度器启动前先灌进去
            let settings = settings::load(&handle);
            scheduler::set_bubble_ttl(settings.bubble_seconds);

            // 全局快捷键：默认 Control+Alt+Space，被别的程序占着时自动换一个能用的，
            // 并把实际生效的组合写回配置（设置页显示的就是它）
            commands::bind_panel_shortcut(&handle);

            // 气泡和面板都是透明窗口，同样要抹掉 WebView2 的默认底色
            for label in ["bubble", "panel"] {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                }
            }

            scheduler::start(handle.clone());
            // 定时备份（6 小时一份、留 7 份）跑在自己的线程上，
            // 不跟 15 秒一跳的调度器混在一起
            backup::spawn(handle.clone());

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
            commands::reschedule_reminder,
            commands::bubble_resize,
            commands::panel_resize,
            commands::today_brief,
            commands::open_panel,
            commands::close_panel,
            commands::take_pending_check,
            commands::get_settings,
            commands::set_bubble_seconds,
            commands::set_autostart,
            commands::set_panel_size,
            commands::set_panel_shortcut,
            commands::begin_shortcut_capture,
            commands::resume_shortcut,
            commands::set_pet_style,
            commands::set_pet_live2d,
            commands::web_log,
            commands::web_dump_pixels,
            commands::clear_history,
            commands::list_notes,
            commands::create_note,
            commands::update_note,
            commands::delete_note,
            commands::list_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::open_url,
            overlay::overlay_frame,
            overlay::overlay_close,
            scanner::scan_start,
            scanner::scan_pick,
            scanner::scan_history,
            scanner::scan_forget,
            scanner::scan_clear_history,
            scanner::qr_encode,
            scanner::save_qr_image,
            tools::tool_usage,
            tools::tool_open,
            color::color_history,
            color::color_remember,
            color::color_clear,
            color::pick_start,
            color::pick_commit,
            color::pick_take,
            pet::snap_pet,
            pet::get_dock,
            pet::dock_pet,
            pet::pet_peek,
            pet::pet_say,
            pet::pet_throw,
            pet::pet_next_monitor,
            pet::pet_home,
            commands::system_idle,
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
