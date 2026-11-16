//! 二维码助手：两件事——把屏幕上的码认出来，把一段文字变成码。
//!
//! 抓屏和浮层窗口是 `overlay.rs` 的活（颜色转换的吸管也用它），这里只管二维码：
//!
//! 1. 面板点「开始框选」→ `scan_start` → `overlay::start("scan")`。
//! 2. 浮层挂载后取 `overlay_frame` 拿到整屏 PNG 当底图，用户在图上拖一个框，
//!    只把**归一化后的比例**发回来（`scan_pick`）——不同 DPI 下窗口尺寸和图片
//!    尺寸不一定是 1:1，用比例换算才不会被缩放带偏。
//! 3. 解码成功后浮层显示结果卡；关掉浮层时面板由 overlay 的 `Destroyed` 钩子叫回来。
//!
//! 生成走 `qr_encode`：只回模块矩阵（0/1 串），画成图片是前端 canvas 的事，
//! 这样同一个矩阵既能上屏又能直接导出，不用在 Rust 里编 PNG。

use base64::Engine as _;
use image::RgbaImage;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// 最近识别保留多少条
const HISTORY_LIMIT: usize = 20;

/// 框选小于这个尺寸就没必要送去识别了（ZXing 也认不出来，只会白等）
const MIN_SIDE: f64 = 8.0;

/// 一条识别记录。字段名直接给前端用，别改名。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ScanEntry {
    pub id: String,
    pub text: String,
    /// ZXing 的格式名，比如 `QR_CODE` / `EAN_13`；中文说法在前端映射
    pub format: String,
    /// UTC RFC3339
    pub at: String,
}

/* ------------------------------------------------------------------ 历史记录 */

fn history_path() -> std::path::PathBuf {
    crate::db::data_dir().join("scans.json")
}

fn load_history() -> Vec<ScanEntry> {
    std::fs::read(history_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_history(list: &[ScanEntry]) {
    let path = history_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(list) {
        let _ = std::fs::write(path, bytes);
    }
}

fn push_history(entry: ScanEntry) {
    let mut list = load_history();
    list.insert(0, entry);
    list.truncate(HISTORY_LIMIT);
    save_history(&list);
}

/* ------------------------------------------------------------------ 命令 */

/// 开始框选。抓屏和建窗口都由 `overlay` 在后台线程里做，这里只发起。
#[tauri::command]
pub fn scan_start(app: AppHandle) -> AppResult<()> {
    crate::overlay::start(&app, "scan", "scan", "二维码助手")
}

/// 框选完成：按比例裁一块出来识别。
///
/// 参数是**归一化比例**（0..1），不是像素：浮层窗口的内尺寸受 DPI 影响，
/// 和截图的物理像素不一定相等，用比例换算两边都对齐。
#[tauri::command]
pub async fn scan_pick(
    app: AppHandle,
    fx: f64,
    fy: f64,
    fw: f64,
    fh: f64,
) -> AppResult<ScanEntry> {
    let image = crate::overlay::rgba(&app)?;

    let rect = to_pixels(&image, fx, fy, fw, fh)?;

    // 解码是纯 CPU 活，几百毫秒起步。命令是 async 的，跑在运行时线程池上，
    // 不会把浮层的界面卡住。
    let Some((text, format)) = decode(&image, rect) else {
        return Err(AppError::Other("没认出码，框得紧一点再试".into()));
    };

    let entry = ScanEntry {
        id: crate::db::new_id(),
        text,
        format,
        at: crate::db::now_iso(),
    };
    push_history(entry.clone());
    Ok(entry)
}

#[tauri::command]
pub fn scan_history() -> Vec<ScanEntry> {
    load_history()
}

#[tauri::command]
pub fn scan_forget(id: String) -> Vec<ScanEntry> {
    let mut list = load_history();
    list.retain(|entry| entry.id != id);
    save_history(&list);
    list
}

#[tauri::command]
pub fn scan_clear_history() -> Vec<ScanEntry> {
    save_history(&[]);
    Vec::new()
}

/* ------------------------------------------------------------------ 生成二维码 */

/// 一段文字编出来的模块矩阵（不含四周静区）。
///
/// 不直接给图片：矩阵交给前端 canvas 画，屏幕上是矢量般的锐利，
/// 要复制、要另存也都在同一个 canvas 上取，不用在 Rust 里再编一遍 PNG。
#[derive(serde::Serialize)]
pub struct QrMatrix {
    /// 边长（模块数）
    pub size: u32,
    /// 行优先的 `'0'`/`'1'` 串，`'1'` 是黑块
    pub modules: String,
}

#[tauri::command]
pub fn qr_encode(text: String) -> AppResult<QrMatrix> {
    use rxing::Writer as _;

    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Invalid("先写点内容再生成".into()));
    }
    // 版本 40 的 L 级也只装得下约 2900 字节，一千字已经远远够用
    if text.chars().count() > 1_000 {
        return Err(AppError::Invalid("内容太长了，一千字以内比较稳".into()));
    }

    let mut hints = rxing::EncodeHints::default();
    // 静区由前端补（渲染时四周各留 4 个模块），这里只要模块本体
    hints.Margin = Some("0".into());
    // M 级容错：贴屏幕上被拍照、被压缩都还扫得出来，又不会把码撑太大
    hints.ErrorCorrection = Some("M".into());

    // 宽高传 0 + 静区 0，出来的就是「1 像素 = 1 模块」的原始矩阵
    let matrix = rxing::qrcode::QRCodeWriter
        .encode_with_hints(text, &rxing::BarcodeFormat::QR_CODE, 0, 0, &hints)
        .map_err(|err| AppError::Other(format!("生成失败：{err}")))?;

    let (width, height) = (matrix.width(), matrix.height());
    let mut modules = String::with_capacity((width * height) as usize);
    for y in 0..height {
        for x in 0..width {
            modules.push(if matrix.get(x, y) { '1' } else { '0' });
        }
    }

    Ok(QrMatrix {
        size: width,
        modules,
    })
}

