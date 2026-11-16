use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::backup;
use crate::error::{AppError, AppResult};
use crate::hlc::{DeviceId, Hlc};

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

const SCHEMA_VERSION: i64 = 5;

pub fn data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

pub fn db_path() -> PathBuf {
    data_dir().join("whale.db")
}

/// 这次启动有没有从事故里爬起来。
///
/// GUI 拿到它之后记一条 `event_log`，用户以后能在历史里看到
/// 「某天启动时做过恢复」——数据被动过就得留痕。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recovery {
    /// 一切正常，什么都没发生
    Clean,
    /// 库坏了，已从某份备份恢复
    Restored {
        from: String,
        quarantined: String,
        reason: String,
    },
    /// 库坏了且没有可用备份，已建空库（坏库留在旁边等人捞）
    Recreated { quarantined: String, reason: String },
}

/// 打开数据库。GUI 与 MCP 两个进程都走这里，指向同一个文件。
///
/// 坏了直接报错、不做恢复——恢复是 GUI 启动时的事（见 `open_or_recover`）。
/// MCP 是短命进程，让它在坏库上自己「修好」反而会跟 GUI 抢文件。
pub fn open() -> AppResult<Connection> {
    connect(&db_path())
}

/// GUI 启动用：库坏了就隔离坏库、从备份恢复。
///
/// 刻意**不删除**坏库——万一所有备份都坏，人工还有东西可捞。
pub fn open_or_recover() -> AppResult<(Connection, Recovery)> {
    open_at(&db_path(), &backup::dir())
}

/// 打开 + 自检 + 配置 + 迁移。
///
/// 自检必须排在所有 PRAGMA 写入和 DDL 之前：坏库上跑这些，
/// 真实原因会被埋成「file is not a database」这种底层报错，看不出是数据问题。
fn connect(path: &Path) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let conn = Connection::open(path)?;

    if let Some(reason) = backup::check(&conn) {
        return Err(AppError::Other(format!("数据库自检未通过：{reason}")));
    }

    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> AppResult<()> {
    // WAL：GUI 与 MCP 两个进程可以同时读写，不会互相阻塞读
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // 写冲突时自动重试 5 秒，避免直接抛 SQLITE_BUSY
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // 攒到 1000 页（约 4MB）自动 checkpoint。
    // 不设的话 -wal 会一直涨，尤其 MCP 那种频繁短连接写入的场景
    conn.pragma_update(None, "wal_autocheckpoint", 1000)?;
    Ok(())
}

/// 带恢复的开库。抽成接路径的形态是为了能测——直接测 `open_or_recover`
/// 会动到 %APPDATA% 里的真数据。
fn open_at(path: &Path, backup_dir: &Path) -> AppResult<(Connection, Recovery)> {
    match connect(path) {
        Ok(conn) => Ok((conn, Recovery::Clean)),
        Err(err) => {
            let reason = err.to_string();
            let quarantined = quarantine(path)?;

            if let Some(from) = backup::restore_latest(path, backup_dir)? {
                let conn = connect(path)?;
                return Ok((
                    conn,
                    Recovery::Restored {
                        from: from.display().to_string(),
                        quarantined: quarantined.display().to_string(),
                        reason,
                    },
                ));
            }

            // 一份能用的备份都没有：建空库让应用先起来，坏库留在旁边
            let conn = connect(path)?;
            Ok((
                conn,
                Recovery::Recreated {
                    quarantined: quarantined.display().to_string(),
                    reason,
                },
            ))
        }
    }
}

/// 把坏库改名隔离，连带 `-wal` / `-shm` 一起挪走。
///
/// 只挪 `.db` 是不够的：残留的 `-wal` 会被新建的库当成自己的日志重放，
/// 相当于把坏数据又灌回去一遍。
fn quarantine(path: &Path) -> AppResult<PathBuf> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = path.with_file_name(format!("whale.corrupt-{stamp}.db"));

    std::fs::rename(path, &target)?;

    for suffix in ["-wal", "-shm"] {
        let side = with_suffix(path, suffix);
        if side.exists() {
            let _ = std::fs::rename(&side, with_suffix(&target, suffix));
        }
    }

    Ok(target)
}

