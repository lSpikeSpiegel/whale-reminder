//! 测试专用的小工具。只在 `cargo test` 时编进 crate，不进二进制。

use std::path::{Path, PathBuf};

/// 一个临时目录，`Drop` 时自动删掉。
///
/// 名字带 uuid，同一台机器上并行跑多个测试也不会撞。
/// 删失败（Windows 上文件还被占用）就算了——临时目录里留着不影响下次运行。
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("whale-test-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("建临时目录失败");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
