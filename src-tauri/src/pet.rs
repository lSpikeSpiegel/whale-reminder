//! 贴边停靠。
//!
//! 桌宠被拖到屏幕边缘附近松手时，把窗口吸到边上，并记住贴的是哪条边。
//! 贴着边的时候还会「探头」——睡着了就缩到屏幕外只露一半，鼠标过来再滑回去。
//!
//! 几何计算全部在 Rust 做，前端只负责表现（侧身、朝向、停止呼吸浮动）。

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow};

use crate::config::{self, Edge, WindowPos};

pub const EVENT_DOCK: &str = "pet://dock";
pub const EVENT_ACTION: &str = "pet://action";
/// 设置页换了立绘风格，通知桌宠窗口换素材
pub const EVENT_STYLE: &str = "pet://style";
/// 甩出去之后落地停稳
pub const EVENT_LANDED: &str = "pet://landed";
/// 设置页开关了 Live2D 动态立绘
pub const EVENT_LIVE: &str = "pet://live";
const MAIN_LABEL: &str = "main";
/// 离边缘多近算「想贴上去」（物理像素）
const SNAP_DISTANCE: i32 = 26;
/// 探头时缩到屏幕外的比例
const PEEK_RATIO: f64 = 0.42;

#[derive(Debug, Clone, Copy)]
pub struct DockInfo {
    pub edge: Edge,
    /// 贴边时的「家」位置，探头之后要能退回来
    pub home: WindowPos,
    pub peeked: bool,
}

#[derive(Default)]
pub struct DockState(Mutex<Option<DockInfo>>);

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    app.manage(DockState::default());
}

#[derive(Serialize, Clone, Copy)]
struct DockPayload {
    edge: Option<Edge>,
}

fn emit_dock<R: Runtime>(app: &AppHandle<R>, edge: Option<Edge>) {
    let _ = app.emit_to(MAIN_LABEL, EVENT_DOCK, DockPayload { edge });
}

fn store<R: Runtime>(app: &AppHandle<R>, info: Option<DockInfo>) {
    if let Some(state) = app.try_state::<DockState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = info;
        }
    }
}

fn current<R: Runtime>(app: &AppHandle<R>) -> Option<DockInfo> {
    let state = app.try_state::<DockState>()?;
    let guard = state.0.lock().ok()?;
    *guard
}

pub fn is_docked<R: Runtime>(app: &AppHandle<R>) -> bool {
    current(app).is_some()
}

/// 当前显示器的工作区（已排除任务栏），单位物理像素。
fn work_area<R: Runtime>(window: &WebviewWindow<R>) -> Option<(i32, i32, i32, i32)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let area = monitor.work_area();
    Some((
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    ))
}

fn clamp(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        min
    } else {
        value.max(min).min(max)
    }
}

/// 计算某条边的吸附坐标，并保留另一个轴上的当前位置。
fn target_pos<R: Runtime>(
    window: &WebviewWindow<R>,
    edge: Edge,
) -> Option<WindowPos> {
    let size = window.outer_size().ok()?;
    let pos = window.outer_position().ok()?;
    let (ax, ay, aw, ah) = work_area(window)?;
    let (w, h) = (size.width as i32, size.height as i32);
    let right = ax + aw;
    let bottom = ay + ah;

    let mut x = pos.x;
    let mut y = pos.y;
    match edge {
        Edge::Left => x = ax,
        Edge::Right => x = right - w,
        Edge::Top => y = ay,
        Edge::Bottom => y = bottom - h,
    }

    Some(WindowPos {
        x: clamp(x, ax, right - w),
        y: clamp(y, ay, bottom - h),
    })
}

/// 拖拽松手后调用：离边够近就吸附，否则算取消贴边。
pub fn snap<R: Runtime>(app: &AppHandle<R>) -> Option<Edge> {
    let window = app.get_webview_window(MAIN_LABEL)?;
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    #[cfg(debug_assertions)]
    eprintln!("[pet] snap pos={pos:?} size={size:?}");
    let (ax, ay, aw, ah) = work_area(&window)?;

    let (w, h) = (size.width as i32, size.height as i32);
    let right = ax + aw;
    let bottom = ay + ah;

    let candidates = [
        (Edge::Left, (pos.x - ax).abs()),
        (Edge::Right, (right - (pos.x + w)).abs()),
        (Edge::Top, (pos.y - ay).abs()),
        (Edge::Bottom, (bottom - (pos.y + h)).abs()),
    ];
    let (edge, distance) = candidates
        .iter()
        .copied()
        .min_by_key(|(_, value)| *value)?;

    if distance > SNAP_DISTANCE {
        store(app, None);
        emit_dock(app, None);
        return None;
    }

    let home = target_pos(&window, edge)?;
    // 先记状态再挪窗口：Moved 事件会在挪动瞬间到达，位置保存要靠这个标记跳过
    store(
        app,
        Some(DockInfo {
            edge,
            home,
            peeked: false,
        }),
    );
    let _ = window.set_position(PhysicalPosition::new(home.x, home.y));
    config::save(app, home, Some(edge));
    emit_dock(app, Some(edge));
    Some(edge)
}

