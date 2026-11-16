//! 备忘的读写。
//!
//! 和待办是两个东西：待办有截止时间、会进调度器、会被追问；备忘只是一段写下来的文字，
//! 不提醒、不参与统计。所以单独一张表，不往 `task` 里塞 `kind = 'note'`——
//! 那样每个「查未完成待办」的地方都得加一条排除条件，迟早漏。
//!
//! 标签存在 `tag` / `note_tag` 两张表里（见 `tag.rs`），`Note` 返回时直接带上完整对象，
//! 前端不用再拿 id 去映射一遍。

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::tag::{self, Tag};
use crate::db::{new_id, now_iso};
use crate::error::{AppError, AppResult};
use crate::sync::{self, Entity};

/// 一条备忘最多多少字。够写一段长笔记，又不至于让列表变成一篇文档。
pub const MAX_BODY_CHARS: usize = 5000;

const COLUMNS: &str = "id, body, pinned, created_at, updated_at";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub body: String,
    /// 置顶的排在前面
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    /// 挂在这条备忘上的标签，按名字排
    pub tags: Vec<Tag>,
}

/// 新建备忘的入参。字段名一律 snake_case，和 `invoke("create_note", { input })` 对齐。
///
/// `deny_unknown_fields` 是刻意的：前端多传一个键就直接报错，
/// 免得像以前 `start_at` 那样被静默丢掉、存进去少了一半字段还不报错。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewNote {
    pub body: String,
    /// 标签 id 列表。不传等于不挂标签
    pub tags: Option<Vec<String>>,
}

/// 改备忘：正文、置顶、标签都是可选的，只传要改的那个。
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotePatch {
    pub body: Option<String>,
    pub pinned: Option<bool>,
    /// 传了就**整体替换**标签，不是追加
    pub tags: Option<Vec<String>>,
}

/// 列表筛选。不传就是全部。
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteFilter {
    /// 只看挂了这个标签的备忘
    pub tag_id: Option<String>,
}

fn row_to_note(row: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get("id")?,
        body: row.get("body")?,
        // SQLite 没有布尔，库里存的是 0/1
        pinned: row.get::<_, i64>("pinned")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        tags: Vec::new(),
    })
}

/// 正文归一化：统一换行符、去掉首尾空白，空内容和超长直接拒。
///
/// 从网页或别处粘过来的文本常带 `\r\n`，不统一的话前端 `pre-wrap` 会多出一截空行。
fn normalize(body: &str) -> AppResult<String> {
    let text = body.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Invalid("备忘不能是空的".into()));
    }
    if text.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::Invalid(format!(
            "一条备忘最多 {MAX_BODY_CHARS} 字"
        )));
    }
    Ok(text.to_string())
}

/// 列表：置顶在前，然后按最近改过的排。id 是 uuid v7，时间相同时它兜底保证顺序稳定。
pub fn list(conn: &Connection, filter: &NoteFilter) -> AppResult<Vec<Note>> {
    let mut sql = format!("SELECT {COLUMNS} FROM note WHERE deleted_at IS NULL");
    let mut args: Vec<String> = Vec::new();

    if let Some(tag_id) = filter.tag_id.as_deref().filter(|value| !value.is_empty()) {
        // 子查询而不是 JOIN：一条备忘挂多个标签时 JOIN 会出重复行
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM note_tag
                           WHERE note_tag.note_id = note.id AND note_tag.tag_id = ?1)",
        );
        args.push(tag_id.to_string());
    }
    sql.push_str(" ORDER BY pinned DESC, updated_at DESC, id DESC");

    let mut stmt = conn.prepare(&sql)?;
    let mut notes = stmt
        .query_map(params_from_iter(args.iter()), row_to_note)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // 备忘量小（单机几十条），逐条补标签比拼多表 JOIN 好读
    for note in &mut notes {
        note.tags = tag::for_note(conn, &note.id)?;
    }
    Ok(notes)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Note> {
    let mut note = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM note WHERE id = ?1 AND deleted_at IS NULL"),
            [id],
            row_to_note,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("备忘 {id} 不存在")))?;
    note.tags = tag::for_note(conn, id)?;
    Ok(note)
}

pub fn create(conn: &Connection, input: NewNote) -> AppResult<Note> {
    let body = normalize(&input.body)?;
    let id = new_id();
    let now = now_iso();

    // 标签关系跟着备忘一起落库：备忘的快照里带的是 tag id 列表，
    // 分开写会出现「备忘存在但标签没挂上」的半截状态
    sync::mutate(conn, Entity::Note, &id, |tx| {
        tx.execute(
            "INSERT INTO note (id, body, pinned, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, ?3)",
            params![id, body, now],
        )?;
        if let Some(tags) = input.tags.as_deref() {
            tag::set_for_note(tx, &id, tags)?;
        }
        Ok(())
    })?;

    get(conn, &id)
}

