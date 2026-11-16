//! 同步的写路径：**推进 HLC → 更新业务行 → 投 outbox**，三件事一个事务。
//!
//! 为什么不让每个 repository 自己写一遍：漏一处的后果是「数据改了但没进队列」，
//! 而这种现象在本地完全看不出来——要等用户换设备才发现某条改动作没传过去，
//! 到那时已经无从追溯。所以收敛成一个入口 [`mutate`]，并有单测守着
//! （见文件末尾 `every_write_function_leaves_an_outbox_row`）。
//!
//! ## 三件事为什么必须同事务
//!
//! - 只写业务行不投 outbox → 静默丢失（上面说的）；
//! - 只投 outbox 不写业务行 → 对端收到一条本地并不存在的变更，拉回来又覆盖回去，来回震荡；
//! - hlc 落在 outbox 里但没落到行上 → 本地和远端的版本号对不上，永远在「谁更新」上打架。
//!
//! ## 幂等与噪声
//!
//! 0 行命中（重复调用、对象已删）也会投一条记录，payload 就是当前行的样子。
//! 这不影响正确性——行级 LWW 收到一条和原来一模一样的快照等于没变——
//! 换来的是调用点不用传「到底改没改」这种容易传错的标志。

use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Map, Value};

use crate::db::{new_id, now_iso};
use crate::error::AppResult;
use crate::hlc::{DeviceId, Hlc};

/// `sync_state` 里存本机设备号的键
const KEY_DEVICE_ID: &str = "device_id";
/// `sync_state` 里存时钟水位的键
const KEY_LAST_HLC: &str = "last_hlc";

/// 参与同步的实体。`progress_log` / `event_log` 不在其中：
/// 前者是追问记录（设备各记各的），后者是操作日志（本地留痕，给历史页看）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entity {
    Task,
    Note,
    Reminder,
    Tag,
}

impl Entity {
    /// 表名 / outbox 里的实体名。两张表同名是刻意的——同步端按实体名找表。
    pub fn as_str(self) -> &'static str {
        match self {
            Entity::Task => "task",
            Entity::Note => "note",
            Entity::Reminder => "reminder",
            Entity::Tag => "tag",
        }
    }
}

/// 一次变更的性质。
///
/// 待办和备忘是软删，删除也走 `upsert`（payload 里 `deleted_at` 非空就是对端的墓碑）；
/// 标签是硬删，行已经没了，只能单独投一条 `delete`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Upsert,
    Delete,
}

impl Op {
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Upsert => "upsert",
            Op::Delete => "delete",
        }
    }
}

/// 可重入的事务。
///
/// 写路径会层层嵌套（`task::complete` → `reminder::stop_all_for_task` → 每个提醒各自投一条），
/// 而 SQLite 不支持嵌套 `BEGIN`：内层再开一次会直接报
/// `cannot start a transaction within a transaction`。
///
/// 所以用 `is_autocommit` 判断「是不是已经有外层事务」：有就直接复用，
/// 让最外层那个统一提交。这样每个函数单测时各管各的事务，
/// 被组合调用时又天然是原子的，调用方不用区分两种场景。
pub fn with_tx<T>(
    conn: &Connection,
    apply: impl FnOnce(&Connection) -> AppResult<T>,
) -> AppResult<T> {
    if !conn.is_autocommit() {
        return apply(conn);
    }

    let tx = conn.unchecked_transaction()?;
    let value = apply(&tx)?;
    tx.commit()?;
    Ok(value)
}

/// 一次写操作的统一入口：业务写成功才投 outbox，失败则一起回滚。
///
/// 闭包里拿到的已经是事务，**不要再自己开事务**（用 [`with_tx`] 就不会撞）。
pub fn mutate<T>(
    conn: &Connection,
    entity: Entity,
    entity_id: &str,
    apply: impl FnOnce(&Connection) -> AppResult<T>,
) -> AppResult<T> {
    mutate_many(conn, entity, &[entity_id.to_string()], apply)
}

/// 一次操作动到多行时用（停提醒、清空历史）。每行各投一条，同步端按行合并。
pub fn mutate_many<T>(
    conn: &Connection,
    entity: Entity,
    entity_ids: &[String],
    apply: impl FnOnce(&Connection) -> AppResult<T>,
) -> AppResult<T> {
    with_tx(conn, |tx| {
        let value = apply(tx)?;
        for id in entity_ids {
            record(tx, entity, id)?;
        }
        Ok(value)
    })
}