/// 把前端画好的 PNG（base64，不带 `data:` 前缀）落到「图片/Whale Reminder」下。
///
/// 复制图片走的是系统剪贴板，某些环境不给写；存文件是那条路走不通时的退路，
/// 也顺便让用户有个能发给别人的东西。
#[tauri::command]
pub fn save_qr_image(app: AppHandle, data: String) -> AppResult<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|err| AppError::Other(format!("图片数据损坏：{err}")))?;

    let dir = app
        .path()
        .picture_dir()
        .map_err(|err| AppError::Other(format!("找不到图片文件夹：{err}")))?
        .join("Whale Reminder");
    std::fs::create_dir_all(&dir)?;

    let name = format!(
        "二维码-{}.png",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    );
    let path = dir.join(name);
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ 解码 */

struct Rect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

fn to_pixels(image: &RgbaImage, fx: f64, fy: f64, fw: f64, fh: f64) -> AppResult<Rect> {
    let (iw, ih) = (f64::from(image.width()), f64::from(image.height()));

    let x = (fx.clamp(0.0, 1.0) * iw).round().clamp(0.0, iw);
    let y = (fy.clamp(0.0, 1.0) * ih).round().clamp(0.0, ih);
    // 起点先夹住，宽高再按剩余空间收一次，免得右下角越界
    let w = (fw.clamp(0.0, 1.0) * iw).round().min(iw - x);
    let h = (fh.clamp(0.0, 1.0) * ih).round().min(ih - y);

    if w < MIN_SIDE || h < MIN_SIDE {
        return Err(AppError::Invalid("框选区域太小了".into()));
    }

    Ok(Rect {
        x: x as u32,
        y: y as u32,
        w: w as u32,
        h: h as u32,
    })
}

/// 裁一块 → 逐级放大重试。
///
/// 一维码和远处的小二维码在原尺寸下模块可能只有一两个像素，ZXing 直接放弃；
/// 放大两倍、三倍往往就认出来了。放大只重采样亮度，不重新解码整屏。
fn decode(image: &RgbaImage, rect: Rect) -> Option<(String, String)> {
    let crop = image::imageops::crop_imm(image, rect.x, rect.y, rect.w, rect.h).to_image();

    let mut hints = rxing::DecodeHints::default();
    // 深色模式里常见「白码黑底」，正着认不出来就反过来再认一次
    hints.AlsoInverted = Some(true);

    for scale in [1u32, 2, 3] {
        let (w, h) = (crop.width() * scale, crop.height() * scale);
        // 再大就不是「小码」而是「大图」了，放大只会拖慢解码
        if w.max(h) > 2_600 {
            break;
        }

        let luma = to_luma(&crop, scale);
        if let Ok(result) =
            rxing::helpers::detect_in_luma_slice_with_hints(&luma, w, h, None, &mut hints)
        {
            return Some((
                result.getText().to_owned(),
                result.getBarcodeFormat().to_string(),
            ));
        }
    }

    None
}

