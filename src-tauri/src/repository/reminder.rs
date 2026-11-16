use chrono::{DateTime, Duration, Local, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::ReminderView;
use crate::db::{new_id, now_iso};
use crate::error::{AppError, AppResult};
use crate::recur::RecurRule;
use crate::sync::{self, Entity};

/// 默认提前量：截止前 30 分钟、10 分钟各提醒一次
pub const DEFAULT_OFFSETS: [i64; 2] = [-1800, -600];

/// 一次性提醒的「来源」标记，写进 `rule` JSON 的 `origin` 字段。
///
/// 气泡靠它区分「开始时间到了」和「快截止了」：前者给「已开始」，
/// 后者给「已完成」。不这么做的话，两者都是 `kind = notify` 的一次性提醒，
/// 从库里根本分不出来。
pub const ORIGIN_START: &str = "start";

/// 一次性提醒的规则 JSON。带 origin 时多一个字段，`RecurRule` 解析时会忽略它。
fn once_rule(origin: Option<&str>) -> String {
    match origin {
        Some(origin) => format!(r#"{{"type":"once","origin":"{origin}"}}"#),
        None => r#"{"type":"once"}"#.to_string(),
    }
}

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
        insert_once(conn, task_id, "notify", fire_at, None)?;
        created += 1;
    }

    Ok(created)
}

/// 建一条一次性提醒。`origin` 见 [`ORIGIN_START`]。
pub fn insert_once(
    conn: &Connection,
    task_id: &str,
    kind: &str,
    fire_at: DateTime<Utc>,
    origin: Option<&str>,
) -> AppResult<()> {
    let id = new_id();
    sync::mutate(conn, Entity::Reminder, &id, |tx| {
        tx.execute(
            "INSERT INTO reminder (id, task_id, kind, rule, next_fire_at, state, fire_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6)",
            params![id, task_id, kind, once_rule(origin), to_iso(fire_at), now_iso()],
        )?;
        Ok(())
    })
}

/// 在指定时刻准点提醒一次（「开始时提醒」「结束时提醒」用的就是这条）。
///
/// 时刻已经过去就跳过，避免刚建完就弹一个过期提醒。
pub fn create_at(
    conn: &Connection,
    task_id: &str,
    kind: &str,
    at: &str,
    origin: Option<&str>,
) -> AppResult<()> {
    let fire_at = parse_utc(at)?;
    if fire_at <= Utc::now() {
        return Ok(());
    }
    insert_once(conn, task_id, kind, fire_at, origin)
}

/// 把某一条提醒挪到指定时刻重新触发（气泡里的「15 分钟后」「晚点提醒我」）。
///
/// 一次性提醒响过之后 `state` 已经是 `done`，这里把它复活成 `pending`——
/// 否则用户选了时间却什么都不会发生（旧版按 task 推迟就有这个毛病）。
pub fn reschedule(conn: &Connection, reminder_id: &str, at: &str) -> AppResult<String> {
    let fire_at = parse_utc(at)?;
    if fire_at <= Utc::now() {
        return Err(AppError::Invalid("提醒时间要晚于现在".into()));
    }

    let next = to_iso(fire_at);
    sync::mutate(conn, Entity::Reminder, reminder_id, |tx| {
        let changed = tx.execute(
            "UPDATE reminder SET state = 'pending', next_fire_at = ?2
             WHERE id = ?1 AND state IN ('pending','paused','done')",
            params![reminder_id, next],
        )?;

        if changed == 0 {
            return Err(AppError::NotFound(format!("提醒 {reminder_id} 不存在")));
        }
        Ok(())
    })?;

    Ok(next)
}

/// 建一条循环提醒。下一次触发由规则推算，推不出来（比如每周一天都没选）就不建。
pub fn create_recurring(conn: &Connection, task_id: &str, rule: &RecurRule) -> AppResult<bool> {
    let Some(next) = rule.next_after(Local::now()) else {
        return Ok(false);
    };

    let id = new_id();
    sync::mutate(conn, Entity::Reminder, &id, |tx| {
        tx.execute(
            "INSERT INTO reminder (id, task_id, kind, rule, next_fire_at, state, fire_count, created_at)
             VALUES (?1, ?2, 'notify', ?3, ?4, 'pending', 0, ?5)",
            params![id, task_id, rule.to_json(), to_iso(next), now_iso()],
        )?;
        Ok(())
    })?;

    Ok(true)
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
        insert_once(conn, task_id, "ask", fire_at, None)?;
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
    let ids = ids_where(
        conn,
        "SELECT id FROM reminder
          WHERE task_id = ?1 AND kind = 'ask' AND state = 'pending'",
        task_id,
    )?;
    if ids.is_empty() {
        return Ok(0);
    }

    sync::mutate_many(conn, Entity::Reminder, &ids, |tx| {
        Ok(tx.execute(
            "UPDATE reminder SET state = 'cancelled'
             WHERE task_id = ?1 AND kind = 'ask' AND state = 'pending'",
            [task_id],
        )?)
    })
}

