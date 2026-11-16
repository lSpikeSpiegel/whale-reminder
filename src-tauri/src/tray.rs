use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;

use crate::config::Edge;

const WINDOW_LABEL: &str = "main";
const PANEL_LABEL: &str = "panel";

/// 托盘里的「开机自启」勾选项。
///
/// Tauri 没有 `TrayIcon::menu()` 这种读回来的接口，设置页改了自启之后
/// 拿不到那个 CheckMenuItem，只能建菜单时自己留一份。
pub struct AutostartCheck(Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// 面板关闭时的位置。面板是「关了就没」的窗口，重建时不记一下就会跳回屏幕中间。
/// 只放内存：应用重启后回到 conf 里的居中，和以前的行为一致。
#[derive(Default)]
pub struct PanelPos(Mutex<Option<PhysicalPosition<i32>>>);

impl PanelPos {
    pub fn save(&self, pos: PhysicalPosition<i32>) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(pos);
        }
    }

    fn take(&self) -> Option<PhysicalPosition<i32>> {
        self.0.lock().ok().and_then(|guard| *guard)
    }
}

/// 托盘点了「检查更新」但面板当时是关着的——新窗口还在加载，事件发过去会丢，
/// 先留个标记，等页面挂载后自己来取（见 `take_pending_check`）。
#[derive(Default)]
pub struct PendingCheck(AtomicBool);

impl PendingCheck {
    fn arm(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

/// 面板前端监听的事件名，收到后立即检查更新（忽略节流）
pub const CHECK_UPDATE_EVENT: &str = "update://check";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏桌宠", true, None::<&str>)?;

    // 动作：和右键菜单同一套动作名，前端按字符串分发
    let act_pat = MenuItem::with_id(app, "act:pat", "摸摸头", true, None::<&str>)?;
    let act_happy = MenuItem::with_id(app, "act:happy", "撒个欢", true, None::<&str>)?;
    let act_think = MenuItem::with_id(app, "act:think", "沉思", true, None::<&str>)?;
    let act_slack = MenuItem::with_id(app, "act:slack", "摸鱼", true, None::<&str>)?;
    let act_daydream = MenuItem::with_id(app, "act:daydream", "发呆", true, None::<&str>)?;
    let act_bored = MenuItem::with_id(app, "act:bored", "无聊", true, None::<&str>)?;
    let act_doze = MenuItem::with_id(app, "act:doze", "打瞌睡", true, None::<&str>)?;
    let act_sleep = MenuItem::with_id(app, "act:sleep", "睡觉", true, None::<&str>)?;
    let act_work = MenuItem::with_id(app, "act:work", "坐下干活", true, None::<&str>)?;
    let act_eat = MenuItem::with_id(app, "act:eat", "吃点心", true, None::<&str>)?;
    let act_idle = MenuItem::with_id(app, "act:idle", "回神", true, None::<&str>)?;
    let act_sep_a = PredefinedMenuItem::separator(app)?;
    let act_sep_b = PredefinedMenuItem::separator(app)?;

    let actions = Submenu::with_items(
        app,
        "动作",
        true,
        &[
            &act_pat,
            &act_happy,
            &act_sep_a,
            &act_think,
            &act_slack,
            &act_daydream,
            &act_bored,
            &act_sep_b,
            &act_doze,
            &act_sleep,
            &act_work,
            &act_eat,
            &act_idle,
        ],
    )?;

    // 贴边
    let dock_left = MenuItem::with_id(app, "dock:left", "贴左边", true, None::<&str>)?;
    let dock_right = MenuItem::with_id(app, "dock:right", "贴右边", true, None::<&str>)?;
    let dock_top = MenuItem::with_id(app, "dock:top", "贴上面", true, None::<&str>)?;
    let dock_bottom = MenuItem::with_id(app, "dock:bottom", "贴下面", true, None::<&str>)?;
    let dock_none = MenuItem::with_id(app, "dock:none", "取消贴边", true, None::<&str>)?;
    let dock_sep = PredefinedMenuItem::separator(app)?;
    let home = MenuItem::with_id(app, "home", "回到右下角", true, None::<&str>)?;

    let docks = Submenu::with_items(
        app,
        "贴边",
        true,
        &[
            &dock_left,
            &dock_right,
            &dock_top,
            &dock_bottom,
            &dock_sep,
            &dock_none,
            &home,
        ],
    )?;

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

    let sep_a = PredefinedMenuItem::separator(app)?;
    let sep_b = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &hide,
            &sep_a,
            &actions,
            &docks,
            &sep_b,
            &autostart,
            &update,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Whale Reminder")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => open_panel(app),
                "hide" => set_visible(app, false),
                "home" => crate::window::go_home(app),
                "autostart" => toggle_autostart(app),
                "update" => check_update(app),
                "quit" => app.exit(0),
                _ => {
                    if let Some(action) = id.strip_prefix("act:") {
                        // 动作要在看得见的地方演，先把她叫出来
                        set_visible(app, true);
                        crate::pet::emit_action(app, action);
                    } else if let Some(edge) = id.strip_prefix("dock:") {
                        set_visible(app, true);
                        match edge {
                            "left" => crate::pet::dock_to(app, Edge::Left),
                            "right" => crate::pet::dock_to(app, Edge::Right),
                            "top" => crate::pet::dock_to(app, Edge::Top),
                            "bottom" => crate::pet::dock_to(app, Edge::Bottom),
                            _ => crate::pet::undock(app),
                        }
                    }
                }
            }
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
    // 留一份勾选项的句柄，设置页改完自启要回来同步
    app.manage(AutostartCheck(Mutex::new(Some(autostart))));
    app.manage(PanelPos::default());
    app.manage(PendingCheck::default());
    Ok(())
}

