use serde::{Serialize, Serializer};

/// 统一错误类型。Tauri command 的返回错误必须可序列化，
/// 这里序列化成字符串，前端拿到的就是一句可读的中文提示。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误：{0}")]
    Db(#[from] rusqlite::Error),

    #[error("文件读写失败：{0}")]
    Io(#[from] std::io::Error),

    #[error("系统调用失败：{0}")]
    Tauri(#[from] tauri::Error),

    #[error("找不到：{0}")]
    NotFound(String),

    #[error("参数不合法：{0}")]
    Invalid(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