/// 取某个任务所有未完成的提醒。
pub fn list_for_task(conn: &Connection, task_id: &str) -> AppResult<Vec<ReminderView>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, rule, next_fire_at, state FROM reminder
         WHERE task_id = ?1 AND state IN ('pending','paused')
         ORDER BY next_fire_at ASC",
    )?;

    let rows = stmt
        .query_map([task_id], |row| {
            Ok(ReminderView {
                id: row.get(0)?,
                kind: row.get(1)?,
                rule: row.get(2)?,
                next_fire_at: row.get(3)?,
                state: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(rows)
}

/// 任务完成或删除时，把它的提醒全部关停。
pub fn stop_all_for_task(conn: &Connection, task_id: &str) -> AppResult<usize> {
    let ids = ids_where(conn, LIVE_SQL, task_id)?;
    if ids.is_empty() {
        return Ok(0);
    }

    sync::mutate_many(conn, Entity::Reminder, &ids, |tx| {
        Ok(tx.execute(
            "UPDATE reminder SET state = 'done'
             WHERE task_id = ?1 AND state IN ('pending','paused')",
            [task_id],
        )?)
    })
}

/// 把下次触发时间整体推后，用于"稍后提醒"。
pub fn snooze(conn: &Connection, task_id: &str, minutes: i64) -> AppResult<Option<String>> {
    if !(1..=1440).contains(&minutes) {
        return Err(AppError::Invalid("推迟分钟数需在 1–1440 之间".into()));
    }

    let next = Utc::now() + Duration::minutes(minutes);
    let next_iso = to_iso(next);

    let ids = ids_where(conn, LIVE_SQL, task_id)?;
    if ids.is_empty() {
        return Ok(None);
    }

    sync::mutate_many(conn, Entity::Reminder, &ids, |tx| {
        tx.execute(
            "UPDATE reminder SET next_fire_at = ?1, state = 'pending'
             WHERE task_id = ?2 AND state IN ('pending','paused')",
            params![next_iso, task_id],
        )?;
        Ok(())
    })?;

    Ok(Some(next_iso))
}

/// 「还会响」的提醒。
const LIVE_SQL: &str =
    "SELECT id FROM reminder WHERE task_id = ?1 AND state IN ('pending','paused')";

/// 批量改状态前先把 id 取出来。
///
/// 改完再查就查不到了——条件（`state = 'pending'`）已经不成立，而这些行
/// 每一条都要各投一条 outbox 记录，漏了哪条对端就会一直以为它还挂着。
fn ids_where(conn: &Connection, sql: &str, task_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt
        .query_map([task_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../schema.sql")).unwrap();
        conn.execute(
            "INSERT INTO task (id, title, created_at, updated_at)
             VALUES ('t1', '测试', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn
    }

    fn only_reminder(conn: &Connection) -> String {
        conn.query_row("SELECT id FROM reminder", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn start_reminder_carries_origin_marker() {
        let conn = mem();
        let at = Utc::now() + Duration::hours(1);
        create_at(&conn, "t1", "notify", &at.to_rfc3339(), Some(ORIGIN_START)).unwrap();

        let rule: String = conn
            .query_row("SELECT rule FROM reminder", [], |row| row.get(0))
            .unwrap();
        assert!(rule.contains(r#""origin":"start""#), "规则里要留下来源标记");
        // 多出来的 origin 字段不能让 RecurRule 误判成循环提醒
        assert!(!RecurRule::from_json(&rule).is_recurring());
    }

    #[test]
    fn reschedule_revives_a_fired_reminder() {
        let conn = mem();
        let at = Utc::now() + Duration::minutes(5);
        insert_once(&conn, "t1", "notify", at, Some(ORIGIN_START)).unwrap();
        let id = only_reminder(&conn);

        // 模拟已经响过：一次性提醒这时 state = done
        conn.execute("UPDATE reminder SET state = 'done'", []).unwrap();

        let next_at = Utc::now() + Duration::hours(1);
        let next = reschedule(&conn, &id, &next_at.to_rfc3339()).unwrap();
        assert_eq!(next, to_iso(next_at));

        let (state, fire): (String, String) = conn
            .query_row(
                "SELECT state, next_fire_at FROM reminder WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "pending", "复活成 pending 才会再响");
        assert_eq!(fire, to_iso(next_at));
    }

    #[test]
    fn reschedule_rejects_past_time() {
        let conn = mem();
        let at = Utc::now() + Duration::minutes(5);
        insert_once(&conn, "t1", "notify", at, None).unwrap();
        let id = only_reminder(&conn);

        let past = Utc::now() - Duration::minutes(1);
        assert!(reschedule(&conn, &id, &past.to_rfc3339()).is_err());
    }

    #[test]
    fn reschedule_unknown_id_is_error() {
        let conn = mem();
        let at = Utc::now() + Duration::hours(1);
        assert!(reschedule(&conn, "nope", &at.to_rfc3339()).is_err());
    }
}
