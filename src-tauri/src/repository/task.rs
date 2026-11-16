use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Deserialize;

use super::{reminder, Task, TaskFilter};
use crate::db::{new_id, now_iso};
use crate::error::{AppError, AppResult};
use crate::recur::RecurRule;
use crate::sync::{self, Entity};

const COLUMNS: &str = "id, title, description, status, priority, due_at, start_at, started_at, \
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
        start_at: row.get("start_at")?,
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

/// 新建待办的入参。
///
/// **字段名一律 snake_case**：这条边界上的另一端是 `invoke("create_task", { input })`，
/// 前端发的就是 `start_at` / `due_at` / `remind_offsets`，与 `Task` 序列化回前端的形状一致。
/// 曾经这里挂过 `#[serde(rename_all = "camelCase")]`，serde 默认忽略未知字段，
/// 于是 `start_at` 被静默丢弃、变成 None，待办存进去却没有开始时间——不报错，最难查。
/// 现在用 `deny_unknown_fields` 把这类拼写不一致直接变成一条明确的报错。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub due_at: Option<String>,
    /// 计划开始时间。传了就在这个点提醒一次（「开始时提醒」）。
    pub start_at: Option<String>,
    pub priority: Option<i64>,
    pub estimate_min: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source: Option<String>,
    /// 相对截止时间的提前秒数（负数）。不传用默认值，传空数组表示不提醒。
    pub remind_offsets: Option<Vec<i64>>,
    /// 是否开启定时追问，默认开启
    pub ask_progress: Option<bool>,
    /// 循环提醒规则（每天 / 每周 / 工作日 / 节假日），不传表示不循环
    pub recur: Option<RecurRule>,
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

    // 待办和它的一串提醒必须一起落库：拆开写会出现「任务建好了但提醒没建」，
    // 而用户看到的只是「这个任务怎么不提醒我」。
    sync::mutate(conn, Entity::Task, &id, |tx| {
        tx.execute(
            &format!(
                "INSERT INTO task ({COLUMNS})
                 VALUES (?1, ?2, ?3, 'todo', ?4, ?5, ?6, NULL, NULL, ?7, ?8, ?9, ?10, ?10)"
            ),
            params![
                id,
                title,
                input.description,
                priority,
                input.due_at,
                input.start_at,
                input.estimate_min,
                tags,
                source,
                now
            ],
        )?;

        // 开始时提醒：准点一次。打上 origin 标记，气泡才知道该给「已开始」而不是「已完成」
        if let Some(start) = input.start_at.as_deref() {
            reminder::create_at(tx, &id, "notify", start, Some(reminder::ORIGIN_START))?;
        }

        if let Some(due) = input.due_at.as_deref() {
            match input.remind_offsets.as_deref() {
                // 显式传空数组 = 用户不想被提醒
                Some([]) => {}
                offsets => {
                    reminder::create_for_due(tx, &id, due, offsets)?;
                }
            }

            if input.ask_progress.unwrap_or(true) {
                reminder::create_progress_checks(tx, &id, due, chrono::Utc::now())?;
            }
        }

        // 循环提醒：与开始/结束时间互相独立，可以同时存在
        if let Some(rule) = input.recur.as_ref().filter(|r| r.is_recurring()) {
            reminder::create_recurring(tx, &id, rule)?;
        }

        Ok(())
    })?;

    get(conn, &id)
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
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

    sync::mutate(conn, Entity::Task, id, |tx| {
        tx.execute(
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
        Ok(())
    })?;

    get(conn, id)
}

