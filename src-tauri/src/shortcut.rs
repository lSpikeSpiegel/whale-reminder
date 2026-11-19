//! 呼出待办面板的全局快捷键。
//!
//! 只有一条快捷键，绑的是 `settings.json` 里的 `panel_shortcut`（默认
//! `Alt+Space`）。这里只管「注册 / 换绑 / 按下时该干什么」，
//! 窗口怎么开关是 `tray::toggle_panel` 的事。
//!
//! 五个容易踩的点：
//!
//! 1. **插件的事件按下和松开各来一条**，不筛 `Pressed` 会一次按键开一次关，
//!    看起来像快捷键失灵。
//! 2. **换绑没有 replace**，只能 `unregister_all` 再挂新的。摘干净很重要——
//!    旧组合留着的话，用户以为已经改掉了，其实两个键都能叫出面板。
//! 3. **`RegisterHotKey` 会失败**，最常见的原因是键被别的程序占着（uTools、PowerToys
//!    Run 都默认吃 `Alt+Space`）。所以失败不能只退回默认值——默认值可能同样被占——
//!    要顺着 `FALLBACKS` 一个个试，把**第一个真的绑上的**返回给调用方。
//! 4. **绑定值必须和配置对齐**。返回的是实际生效的组合，调用方要拿它落盘，
//!    否则设置页显示的是一套、系统里挂的是另一套。
//! 5. **录制时 `Alt+Space` 要临时注册**。它不在注册状态时会被窗口的系统菜单吃掉，
//!    webview 收不到 `keydown`——用户把热键改走之后，就再也录不回这个组合。
//!    录制期间临时占住它，按键走 `WM_HOTKEY`，从 `CAPTURED_EVENT` 把结果补回前端。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::settings::{self, DEFAULT_PANEL_SHORTCUT};

/// 录制期间按到「已经被注册」的组合时，后端推给前端的事件。
///
/// 注册过的键会被系统直接吞掉，webview 收不到 `keydown`。`Alt+Space` 还多一层：
/// 没被注册时它会被窗口的系统菜单吃掉（焦点窗口按 Alt+Space 由 `DefWindowProc`
/// 弹菜单），所以「把热键改走之后再想改回 Alt+Space」在纯前端录制器里是个单向门。
/// 后端在录制期间临时占住它，拿到 `WM_HOTKEY` 后从这里把结果补回前端。
pub const CAPTURED_EVENT: &str = "shortcut://captured";

/// 录制时额外临时占住的组合——目前只有 `Alt+Space` 需要。
///
/// 它可注册、但会被系统菜单抢；临时注册上之后按键走 `WM_HOTKEY`，既不会弹菜单，
/// 也能被当成一次正常的录制结果。
const CAPTURE_HOTKEY: &str = "Alt+Space";

/// 默认值被占时依次尝试的组合。
///
/// 都带修饰键：单键（比如 `F9`）会全局吃掉那个键，在别的软件里按就变成呼面板了。
/// 顺序按冲突概率和手感排，默认值本身排第一（`Alt+Space` 被 uTools、PowerToys Run
/// 这类启动器占着是常事），后面的三键组合留作退路。
const FALLBACKS: &[&str] = &[
    DEFAULT_PANEL_SHORTCUT,
    "Control+Alt+Space",
    "Control+Shift+Space",
    "Alt+Shift+Space",
    "Control+Alt+P",
];

/// 设置页是不是正在录制新组合。
///
/// 录制期间热键**不注销**，只让 `on_pressed` 不再 toggle 面板。注销再挂回去那条路
/// 一旦中途被打断（面板被关、渲染进程崩），热键就永久失效了，用户只能重启应用；
/// 只停掉 toggle 最坏也就是多按几次没反应，打开一次面板就自己好了。
///
/// `temp` 是录制期间额外占住的组合（见 `CAPTURE_HOTKEY`）。它必须在三个退出点
/// （`set_panel_shortcut` / `resume_shortcut` / `close_panel`）都摘掉，否则会跟着
/// 应用一直占着，变成「设置里写 A、实际按 Alt+Space 也能开」。
#[derive(Default)]
pub struct Capturing {
    active: AtomicBool,
    temp: Mutex<Vec<String>>,
}

impl Capturing {
    fn begin(&self) {
        self.active.store(true, Ordering::SeqCst);
    }

