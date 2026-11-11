use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Deserialize;

use super::{reminder, Task, TaskFilter};
use crate::db::{new_id, now_iso};
use crate::error::{AppError, AppResult};

const COLUMNS: &str = "id, title, description, status, priority, due_at, started_at, \
                       completed_at, estimate_min, tags, source, created_at, updated_at";

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let tags_raw: String = row.get("tags")?;
    Ok(Task {
        id: row.get("id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        status: row.get("status")?,
        priority: row.get("priority")?,
        due_at: row.get("due_at")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
        estimate_min: row.get("estimate_min")?,
        tags: serde_json::from_str(&tags_raw).unwrap_or_default(),
        source: row.get("source")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        reminders: Vec::new(),
        ask_count: 0,
    })
}

/// 列表查询。默认只返回未完成的任务，按「有截止时间的在前 → 时间近的在前 → 优先级高的在前」排序。
pub fn list(conn: &Connection, filter: &TaskFilter) -> AppResult<Vec<Task>> {
    let mut sql = format!("SELECT {COLUMNS} FROM task WHERE deleted_at IS NULL");
    let mut args: Vec<String> = Vec::new();

    // 状态用字面量拼接（取值已枚举，无注入风险）；关键词用参数绑定
    match filter.status.as_deref() {
        Some("all") => {}
        Some("done") => sql.push_str(" AND status = 'done'"),
        Some("doing") => sql.push_str(" AND status = 'doing'"),
        Some("todo") | None => sql.push_str(" AND status IN ('todo','doing')"),
        Some(other) => {
            return Err(AppError::Invalid(format!("未知的状态筛选：{other}")));
        }
    }

    if let Some(q) = filter.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        sql.push_str(" AND (title LIKE ?1 OR description LIKE ?1)");
        args.push(format!("%{q}%"));
    }

    sql.push_str(" ORDER BY due_at IS NULL, due_at ASC, priority DESC, created_at ASC");

    let limit = filter.limit.unwrap_or(200).clamp(1, 200);
    sql.push_str(&format!(" LIMIT {limit}"));

    let mut stmt = conn.prepare(&sql)?;
    let mut tasks = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), row_to_task)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // 数据量小（单机待办），逐个补提醒比拼复杂 JOIN 更易读
    for task in &mut tasks {
        task.reminders = reminder::list_for_task(conn, &task.id)?;
    }

    Ok(tasks)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Task> {
    let mut task = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM task WHERE id = ?1 AND deleted_at IS NULL"),
            [id],
            row_to_task,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("待办 {id} 不存在")))?;

    task.reminders = reminder::list_for_task(conn, id)?;
    Ok(task)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub due_at: Option<String>,
    pub priority: Option<i64>,
    pub estimate_min: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source: Option<String>,
    /// 相对截止时间的提前秒数（负数）。不传用默认值，传空数组表示不提醒。
    pub remind_offsets: Option<Vec<i64>>,
    /// 是否开启定时追问，默认开启
    pub ask_progress: Option<bool>,
}

pub fn create(conn: &Connection, input: NewTask) -> AppResult<Task> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::Invalid("标题不能为空".into()));
    }
    if title.chars().count() > 200 {
        return Err(AppError::Invalid("标题不能超过 200 字".into()));
    }

    let id = new_id();
    let now = now_iso();
    let priority = input.priority.unwrap_or(1).clamp(0, 3);
    let tags = serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".into());
    let source = input.source.unwrap_or_else(|| "manual".into());

    conn.execute(
        &format!(
            "INSERT INTO task ({COLUMNS})
             VALUES (?1, ?2, ?3, 'todo', ?4, ?5, NULL, NULL, ?6, ?7, ?8, ?9, ?9)"
        ),
        params![
            id,
            title,
            input.description,
            priority,
            input.due_at,
            input.estimate_min,
            tags,
            source,
            now
        ],
    )?;

    if let Some(due) = input.due_at.as_deref() {
        match input.remind_offsets.as_deref() {
            // 显式传空数组 = 用户不想被提醒
            Some([]) => {}
            offsets => {
                reminder::create_for_due(conn, &id, due, offsets)?;
            }
        }

        if input.ask_progress.unwrap_or(true) {
            reminder::create_progress_checks(conn, &id, due, chrono::Utc::now())?;
        }
    }

    get(conn, &id)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub due_at: Option<String>,
    /// 为 true 时清空截止时间（与 due_at 互斥，clear_due 优先）
    #[serde(default)]
    pub clear_due: bool,
    pub priority: Option<i64>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
}