/// 主动贴到某条边（右键菜单 / 托盘）。
pub fn dock_to<R: Runtime>(app: &AppHandle<R>, edge: Edge) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let Some(home) = target_pos(&window, edge) else {
        return;
    };
    #[cfg(debug_assertions)]
    eprintln!("[pet] dock_to {edge:?} -> {home:?}");

    store(
        app,
        Some(DockInfo {
            edge,
            home,
            peeked: false,
        }),
    );
    let _ = window.set_position(PhysicalPosition::new(home.x, home.y));
    config::save(app, home, Some(edge));
    emit_dock(app, Some(edge));
}

pub fn undock<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    // 探头状态下先滑回来，否则会把半个身子在屏幕外的那点坐标存成「家」
    if let Some(info) = current(app) {
        if info.peeked {
            let _ = window.set_position(PhysicalPosition::new(info.home.x, info.home.y));
        }
    }
    if let Ok(pos) = window.outer_position() {
        config::save(
            app,
            WindowPos {
                x: pos.x,
                y: pos.y,
            },
            None,
        );
    }
    store(app, None);
    emit_dock(app, None);
}

/// 探头 / 收回。只对左右贴边有意义。
pub fn peek<R: Runtime>(app: &AppHandle<R>, peek_out: bool) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let Some(state) = app.try_state::<DockState>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    let Some(info) = guard.as_mut() else {
        return;
    };
    if info.peeked == peek_out {
        return;
    }
    let Ok(size) = window.outer_size() else {
        return;
    };

    let offset = (size.width as f64 * PEEK_RATIO).round() as i32;
    let x = if peek_out {
        match info.edge {
            Edge::Left => info.home.x - offset,
            Edge::Right => info.home.x + offset,
            _ => info.home.x,
        }
    } else {
        info.home.x
    };

    info.peeked = peek_out;
    #[cfg(debug_assertions)]
    eprintln!("[pet] peek out={peek_out} x={x} home={:?}", info.home);
    let _ = window.set_position(PhysicalPosition::new(x, info.home.y));
}

/// 启动时按上次贴的边还原。
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    if let Some(edge) = config::load_dock(app) {
        dock_to(app, edge);
    }
}

/// 换立绘风格时把桌宠窗口改成这套素材的尺寸。
///
/// 两套立绘构图差得远（Q 版 176²，写实 9 头身 172×340），窗口必须跟着换，
/// 否则 `object-fit: contain` 会在四周留出透明边，立绘看起来缩了一圈。
///
/// 锚点是**底边中点**：立绘站在桌面上，换风格时脚不该往上跳。
pub fn apply_style_size<R: Runtime>(app: &AppHandle<R>, style: crate::settings::PetStyle) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let (width, height) = style.window_size();

    let (Ok(old_pos), Ok(old_size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    if old_size.width == 0 || old_size.height == 0 {
        return;
    }
    if window.set_size(LogicalSize::new(width, height)).is_err() {
        return;
    }
    // 重新读一次实际尺寸：DPI 缩放下逻辑尺寸换算成物理像素会取整
    let Ok(new_size) = window.outer_size() else {
        return;
    };

    // 贴着边的时候交给吸附逻辑重算「家」——窗口变高后不重算就会压出屏幕
    if let Some(edge) = current(app).map(|info| info.edge) {
        dock_to(app, edge);
        return;
    }

    let mut x = old_pos.x + (old_size.width as i32 - new_size.width as i32) / 2;
    let mut y = old_pos.y + (old_size.height as i32 - new_size.height as i32);
    // 原来贴顶站着的话，变高之后 y 会是负的，按工作区收回来
    if let Some((ax, ay, aw, ah)) = work_area(&window) {
        x = clamp(x, ax, ax + aw - new_size.width as i32);
        y = clamp(y, ay, ay + ah - new_size.height as i32);
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
    config::save(app, WindowPos { x, y }, None);
}

pub fn emit_action<R: Runtime>(app: &AppHandle<R>, action: &str) {
    let _ = app.emit_to(MAIN_LABEL, EVENT_ACTION, action.to_string());
}

/// 把桌宠甩出去：松手时的速度决定滑多远，撞到工作区边缘会弹一下。
///
/// 速度单位是**像素/毫秒**，和前端从窗口位移算出来的一致。
/// 贴着边的时候直接忽略——贴边位置由吸附逻辑管，两套逻辑抢同一个坐标会抖。
pub fn throw<R: Runtime>(app: &AppHandle<R>, vx: f64, vy: f64) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    // 贴着边被拎起来甩也要能飞：先退掉贴边状态（会顺手把探头位置收回来），
    // 否则吸附逻辑记着的「家」还停在旧坐标上，落地后会被拽回去。
    if current(app).is_some() {
        undock(app);
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let Some((ax, ay, aw, ah)) = work_area(&window) else {
        return;
    };

    let bounds = crate::throw::Bounds {
        min_x: ax as f64,
        min_y: ay as f64,
        max_x: (ax + aw - size.width as i32) as f64,
        max_y: (ay + ah - size.height as i32) as f64,
    };
    let mut body = crate::throw::Body {
        x: pos.x as f64,
        y: pos.y as f64,
        vx,
        vy,
    }
    .clamped();

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut bounced = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            bounced |= crate::throw::step(&mut body, &bounds, 16.0);
            let _ = window.set_position(PhysicalPosition::new(
                body.x.round() as i32,
                body.y.round() as i32,
            ));
            if body.at_rest() {
                break;
            }
        }
        // 撞过边就让她委屈一下，直直滑停的只是「站住了」
        let _ = handle.emit_to(MAIN_LABEL, EVENT_LANDED, bounced);
    });
}

