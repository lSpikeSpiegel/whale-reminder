//! 全屏截图浮层。
//!
//! 二维码助手的「框选」和颜色转换的「吸管」是同一件事的两半：
//! 藏面板 → 抓一张当前屏幕 → 铺一个满屏窗口把这张图当底图 → 用户在图上点/拖 →
//! 窗口关掉、面板回来。差别只在窗口里画什么、回传什么。
//!
//! 所以抓屏、建窗口、收尾这些坑只写一份，两个工具各自只留自己的业务。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::error::{AppError, AppResult};

const PANEL_LABEL: &str = "panel";

/// 面板隐藏到屏幕真正重绘之间的等待。
///
/// `hide()` 只是把窗口标记成不可见，桌面要等下一帧合成才会补上那块区域；
/// 立刻抓屏会连面板一起抓下来。
const REPAINT_WAIT: Duration = Duration::from_millis(140);

/// 抓屏失败时推给面板：面板此时是藏着的，只能靠事件把话说回去。
pub const EVENT_ERROR: &str = "overlay://error";

/// 一次浮层用的截图。`png` 给前端当底图，`rgba` 留给后端裁剪/取色。
pub struct Frame {
    png: Vec<u8>,
    rgba: Arc<RgbaImage>,
}

#[derive(Default)]
pub struct OverlayState(Mutex<Option<Frame>>);

/// 浮层要的底图。只取一次，之后都走各自的「选完了」命令。
#[derive(serde::Serialize)]
pub struct FrameView {
    /// `data:image/png;base64,...`，直接塞给 `<img src>`
    pub image: String,
    pub width: u32,
    pub height: u32,
}

/// 截图对应的那块屏幕（物理像素）。
struct Geo {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    scale: f32,
}

/// 打开浮层。
///
/// `label` 是窗口 label（`scan` / `pick`），`view` 是前端路由（`index.html?view=xxx`）。
/// 同步返回，真正的抓屏和建窗口都在后台线程里做——抓一张 4K 屏 + 编码 PNG 要几百毫秒，
/// 占着命令线程会让面板卡一下才收起，用户会以为点了没反应。
pub fn start<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    view: &str,
    title: &str,
) -> AppResult<()> {
    if let Some(window) = app.get_webview_window(label) {
        // 已经在用了，再点一次就当「把浮层叫到前面」
        let _ = window.set_focus();
        return Ok(());
    }

    // 面板必须先进截图之前藏起来
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.hide();
    }

    let handle = app.clone();
    let label = label.to_owned();
    let view = view.to_owned();
    let title = title.to_owned();

    std::thread::spawn(move || {
        if let Err(err) = capture_and_open(&handle, &label, &view, &title) {
            // 面板此时是藏着的，只能先叫回来再把话说出去
            restore_panel(&handle);
            let _ = handle.emit(EVENT_ERROR, err.to_string());
        }
    });

    Ok(())
}

pub fn frame<R: Runtime>(app: &AppHandle<R>) -> AppResult<FrameView> {
    let state = app
        .try_state::<OverlayState>()
        .ok_or_else(|| AppError::Other("截图模块没初始化".into()))?;
    let guard = state
        .0
        .lock()
        .map_err(|_| AppError::Other("截图数据异常，请重试".into()))?;
    let frame = guard
        .as_ref()
        .ok_or_else(|| AppError::Other("截图已失效，请重试".into()))?;

    Ok(FrameView {
        image: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&frame.png)
        ),
        width: frame.rgba.width(),
        height: frame.rgba.height(),
    })
}

/// 拿整屏像素做裁剪/取色。浮层已经关了会报错，调用方照常提示用户重来。
pub fn rgba<R: Runtime>(app: &AppHandle<R>) -> AppResult<Arc<RgbaImage>> {
    let state = app
        .try_state::<OverlayState>()
        .ok_or_else(|| AppError::Other("截图模块没初始化".into()))?;
    let guard = state
        .0
        .lock()
        .map_err(|_| AppError::Other("截图数据异常，请重试".into()))?;
    guard
        .as_ref()
        .map(|frame| frame.rgba.clone())
        .ok_or_else(|| AppError::Other("截图已失效，请重试".into()))
}

/// 关掉浮层。两个浮层共用一套收尾逻辑，谁在关谁。
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    let mut closed = false;
    for label in ["scan", "pick"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
            closed = true;
        }
    }
    // 窗口不在了（比如已经自己关掉）就直接把面板叫回来
    if !closed {
        restore_panel(app);
    }
}

pub fn restore_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(panel) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let _ = panel.show();
    let _ = panel.set_focus();
}

/* ------------------------------------------------------------------ 抓屏 / 建窗口 */