    fn end(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    fn is_on(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    fn remember(&self, key: &str) {
        let mut list = self.temp.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !list.iter().any(|item| item == key) {
            list.push(key.to_string());
        }
    }

    fn take(&self) -> Vec<String> {
        let mut list = self.temp.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *list)
    }
}

/// 快捷键按下：录制中就把组合回传给设置页，平时是「把面板叫出来 / 收起来」。
pub fn on_pressed<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut) {
    let capturing = app
        .try_state::<Capturing>()
        .map(|state| state.is_on())
        .unwrap_or(false);

    if capturing {
        // 录制态不 toggle（否则面板会被自己收走，录制器当场没了），
        // 但要把按键交给前端——注册过的组合不会进 webview，只能走这条路
        let _ = app.emit(CAPTURED_EVENT, shortcut.to_string());
        return;
    }

    crate::tray::toggle_panel(app);
}

/// 进入录制态，并临时占住 `Alt+Space`。
///
/// 当前绑的就是 `Alt+Space` 时不用重复注册（它已经在系统里，按下去照样走 WM_HOTKEY）。
/// 返回 `false` 表示 `Alt+Space` 被别的程序占着——这时候它也设不成，前端会提示一句；
/// 其它组合的录制不受影响。
pub fn begin_capture<R: Runtime>(app: &AppHandle<R>) -> bool {
    if let Some(state) = app.try_state::<Capturing>() {
        state.begin();
    }

    let current = crate::settings::load(app).panel_shortcut;
    if settings::normalize_shortcut(&current) == CAPTURE_HOTKEY {
        return true;
    }

    match register(app, CAPTURE_HOTKEY) {
        Ok(()) => {
            if let Some(state) = app.try_state::<Capturing>() {
                state.remember(CAPTURE_HOTKEY);
            }
            eprintln!("[shortcut] 录制期间临时占用 {CAPTURE_HOTKEY}");
            true
        }
        Err(err) => {
            eprintln!("[shortcut] 录制期间占不住 {CAPTURE_HOTKEY}：{err}");
            false
        }
    }
}

/// 退出录制态，并把临时占住的组合摘掉。
///
/// 三个出口都要走这里（`set_panel_shortcut` / `resume_shortcut` / `close_panel`）；
/// 前两个随后会 `bind`（内部 `unregister_all`），`close_panel` 只关窗口、不重绑，
/// 所以这里必须自己摘。
pub fn end_capture<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<Capturing>() else {
        return;
    };
    state.end();

    for key in state.take() {
        let Ok(shortcut) = key.parse::<Shortcut>() else {
            continue;
        };
        if let Err(err) = app.global_shortcut().unregister(shortcut) {
            eprintln!("[shortcut] 摘掉临时组合 {key} 失败：{err}");
        }
    }
}

/// 注册（或换绑）呼出面板的快捷键，返回**实际生效**的写法。
///
/// 空字符串表示一个都绑不上（多个程序把这几个组合全占了），此时功能不可用，
/// 但应用照常跑——调用方把空串落盘，设置页会显示「未生效」。
pub fn bind<R: Runtime>(app: &AppHandle<R>, raw: &str) -> String {
    // 先全摘掉：换绑走的就是这条路径，旧组合不能留着
    let _ = app.global_shortcut().unregister_all();
    // 临时组合也被 `unregister_all` 摘掉了，列表跟着清空，别留悬空记录
    if let Some(state) = app.try_state::<Capturing>() {
        state.take();
    }

    let wanted = settings::normalize_shortcut(raw);
    match register(app, &wanted) {
        Ok(()) => {
            // 和 [live2d] 那行一样，留着给启动自检用：
            // 快捷键「按了没反应」时分不清是被占、没绑上、还是 toggle 逻辑出错，
            // 有这行至少能先排除前两种
            eprintln!("[shortcut] 已绑定 {wanted}");
            return wanted;
        }
        Err(err) => eprintln!("[shortcut] {wanted} 绑不上：{err}"),
    }

    // 用户明确要的那个键被占了：顺着备选往下试。
    // 注意这些组合之间互不相同，且都不等于 wanted（`wanted` 可能是任意用户输入）
    for fallback in FALLBACKS {
        if *fallback == wanted {
            continue;
        }
        match register(app, fallback) {
            Ok(()) => {
                eprintln!("[shortcut] 改用 {fallback}（原来的 {wanted} 被别的程序占着）");
                return (*fallback).to_string();
            }
            Err(err) => eprintln!("[shortcut] {fallback} 也绑不上：{err}"),
        }
    }

    eprintln!("[shortcut] 没有可用的组合，这次启动不带快捷键");
    String::new()
}

fn register<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Result<(), String> {
    let shortcut: Shortcut = raw
        .parse()
        .map_err(|err| format!("{raw} 不是合法的快捷键写法：{err}"))?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|err| err.to_string())
}