pub fn update(conn: &Connection, id: &str, patch: TaskPatch) -> AppResult<Task> {
    // 先确认存在，避免 UPDATE 影响 0 行时无法区分「不存在」和「无变化」
    let _ = get(conn, id)?;

    if let Some(status) = patch.status.as_deref() {
        if !["todo", "doing", "archived"].contains(&status) {
            return Err(AppError::Invalid(
                "状态只能是 todo / doing / archived；标记完成请用 complete".into(),
            ));
        }
    }

    if let Some(title) = patch.title.as_deref() {
        if title.trim().is_empty() {
            return Err(AppError::Invalid("标题不能为空".into()));
        }
    }

    let now = now_iso();
    let tags = patch
        .tags
        .as_ref()
        .and_then(|t| serde_json::to_string(t).ok());

    conn.execute(
        "UPDATE task SET
           title       = COALESCE(?2, title),
           description = COALESCE(?3, description),
           due_at      = CASE WHEN ?4 = 1 THEN NULL ELSE COALESCE(?5, due_at) END,
           priority    = COALESCE(?6, priority),
           status      = COALESCE(?7, status),
           tags        = COALESCE(?8, tags),
           started_at  = CASE WHEN ?7 = 'doing' AND started_at IS NULL THEN ?9 ELSE started_at END,
           updated_at  = ?9
         WHERE id = ?1 AND deleted_at IS NULL",
        params![
            id,
            patch.title.map(|t| t.trim().to_string()),
            patch.description,
            i64::from(patch.clear_due),
            patch.due_at,
            patch.priority.map(|p| p.clamp(0, 3)),
            patch.status,
            tags,
            now
        ],
    )?;

    get(conn, id)
}

/// 标记完成：写 completed_at、关停所有提醒，两个动作必须一致。
pub fn complete(conn: &Connection, id: &str, note: Option<&str>) -> AppResult<Task> {
    let now = now_iso();

    let changed = conn.execute(
        "UPDATE task SET
           status       = 'done',
           completed_at = ?2,
           updated_at   = ?2,
           description  = CASE
                            WHEN ?3 IS NULL OR ?3 = '' THEN description
                            WHEN description = '' THEN ?3
                            ELSE description || char(10) || ?3
                          END
         WHERE id = ?1 AND deleted_at IS NULL AND status != 'done'",
        params![id, now, note],
    )?;

    if changed == 0 {
        // 已经是 done 的重复调用视为幂等成功
        let task = get(conn, id)?;
        if task.status == "done" {
            return Ok(task);
        }
        return Err(AppError::NotFound(format!("待办 {id} 不存在")));
    }

    reminder::stop_all_for_task(conn, id)?;
    get(conn, id)
}