/// 挪到下一块显示器，摆在那块屏的右下角（和出厂位置一个习惯）。
///
/// 返回新显示器序号；只有一块屏时返回 `None`，菜单那边据此提示。
pub fn next_monitor<R: Runtime>(app: &AppHandle<R>) -> Option<usize> {
    let window = app.get_webview_window(MAIN_LABEL)?;
    let monitors = app.available_monitors().ok()?;
    if monitors.len() < 2 {
        return None;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return None;
    };

    let cx = pos.x + size.width as i32 / 2;
    let cy = pos.y + size.height as i32 / 2;
    let current_index = monitors
        .iter()
        .position(|monitor| {
            let p = monitor.position();
            let s = monitor.size();
            cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
        })
        .unwrap_or(0);
    let next = (current_index + 1) % monitors.len();

    let area = monitors[next].work_area();
    let margin = (EDGE_MARGIN * monitors[next].scale_factor()) as i32;
    let target = WindowPos {
        x: area.position.x + area.size.width as i32 - size.width as i32 - margin,
        y: area.position.y + area.size.height as i32 - size.height as i32 - margin,
    };

    // 先退掉贴边，否则吸附状态里的「家」还停在旧屏幕上
    undock(app);
    let _ = window.set_position(PhysicalPosition::new(target.x, target.y));
    config::save(app, target, None);
    Some(next)
}

/// 距屏幕边缘的初始留白（逻辑像素），和 window.rs 的出厂位置保持一致。
const EDGE_MARGIN: f64 = 24.0;

// ------------------------------------------------------------- Tauri 命令

#[tauri::command]
pub fn snap_pet(app: AppHandle) -> Option<Edge> {
    snap(&app)
}

#[tauri::command]
pub fn get_dock(app: AppHandle) -> Option<Edge> {
    current(&app).map(|info| info.edge)
}

#[tauri::command]
pub fn dock_pet(app: AppHandle, edge: Option<Edge>) {
    match edge {
        Some(edge) => dock_to(&app, edge),
        None => undock(&app),
    }
}

#[tauri::command]
pub fn pet_peek(app: AppHandle, peek_out: bool) {
    peek(&app, peek_out);
}

/// 让桌宠冒一句台词。
#[tauri::command]
pub fn pet_say(app: AppHandle, text: String) {
    crate::scheduler::say(&app, &text);
}

/// 甩出去（速度单位：像素/毫秒）。
#[tauri::command]
pub fn pet_throw(app: AppHandle, vx: f64, vy: f64) {
    throw(&app, vx, vy);
}

/// 换到下一块显示器；只有一块屏时返回 null。
#[tauri::command]
pub fn pet_next_monitor(app: AppHandle) -> Option<usize> {
    next_monitor(&app)
}

/// 叫回来：回到主屏右下角，并取消贴边。
#[tauri::command]
pub fn pet_home(app: AppHandle) {
    crate::window::go_home(&app);
}
