//! 搜索结果的应用图标 / 文件缩略图。
//!
//! 用 Shell 的 `IShellItemImageFactory`：一次调用就能拿到「有缩略图就给缩略图，
//! 没有就退回系统图标」，尺寸由我们定。这比 `SHGetFileInfoW` 强的地方在于图片会
//! 真的给缩略图，而不是一张通用的「图片」图标——这才是「用封面替换通用 icon」。
//!
//! 三条容易踩的：
//!
//! 1. **COM 必须先初始化**。命令走 `spawn_blocking`，在线程池线程上先
//!    `CoInitializeEx(APARTMENTTHREADED)`。线程可能已经被运行时初始化成 MTA，
//!    这时会返回 `RPC_E_CHANGED_MODE`：能继续用，但不能 `CoUninitialize`。
//! 2. `GetImage` 返回 **32bpp 预乘 alpha 的 HBITMAP**，`GetDIBits` 出来是 BGRA。
//!    要反预乘再换成 RGBA，否则透明边缘发黑、PNG 也编不对。
//! 3. 老式图标可能整张 alpha 都是 0（只有 mask），那就当不透明处理，
//!    否则前端拿到的是一张全透明的空图。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// 取多大。徽标显示 18–24px，48 够 2x 屏；再大只是白占内存。
const ICON_SIZE: i32 = 48;

/// 缓存上限。图标只有几 KB，但搜索词会一直换，别让它无限长。
const CACHE_LIMIT: usize = 512;

#[derive(Clone, Serialize)]
pub struct IconEntry {
    pub path: String,
    /// `data:image/png;base64,…`；`None` 表示取不到（就用前端的通用图标）
    pub icon: Option<String>,
}

static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 批量取图标。前端一次搜索最多二十来条，一次 IPC 拿完，省得每条都来回问。
#[tauri::command]
pub async fn search_icons(paths: Vec<String>) -> Vec<IconEntry> {
    tauri::async_runtime::spawn_blocking(move || icons_for(&paths))
        .await
        .unwrap_or_default()
}

pub fn icons_for(paths: &[String]) -> Vec<IconEntry> {
    let mut cache = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let missing: Vec<String> = paths
        .iter()
        .filter(|path| !cache.contains_key(*path))
        .cloned()
        .collect();

    if !missing.is_empty() {
        let initialized = win::init_com();
        for path in &missing {
            let icon = win::extract(path);
            cache.insert(path.clone(), icon);
        }
        if initialized {
            win::uninit_com();
        }

        if cache.len() > CACHE_LIMIT {
            // 只留下当前这一屏用得到的，别让缓存跟着搜索词一直涨
            cache.retain(|key, _| paths.iter().any(|path| path == key));
        }
    }

    paths
        .iter()
        .map(|path| IconEntry {
            path: path.clone(),
            icon: cache.get(path).cloned().flatten(),
        })
        .collect()
}

#[cfg(not(windows))]
mod win {
    pub fn init_com() -> bool {
        false
    }

    pub fn uninit_com() {}

    pub fn extract(_path: &str) -> Option<String> {
        None
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::mem::size_of;

    use base64::Engine;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT,
    };

    use super::ICON_SIZE;

