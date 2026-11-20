//! 图片处理工具的落盘侧：读一张图、扫一个文件夹、把处理结果存回去。
//!
//! **压缩、裁剪、转格式都不在这里**——那些交给 canvas：浏览器自带解码器和编码器，
//! 引一套 Rust 图像库（image / oxipng / libwebp）要编半天、体积也大，而这个面板
//! 只做「随手压一下」，canvas 的 `toBlob` 已经够了。
//!
//! 这里只干三件前端干不了的事：读文件、列文件夹、写文件（含原地替换）。

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 一张图的上限。40MB 足够涵盖相机直出的单张，再大就是「是不是拖错文件了」，
/// 而且 base64 过来还要在内存里翻一倍多。
const MAX_BYTES: u64 = 40 * 1024 * 1024;

/// 认得的扩展名。只用来做一道粗筛，真正的解码在 canvas 那边
const IMAGE_EXT: [&str; 6] = ["jpg", "jpeg", "png", "webp", "bmp", "gif"];

/// 一个文件夹最多收多少张。
///
/// 这些图不是一次读进来的（前端一张一张读、处理完就丢），所以内存压力不大，
/// 真正的限制是时间：一张 4K 要几百毫秒，500 张就是好几分钟。200 张已经够
/// 「一次整理一批图」了，再多请分几次来。
const MAX_FOLDER_ITEMS: usize = 200;

/// 读给前端的图：文件名 + 字节数 + base64。前端拿它建 Blob，再丢给 createImageBitmap。
#[derive(Debug, Serialize)]
pub struct ImageFile {
    pub name: String,
    /// 小写扩展名（`jpg` / `png`…），前端据此决定「保持原格式」是哪个
    pub ext: String,
    /// 原始字节数，用来说明「原图多大」
    pub size: u64,
    /// base64（标准字母表，不带换行）
    pub data: String,
}

/// 文件夹里的一张图，只给路径和大小——真要处理时前端再一张张读。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageBrief {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// 拖进来的东西：一张图（带数据），或者一个文件夹（只带清单）。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Opened {
    Image {
        file: ImageFile,
    },
    Folder {
        name: String,
        items: Vec<ImageBrief>,
        /// 文件夹里总共有多少张。超过上限时前端要如实说「先处理前 N 张」
        total: usize,
    },
}

/// 输出目录的兜底位置：`图片\Whale Reminder`。
///
/// 拖进来的图片有源目录，就存在图片旁边；用「选择图片」挑的（WebView 不给路径）
/// 没地方可回，统一落到这里——比存到桌面更不容易被当成垃圾删掉。
fn fallback_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Pictures")
        .join("Whale Reminder")
}

fn lower_ext(path: &Path) -> String {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_image(path: &Path) -> bool {
    IMAGE_EXT.contains(&lower_ext(path).as_str())
}

/// 文件名里的非法字符换掉。
///
/// 这个值来自前端拼出来的「原名-1920x1080」，理论上很干净，但它最终会变成
/// 磁盘上的一个路径：`..`、`/`、`:` 只要漏一个就能写到别处去，所以在 Rust 这一侧
/// 再收一遍口——**永远不要相信调用方传来的文件名**。
fn sanitize_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_control() || "\\/:*?\"<>|".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();

    // Windows 上结尾的点和空格会被静默吃掉，留下的名字和预期不一样
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    // 文件名过长在 Windows 上直接失败，80 个字符够表达「原名 + 尺寸」
    let capped: String = trimmed.chars().take(80).collect();
    if capped.is_empty() {
        "image".to_owned()
    } else {
        capped
    }
}

fn sanitize_ext(ext: &str) -> AppResult<String> {
    let ext = ext.trim().trim_start_matches('.').to_lowercase();
    // `jpeg` 和 `jpg` 是同一个东西，统一成 jpg 免得同一张图存出两个后缀
    let ext = if ext == "jpeg" { "jpg".to_owned() } else { ext };
    if matches!(ext.as_str(), "jpg" | "png" | "webp") {
        Ok(ext)
    } else {
        Err(AppError::Invalid(format!("不支持的输出格式：{ext}")))
    }
}