/// 打开待办面板（独立窗口），已打开则聚焦。
///
/// 托盘菜单和桌宠双击都走这里，避免两处逻辑走偏。
///
/// 面板的关闭按钮是**真关窗口**（下次打开重新加载，状态全清），
/// 所以窗口不在时得按 `tauri.conf.json` 里那份配置重新建一个——
/// 尺寸、透明、无边框这些都从 conf 读，别在这里再抄一遍。
pub(crate) fn open_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // 建窗口不能占着主线程：`build()` 会把请求发给事件循环再等回执，
    // 在主线程上直接调就是自己等自己，整个应用会卡死（窗口出来了但页面永远不加载）。
    // 从别的线程发起，事件循环才有机会处理这次创建。
    let handle = app.clone();
    std::thread::spawn(move || create_panel(&handle));
}

/// 按 `tauri.conf.json` 里那份 `panel` 配置重建窗口。
///
/// 尺寸、透明、无边框、URL 都从 conf 读，别在这里再抄一遍——改 conf 就该生效。
/// 唯一例外是尺寸：用户拖过之后以 settings.json 里记的为准。
fn create_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == PANEL_LABEL)
        .cloned()
    else {
        return;
    };

    let builder = match WebviewWindowBuilder::from_config(app, &config) {
        Ok(builder) => builder,
        Err(err) => {
            eprintln!("[panel] 重建失败：{err}");
            return;
        }
    };

    // 上次拖成多大就建多大，别先按 conf 的出厂尺寸闪一下再改
    let builder = match crate::settings::load(app).panel_size {
        Some(size) => builder.inner_size(size.width as f64, size.height as f64),
        None => builder,
    };

    // visible(true) 必须在 build 时给：建完再 show() 在 Windows 上偶尔不生效
    // （窗口出来了但一直藏着，页面也不加载）。
    let window = match builder.visible(true).build() {
        Ok(window) => window,
        Err(err) => {
            eprintln!("[panel] 重建失败：{err}");
            return;
        }
    };

    panel_limits(&window);

    // conf 里没有这个字段（setup 里是逐个窗口设的），重建时得补上，
    // 否则深色模式下窗口会露出一块不透明的底色。
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

    // 上次关掉时在哪，还摆回哪；没记过就让 conf 的 center 生效
    if let Some(state) = app.try_state::<PanelPos>() {
        if let Some(pos) = state.take() {
            let _ = window.set_position(pos);
        }
    }

    let _ = window.set_focus();
}

/// 面板尺寸的兜底约束。
///
/// 窗口是 `resizable: false`——拖拽由前端自己算（`ui/ResizeHandles.tsx`），
/// 系统那层原生缩放用不上，留着反而会在边框上抢鼠标。所以这里只管「别被写出离谱尺寸」：
/// 下限和前端那份 clamp 对齐，上限不设，想拉多大拉多大。
fn panel_limits<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use crate::settings::{MIN_PANEL_HEIGHT, MIN_PANEL_WIDTH};

    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(
        MIN_PANEL_WIDTH as f64,
        MIN_PANEL_HEIGHT as f64,
    ))));
    // 泛型参数从 None 推不出来，得显式给个类型
    let _ = window.set_max_size(None::<tauri::Size>);
}

/// 启动时把上次拖好的尺寸套回面板窗口。
///
/// 面板窗口在 conf 里已经按出厂尺寸建好了，这里补一次——只在应用启动时走，
/// 之后关掉重开走的是 `create_panel`（那边直接按保存尺寸 build）。
pub fn apply_saved_size<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    panel_limits(&window);

    if let Some(size) = crate::settings::load(app).panel_size {
        let _ = window.set_size(tauri::LogicalSize::new(size.width, size.height));
    }
}

/// 托盘「检查更新」：先把面板亮出来，再让前端立刻发起检查。
///
/// 检查逻辑放在前端（用 updater 的 JS API 能直接拿下载进度），
/// 这里只负责给一个用户可见的反馈入口。
fn check_update<R: Runtime>(app: &AppHandle<R>) {
    let alive = app.get_webview_window(PANEL_LABEL).is_some();
    open_panel(app);

    if alive {
        let _ = app.emit_to(PANEL_LABEL, CHECK_UPDATE_EVENT, ());
    } else if let Some(state) = app.try_state::<PendingCheck>() {
        // 刚建出来的窗口还没加载完页面，这时候 emit 没人接；留个标记让前端挂载后来取
        state.arm();
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

/// 从设置页改了自启之后，把托盘菜单里那个勾同步过去。
pub fn sync_autostart(app: &AppHandle, on: bool) {
    let Some(state) = app.try_state::<AutostartCheck>() else {
        return;
    };
    let Ok(guard) = state.0.lock() else {
        return;
    };
    if let Some(item) = guard.as_ref() {
        let _ = item.set_checked(on);
    }
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