/// 记录用户对追问的回答，并据此调整任务状态与后续追问频率。
///
/// - `done`        标记完成（同时关停所有提醒）
/// - `doing`       置为进行中，写入 started_at
/// - `not_started` 状态不变，但连续两次后会取消剩余追问
/// - `ignored`     用户直接关掉气泡，不做任何变更
pub fn answer_progress(conn: &Connection, task_id: &str, answer: &str) -> AppResult<Task> {
    if !["done", "doing", "not_started", "ignored"].contains(&answer) {
        return Err(AppError::Invalid(format!("未知的回答：{answer}")));
    }

    // 先确认任务存在
    let _ = get(conn, task_id)?;
    let now = now_iso();

    // 回填最近一条「已问但没答」的记录；找不到就补一条（用户主动回答的场景）
    let updated = conn.execute(
        "UPDATE progress_log SET answer = ?2, answered_at = ?3
         WHERE id = (
             SELECT id FROM progress_log
             WHERE task_id = ?1 AND answer IS NULL
             ORDER BY asked_at DESC LIMIT 1
         )",
        params![task_id, answer, now],
    )?;

    if updated == 0 {
        conn.execute(
            "INSERT INTO progress_log (id, task_id, asked_at, answer, answered_at)
             VALUES (?1, ?2, ?3, ?4, ?3)",
            params![new_id(), task_id, now, answer],
        )?;
    }

    match answer {
        "done" => {
            let _ = complete(conn, task_id, None)?;
        }
        "doing" => {
            let patch = TaskPatch {
                status: Some("doing".into()),
                ..Default::default()
            };
            let _ = update(conn, task_id, patch)?;
        }
        "not_started" => {
            maybe_downgrade(conn, task_id)?;
        }
        _ => {}
    }

    get(conn, task_id)
}

/// 连续两次回答「还没开始」就把剩余追问全部取消。
///
/// 产品意图是：用户明确表达了拖延，继续高频追问只会让人反感，
/// 不如闭嘴，让任务自己在列表里变红。
fn maybe_downgrade(conn: &Connection, task_id: &str) -> AppResult<()> {
    let recent: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT answer FROM progress_log
             WHERE task_id = ?1 AND answer IS NOT NULL
             ORDER BY asked_at DESC LIMIT 2",
        )?;
        stmt.query_map([task_id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    if recent.len() == 2 && recent.iter().all(|a| a == "not_started") {
        reminder::cancel_pending_asks(conn, task_id)?;
    }

    Ok(())
}

/// 软删除，30 天内可从库中恢复。
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE task SET deleted_at = ?2, updated_at = ?2
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )?;

    if changed == 0 {
        return Err(AppError::NotFound(format!("待办 {id} 不存在")));
    }

    reminder::stop_all_for_task(conn, id)?;
    Ok(())
}

pub fn reopen(conn: &Connection, id: &str) -> AppResult<Task> {
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE task SET status = 'todo', completed_at = NULL, updated_at = ?2
         WHERE id = ?1 AND deleted_at IS NULL AND status = 'done'",
        params![id, now],
    )?;

    if changed == 0 {
        return Err(AppError::Invalid("只有已完成的任务可以重新打开".into()));
    }

    // 提醒不自动恢复，避免用户刚撤销就又被提醒
    get(conn, id)
}

/// 今天的统计摘要，供面板头部与 M4 的 get_today_brief 使用。
#[derive(Debug, serde::Serialize)]
pub struct DayBrief {
    pub total: i64,
    pub done: i64,
    pub pending: i64,
    pub overdue: i64,
}