/// 改正文、置顶或标签。
///
/// **只改置顶不动 `updated_at`**：否则点一下置顶，它就在置顶区里换到最前面，
/// 用户会觉得自己只按了一个键，列表却整个跳了一下。正文和标签算真改过，会更新。
///
/// 注意 `updated_at` 不动不代表同步看不到这次修改——`hlc` 照样推进（见 `sync::mutate`），
/// 这正是把「业务排序」和「同步定序」拆开的意义。
pub fn update(conn: &Connection, id: &str, patch: NotePatch) -> AppResult<Note> {
    let mut note = get(conn, id)?;
    let mut touched = false;

    if let Some(body) = patch.body.as_deref() {
        let next = normalize(body)?;
        if next != note.body {
            note.body = next;
            touched = true;
        }
    }
    if let Some(pinned) = patch.pinned {
        note.pinned = pinned;
    }
    // 先算好要不要换标签：真换了才算「改过」，顺序不同不算
    let next_tags = patch
        .tags
        .filter(|ids| !same_tags(&note.tags, ids));
    if next_tags.is_some() {
        touched = true;
    }
    if touched {
        note.updated_at = now_iso();
    }

    sync::mutate(conn, Entity::Note, id, |tx| {
        if let Some(ids) = next_tags.as_deref() {
            tag::set_for_note(tx, id, ids)?;
        }
        tx.execute(
            "UPDATE note SET body = ?1, pinned = ?2, updated_at = ?3 WHERE id = ?4",
            params![note.body, note.pinned as i64, note.updated_at, id],
        )?;
        Ok(())
    })?;

    get(conn, id)
}

/// 标签集合是否一致。顺序无关——前端传过来的顺序跟着 chip 的排列走，不代表语义。
fn same_tags(current: &[Tag], next: &[String]) -> bool {
    let mut a: Vec<&str> = current.iter().map(|tag| tag.id.as_str()).collect();
    let mut b: Vec<&str> = next.iter().map(String::as_str).collect();
    a.sort_unstable();
    b.sort_unstable();
    a.dedup();
    b.dedup();
    a == b
}