/// 挑一个不撞的路径：`名字.jpg` 占了就 `名字 (2).jpg`。
///
/// 不覆盖是有意的：用户可能刚处理完一张又要换个质量再存一次，
/// 悄悄盖掉上一版等于把「对比一下」这件事废掉。
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for index in 2..1000 {
        let candidate = dir.join(format!("{stem} ({index}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 一千个同名文件还撞，多半是有别的东西在捣乱：带上时刻，至少不会失败
    dir.join(format!(
        "{stem}-{}.{ext}",
        chrono::Local::now().format("%H%M%S")
    ))
}

/// 原地替换要写到哪、写完要不要删原文件。
///
/// 同格式（jpg → jpg）就是覆盖同一个路径；换格式（png → jpg）要写到新名字，
/// 再把原来那个删掉——留着两个同名不同后缀的图，下次拖进来会让人分不清哪个是新的。
fn replace_target(origin: &Path, ext: &str) -> (PathBuf, bool) {
    let target = origin.with_extension(ext);
    let needs_cleanup = target != origin;
    (target, needs_cleanup)
}

/// 读一张图（内部用，命令再包一层）。`image_open` 和 `image_read` 共用它。
fn read_image(target: &Path) -> AppResult<ImageFile> {
    if !target.is_file() {
        return Err(AppError::NotFound(format!("{} 不在了", target.display())));
    }
    if !is_image(target) {
        return Err(AppError::Invalid("这不是图片，或者格式认不出来".into()));
    }

    let meta = std::fs::metadata(target)?;
    if meta.len() > MAX_BYTES {
        return Err(AppError::Invalid(format!(
            "图片太大（{}），{} 以内的才处理得了",
            human_size(meta.len()),
            human_size(MAX_BYTES)
        )));
    }

    let bytes = std::fs::read(target)?;
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".to_owned());

    Ok(ImageFile {
        name,
        ext: lower_ext(target),
        size: meta.len(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// 列一个文件夹里的图片（**只看第一层**）。
///
/// 不递归：递归一次可能几百张，面板会长时间转圈，而且用户拖文件夹时想的多半是
/// 「这一层这批图」。要处理子目录就一次拖一个。
fn collect_images(dir: &Path) -> Vec<ImageBrief> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut items: Vec<ImageBrief> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_image(path))
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some(ImageBrief {
                name: path.file_name()?.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                size: meta.len(),
            })
        })
        .collect();

    // 按文件名排：资源管理器里看到的顺序，处理进度才对得上
    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    items
}

/// 打开拖进来的东西：是文件夹就回清单，是图片就回数据。
///
/// 合成一个命令（而不是让前端先 stat 再决定）：判断放在有文件系统的那一侧更可靠，
/// 前端也不必为了知道「这是不是文件夹」多打一次 IPC。
#[tauri::command]
pub fn image_open(path: String) -> AppResult<Opened> {
    let target = PathBuf::from(path.trim());

    if target.is_dir() {
        let all = collect_images(&target);
        if all.is_empty() {
            return Err(AppError::NotFound("这个文件夹里（第一层）没有图片".into()));
        }
        let total = all.len();
        return Ok(Opened::Folder {
            name: target
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| target.to_string_lossy().into_owned()),
            items: all.into_iter().take(MAX_FOLDER_ITEMS).collect(),
            total,
        });
    }

    Ok(Opened::Image {
        file: read_image(&target)?,
    })
}

/// 读一张图。批量处理时前端按路径一张张要，就是这么来的。
#[tauri::command]
pub fn image_read(path: String) -> AppResult<ImageFile> {
    read_image(&PathBuf::from(path.trim()))
}

/// 存一份处理结果，返回落盘的绝对路径。
///
/// 两种存法：
/// - `replace = false`：另存一份。存到原图旁边（拖进来的才有源目录），名字重了自动
///   `名字 (2).jpg`，不覆盖；
/// - `replace = true`：**原地替换**。同格式覆盖原路径；换格式写到新后缀再把原文件删掉
///   （先写成功再删，写失败时原图还在）。
#[tauri::command]
pub fn image_save(
    source: Option<String>,
    name: String,
    ext: String,
    data: String,
    replace: bool,
) -> AppResult<String> {
    // 先按「编码后长度」粗算一遍，避免把一个几百 MB 的字符串解开再拒绝
    if data.len() as u64 > MAX_BYTES * 2 {
        return Err(AppError::Invalid("图片太大，处理不了".into()));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|err| AppError::Invalid(format!("图片数据坏了：{err}")))?;
    if bytes.is_empty() {
        return Err(AppError::Invalid("没有可保存的图片".into()));
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AppError::Invalid(format!(
            "结果太大（{}），存不下",
            human_size(bytes.len() as u64)
        )));
    }

    let ext = sanitize_ext(&ext)?;
    let origin = source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    if replace {
        let Some(origin) = origin else {
            return Err(AppError::Invalid("这张图没有原路径，只能另存".into()));
        };
        if !origin.is_file() {
            return Err(AppError::NotFound(format!(
                "{} 已经不在了",
                origin.display()
            )));
        }

        let (target, needs_cleanup) = replace_target(&origin, &ext);
        // 换格式时目标名可能已经被另一张图占着（同名的 .png 和 .jpg 并存过），
        // 这时候覆盖等于顺手毁掉别人的文件
        if needs_cleanup && target.exists() {
            return Err(AppError::Invalid(format!(
                "{} 已经存在，先手动处理一下",
                target.display()
            )));
        }

        crate::fsutil::write_atomic(&target, &bytes)?;
        if needs_cleanup {
            std::fs::remove_file(&origin)?;
        }
        return Ok(target.to_string_lossy().into_owned());
    }

    let dir = origin
        .as_ref()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(fallback_dir);

    let stem = sanitize_stem(&name);
    let target = unique_path(&dir, &stem, &ext);
    crate::fsutil::write_atomic(&target, &bytes)?;
    Ok(target.to_string_lossy().into_owned())
}

