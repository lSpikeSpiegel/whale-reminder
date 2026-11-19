//! 按掉 `Alt+Space` 的系统菜单。
//!
//! 窗口都是 `decorations: false`，但 Windows 仍然会给每个顶层窗口挂一份系统菜单：
//! 焦点在窗口上按 `Alt+Space`，`DefWindowProc` 会收到 `WM_SYSCOMMAND(SC_KEYMENU)`，
//! 在窗口左上角弹出「还原 / 移动 / 大小 / 最小化 / 最大化 / 关闭」。
//!
//! 我们的默认呼出键就是 `Alt+Space`，这个菜单必须按掉——否则用户每按一次热键，
//! 面板是出来了，左上角还多挂一个系统菜单。用 `RegisterHotKey` 注册并不能解决：
//! **同一个线程里注册的热键，按键仍然会送到该线程的焦点窗口**，`WM_SYSKEYDOWN`
//! 照走 `DefWindowProc`。
//!
//! 做法是给每个窗口挂一层子类（`SetWindowSubclass`），只吞两类消息：
//!
//! - `WM_SYSKEYDOWN` / `WM_SYSKEYUP` / `WM_SYSCHAR` 且主键是空格；
//! - `WM_SYSCOMMAND` 且命令是 `SC_KEYMENU`（没有菜单栏，这个命令对我们没有别的含义）。
//!
//! 别的 Alt 组合（`Alt+F4`、`Alt+Tab`）原样交给 `DefSubclassProc`，不要顺手全吃掉。
//!
//! **必须装在窗口线程上**：子类化是线程内的消息拦截，从别的线程调会挂到错误的
//! 消息队列上。`setup` 和 `on_window_event` 都在事件循环线程里跑，刚好满足。

use core::ffi::c_void;

use tauri::{Runtime, WebviewWindow, Window};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_SPACE;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SC_KEYMENU, WM_SYSCHAR, WM_SYSCOMMAND, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// 子类 id。同一个窗口重复调用会命中同一条记录（只更新 ref data），不会越挂越多，
/// 所以焦点每来一次都调一遍也没关系。
const SUBCLASS_ID: usize = 0x5748_4c31; // "WHL1"

/// 给 WebView 窗口挂上拦截（`setup` 里遍历已有窗口时用）。
pub fn block_webview<R: Runtime>(window: &WebviewWindow<R>) {
    if let Ok(hwnd) = window.hwnd() {
        install(hwnd.0 as *mut c_void);
    }
}

/// 给普通窗口挂上拦截（`on_window_event` 拿到的是 `&Window`）。
pub fn block_window<R: Runtime>(window: &Window<R>) {
    if let Ok(hwnd) = window.hwnd() {
        install(hwnd.0 as *mut c_void);
    }
}

fn install(hwnd: *mut c_void) {
    let ok = unsafe { SetWindowSubclass(hwnd, Some(hook), SUBCLASS_ID, 0) };
    if ok == 0 {
        // 失败不该影响主流程，但「按 Alt+Space 还是弹菜单」时这行是唯一线索
        eprintln!("[sysmenu] 窗口子类化失败，Alt+Space 可能仍会弹出系统菜单");
    }
}

unsafe extern "system" fn hook(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    const SPACE: usize = VK_SPACE as usize;

    match msg {
        // 空格作为主键的三条系统键消息：返回 0 = 已处理，不再往下传
        WM_SYSKEYDOWN | WM_SYSKEYUP | WM_SYSCHAR if wparam == SPACE => 0,
        // SC_KEYMENU 是「用键盘激活菜单」。窗口没有菜单栏，收到就说明是 Alt+Space，
        // 直接吃掉；不按 lParam 判断是因为不同 Windows 版本这里给的值不一致。
        WM_SYSCOMMAND if (wparam & 0xFFF0) == SC_KEYMENU as usize => 0,
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}