/// 软删。返回 NotFound 而不是静默成功：前端点了删除却什么都没发生，比报错更难查。
///
/// 关联的 `note_tag` 不在这里删——备忘软删还能恢复，标签关系得跟着一起回来。
/// 真正要清关联的只有「删标签」（见 `tag::delete`）。
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    sync::mutate(conn, Entity::Note, id, |tx| {
        let changed = tx.execute(
            "UPDATE note SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now_iso(), id],
        )?;
        if changed == 0 {
            // 返回错误会回滚事务，不留一条假的删除记录
            return Err(AppError::NotFound(format!("备忘 {id} 不存在")));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../schema.sql")).unwrap();
        conn
    }

    fn new(body: &str) -> NewNote {
        NewNote {
            body: body.into(),
            tags: None,
        }
    }

    fn all(conn: &Connection) -> Vec<Note> {
        list(conn, &NoteFilter::default()).unwrap()
    }

    #[test]
    fn create_then_list() {
        let conn = mem();
        let note = create(&conn, new("  记一下：周报模板在 D 盘  ")).unwrap();
        assert_eq!(note.body, "记一下：周报模板在 D 盘");
        assert!(!note.pinned);
        assert!(note.tags.is_empty());
        assert_eq!(note.created_at, note.updated_at);

        let list = all(&conn);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, note.id);
    }

    #[test]
    fn blank_body_rejected() {
        let conn = mem();
        assert!(create(&conn, new("")).is_err());
        assert!(create(&conn, new("  \n\t ")).is_err());
        assert!(all(&conn).is_empty());
    }

    #[test]
    fn too_long_rejected() {
        let conn = mem();
        assert!(create(&conn, new(&"字".repeat(MAX_BODY_CHARS + 1))).is_err());
        // 正好卡在上限要能存
        assert!(create(&conn, new(&"字".repeat(MAX_BODY_CHARS))).is_ok());
    }

    #[test]
    fn crlf_normalized() {
        let conn = mem();
        let note = create(&conn, new("第一行\r\n第二行\r第三行")).unwrap();
        assert_eq!(note.body, "第一行\n第二行\n第三行");
    }

    #[test]
    fn pinned_goes_first_and_keeps_updated_at() {
        let conn = mem();
        let first = create(&conn, new("先写的")).unwrap();
        let second = create(&conn, new("后写的")).unwrap();

        // 后写的在前（updated_at 倒序）
        assert_eq!(all(&conn)[0].id, second.id);

        let pinned = update(
            &conn,
            &first.id,
            NotePatch {
                body: None,
                pinned: Some(true),
                tags: None,
            },
        )
        .unwrap();
        assert!(pinned.pinned);
        // 置顶不改 updated_at，否则置顶区内部的顺序会被这一个动作搅乱
        assert_eq!(pinned.updated_at, first.updated_at);
        assert_eq!(all(&conn)[0].id, first.id);
    }

    #[test]
    fn update_body_only_touches_changed() {
        let conn = mem();
        let note = create(&conn, new("旧内容")).unwrap();

        let same = update(
            &conn,
            &note.id,
            NotePatch {
                body: Some("旧内容  ".into()),
                pinned: None,
                tags: None,
            },
        )
        .unwrap();
        // 只是首尾空白差异，等于没改，updated_at 不该动
        assert_eq!(same.updated_at, note.updated_at);

        let changed = update(
            &conn,
            &note.id,
            NotePatch {
                body: Some("新内容".into()),
                pinned: None,
                tags: None,
            },
        )
        .unwrap();
        assert_eq!(changed.body, "新内容");
        assert!(changed.updated_at >= note.updated_at);
    }

    #[test]
    fn update_rejects_blank() {
        let conn = mem();
        let note = create(&conn, new("有内容")).unwrap();
        assert!(update(
            &conn,
            &note.id,
            NotePatch {
                body: Some("   ".into()),
                pinned: None,
                tags: None,
            }
        )
        .is_err());
        // 被拒之后原内容还在
        assert_eq!(get(&conn, &note.id).unwrap().body, "有内容");
    }

    #[test]
    fn filter_by_tag() {
        let conn = mem();
        let work = tag::create(&conn, "工作").unwrap();
        let idea = tag::create(&conn, "灵感").unwrap();

        let a = create(
            &conn,
            NewNote {
                body: "写周报".into(),
                tags: Some(vec![work.tag.id.clone()]),
            },
        )
        .unwrap();
        let b = create(
            &conn,
            NewNote {
                body: "想到一个点子".into(),
                tags: Some(vec![idea.tag.id.clone()]),
            },
        )
        .unwrap();
        create(&conn, new("没标签的")).unwrap();

        let only_work = list(
            &conn,
            &NoteFilter {
                tag_id: Some(work.tag.id.clone()),
            },
        )
        .unwrap();
        assert_eq!(only_work.len(), 1);
        assert_eq!(only_work[0].id, a.id);

        // 不传筛选就是全部
        assert_eq!(all(&conn).len(), 3);

        // 传一个空串等于没筛，别让它筛出空列表
        assert_eq!(
            list(
                &conn,
                &NoteFilter {
                    tag_id: Some(String::new()),
                }
            )
            .unwrap()
            .len(),
            3
        );

        // 同一个标签挂两条也要各返回一次（用子查询而不是 JOIN 的原因）
        update(
            &conn,
            &b.id,
            NotePatch {
                body: None,
                pinned: None,
                tags: Some(vec![work.tag.id.clone(), idea.tag.id.clone()]),
            },
        )
        .unwrap();
        assert_eq!(
            list(
                &conn,
                &NoteFilter {
                    tag_id: Some(work.tag.id.clone()),
                }
            )
            .unwrap()
            .len(),
            2
        );
    }

    #[test]
    fn tags_order_does_not_count_as_change() {
        let conn = mem();
        let work = tag::create(&conn, "工作").unwrap();
        let idea = tag::create(&conn, "灵感").unwrap();
        let note = create(
            &conn,
            NewNote {
                body: "写周报".into(),
                tags: Some(vec![work.tag.id.clone(), idea.tag.id.clone()]),
            },
        )
        .unwrap();

        // 顺序反过来再存一次，集合没变，不该被当成「改过」
        let same = update(
            &conn,
            &note.id,
            NotePatch {
                body: None,
                pinned: None,
                tags: Some(vec![idea.tag.id.clone(), work.tag.id.clone()]),
            },
        )
        .unwrap();
        assert_eq!(same.updated_at, note.updated_at);
    }

    #[test]
    fn delete_is_soft_and_idempotent_error() {
        let conn = mem();
        let note = create(&conn, new("待删")).unwrap();
        delete(&conn, &note.id).unwrap();

        assert!(all(&conn).is_empty());
        assert!(get(&conn, &note.id).is_err());
        // 再删一次要说「找不到」，而不是假装成功
        assert!(delete(&conn, &note.id).is_err());
    }

    #[test]
    fn unknown_field_rejected() {
        // 键名写错要当场报错，别静默丢掉
        assert!(serde_json::from_str::<NewNote>(r#"{"body":"x","pinned":true}"#).is_err());
        assert!(serde_json::from_str::<NotePatch>(r#"{"body":"x","pin":true}"#).is_err());
        assert!(serde_json::from_str::<NotePatch>(r#"{"pinned":true}"#).is_ok());
    }
}