/// 标记完成：写 completed_at、关停所有提醒，两个动作必须一致。
pub fn complete(conn: &Connection, id: &str, note: Option<&str>) -> AppResult<Task> {
    // 先看状态再动手：已经完成的重复调用直接返回，不进 mutate——
    // 否则每点一次都会往 outbox 投一条内容完全一样的记录。
    let current = get(conn, id)?;
    if current.status == "done" {
        return Ok(current);
    }

    let now = now_iso();

    sync::mutate(conn, Entity::Task, id, |tx| {
        tx.execute(
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

        // 提醒和任务同事务关停，否则可能「任务已完成但气泡还在响」
        reminder::stop_all_for_task(tx, id)?;
        Ok(())
    })?;

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

    sync::mutate(conn, Entity::Task, task_id, |tx| {
        // 回填最近一条「已问但没答」的记录；找不到就补一条（用户主动回答的场景）
        let updated = tx.execute(
            "UPDATE progress_log SET answer = ?2, answered_at = ?3
             WHERE id = (
                 SELECT id FROM progress_log
                 WHERE task_id = ?1 AND answer IS NULL
                 ORDER BY asked_at DESC LIMIT 1
             )",
            params![task_id, answer, now],
        )?;

        if updated == 0 {
            tx.execute(
                "INSERT INTO progress_log (id, task_id, asked_at, answer, answered_at)
                 VALUES (?1, ?2, ?3, ?4, ?3)",
                params![new_id(), task_id, now, answer],
            )?;
        }

        // 状态变更走各自的老函数：它们内部也走 mutate，靠 with_tx 汇进这一个事务
        match answer {
            "done" => {
                let _ = complete(tx, task_id, None)?;
            }
            "doing" => {
                let patch = TaskPatch {
                    status: Some("doing".into()),
                    ..Default::default()
                };
                let _ = update(tx, task_id, patch)?;
            }
            "not_started" => {
                maybe_downgrade(tx, task_id)?;
            }
            _ => {}
        }

        Ok(())
    })?;

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

    sync::mutate(conn, Entity::Task, id, |tx| {
        let changed = tx.execute(
            "UPDATE task SET deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )?;

        if changed == 0 {
            // 返回错误会连同事务一起回滚，不会往 outbox 留一条假变更
            return Err(AppError::NotFound(format!("待办 {id} 不存在")));
        }

        reminder::stop_all_for_task(tx, id)?;
        Ok(())
    })
}

/// 清空历史：把已完成的待办整体软删。
///
/// 走软删（`deleted_at`）而不是 `DELETE`，和单条删除保持一致——误点了还能从库里捞回来。
/// 已完成的待办理论上没有待触发的提醒，仍然顺手停一遍，免得历史清完还有气泡弹出来。
pub fn clear_done(conn: &Connection) -> AppResult<usize> {
    let now = now_iso();

    // 先取 id 再更新：每次批量写都要为「被改动的每一行」各投一条 outbox，
    // 事后从库里反查是查不出来的（改完之后条件已经不成立了）
    let ids: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT id FROM task WHERE status = 'done' AND deleted_at IS NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    if ids.is_empty() {
        return Ok(0);
    }

    sync::mutate_many(conn, Entity::Task, &ids, |tx| {
        let changed = tx.execute(
            "UPDATE task SET deleted_at = ?1, updated_at = ?1
             WHERE status = 'done' AND deleted_at IS NULL",
            params![now],
        )?;

        for id in &ids {
            reminder::stop_all_for_task(tx, id)?;
        }

        Ok(changed)
    })
}

pub fn reopen(conn: &Connection, id: &str) -> AppResult<Task> {
    let now = now_iso();

    sync::mutate(conn, Entity::Task, id, |tx| {
        let changed = tx.execute(
            "UPDATE task SET status = 'todo', completed_at = NULL, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL AND status = 'done'",
            params![id, now],
        )?;

        if changed == 0 {
            return Err(AppError::Invalid("只有已完成的任务可以重新打开".into()));
        }

        Ok(())
    })?;

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
            start_at: None,
            priority: None,
            estimate_min: None,
            tags: vec![],
            source: None,
            remind_offsets: None,
            ask_progress: None,
            recur: None,
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
    fn start_at_creates_one_shot_reminder() {
        let conn = mem();
        let mut input = sample("开会");
        input.start_at = Some(in_hours(2));
        let task = create(&conn, input).unwrap();

        assert!(task.start_at.is_some());
        assert_eq!(
            task.reminders.iter().filter(|r| r.kind == "notify").count(),
            1,
            "开始时间应生成一条准点提醒"
        );
    }

    #[test]
    fn new_task_accepts_the_panel_payload() {
        // 面板 invoke("create_task", { input }) 发的就是这几个键（snake_case）
        let raw = r#"{
            "title": "222",
            "start_at": "2026-11-12T02:30:00.000Z",
            "due_at": null,
            "remind_offsets": null,
            "recur": null
        }"#;
        let input: NewTask = serde_json::from_str(raw).expect("面板的 payload 必须能反序列化");
        assert!(
            input.start_at.is_some(),
            "start_at 被静默丢弃了——字段名和前端对不上"
        );
        assert!(input.due_at.is_none());
    }

    #[test]
    fn new_task_rejects_misspelled_keys() {
        // 键名拼错要报错，不能像以前那样静默变成 None
        let raw = r#"{"title":"x","startAt":"2026-11-12T02:30:00Z"}"#;
        assert!(serde_json::from_str::<NewTask>(raw).is_err());
    }

    #[test]
    fn recurring_rule_creates_repeating_reminder() {
        let conn = mem();
        let mut input = sample("每天喝水");
        input.recur = Some(RecurRule::Daily {
            time: "09:00".into(),
        });
        let task = create(&conn, input).unwrap();

        let recurring: Vec<_> = task
            .reminders
            .iter()
            .filter(|r| r.rule.contains("\"daily\""))
            .collect();
        assert_eq!(recurring.len(), 1);
        assert_eq!(recurring[0].state, "pending");
    }

    #[test]
    fn start_and_due_and_recur_can_coexist() {
        let conn = mem();
        let mut input = sample("三个开关全开");
        input.start_at = Some(in_hours(1));
        input.due_at = Some(in_hours(3));
        input.remind_offsets = Some(vec![0]);
        input.recur = Some(RecurRule::Workday {
            time: "09:00".into(),
        });
        let task = create(&conn, input).unwrap();

        // 1 条开始 + 1 条准点结束 + 3 条追问 + 1 条循环
        assert_eq!(
            task.reminders.iter().filter(|r| r.kind == "notify").count(),
            3
        );
        assert_eq!(task.reminders.iter().filter(|r| r.kind == "ask").count(), 3);
    }

    #[test]
    fn empty_offsets_means_no_reminder() {        let conn = mem();
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