/// 给路径加后缀（`a.db` + `-wal` → `a.db-wal`）。
///
/// 用 `OsString` 拼接而不是 `format!`：Windows 上路径不保证是 UTF-8，
/// 走字符串会失真。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
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

    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    // 新库：schema.sql 里的 CREATE TABLE IF NOT EXISTS 会把表建全。
    // 老库：下面按版本号逐条补列。
    conn.execute_batch(include_str!("../schema.sql"))?;

    // v1 → v2：加计划开始时间。老库的 CREATE TABLE 是空操作，只能 ALTER 补。
    ensure_column(conn, "task", "start_at", "TEXT")?;

    // v4 → v5：同步元数据。老库的 CREATE TABLE 同样是空操作。
    // 这一列必须 NOT NULL DEFAULT ''——迁移时先让老行落在空串上，
    // 再由 backfill 按 updated_at 补齐；没有默认值的话 ALTER 会直接失败。
    for table in ["task", "note", "reminder", "tag"] {
        ensure_column(conn, table, "hlc", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(conn, table, "origin", "TEXT NOT NULL DEFAULT ''")?;
    }

    // 老数据 hlc = ''，直接同步会全部排在最前，所以按写入时间补一个初始值。
    // 各表的「写入时间」列不一样：待办和备忘有 updated_at，提醒和标签只有 created_at。
    backfill_hlc(conn, "task", "updated_at")?;
    backfill_hlc(conn, "note", "updated_at")?;
    backfill_hlc(conn, "reminder", "created_at")?;
    backfill_hlc(conn, "tag", "created_at")?;

    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [SCHEMA_VERSION.to_string()],
    )?;

    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 缺列就补上。`table` / `column` / `decl` 都来自本文件里的字面量，不是外部输入。
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> AppResult<()> {
    if !has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

/// 给 `hlc = ''` 的老行按写入时间补一个初始时钟。
///
/// device 段填 `00000000`，让老数据在冲突时永远输给任何新写入——这是对的，
/// 因为它确实更旧。counter 段靠 `tick_at` 在同一毫秒内自增，保证同秒的多行
/// 也有确定先后；查询按时间列排过序，所以顺推出来的时钟天然有序。
///
/// `WHERE hlc = ''` 让这一步幂等：迁移中断后重跑不会改动已经补过的行。
fn backfill_hlc(conn: &Connection, table: &str, stamp_column: &str) -> AppResult<()> {
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, {stamp_column} FROM {table} WHERE hlc = '' ORDER BY {stamp_column}, id"
        ))?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut clock = Hlc::new(DeviceId::new([0; 4]));
    for (id, stamp) in rows {
        let value = clock.tick_at(iso_to_millis(&stamp)).to_string();
        conn.execute(
            &format!("UPDATE {table} SET hlc = ?1 WHERE id = ?2"),
            params![value, id],
        )?;
    }
    Ok(())
}

/// 把库里存的 ISO 时间转成毫秒。解析不了就按 0 处理——
/// 一条时间格式坏掉的老行不该让整个迁移失败。
fn iso_to_millis(raw: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|at| u64::try_from(at.timestamp_millis()).unwrap_or(0))
        .unwrap_or(0)
}

