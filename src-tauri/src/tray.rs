use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_autostart::ManagerExt;

const WINDOW_LABEL: &str = "main";
const PANEL_LABEL: &str = "panel";

/// 面板前端监听的事件名，收到后立即检查更新（忽略节流）
pub const CHECK_UPDATE_EVENT: &str = "update://check";

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏桌宠", true, None::<&str>)?;

    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart_on,
        None::<&str>,
    )?;

    let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;

    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &hide, &autostart, &update, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Whale Reminder")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_panel(app),
            "hide" => set_visible(app, false),
            "autostart" => toggle_autostart(app),
            "update" => check_update(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_visible(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 打开待办面板（独立窗口），已打开则聚焦。
fn open_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 托盘「检查更新」：先把面板亮出来，再让前端立刻发起检查。
///
/// 检查逻辑放在前端（用 updater 的 JS API 能直接拿下载进度），
/// 这里只负责给一个用户可见的反馈入口。
fn check_update<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit_to(PANEL_LABEL, CHECK_UPDATE_EVENT, ());
    }
}

/// 切换开机自启。菜单项自身的勾选状态由原生控件维护。
fn toggle_autostart<R: Runtime>(app: &AppHandle<R>) {
    let launcher = app.autolaunch();
    let enabled = launcher.is_enabled().unwrap_or(false);

    let _ = if enabled {
        launcher.disable()
    } else {
        launcher.enable()
    };
}

fn set_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let _ = if visible {
        window.show()
    } else {
        window.hide()
    };
}

fn toggle_visible<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let _ = if visible {
        window.hide()
    } else {
        window.show()
    };
}