fn capture_and_open<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    view: &str,
    title: &str,
) -> AppResult<()> {
    std::thread::sleep(REPAINT_WAIT);

    let (frame, geo) = grab(app)?;

    {
        let state = app
            .try_state::<OverlayState>()
            .ok_or_else(|| AppError::Other("截图模块没初始化".into()))?;
        let mut guard = state
            .0
            .lock()
            .map_err(|_| AppError::Other("截图数据异常".into()))?;
        *guard = Some(frame);
    }

    create_window(app, &geo, label, view, title)
}

fn grab<R: Runtime>(app: &AppHandle<R>) -> AppResult<(Frame, Geo)> {
    // 抓鼠标所在的那块屏幕：多屏时用户想取的通常就在鼠标这一屏，
    // 而铺满整个虚拟桌面会让不同 DPI 的屏幕拼在一张图里，缩放对不齐。
    let cursor = app
        .cursor_position()
        .map_err(|err| AppError::Other(format!("读不到鼠标位置：{err}")))?;
    let monitor = xcap::Monitor::from_point(cursor.x.round() as i32, cursor.y.round() as i32)
        .map_err(|err| AppError::Other(format!("找不到鼠标所在的屏幕：{err}")))?;

    let image = monitor
        .capture_image()
        .map_err(|err| AppError::Other(format!("截屏失败：{err}")))?;

    let geo = Geo {
        x: monitor.x().unwrap_or(0),
        y: monitor.y().unwrap_or(0),
        w: image.width(),
        h: image.height(),
        scale: monitor.scale_factor().unwrap_or(1.0),
    };

    let png = encode_png(&image)?;
    Ok((
        Frame {
            png,
            rgba: Arc::new(image),
        },
        geo,
    ))
}

fn encode_png(image: &RgbaImage) -> AppResult<Vec<u8>> {
    let mut buffer = Vec::new();
    // Fast 而不是默认压缩：这张图只当底图，压得慢一点换来几百毫秒延迟不值
    PngEncoder::new_with_quality(&mut buffer, CompressionType::Fast, FilterType::Sub)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|err| AppError::Other(format!("截屏编码失败：{err}")))?;
    Ok(buffer)
}

fn create_window<R: Runtime>(
    app: &AppHandle<R>,
    geo: &Geo,
    label: &str,
    view: &str,
    title: &str,
) -> AppResult<()> {
    let scale = if geo.scale > 0.5 {
        f64::from(geo.scale)
    } else {
        1.0
    };

    // 位置和尺寸都按逻辑像素给一份「初值」，窗口一出来就用物理像素钉死——
    // 混合 DPI 下逻辑换算会差几像素，而浮层必须和底图严丝合缝。
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?view={view}").into()),
    )
    .title(title)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(true)
    // visible(true) 要在 build 时给，建完再 show() 在 Windows 上经常不生效
    .visible(true)
    .position(f64::from(geo.x) / scale, f64::from(geo.y) / scale)
    .inner_size(f64::from(geo.w) / scale, f64::from(geo.h) / scale)
    .build()
    .map_err(|err| AppError::Other(format!("打不开浮层窗口：{err}")))?;

    // conf 里没有这些窗口，WebView2 的默认底色得自己抹掉，否则会露出白底
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

    // resizable:false 的窗口在 Windows 上会被忽略 set_size，先放开再锁回去
    let _ = window.set_resizable(true);
    let _ = window.set_position(PhysicalPosition::new(geo.x, geo.y));
    let _ = window.set_size(PhysicalSize::new(geo.w, geo.h));
    let _ = window.set_resizable(false);
    let _ = window.set_focus();

    attach_restore(window);
    Ok(())
}

/// 浮层一消失就把面板叫回来。
///
/// 挂在 `Destroyed` 上而不是只写在关闭命令里：Esc、点外面、Alt+F4，
/// 任何关法都会走窗口销毁，面板不会因为「浮层没了」而永远藏着。
fn attach_restore<R: Runtime>(window: tauri::WebviewWindow<R>) {
    let handle = window.app_handle().clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        // 整屏 PNG 别留着，几 MB 到几十 MB 常驻没意义
        if let Some(state) = handle.try_state::<OverlayState>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = None;
            }
        }
        restore_panel(&handle);
    });
}

/* ------------------------------------------------------------------ 命令 */

/// 浮层挂载后取底图。两个浮层共用。
#[tauri::command]
pub fn overlay_frame(app: AppHandle) -> AppResult<FrameView> {
    frame(&app)
}

/// 关掉浮层（取消 / 选完）。面板由 `Destroyed` 里的钩子叫回来。
#[tauri::command]
pub fn overlay_close(app: AppHandle) {
    close(&app);
}
