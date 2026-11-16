//! 数据库备份与损坏恢复。
//!
//! 这一层的目标只有一个：**用户的数据比应用能不能起来更重要**。
//! 所以库坏了不静默重建——先把坏库改名留证，再从最近一份能打开的备份恢复；
//! 一份可用备份都没有时才建空库，坏库仍然留在旁边等人捞。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Local;
use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};

use crate::db::Db;
use crate::error::AppResult;

/// 保留多少份。6 小时一份、留 7 份 ≈ 一周滚动，
/// 足够覆盖「周五发现周一改坏了」这种最常见的情况。
pub const KEEP: usize = 7;

/// 两次备份的间隔。
pub const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// 启动后多久跑第一次。
///
/// 30 秒是刻意的：这时窗口建好了、库热了、调度器也跑过一轮了，
/// 备份不会跟启动阶段抢磁盘。
const FIRST_DELAY: Duration = Duration::from_secs(30);

/// 备份目录，跟数据库放在一起。
pub fn dir() -> PathBuf {
    crate::db::data_dir().join("backups")
}

/// 自检。健康返回 `None`，否则返回原因。
///
/// 用 `quick_check` 而不是 `integrity_check`：前者不校验索引与表数据的一致性，
/// 快一个量级，启动时跑得起；真出问题时也足够判断「这个库还能不能救」。
pub fn check(conn: &Connection) -> Option<String> {
    match conn.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
        Ok(message) if message == "ok" => None,
        Ok(message) => Some(message),
        // 文件根本不是数据库时 query_row 直接报错，这比返回一行问题描述更常见
        Err(err) => Some(err.to_string()),
    }
}

/// 产出一份完整副本，返回它的路径。
///
/// **不要复制 `.db` 文件**：WAL 模式下未 checkpoint 的数据还在 `-wal` 里，
/// 复制出来的是一份缺了最近写入的库。`VACUUM INTO` 在一个读事务里产出
/// 完整、一致、顺带整理了碎片的副本，且不会长时间占着写锁。
pub fn snapshot(conn: &Connection, dir: &Path, keep: usize) -> AppResult<PathBuf> {
    fs::create_dir_all(dir)?;

    // 毫秒级时间戳：文件名定长，字典序 == 时间序，prune 直接按名字排就行
    let stamp = Local::now().format("%Y%m%d-%H%M%S%3f");
    let target = dir.join(format!("whale-{stamp}.db"));
    if target.exists() {
        // 同一毫秒已经备过（正常不会发生），别让 VACUUM INTO 报「文件已存在」
        return Ok(target);
    }

    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])?;
    prune(dir, keep)?;
    Ok(target)
}

/// 只留最近 `keep` 份，返回删掉几份。
fn prune(dir: &Path, keep: usize) -> AppResult<usize> {
    let mut backups = list(dir)?;
    if backups.len() <= keep {
        return Ok(0);
    }

    // 定长时间戳 → 名字序即时间序，不用解析
    backups.sort();
    let stale = backups.len() - keep;
    Ok(backups
        .into_iter()
        .take(stale)
        .filter(|path| fs::remove_file(path).is_ok())
        .count())
}

/// 按名字升序列出备份文件。目录不存在等于没有备份，不是错误。
fn list(dir: &Path) -> AppResult<Vec<PathBuf>> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(Vec::new());
    };

    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| is_backup(path))
        .collect();
    paths.sort();
    Ok(paths)
}

/// 只认自己产出的文件名——用户手动放进备份目录的东西不能被顺手删掉。
///
/// `-wal` / `-shm` 的结尾不是 `.db`，自然被排除。
fn is_backup(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("whale-") && name.ends_with(".db"))
}

/// 从备份里挑一份最新的、**能打开**的，覆盖到 `db_path`。
///
/// 「能打开」必须真打开验一次：备份文件本身也可能在复制途中被打断。
/// 从新往旧试，第一份通过的就用；全都坏则返回 `None`。
pub fn restore_latest(db_path: &Path, dir: &Path) -> AppResult<Option<PathBuf>> {
    let mut backups = list(dir)?;
    backups.reverse();

    for candidate in backups {
        let Ok(conn) = Connection::open(&candidate) else {
            continue;
        };
        if check(&conn).is_some() {
            continue;
        }
        // Windows 上文件还被占用时 copy 会失败，先关掉连接再复制
        drop(conn);

        fs::copy(&candidate, db_path)?;
        return Ok(Some(candidate));
    }
    Ok(None)
}

/// 起一个后台线程定期备份。
///
/// 独立于调度器：调度器 15 秒一跳，是「快」的循环；
/// 备份 6 小时一次，是「慢」的循环，混在一起会让 tick 偶尔卡顿。
pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_DELAY);
        loop {
            run_once(&app);
            std::thread::sleep(INTERVAL);
        }
    });
}

fn run_once<R: Runtime>(app: &AppHandle<R>) {
    let Some(db) = app.try_state::<Db>() else {
        return;
    };
    let Ok(guard) = db.0.lock() else {
        return;
    };

    // 先把 WAL 落进主库：既能让 -wal 文件真正缩小，也让备份前后的文件状态更干净。
    // 有别的进程正在读时会返回 busy，忽略即可——VACUUM INTO 本来也能读到 WAL 里的内容。
    let _ = guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

    // 单机待办几 MB，VACUUM INTO 几十毫秒。这期间拿着 Mutex 会挡住 GUI 写入，
    // 但比「备份时读到半截数据」划算得多。
    if let Err(err) = snapshot(&guard, &dir(), KEEP) {
        eprintln!("[whale] 备份失败：{err}");
    }
}

