use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WindowEvent};

use crate::config::{self, WindowPos};

const WINDOW_LABEL: &str = "main";
/// 距屏幕边缘的初始留白（逻辑像素）
const EDGE_MARGIN: f64 = 24.0;
/// 停止移动多久后落盘
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);
/// 后台线程检查间隔
const TICK: Duration = Duration::from_millis(600);

/// 记录最近一次窗口移动，用于防抖保存。
#[derive(Default)]
pub struct MoveTracker(Mutex<Option<(Instant, WindowPos)>>);

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(MoveTracker::default());

    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(());
    };

    // 先定位再显示，避免启动时在默认位置闪一下
    let size = window.outer_size()?;
    #[cfg(debug_assertions)]
    if let Ok(Some(m)) = app.primary_monitor() {
        eprintln!(
            "[pet] outer_size={:?} monitor={:?}x{:?} scale={}",
            size,
            m.position(),
            m.size(),
            m.scale_factor()
        );
    }
    let pos = resolve_position(app, size);
    #[cfg(debug_assertions)]
    eprintln!("[pet] resolved={:?}", pos);
    window.set_position(PhysicalPosition::new(pos.x, pos.y))?;

    // WebView2 默认会画一层不透明底色（深色模式下尤其明显），
    // 显式设成全透明，否则立绘周围会出现一块矩形色块。
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

    window.show()?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(p) = event {
            if let Some(tracker) = handle.try_state::<MoveTracker>() {
                if let Ok(mut guard) = tracker.0.lock() {
                    *guard = Some((Instant::now(), WindowPos { x: p.x, y: p.y }));
                }
            }
        }
    });

    spawn_persister(app.clone());
    Ok(())
}

/// 防抖落盘：拖拽过程中不写文件，停手半秒后才写一次。
fn spawn_persister<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);

        let Some(tracker) = app.try_state::<MoveTracker>() else {
            break;
        };

        let pending = {
            let Ok(mut guard) = tracker.0.lock() else {
                continue;
            };
            match *guard {
                Some((at, pos)) if at.elapsed() >= SAVE_DEBOUNCE => {
                    *guard = None;
                    Some(pos)
                }
                _ => None,
            }
        };

        if let Some(pos) = pending {
            config::save(&app, pos);
        }
    });
}

fn resolve_position<R: Runtime>(app: &AppHandle<R>, size: PhysicalSize<u32>) -> WindowPos {
    if let Some(saved) = config::load(app) {
        // 上次可能在已拔掉的显示器上，落在屏幕外就回退到默认位置
        if is_on_screen(app, &saved, size) {
            return saved;
        }
    }
    default_position(app, size)
}

fn is_on_screen<R: Runtime>(app: &AppHandle<R>, pos: &WindowPos, size: PhysicalSize<u32>) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        pos.x + size.width as i32 > mp.x
            && pos.x < mp.x + ms.width as i32
            && pos.y + size.height as i32 > mp.y
            && pos.y < mp.y + ms.height as i32
    })
}

fn default_position<R: Runtime>(app: &AppHandle<R>, size: PhysicalSize<u32>) -> WindowPos {
    let fallback = WindowPos { x: 100, y: 100 };
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return fallback;
    };

    let mp = monitor.position();
    let ms = monitor.size();
    let margin = (EDGE_MARGIN * monitor.scale_factor()) as i32;

    WindowPos {
        x: mp.x + ms.width as i32 - size.width as i32 - margin,
        // 底部多留一些，避开任务栏
        y: mp.y + ms.height as i32 - size.height as i32 - margin * 4,
    }
}