/// 推进时钟、把时钟落到业务行上、投一条 outbox。
fn record(conn: &Connection, entity: Entity, entity_id: &str) -> AppResult<()> {
    let stamped = next_hlc(conn)?;
    let stamp = stamped.to_string();
    let table = entity.as_str();

    // 行上的 hlc 和 outbox 里的 hlc 必须是同一个值：对端拿 outbox 的 hlc 做比较，
    // 再按 payload 写自己的行——两边不一致的话，「谁更新」会永远算不清。
    conn.execute(
        &format!("UPDATE {table} SET hlc = ?1, origin = ?2 WHERE id = ?3"),
        params![stamp, stamped.device().to_string(), entity_id],
    )?;

    let (op, payload) = match snapshot(conn, entity, entity_id)? {
        Some(value) => (op_of(&value), value),
        // 行已经不在了（标签硬删）：只能投一个只有 id 的墓碑
        None => (Op::Delete, json!({ "id": entity_id })),
    };

    conn.execute(
        "INSERT INTO outbox (op_id, entity, entity_id, op, payload, hlc, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new_id(),
            table,
            entity_id,
            op.as_str(),
            payload.to_string(),
            stamp,
            now_iso()
        ],
    )?;

    Ok(())
}

/// 软删的行 payload 里带 `deleted_at`，语义上已经是墓碑，但 outbox 的 op 也标成
/// `delete`——推送端不用解析 payload 就能过滤出删除，流量最省。
fn op_of(row: &Value) -> Op {
    match row.get("deleted_at") {
        Some(Value::String(_)) => Op::Delete,
        _ => Op::Upsert,
    }
}

/// 下一个时钟读数。
///
/// 每次都从库里的水位续上，不进程内缓存：GUI 和 MCP 是两个进程，各记各的时钟
/// 迟早会互相压过（MCP 写过之后 GUI 拿旧时钟再写，对端就会把 GUI 的修改判成更旧）。
/// 代价是每次写多一次主键查询，对单人待办完全可以忽略。
fn next_hlc(conn: &Connection) -> AppResult<Hlc> {
    let mut clock = Hlc::new(device_id(conn)?);

    // 水位可能比本进程记忆的更靠前（别的进程刚写过、或者上次没来得及落库）
    if let Some(stored) = state(conn, KEY_LAST_HLC)? {
        if let Ok(remote) = Hlc::parse(&stored) {
            clock.observe(&remote);
        }
    }

    let stamped = clock.tick();
    set_state(conn, KEY_LAST_HLC, &stamped.to_string())?;
    Ok(stamped)
}

/// 本机设备号，第一次用到时生成后落库。
///
/// 取 uuid v7 的尾部随机段（8 位 hex），不取时间戳高位——同一毫秒生成的一批
/// uuid 开头是一样的。
pub fn device_id(conn: &Connection) -> AppResult<DeviceId> {
    if let Some(raw) = state(conn, KEY_DEVICE_ID)? {
        if let Ok(id) = DeviceId::parse(&raw) {
            return Ok(id);
        }
    }

    let id = DeviceId::from_uuid(uuid::Uuid::now_v7());
    set_state(conn, KEY_DEVICE_ID, &id.to_string())?;
    Ok(id)
}