/// 字节数给人看：`2.4 MB` / `320 KB`。
fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let value = bytes as f64;
    if value >= KB * KB {
        format!("{:.1} MB", value / (KB * KB))
    } else if value >= KB {
        format!("{:.0} KB", value / KB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        collect_images, human_size, replace_target, sanitize_ext, sanitize_stem, unique_path,
    };
    use crate::testutil::TempDir;
    use std::fs;
    use std::path::Path;

    #[test]
    fn ext_is_normalised_and_whitelisted() {
        assert_eq!(sanitize_ext("JPG").unwrap(), "jpg");
        assert_eq!(sanitize_ext(".jpeg").unwrap(), "jpg");
        assert_eq!(sanitize_ext("webp").unwrap(), "webp");
        assert!(sanitize_ext("exe").is_err());
        assert!(sanitize_ext("").is_err());
    }

    #[test]
    fn stem_drops_path_separators() {
        // 这些字符进了文件名就能写到别处去，必须清掉
        assert_eq!(sanitize_stem("a/b\\c:d*e?f"), "a_b_c_d_e_f");
        assert_eq!(sanitize_stem("../evil"), ".._evil");
    }

    #[test]
    fn stem_trims_trailing_dots_and_spaces() {
        // Windows 会把结尾的点和空格静默吃掉，名字就和预期不一样了
        assert_eq!(sanitize_stem("photo."), "photo");
        assert_eq!(sanitize_stem("photo   "), "photo");
        assert_eq!(sanitize_stem(" . "), "image");
    }

    #[test]
    fn stem_falls_back_when_empty() {
        assert_eq!(sanitize_stem(""), "image");
        assert_eq!(sanitize_stem("///"), "___");
    }

    #[test]
    fn unique_path_avoids_overwriting() {
        let dir = TempDir::new("image-unique");
        let first = unique_path(dir.path(), "photo", "jpg");
        assert_eq!(first.file_name().unwrap(), "photo.jpg");

        fs::write(&first, b"x").unwrap();
        let second = unique_path(dir.path(), "photo", "jpg");
        assert_eq!(second.file_name().unwrap(), "photo (2).jpg");

        fs::write(&second, b"x").unwrap();
        assert_eq!(
            unique_path(dir.path(), "photo", "jpg").file_name().unwrap(),
            "photo (3).jpg"
        );
    }

    #[test]
    fn replace_same_ext_overwrites_in_place() {
        let (target, cleanup) = replace_target(Path::new("D:/pics/a.jpg"), "jpg");
        assert_eq!(target, Path::new("D:/pics/a.jpg"));
        assert!(!cleanup, "同格式不该删原文件（写的就是它）");
    }

    #[test]
    fn replace_other_ext_writes_new_and_cleans_up() {
        let (target, cleanup) = replace_target(Path::new("D:/pics/a.png"), "jpg");
        assert_eq!(target, Path::new("D:/pics/a.jpg"));
        assert!(cleanup, "换格式要删掉原来的 png");
    }

    #[test]
    fn folder_scan_only_takes_first_level_images() {
        let dir = TempDir::new("image-scan");
        fs::write(dir.join("b.PNG"), b"x").unwrap();
        fs::write(dir.join("a.jpg"), b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("nested/deep.jpg"), b"x").unwrap();

        let items = collect_images(dir.path());

        // 只认第一层的图片，按文件名排（不区分大小写），子目录里的不算
        assert_eq!(
            items.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(),
            vec!["a.jpg", "b.PNG"]
        );
        assert!(items.iter().all(|item| item.size == 1));
    }

    #[test]
    fn folder_scan_of_missing_dir_is_empty() {
        assert!(collect_images(Path::new("D:/definitely/not/here")).is_empty());
    }

    #[test]
    fn human_size_reads_like_people_talk() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2 KB");
        assert_eq!(human_size(2 * 1024 * 1024 + 512 * 1024), "2.5 MB");
    }
}