pub fn today_brief(conn: &Connection) -> AppResult<DayBrief> {
    let today_start = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 一定合法")
        .and_local_timezone(chrono::Local)
        .earliest()
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| now_iso());

    let now = now_iso();

    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task
         WHERE deleted_at IS NULL AND status = 'done' AND completed_at >= ?1",
        [&today_start],
        |r| r.get(0),
    )?;

    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task
         WHERE deleted_at IS NULL AND status IN ('todo','doing')",
        [],
        |r| r.get(0),
    )?;

    let overdue: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task
         WHERE deleted_at IS NULL AND status IN ('todo','doing')
           AND due_at IS NOT NULL AND due_at < ?1",
        [&now],
        |r| r.get(0),
    )?;

    Ok(DayBrief {
        total: done + pending,
        done,
        pending,
        overdue,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::reminder;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../schema.sql")).unwrap();
        conn
    }

    fn sample(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            description: String::new(),
            due_at: None,
            priority: None,
            estimate_min: None,
            tags: vec![],
            source: None,
            remind_offsets: None,
            ask_progress: None,
        }
    }

    fn in_hours(h: i64) -> String {
        (chrono::Utc::now() + chrono::Duration::hours(h))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    #[test]
    fn create_then_list() {
        let conn = mem();
        let task = create(&conn, sample("写周报")).unwrap();
        assert_eq!(task.status, "todo");
        assert_eq!(task.priority, 1);

        let all = list(&conn, &TaskFilter::default()).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "写周报");
    }

    #[test]
    fn blank_title_rejected() {
        let conn = mem();
        assert!(create(&conn, sample("   ")).is_err());
    }

    #[test]
    fn due_task_gets_default_reminders() {
        let conn = mem();
        let mut input = sample("交周报");
        input.due_at = Some(in_hours(2));
        let task = create(&conn, input).unwrap();
        // 默认提前 30 分钟、10 分钟各一条 notify（追问是另一类，单独计数）
        let notify = task.reminders.iter().filter(|r| r.kind == "notify").count();
        assert_eq!(notify, 2);
    }

    #[test]
    fn empty_offsets_means_no_reminder() {
        let conn = mem();
        let mut input = sample("不提醒");
        input.due_at = Some(in_hours(2));
        input.remind_offsets = Some(vec![]);
        let task = create(&conn, input).unwrap();
        // 空 offsets 只关掉 notify；追问由 ask_progress 单独控制
        assert!(task.reminders.iter().all(|r| r.kind != "notify"));
    }

    #[test]
    fn complete_stops_reminders_and_appends_note() {
        let conn = mem();
        let mut input = sample("交周报");
        input.due_at = Some(in_hours(2));
        let task = create(&conn, input).unwrap();
        assert!(!task.reminders.is_empty());

        let done = complete(&conn, &task.id, Some("已提交")).unwrap();
        assert_eq!(done.status, "done");
        assert!(done.completed_at.is_some());
        assert!(done.reminders.is_empty(), "完成后提醒必须全部关停");
        assert!(done.description.contains("已提交"));
    }

    #[test]
    fn complete_is_idempotent() {
        let conn = mem();
        let task = create(&conn, sample("x")).unwrap();
        complete(&conn, &task.id, None).unwrap();
        // 重复完成不应该报错
        let again = complete(&conn, &task.id, None).unwrap();
        assert_eq!(again.status, "done");
    }

    #[test]
    fn soft_delete_hides_from_list_and_get() {
        let conn = mem();
        let task = create(&conn, sample("买咖啡")).unwrap();
        delete(&conn, &task.id).unwrap();

        assert!(list(&conn, &TaskFilter::default()).unwrap().is_empty());
        assert!(get(&conn, &task.id).is_err());
    }

    #[test]
    fn update_can_clear_due() {
        let conn = mem();
        let mut input = sample("带时间的");
        input.due_at = Some(in_hours(1));
        let task = create(&conn, input).unwrap();
        assert!(task.due_at.is_some());

        let patch = TaskPatch {
            clear_due: true,
            ..Default::default()
        };
        let updated = update(&conn, &task.id, patch).unwrap();
        assert!(updated.due_at.is_none());
    }

    #[test]
    fn update_rejects_done_status() {
        let conn = mem();
        let task = create(&conn, sample("x")).unwrap();
        let patch = TaskPatch {
            status: Some("done".into()),
            ..Default::default()
        };
        assert!(
            update(&conn, &task.id, patch).is_err(),
            "完成必须走 complete，不能绕过提醒关停"
        );
    }

    #[test]
    fn marking_doing_sets_started_at() {
        let conn = mem();
        let task = create(&conn, sample("进行中")).unwrap();
        assert!(task.started_at.is_none());

        let patch = TaskPatch {
            status: Some("doing".into()),
            ..Default::default()
        };
        let updated = update(&conn, &task.id, patch).unwrap();
        assert!(updated.started_at.is_some());
    }

    #[test]
    fn snooze_moves_next_fire() {
        let conn = mem();
        let mut input = sample("推迟测试");
        input.due_at = Some(in_hours(2));
        let task = create(&conn, input).unwrap();

        let next = reminder::snooze(&conn, &task.id, 30).unwrap();
        assert!(next.is_some());
        assert!(reminder::snooze(&conn, &task.id, 0).is_err(), "0 分钟应被拒绝");
    }

    #[test]
    fn list_sorts_overdue_first() {
        let conn = mem();
        create(&conn, sample("没有时间的")).unwrap();
        let mut late = sample("晚点到期");
        late.due_at = Some(in_hours(5));
        create(&conn, late).unwrap();
        let mut early = sample("早点到期");
        early.due_at = Some(in_hours(1));
        create(&conn, early).unwrap();

        let all = list(&conn, &TaskFilter::default()).unwrap();
        assert_eq!(all[0].title, "早点到期");
        assert_eq!(all[1].title, "晚点到期");
        assert_eq!(all[2].title, "没有时间的");
    }

    // ---- 追问相关 ----

    fn pending_asks(conn: &Connection, task_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM reminder
             WHERE task_id = ?1 AND kind = 'ask' AND state = 'pending'",
            [task_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn due_task_generates_progress_checks() {
        let conn = mem();
        let mut input = sample("有追问的");
        input.due_at = Some(in_hours(10));
        let task = create(&conn, input).unwrap();
        // 50% / 80% / 95% 三个点都在未来
        assert_eq!(pending_asks(&conn, &task.id), 3);
    }

    #[test]
    fn ask_progress_can_be_disabled() {
        let conn = mem();
        let mut input = sample("不要追问");
        input.due_at = Some(in_hours(10));
        input.ask_progress = Some(false);
        let task = create(&conn, input).unwrap();
        assert_eq!(pending_asks(&conn, &task.id), 0);
    }

    #[test]
    fn answer_doing_marks_task_doing() {
        let conn = mem();
        let task = create(&conn, sample("进行中")).unwrap();
        let updated = answer_progress(&conn, &task.id, "doing").unwrap();
        assert_eq!(updated.status, "doing");
        assert!(updated.started_at.is_some());
    }

    #[test]
    fn answer_done_completes_task() {
        let conn = mem();
        let mut input = sample("完成它");
        input.due_at = Some(in_hours(10));
        let task = create(&conn, input).unwrap();

        let updated = answer_progress(&conn, &task.id, "done").unwrap();
        assert_eq!(updated.status, "done");
        assert!(updated.reminders.is_empty(), "完成后提醒应全部关停");
    }

    #[test]
    fn two_not_started_cancels_remaining_asks() {
        let conn = mem();
        let mut input = sample("拖延任务");
        input.due_at = Some(in_hours(10));
        let task = create(&conn, input).unwrap();
        assert!(pending_asks(&conn, &task.id) > 0);

        answer_progress(&conn, &task.id, "not_started").unwrap();
        answer_progress(&conn, &task.id, "not_started").unwrap();

        assert_eq!(
            pending_asks(&conn, &task.id),
            0,
            "连续两次「还没开始」后应取消剩余追问"
        );
    }

    #[test]
    fn single_not_started_keeps_asks() {
        let conn = mem();
        let mut input = sample("只拖了一次");
        input.due_at = Some(in_hours(10));
        let task = create(&conn, input).unwrap();
        let before = pending_asks(&conn, &task.id);

        answer_progress(&conn, &task.id, "not_started").unwrap();

        assert_eq!(pending_asks(&conn, &task.id), before, "只拖一次不该降级");
    }

    #[test]
    fn invalid_answer_rejected() {
        let conn = mem();
        let task = create(&conn, sample("x")).unwrap();
        assert!(answer_progress(&conn, &task.id, "whatever").is_err());
    }
}