    pub fn init_com() -> bool {
        // S_FALSE（已经初始化过）也算成功，配一次 CoUninitialize 正好抵掉；
        // RPC_E_CHANGED_MODE 说明线程是 MTA，继续用但不要反初始化。
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().is_ok() }
    }

    pub fn uninit_com() {
        unsafe { CoUninitialize() };
    }

    pub fn extract(path: &str) -> Option<String> {
        let factory: IShellItemImageFactory = unsafe {
            SHCreateItemFromParsingName(&HSTRING::from(path), None::<&IBindCtx>).ok()?
        };
        let bitmap = unsafe {
            factory
                .GetImage(
                    SIZE {
                        cx: ICON_SIZE,
                        cy: ICON_SIZE,
                    },
                    SIIGBF_RESIZETOFIT,
                )
                .ok()?
        };

        let png = unsafe { bitmap_to_png(bitmap) };
        unsafe {
            let _ = DeleteObject(bitmap.into());
        }

        let png = png?;
        let mut url = String::from("data:image/png;base64,");
        base64::engine::general_purpose::STANDARD.encode_string(png, &mut url);
        Some(url)
    }

    /// HBITMAP → PNG。拿到的是 32bpp 预乘 BGRA，处理见文件头第 2、3 条。
    unsafe fn bitmap_to_png(bitmap: HBITMAP) -> Option<Vec<u8>> {
        let mut info = BITMAP::default();
        if unsafe {
            GetObjectW(
                HGDIOBJ(bitmap.0),
                size_of::<BITMAP>() as i32,
                Some(&mut info as *mut _ as *mut c_void),
            )
        } == 0
        {
            return None;
        }

        let width = info.bmWidth;
        let height = info.bmHeight;
        if width <= 0 || height <= 0 {
            return None;
        }

        let dc = unsafe { GetDC(None) };
        if dc.is_invalid() {
            return None;
        }

        let mut header = BITMAPINFO::default();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // 负数 = 从上到下，省得自己再翻一遍
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };

        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = unsafe {
            GetDIBits(
                dc,
                bitmap,
                0,
                height as u32,
                Some(pixels.as_mut_ptr() as *mut c_void),
                &mut header,
                DIB_RGB_COLORS,
            )
        };
        unsafe { ReleaseDC(None, dc) };
        if lines == 0 {
            return None;
        }

        // 有任一像素带 alpha 就当它真的带透明度；全 0 是只有 mask 的老图标
        let has_alpha = pixels.chunks_exact(4).any(|px| px[3] != 0);
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2); // BGRA → RGBA
            if !has_alpha {
                px[3] = 255;
                continue;
            }
            let alpha = px[3] as u32;
            if alpha == 0 {
                px[0] = 0;
                px[1] = 0;
                px[2] = 0;
            } else if alpha < 255 {
                // 预乘 → 直通；不反预乘的话透明边缘会发黑
                px[0] = ((px[0] as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
                px[1] = ((px[1] as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
                px[2] = ((px[2] as u32 * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }

        let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut out, image::ImageFormat::Png)
            .ok()?;
        Some(out.into_inner())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use base64::Engine;

    fn decode(url: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(url.trim_start_matches("data:image/png;base64,"))
            .unwrap()
    }

    #[test]
    fn shell_gives_a_file_an_icon() {
        let dir = crate::testutil::TempDir::new("icon");
        let file = dir.join("demo.txt");
        std::fs::write(&file, b"hello").unwrap();

        let entries = icons_for(&[file.to_string_lossy().into_owned()]);
        let url = entries[0].icon.as_deref().expect("txt 应该能拿到系统图标");
        let png = decode(url);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(png.len() > 200, "图标不该是一张空 PNG");
    }

    /// 手动看一眼真实图标有没有取错（快捷方式上的小箭头、图片缩略图、透明边）。
    ///
    ///   cargo test --lib dump_real_icons -- --ignored
    ///
    /// 输出在 `%TEMP%\whale-icons\`，看完可以删。
    #[test]
    #[ignore = "输出到 %TEMP% 供人工检查，正常测试不跑"]
    fn dump_real_icons() {
        let dir = std::env::temp_dir().join("whale-icons");
        std::fs::create_dir_all(&dir).unwrap();

        let mut paths = vec![
            r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Android Studio\Android Studio.lnk"
                .to_string(),
            r"C:\Windows\System32\notepad.exe".to_string(),
        ];

        // 造一张彩色图，验证「文件拿到的是缩略图而不是通用图片图标」
        let sample = image::RgbaImage::from_fn(64, 64, |x, y| {
            image::Rgba([(x * 4) as u8, (y * 4) as u8, 180, 255])
        });
        let sample_path = dir.join("sample.png");
        sample.save(&sample_path).unwrap();
        paths.push(sample_path.to_string_lossy().into_owned());

        for entry in icons_for(&paths) {
            let Some(url) = entry.icon else {
                eprintln!("[icons] 取不到：{}", entry.path);
                continue;
            };
            let name = std::path::Path::new(&entry.path)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| "icon".to_string());
            std::fs::write(dir.join(format!("{name}.png")), decode(&url)).unwrap();
            eprintln!("[icons] OK：{}", entry.path);
        }
        eprintln!("[icons] 输出目录：{}", dir.display());
    }
}
