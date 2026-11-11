use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::ReminderView;
use crate::db::{new_id, now_iso};
use crate::error::{AppError, AppResult};

/// 默认提前量：截止前 30 分钟、10 分钟各提醒一次
pub const DEFAULT_OFFSETS: [i64; 2] = [-1800, -600];

/// 给一个有截止时间的任务建提醒。
///
/// `offsets` 是相对 due_at 的秒数，负数表示提前。已经过去的时间点直接跳过，
/// 避免用户创建一条"昨天就到期"的任务后立刻被提醒。
pub fn create_for_due(
    conn: &Connection,
    task_id: &str,
    due_at: &str,
    offsets: Option<&[i64]>,
) -> AppResult<usize> {
    let due = parse_utc(due_at)?;
    let now = Utc::now();
    let list = offsets.unwrap_or(&DEFAULT_OFFSETS);
    let mut created = 0;

    for offset in list {
        let fire_at = due + Duration::seconds(*offset);
        if fire_at <= now {
            continue;
        }
        insert_once(conn, task_id, "notify", fire_at)?;
        created += 1;
    }

    Ok(created)
}

/// 建一条一次性提醒。
pub fn insert_once(
    conn: &Connection,
    task_id: &str,
    kind: &str,
    fire_at: DateTime<Utc>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO reminder (id, task_id, kind, rule, next_fire_at, state, fire_count, created_at)
         VALUES (?1, ?2, ?3, '{\"type\":\"once\"}', ?4, 'pending', 0, ?5)",
        params![
            new_id(),
            task_id,
            kind,
            to_iso(fire_at),
            now_iso()
        ],
    )?;
    Ok(())
}

/// 按截止时间倒推追问时机：从创建到截止这段区间的 50% / 80% / 95% 处各问一次。
///
/// 已经过去的时间点直接跳过——比如用户创建了一条两小时后就要到期的任务，
/// 50% 那个点可能已经过去了，就只留后面的。
pub fn create_progress_checks(
    conn: &Connection,
    task_id: &str,
    due_at: &str,
    base: DateTime<Utc>,
) -> AppResult<usize> {
    let due = parse_utc(due_at)?;
    if due <= base {
        return Ok(0);
    }

    let now = Utc::now();
    let span = due - base;
    let mut created = 0;

    for pct in [0.5_f64, 0.8, 0.95] {
        let offset_ms = (span.num_milliseconds() as f64 * pct) as i64;
        let fire_at = base + Duration::milliseconds(offset_ms);
        if fire_at <= now {
            continue;
        }
        insert_once(conn, task_id, "ask", fire_at)?;
        created += 1;
    }

    Ok(created)
}

/// 记一条"已追问但还没回答"的记录，供 answer_progress 回填。
pub fn log_ask(conn: &Connection, task_id: &str, asked_at: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO progress_log (id, task_id, asked_at) VALUES (?1, ?2, ?3)",
        params![new_id(), task_id, asked_at],
    )?;
    Ok(())
}

/// 取消某个任务剩余的追问提醒（用于降级）。
pub fn cancel_pending_asks(conn: &Connection, task_id: &str) -> AppResult<usize> {
    let n = conn.execute(
        "UPDATE reminder SET state = 'cancelled'
         WHERE task_id = ?1 AND kind = 'ask' AND state = 'pending'",
        [task_id],
    )?;
    Ok(n)
}

/// 取某个任务所有未完成的提醒。
pub fn list_for_task(conn: &Connection, task_id: &str) -> AppResult<Vec<ReminderView>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, next_fire_at, state FROM reminder
         WHERE task_id = ?1 AND state IN ('pending','paused')
         ORDER BY next_fire_at ASC",
    )?;

    let rows = stmt
        .query_map([task_id], |row| {
            Ok(ReminderView {
                id: row.get(0)?,
                kind: row.get(1)?,
                next_fire_at: row.get(2)?,
                state: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(rows)
}

/// 任务完成或删除时，把它的提醒全部关停。
pub fn stop_all_for_task(conn: &Connection, task_id: &str) -> AppResult<usize> {
    let n = conn.execute(
        "UPDATE reminder SET state = 'done'
         WHERE task_id = ?1 AND state IN ('pending','paused')",
        [task_id],
    )?;
    Ok(n)
}

/// 把下次触发时间整体推后，用于"稍后提醒"。
pub fn snooze(conn: &Connection, task_id: &str, minutes: i64) -> AppResult<Option<String>> {
    if !(1..=1440).contains(&minutes) {
        return Err(AppError::Invalid("推迟分钟数需在 1–1440 之间".into()));
    }

    let next = Utc::now() + Duration::minutes(minutes);
    let next_iso = to_iso(next);

    let changed = conn.execute(
        "UPDATE reminder SET next_fire_at = ?1, state = 'pending'
         WHERE task_id = ?2 AND state IN ('pending','paused')",
        params![next_iso, task_id],
    )?;

    if changed == 0 {
        return Ok(None);
    }
    Ok(Some(next_iso))
}

fn parse_utc(raw: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| AppError::Invalid(format!("时间格式不合法：{raw}")))
}

fn to_iso(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 判断某个任务是否有待触发的提醒（M3 的调度器与列表渲染会用到）。
#[allow(dead_code)]
pub fn next_pending(conn: &Connection, task_id: &str) -> AppResult<Option<String>> {
    let value = conn
        .query_row(
            "SELECT next_fire_at FROM reminder
             WHERE task_id = ?1 AND state = 'pending'
             ORDER BY next_fire_at ASC LIMIT 1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(value)
}