/// RGBA → 灰度，顺便按 `scale` 最近邻放大（ZXing 只吃单通道）。
fn to_luma(image: &RgbaImage, scale: u32) -> Vec<u8> {
    let (w, h) = (image.width(), image.height());
    let mut out = Vec::with_capacity(((w * scale) * (h * scale)) as usize);

    for y in 0..h * scale {
        let sy = y / scale;
        for x in 0..w * scale {
            let pixel = image.get_pixel(x / scale, sy);
            // BT.601 亮度，和 ZXing 自己的取法一致
            let luma = (u32::from(pixel[0]) * 299
                + u32::from(pixel[1]) * 587
                + u32::from(pixel[2]) * 114)
                / 1000;
            out.push(luma as u8);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把「哪些格子是黑的」铺成一张白底黑块图，静区按 `quiet` 个格子补边。
    /// 解码测试用它把生成的矩阵还原成位图，不用往仓库里塞图片。
    fn raster(
        size: (u32, u32),
        dark: impl Fn(u32, u32) -> bool,
        scale: u32,
        quiet: u32,
    ) -> RgbaImage {
        let (w, h) = size;
        let mut image = RgbaImage::from_pixel(
            (w + quiet * 2) * scale,
            (h + quiet * 2) * scale,
            image::Rgba([255, 255, 255, 255]),
        );
        for y in 0..h {
            for x in 0..w {
                if !dark(x, y) {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        image.put_pixel(
                            (x + quiet) * scale + dx,
                            (y + quiet) * scale + dy,
                            image::Rgba([0, 0, 0, 255]),
                        );
                    }
                }
            }
        }
        image
    }

    #[test]
    fn ratio_maps_to_full_image() {
        let image = RgbaImage::new(200, 100);
        let rect = to_pixels(&image, 0.0, 0.0, 1.0, 1.0).expect("整屏");
        assert_eq!((rect.x, rect.y, rect.w, rect.h), (0, 0, 200, 100));
    }

    #[test]
    fn ratio_crops_the_requested_box() {
        let image = RgbaImage::new(200, 100);
        let rect = to_pixels(&image, 0.25, 0.5, 0.5, 0.5).expect("中间那块");
        assert_eq!((rect.x, rect.y, rect.w, rect.h), (50, 50, 100, 50));
    }

    #[test]
    fn box_never_leaves_the_image() {
        let image = RgbaImage::new(200, 100);
        let rect = to_pixels(&image, 0.9, 0.9, 0.5, 0.5).expect("越界要收回来");
        assert_eq!(rect.x + rect.w, 200);
        assert_eq!(rect.y + rect.h, 100);
    }

    #[test]
    fn tiny_box_is_rejected() {
        let image = RgbaImage::new(200, 100);
        assert!(to_pixels(&image, 0.5, 0.5, 0.01, 0.01).is_err());
    }

    #[test]
    fn luma_upscale_repeats_pixels() {
        let mut image = RgbaImage::new(2, 1);
        image.put_pixel(0, 0, image::Rgba([0, 0, 0, 255]));
        image.put_pixel(1, 0, image::Rgba([255, 255, 255, 255]));
        // 2×1 放大两倍 = 4×2：每一行都把原像素各重复一遍
        assert_eq!(to_luma(&image, 2), vec![0, 0, 255, 255, 0, 0, 255, 255]);
    }

    /// 生成 → 上屏 → 再认回来。这条走通了，「文字转二维码」和「扫码」就是一套东西。
    #[test]
    fn generated_qr_decodes_back() {
        let matrix = qr_encode("https://example.com/whale".into()).expect("生成二维码");
        let side = matrix.size;
        let modules = matrix.modules.as_bytes();

        let image = raster(
            (side, side),
            |x, y| modules[(y * side + x) as usize] == b'1',
            4,
            4,
        );
        let (text, format) = decode(
            &image,
            Rect {
                x: 0,
                y: 0,
                w: image.width(),
                h: image.height(),
            },
        )
        .expect("认出来");

        assert_eq!(text, "https://example.com/whale");
        assert_eq!(format, "qrcode");
    }

    /// 一维码也要能认——扫码框里框住一条 EAN/Code128 是很常见的场景。
    #[test]
    fn generated_code128_decodes_back() {
        use rxing::Writer as _;

        let matrix = rxing::oned::Code128Writer
            .encode("WHALE-2026", &rxing::BarcodeFormat::CODE_128, 420, 120)
            .expect("生成一维码");
        let (w, h) = (matrix.width(), matrix.height());

        let image = raster((w, h), |x, y| matrix.get(x, y), 1, 12);
        let (text, format) = decode(
            &image,
            Rect {
                x: 0,
                y: 0,
                w: image.width(),
                h: image.height(),
            },
        )
        .expect("认出来");

        assert_eq!(text, "WHALE-2026");
        assert_eq!(format, "code 128");
    }
}
