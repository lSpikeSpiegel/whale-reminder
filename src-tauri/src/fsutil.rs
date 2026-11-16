//! 落盘小工具。
//!
//! 所有「把数据写进文件」的地方都走这里，不要直接 `fs::write`——
//! 直接写会在断电 / 崩溃 / 磁盘满的时候留下半截文件，而半截 JSON 等于读不出来，
//! 用户的面板尺寸、气泡时长、工具排序会被静默重置回默认值。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::AppResult;

/// 原子写：先写同目录的临时文件并 fsync，再 rename 覆盖目标。
///
/// 三步都是必要的：
///
/// 1. **同目录**——跨分区的 rename 会退化成「复制 + 删除」，不原子；
/// 2. **fsync**——不刷盘的话，rename 成功也可能得到一个「名字对、内容空」的文件；
/// 3. **rename**——同一分区上 rename 是原子的，读者要么看到旧内容，要么看到新内容。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }

    let tmp = tmp_path(path);
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    if let Err(err) = fs::rename(&tmp, path) {
        // rename 失败（被占用、权限）要清掉临时文件，
        // 否则每失败一次就在目录里留一个 .tmp
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

/// 临时文件名带上 pid：GUI 和 MCP 是两个进程，可能同时写同一个 settings.json。
/// 共用一个 `.tmp` 的话，后一个会把前一个正在写的文件截断。
fn tmp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "whale".to_owned());
    path.with_file_name(format!(".{name}.{}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::write_atomic;
    use crate::testutil::TempDir;
    use std::fs;

    #[test]
    fn creates_file_and_missing_parents() {
        let dir = TempDir::new("fsutil-create");
        let path = dir.join("nested/deep/settings.json");

        write_atomic(&path, b"hello").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn replaces_existing_content() {
        let dir = TempDir::new("fsutil-replace");
        let path = dir.join("settings.json");

        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"second");
    }

    #[test]
    fn leaves_no_temp_file_behind() {
        let dir = TempDir::new("fsutil-tmp");
        let path = dir.join("settings.json");

        write_atomic(&path, b"x").unwrap();

        let mut names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["settings.json".to_string()]);
    }

    #[test]
    fn overwriting_empty_file_works() {
        // 上一次崩溃留下了 0 字节文件，下一次写入不该被它挡住
        let dir = TempDir::new("fsutil-empty");
        let path = dir.join("settings.json");
        fs::write(&path, b"").unwrap();

        write_atomic(&path, b"{}").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"{}");
    }
}
