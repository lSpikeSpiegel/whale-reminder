use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::AppResult;

/// 应用数据目录名，必须与 tauri.conf.json 的 identifier 保持一致。
///
/// 这里不依赖 Tauri 的 AppHandle：`--mcp` 模式下进程完全不初始化 Tauri，
/// 但仍然要打开同一个数据库文件。
pub const APP_DIR: &str = "com.whalereminder.app";

/// 全局数据库连接。
///
/// GUI 进程内用单连接 + Mutex 串行化写入；
/// M4 的 MCP 进程会另开自己的连接，靠 SQLite 的 WAL 模式支持多进程并发。
pub struct Db(pub Mutex<Connection>);

const SCHEMA_VERSION: i64 = 1;

pub fn data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

pub fn db_path() -> PathBuf {
    data_dir().join("whale.db")
}

/// 打开数据库。GUI 与 MCP 两个进程都走这里，指向同一个文件。
pub fn open() -> AppResult<Connection> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let conn = Connection::open(&path)?;

    // WAL：GUI 与 MCP 两个进程可以同时读写，不会互相阻塞读
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // 写冲突时自动重试 5 秒，避免直接抛 SQLITE_BUSY
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;

    let current: i64 = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if current < SCHEMA_VERSION {
        conn.execute_batch(include_str!("../schema.sql"))?;
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
    }

    Ok(())
}

/// 当前 UTC 时间，ISO 8601 带 Z，与库里的存储格式保持一致。
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 生成时间有序的主键，`ORDER BY id` 等价于按创建时间排序。
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