#[cfg(test)]
mod tests {
    use super::{check, is_backup, prune, restore_latest, snapshot};
    use crate::testutil::TempDir;
    use rusqlite::Connection;
    use std::fs;
    use std::path::Path;

    fn seed(conn: &Connection) {
        conn.execute_batch("CREATE TABLE t (x TEXT NOT NULL); INSERT INTO t VALUES ('a');")
            .unwrap();
    }

    fn read_x(path: &Path) -> String {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT x FROM t", [], |row| row.get(0)).unwrap()
    }

    /// 造一个「明显不是数据库」的文件：SQLite 的 magic 校验会直接失败。
    fn write_garbage(path: &Path) {
        let text = "this is not a sqlite database, it is just some plain text \
                    padded out so that the header check cannot possibly pass. "
            .repeat(8);
        fs::write(path, text).unwrap();
    }

    #[test]
    fn healthy_db_passes_check() {
        let dir = TempDir::new("backup-check-ok");
        let conn = Connection::open(dir.join("a.db")).unwrap();
        seed(&conn);
        assert!(check(&conn).is_none());
    }

    #[test]
    fn garbage_file_fails_check() {
        let dir = TempDir::new("backup-check-bad");
        let path = dir.join("bad.db");
        write_garbage(&path);

        let conn = Connection::open(&path).unwrap();
        assert!(check(&conn).is_some());
    }

    #[test]
    fn snapshot_produces_readable_copy() {
        let dir = TempDir::new("backup-snapshot");
        let live = dir.join("live.db");
        let conn = Connection::open(&live).unwrap();
        seed(&conn);

        let copy = snapshot(&conn, dir.path(), 7).unwrap();

        assert!(copy.exists());
        assert_ne!(copy, live);
        assert_eq!(read_x(&copy), "a");
    }

    #[test]
    fn snapshot_captures_writes_still_sitting_in_wal() {
        // 这是「不能直接复制 .db」的直接证据：数据还在 WAL 里没落进主库，
        // 但 VACUUM INTO 依然能读到它
        let dir = TempDir::new("backup-wal");
        let live = dir.join("live.db");
        let conn = Connection::open(&live).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        seed(&conn);

        let copy = snapshot(&conn, dir.path(), 7).unwrap();

        assert_eq!(read_x(&copy), "a");
    }

    #[test]
    fn prune_keeps_newest_and_leaves_foreign_files_alone() {
        let dir = TempDir::new("backup-prune");
        for index in 0..10 {
            fs::write(
                dir.join(&format!("whale-2026010{index}-000000000.db")),
                b"x",
            )
            .unwrap();
        }
        // 这两个不该被当成备份
        fs::write(dir.join("notes.txt"), b"keep me").unwrap();
        fs::write(dir.join("whale-manual.db-wal"), b"keep me").unwrap();

        let removed = prune(dir.path(), 3).unwrap();

        assert_eq!(removed, 7);
        let left: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".db"))
            .collect();
        assert_eq!(
            left,
            vec![
                "whale-20260107-000000000.db",
                "whale-20260108-000000000.db",
                "whale-20260109-000000000.db",
            ]
        );
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("whale-manual.db-wal").exists());
    }

    #[test]
    fn prune_is_noop_when_under_limit() {
        let dir = TempDir::new("backup-prune-noop");
        fs::write(dir.join("whale-20260101-000000000.db"), b"x").unwrap();

        assert_eq!(prune(dir.path(), 7).unwrap(), 0);
        assert!(dir.join("whale-20260101-000000000.db").exists());
    }

    #[test]
    fn restore_skips_broken_backup_and_falls_back_to_older_one() {
        let dir = TempDir::new("backup-restore");
        let backups = dir.join("backups");
        fs::create_dir_all(&backups).unwrap();

        // 较早的一份是好的
        let good = backups.join("whale-20260101-000000000.db");
        let conn = Connection::open(&good).unwrap();
        seed(&conn);
        drop(conn);

        // 较新的一份是坏的
        write_garbage(&backups.join("whale-20260102-000000000.db"));

        let live = dir.join("live.db");
        let picked = restore_latest(&live, &backups).unwrap();

        assert_eq!(picked.as_deref(), Some(good.as_path()));
        assert_eq!(read_x(&live), "a");
    }

    #[test]
    fn restore_returns_none_without_any_usable_backup() {
        let dir = TempDir::new("backup-restore-none");
        let backups = dir.join("backups");
        fs::create_dir_all(&backups).unwrap();
        write_garbage(&backups.join("whale-20260102-000000000.db"));

        let picked = restore_latest(&dir.join("live.db"), &backups).unwrap();

        assert!(picked.is_none());
    }

    #[test]
    fn only_own_filenames_count_as_backups() {
        assert!(is_backup(Path::new("whale-20260101-000000000.db")));
        assert!(!is_backup(Path::new("whale-20260101-000000000.db-wal")));
        assert!(!is_backup(Path::new("notes.txt")));
        assert!(!is_backup(Path::new("other-20260101.db")));
    }
}