fn state(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn set_state(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// 当前行的完整快照，作为 outbox 的 payload。
///
/// 用 `SELECT *` 而不是手写列清单：加列时这里自动跟上，不会因为漏写某个字段
/// 让同步过去的行悄悄少一半信息。代价是列顺序依赖表定义，但 payload 是 JSON 对象，
/// 消费端按字段名取，不受顺序影响。
fn snapshot(conn: &Connection, entity: Entity, id: &str) -> AppResult<Option<Value>> {
    let table = entity.as_str();
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE id = ?1"))?;
    let columns: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();

    let mut rows = stmt.query([id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    let mut object = Map::with_capacity(columns.len());
    for (index, name) in columns.iter().enumerate() {
        object.insert(name.clone(), cell(row, index)?);
    }

    shape(entity, conn, id, &mut object)?;
    Ok(Some(Value::Object(object)))
}

/// 把几个「存成 JSON 字符串」或「存在关联表里」的字段摊平成真正的数组。
///
/// 待办的标签本来就是一段 JSON 文本，摊平即可；备忘的标签存在 `note_tag`，
/// 要查出来拼成 id 数组——标签关系不单独同步，跟着备忘的快照一起走，
/// 否则两台设备各改一次标签，LWW 只会留下其中一份关系。
fn shape(
    entity: Entity,
    conn: &Connection,
    id: &str,
    object: &mut Map<String, Value>,
) -> AppResult<()> {
    match entity {
        Entity::Task => {
            if let Some(Value::String(raw)) = object.get("tags") {
                if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
                    object.insert("tags".into(), parsed);
                }
            }
        }
        Entity::Note => {
            object.insert("tags".into(), Value::Array(tag_ids(conn, id)?));
        }
        Entity::Reminder | Entity::Tag => {}
    }
    Ok(())
}

fn tag_ids(conn: &Connection, note_id: &str) -> AppResult<Vec<Value>> {
    let mut stmt =
        conn.prepare("SELECT tag_id FROM note_tag WHERE note_id = ?1 ORDER BY tag_id")?;
    let ids = stmt
        .query_map([note_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids.into_iter().map(Value::String).collect())
}

/// 取一列的值转成 JSON。四种 SQLite 存储类型逐一映射，不留兜底分支。
fn cell(row: &Row<'_>, index: usize) -> rusqlite::Result<Value> {
    Ok(match row.get_ref(index)? {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        // 这几张表没有 BLOB 列，真出现了说明 schema 变了，转成文本比丢字段好排查
        ValueRef::Blob(bytes) => {
            use base64::Engine;
            Value::from(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::{note, reminder, tag, task};
    use rusqlite::Connection;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../schema.sql")).unwrap();
        conn
    }

    fn outbox_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .unwrap()
    }

    fn latest_payload(conn: &Connection) -> Value {
        let raw: String = conn
            .query_row(
                "SELECT payload FROM outbox ORDER BY hlc DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn stamp_of(conn: &Connection, table: &str, id: &str) -> String {
        conn.query_row(&format!("SELECT hlc FROM {table} WHERE id = ?1"), [id], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn new_task(title: &str) -> task::NewTask {
        task::NewTask {
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

    fn sample_task(conn: &Connection) -> String {
        task::create(conn, new_task("写周报")).unwrap().id
    }

    #[test]
    fn a_write_leaves_exactly_one_outbox_row() {
        let conn = mem();
        let before = outbox_count(&conn);
        let id = sample_task(&conn);

        assert_eq!(outbox_count(&conn), before + 1);

        let (entity, op, hlc): (String, String, String) = conn
            .query_row(
                "SELECT entity, op, hlc FROM outbox ORDER BY hlc DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(entity, "task");
        assert_eq!(op, "upsert");
        // outbox 的 hlc 和行上的一模一样，否则对端没法拿它比版本
        assert_eq!(hlc, stamp_of(&conn, "task", &id));
        assert_eq!(hlc.len(), crate::hlc::LEN);
    }

    #[test]
    fn payload_is_the_current_row() {
        let conn = mem();
        let id = sample_task(&conn);

        let payload = latest_payload(&conn);
        assert_eq!(payload["id"], Value::from(id.as_str()));
        assert_eq!(payload["title"], Value::from("写周报"));
        assert_eq!(payload["status"], Value::from("todo"));
        assert_eq!(payload["deleted_at"], Value::Null);
        // origin 就是本机设备号，出问题时能看出是哪台机器写的
        assert_eq!(payload["origin"], Value::from(device_id(&conn).unwrap().to_string()));
    }

    #[test]
    fn soft_delete_is_marked_as_a_delete() {
        let conn = mem();
        let id = sample_task(&conn);
        task::delete(&conn, &id).unwrap();

        let op: String = conn
            .query_row("SELECT op FROM outbox ORDER BY hlc DESC LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(op, "delete");
        // 墓碑仍然是整行快照：对端要能据此知道「删的是哪条」
        assert!(latest_payload(&conn)["deleted_at"].is_string());
    }

    #[test]
    fn failed_write_leaves_no_outbox_row() {
        let conn = mem();
        let before = outbox_count(&conn);

        let outcome: AppResult<()> = mutate(&conn, Entity::Task, "not-a-real-id", |tx| {
            tx.execute("UPDATE task SET title = 'x' WHERE id = 'not-a-real-id'", [])?;
            // 模拟业务侧校验失败
            Err(crate::error::AppError::Invalid("假装出错".into()))
        });

        assert!(outcome.is_err());
        assert_eq!(outbox_count(&conn), before, "写失败不该留下变更记录");
    }

    #[test]
    fn nested_writes_join_the_outer_transaction() {
        let conn = mem();
        // 这条任务会生成「开始提醒」+ 截止提醒 + 追问，全部嵌套在任务的 mutate 里
        let mut input = new_task("带提醒的");
        let soon = (chrono::Utc::now() + chrono::Duration::hours(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        input.start_at = Some(soon.clone());
        input.due_at = Some(soon);
        let created = task::create(&conn, input).unwrap();

        // 任务一条 + 每个提醒各一条，说明内层没有因为「不能嵌套事务」而报错
        let reminders: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE entity = 'reminder'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(reminders > 0, "提醒的写入没进 outbox");
        assert_eq!(
            outbox_count(&conn),
            1 + reminders,
            "outbox 条数应等于任务 1 条加上提醒条数"
        );
        // 业务数据本身也没被事务搞坏
        assert_eq!(task::get(&conn, &created.id).unwrap().title, "带提醒的");
    }

    #[test]
    fn clocks_are_strictly_increasing_across_writes() {
        let conn = mem();
        task::create(&conn, new_task("一")).unwrap();
        task::create(&conn, new_task("二")).unwrap();
        task::create(&conn, new_task("三")).unwrap();

        let stamps: Vec<String> = {
            let mut stmt = conn.prepare("SELECT hlc FROM outbox ORDER BY hlc").unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };

        assert_eq!(stamps.len(), 3);
        for pair in stamps.windows(2) {
            assert!(pair[0] < pair[1], "时钟没往前走：{} -> {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn device_id_is_generated_once_and_reused() {
        let conn = mem();
        let first = device_id(&conn).unwrap();
        let second = device_id(&conn).unwrap();

        assert_eq!(first, second, "设备号每次现生成的话，同步侧会以为是两台新机器");
        // 8 位 hex，和 hlc 的 device 段长度一致
        assert_eq!(first.to_string().len(), 8);
    }

    #[test]
    fn note_payload_carries_tag_ids_not_names() {
        let conn = mem();
        let work = tag::create(&conn, "工作").unwrap();
        let note = note::create(
            &conn,
            note::NewNote {
                body: "周报模板在 D 盘".into(),
                tags: Some(vec![work.tag.id.clone()]),
            },
        )
        .unwrap();

        let payload: Value = {
            let raw: String = conn
                .query_row(
                    "SELECT payload FROM outbox WHERE entity = 'note' AND entity_id = ?1",
                    [&note.id],
                    |row| row.get(0),
                )
                .unwrap();
            serde_json::from_str(&raw).unwrap()
        };

        // 存 id 不存名字：改标签名只牵动 tag 那一行，不用把所有备忘都改一遍
        assert_eq!(payload["tags"], json!([work.tag.id]));
        assert_eq!(payload["body"], Value::from("周报模板在 D 盘"));
    }

    #[test]
    fn hard_deleted_tag_leaves_an_id_only_tombstone() {
        let conn = mem();
        let work = tag::create(&conn, "工作").unwrap();
        tag::delete(&conn, &work.tag.id).unwrap();

        let (op, payload): (String, String) = conn
            .query_row(
                "SELECT op, payload FROM outbox ORDER BY hlc DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(op, "delete");
        // 行已经没了，但有 id 就够对端删掉自己那份
        assert_eq!(payload["id"], Value::from(work.tag.id.as_str()));
    }

    #[test]
    fn note_pin_update_advances_the_clock_without_touching_updated_at() {
        let conn = mem();
        let note = note::create(
            &conn,
            note::NewNote {
                body: "置顶测试".into(),
                tags: None,
            },
        )
        .unwrap();
        let before = stamp_of(&conn, "note", &note.id);

        let pinned = note::update(
            &conn,
            &note.id,
            note::NotePatch {
                body: None,
                pinned: Some(true),
                tags: None,
            },
        )
        .unwrap();

        // 这是「把 updated_at 当版本号」最隐蔽的那个坑：置顶**故意**不动 updated_at，
        // 但 hlc 必须动，否则这次置顶同步出去会被对端当成旧数据丢掉
        assert_eq!(pinned.updated_at, note.updated_at);
        assert!(stamp_of(&conn, "note", &note.id) > before);
    }

    #[test]
    fn batch_writes_record_every_row_they_touch() {
        let conn = mem();
        let mut input = new_task("交周报");
        input.due_at = Some(
            (chrono::Utc::now() + chrono::Duration::hours(10))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        );
        let created = task::create(&conn, input).unwrap();
        let reminders = created.reminders.len();
        assert!(reminders > 0);

        // 记录写之前的水位
        let before = outbox_count(&conn);
        task::complete(&conn, &created.id, None).unwrap();

        // 任务本身 1 条 + 被关停的每条提醒各 1 条
        assert_eq!(outbox_count(&conn) - before, 1 + reminders as i64);

        let flagged: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE entity = 'reminder' AND op = 'upsert'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(flagged > 0, "提醒状态变了却没进队列，对端会再弹一次");
    }

    #[test]
    fn repository_writes_all_land_in_the_outbox() {
        // 护栏：以后新增写函数时忘了接 mutate，这条会直接挂。
        // 每个写函数跑一遍，断言 outbox 都多了记录。
        let conn = mem();

        fn step(conn: &Connection, name: &str, run: impl FnOnce(&Connection)) {
            let before = outbox_count(conn);
            run(conn);
            assert!(
                outbox_count(conn) > before,
                "{name} 写完了却没有进 outbox——接入同步时漏了这一处"
            );
        }

        let task_id = std::cell::RefCell::new(String::new());
        step(&conn, "task::create", |c| {
            *task_id.borrow_mut() = sample_task(c);
        });
        step(&conn, "task::update", |c| {
            task::update(
                c,
                &task_id.borrow(),
                task::TaskPatch {
                    title: Some("改过的标题".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        });
        step(&conn, "task::reopen", |c| {
            task::complete(c, &task_id.borrow(), None).unwrap();
            task::reopen(c, &task_id.borrow()).unwrap();
        });
        step(&conn, "task::clear_done", |c| {
            let done = task::create(c, new_task("待清空")).unwrap();
            task::complete(c, &done.id, None).unwrap();
            task::clear_done(c).unwrap();
        });
        step(&conn, "task::delete", |c| {
            let doomed = task::create(c, new_task("要删的")).unwrap();
            task::delete(c, &doomed.id).unwrap();
        });

        let note_id = std::cell::RefCell::new(String::new());
        step(&conn, "note::create", |c| {
            *note_id.borrow_mut() = note::create(
                c,
                note::NewNote {
                    body: "记一笔".into(),
                    tags: None,
                },
            )
            .unwrap()
            .id;
        });
        step(&conn, "note::update", |c| {
            note::update(
                c,
                &note_id.borrow(),
                note::NotePatch {
                    pinned: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        });
        step(&conn, "note::delete", |c| {
            note::delete(c, &note_id.borrow()).unwrap();
        });

        let tag_id = std::cell::RefCell::new(String::new());
        step(&conn, "tag::create", |c| {
            *tag_id.borrow_mut() = tag::create(c, "工作").unwrap().tag.id;
        });
        step(&conn, "tag::delete", |c| {
            tag::delete(c, &tag_id.borrow()).unwrap();
        });

        step(&conn, "reminder::create_at", |c| {
            let owner = sample_task(c);
            let at = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
            reminder::create_at(c, &owner, "notify", &at, None).unwrap();
        });
        step(&conn, "reminder::snooze", |c| {
            let mut input = new_task("推迟我");
            input.due_at = Some(
                (chrono::Utc::now() + chrono::Duration::hours(3))
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            );
            let owner = task::create(c, input).unwrap();
            reminder::snooze(c, &owner.id, 30).unwrap();
        });
    }
}
