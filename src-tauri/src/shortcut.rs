//! 呼出待办面板的全局快捷键。
//!
//! 只有一条快捷键，绑的是 `settings.json` 里的 `panel_shortcut`（默认
//! `Control+Alt+Space`）。这里只管「注册 / 换绑 / 按下时该干什么」，
//! 窗口怎么开关是 `tray::toggle_panel` 的事。
//!
//! 四个容易踩的点：
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

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::settings::{self, DEFAULT_PANEL_SHORTCUT};

/// 默认值被占时依次尝试的组合。
///
/// 都带修饰键：单键（比如 `F9`）会全局吃掉那个键，在别的软件里按就变成呼面板了。
/// 顺序按冲突概率和手感排，`Ctrl+Alt+Space` 是默认值本身，从它开始试。
const FALLBACKS: &[&str] = &[
    DEFAULT_PANEL_SHORTCUT,
    "Control+Shift+Space",
    "Alt+Shift+Space",
    "Control+Alt+P",
];

/// 设置页是不是正在录制新组合。
///
/// 录制期间热键**不注销**，只让 `on_pressed` 装死。注销再挂回去那条路一旦中途
/// 被打断（面板被关、渲染进程崩），热键就永久失效了，用户只能重启应用；
/// 装死最坏也就是多按几次没反应，打开一次面板就自己好了。
#[derive(Default)]
pub struct Capturing(AtomicBool);

impl Capturing {
    pub fn begin(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn end(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
    fn is_on(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// 快捷键按下：把面板叫出来 / 收起来。
pub fn on_pressed<R: Runtime>(app: &AppHandle<R>) {
    // 用户正在设置页按新组合，这时候把面板收走就等于把录制器关了
    if app
        .try_state::<Capturing>()
        .map(|state| state.is_on())
        .unwrap_or(false)
    {
        return;
    }
    crate::tray::toggle_panel(app);
}

/// 注册（或换绑）呼出面板的快捷键，返回**实际生效**的写法。
///
/// 空字符串表示一个都绑不上（多个程序把这几个组合全占了），此时功能不可用，
/// 但应用照常跑——调用方把空串落盘，设置页会显示「未生效」。
pub fn bind<R: Runtime>(app: &AppHandle<R>, raw: &str) -> String {
    // 先全摘掉：换绑走的就是这条路径，旧组合不能留着
    let _ = app.global_shortcut().unregister_all();

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