/// 当前 UTC 时间，ISO 8601 带 Z，与库里的存储格式保持一致。
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 生成时间有序的主键，`ORDER BY id` 等价于按创建时间排序。
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::{open_at, quarantine, with_suffix, Recovery};
    use crate::backup;
    use crate::testutil::TempDir;
    use rusqlite::Connection;
    use std::fs;

    /// 明显不是数据库的内容：SQLite 的 magic 校验必失败。
    fn write_garbage(path: &std::path::Path) {
        let text = "not a database, just plain text padded out so the header \
                    check cannot possibly pass. "
            .repeat(8);
        fs::write(path, text).unwrap();
    }

    fn seed_live_and_backup(live: &std::path::Path, backup_dir: &std::path::Path) {
        let conn = Connection::open(live).unwrap();
        conn.execute_batch("CREATE TABLE t (x TEXT NOT NULL); INSERT INTO t VALUES ('saved');")
            .unwrap();
        backup::snapshot(&conn, backup_dir, 7).unwrap();
    }

    #[test]
    fn healthy_db_opens_without_recovery() {
        let dir = TempDir::new("db-clean");
        let live = dir.join("whale.db");

        let (conn, recovery) = open_at(&live, &dir.join("backups")).unwrap();

        assert!(matches!(recovery, Recovery::Clean));
        // 迁移跑过了：表都在
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM task", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn corrupt_db_is_quarantined_and_restored() {
        let dir = TempDir::new("db-restore");
        let backup_dir = dir.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let live = dir.join("whale.db");

        seed_live_and_backup(&live, &backup_dir);
        write_garbage(&live);

        let (conn, recovery) = open_at(&live, &backup_dir).unwrap();

        match recovery {
            Recovery::Restored { quarantined, .. } => {
                // 坏库改名留着，不是删掉
                assert!(std::path::Path::new(&quarantined).exists());
            }
            other => panic!("期望 Restored，实际 {other:?}"),
        }
        let value: String = conn
            .query_row("SELECT x FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "saved");
    }

    #[test]
    fn quarantine_takes_stale_wal_and_shm_along() {
        // 只挪 .db 的话，残留的 -wal 会被新建的库当成自己的日志重放。
        //
        // 这里直接调 quarantine 而不是走 open_at：SQLite 打开坏库时会自己
        // 清理非法 WAL，端到端根本构造不出「坏库 + 残留 WAL」这个状态。
        let dir = TempDir::new("db-quarantine-wal");
        let live = dir.join("whale.db");
        fs::write(&live, b"whatever").unwrap();
        fs::write(with_suffix(&live, "-wal"), b"stale").unwrap();
        fs::write(with_suffix(&live, "-shm"), b"stale").unwrap();

        let target = quarantine(&live).unwrap();

        assert!(!live.exists());
        assert!(target.exists());
        assert!(with_suffix(&target, "-wal").exists());
        assert!(with_suffix(&target, "-shm").exists());
        // 原位置不能留下任何一个
        assert!(!with_suffix(&live, "-wal").exists());
        assert!(!with_suffix(&live, "-shm").exists());
    }

    #[test]
    fn restored_db_reads_backup_data_not_stale_wal() {
        let dir = TempDir::new("db-restore-wal");
        let backup_dir = dir.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let live = dir.join("whale.db");

        seed_live_and_backup(&live, &backup_dir);
        write_garbage(&live);

        let (conn, recovery) = open_at(&live, &backup_dir).unwrap();

        assert!(matches!(recovery, Recovery::Restored { .. }));
        let value: String = conn
            .query_row("SELECT x FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "saved");
    }

    #[test]
    fn corrupt_db_without_backup_is_recreated() {
        let dir = TempDir::new("db-recreate");
        let backup_dir = dir.join("backups");
        let live = dir.join("whale.db");

        write_garbage(&live);

        let (conn, recovery) = open_at(&live, &backup_dir).unwrap();

        match recovery {
            Recovery::Recreated { quarantined, .. } => {
                assert!(std::path::Path::new(&quarantined).exists());
            }
            other => panic!("期望 Recreated，实际 {other:?}"),
        }
        // 空库可用，schema 也建好了
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn suffix_keeps_the_original_name_intact() {
        let path = std::path::Path::new("/tmp/a.db");
        assert_eq!(with_suffix(path, "-wal"), std::path::PathBuf::from("/tmp/a.db-wal"));
    }

    /// 造一个 v4 时代的库：`task` 表还没有 `hlc` / `origin` 两列。
    fn seed_v4(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta(key, value) VALUES ('schema_version', '4');
             CREATE TABLE task (
               id TEXT PRIMARY KEY, title TEXT NOT NULL,
               description TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'todo',
               priority INTEGER NOT NULL DEFAULT 1,
               due_at TEXT, start_at TEXT, started_at TEXT, completed_at TEXT,
               estimate_min INTEGER, tags TEXT NOT NULL DEFAULT '[]',
               source TEXT NOT NULL DEFAULT 'manual',
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
             INSERT INTO task (id, title, created_at, updated_at) VALUES
               ('a', '先写的', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
               ('b', '后写的', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');",
        )
        .unwrap();
    }

    #[test]
    fn migration_adds_sync_columns_and_backfills_hlc() {
        let dir = TempDir::new("db-migrate-v5");
        let live = dir.join("whale.db");
        seed_v4(&live);

        let (conn, _) = open_at(&live, &dir.join("backups")).unwrap();

        let first: String = conn
            .query_row("SELECT hlc FROM task WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        let second: String = conn
            .query_row("SELECT hlc FROM task WHERE id = 'b'", [], |row| row.get(0))
            .unwrap();

        // 老数据必须补上时钟，且按写入时间有序——否则同步时全排在最前
        assert_eq!(first.len(), crate::hlc::LEN);
        assert!(first < second, "老数据的初始时钟没跟着 updated_at 走");

        // 新表跟着 schema.sql 一起建好了
        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outbox, 0);
        let origin: String = conn
            .query_row("SELECT origin FROM task WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(origin, "", "老数据的 origin 是空，不该冒充某台设备写的");
    }

    #[test]
    fn backfill_is_idempotent() {
        let dir = TempDir::new("db-migrate-idempotent");
        let live = dir.join("whale.db");
        seed_v4(&live);

        let (conn, _) = open_at(&live, &dir.join("backups")).unwrap();
        let before: String = conn
            .query_row("SELECT hlc FROM task WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        // 模拟迁移中断：版本号退回 4，只清掉一行的时钟
        let conn = Connection::open(&live).unwrap();
        conn.execute("UPDATE meta SET value = '4' WHERE key = 'schema_version'", [])
            .unwrap();
        conn.execute("UPDATE task SET hlc = '' WHERE id = 'a'", [])
            .unwrap();
        drop(conn);

        let (conn, _) = open_at(&live, &dir.join("backups")).unwrap();
        let after: String = conn
            .query_row("SELECT hlc FROM task WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();

        // 重跑一遍补出来的是同一个值，不会把已经补过的行改乱
        assert_eq!(after, before);
    }
}
