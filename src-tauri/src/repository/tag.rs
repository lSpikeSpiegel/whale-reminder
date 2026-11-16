//! 备忘的标签。
//!
//! 标签是独立一张表，不塞进 `note.tags` 的 JSON：**「已有标签」要能脱离某条备忘存在**——
//! 用户可能先建好标签、过两天才用得上；只存在 JSON 里的话，没有备忘引用的标签会凭空消失，
//! 输入框底下那个「选已有标签」的列表也就永远长不大。
//!
//! 删标签是硬删（连带清掉关联）。标签是元数据，没有「回收站」的意义，
//! 软删只会让「已有标签」列表里留一堆看不见又占名字的幽灵。

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::db::{new_id, now_iso};
use crate::error::{AppError, AppResult};
use crate::sync::{self, Entity};

/// 标签名最多几个字。标签是贴在卡片角上的小字，太长会把整行挤爆。
pub const MAX_NAME_CHARS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

/// 带「有多少条备忘在用」的标签。筛选行和标签选择器都要显示条数，
/// 单独查一遍太啰嗦，列表时顺手算出来。
#[derive(Debug, Clone, Serialize)]
pub struct TagView {
    #[serde(flatten)]
    pub tag: Tag,
    pub note_count: i64,
}

fn row_to_tag(row: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: row.get("id")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
    })
}

/// 标签名归一化：去掉用户习惯性敲的 `#` 和首尾空白。
fn normalize(name: &str) -> AppResult<String> {
    let name = name.trim().trim_start_matches('#').trim();
    if name.is_empty() {
        return Err(AppError::Invalid("标签名不能是空的".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::Invalid(format!(
            "标签名最多 {MAX_NAME_CHARS} 个字"
        )));
    }
    Ok(name.to_string())
}

fn find_by_name(conn: &Connection, name: &str) -> AppResult<Option<Tag>> {
    Ok(conn
        .query_row("SELECT id, name, created_at FROM tag WHERE name = ?1", [name], row_to_tag)
        .optional()?)
}

fn count_for(conn: &Connection, tag_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM note_tag nt JOIN note n ON n.id = nt.note_id
          WHERE nt.tag_id = ?1 AND n.deleted_at IS NULL",
        [tag_id],
        |row| row.get(0),
    )?)
}

/// 全部标签，按名字排。名字排序对中文不算完美（按码点），但位置稳定——
/// 选择器里的 chip 每次重排都会让用户点错。
pub fn list(conn: &Connection) -> AppResult<Vec<TagView>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.created_at,
                (SELECT COUNT(*) FROM note_tag nt
                   JOIN note n ON n.id = nt.note_id
                  WHERE nt.tag_id = t.id AND n.deleted_at IS NULL) AS note_count
           FROM tag t
          ORDER BY t.name, t.id",
    )?;
    let tags = stmt
        .query_map([], |row| {
            Ok(TagView {
                tag: row_to_tag(row)?,
                note_count: row.get("note_count")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

/// 新建标签。**同名直接复用**：用户手快点了两次「+」，或者忘了自己建过，
/// 弹一句「已存在」不如把那个标签还给他。
pub fn create(conn: &Connection, name: &str) -> AppResult<TagView> {
    let name = normalize(name)?;

    if let Some(tag) = find_by_name(conn, &name)? {
        let note_count = count_for(conn, &tag.id)?;
        return Ok(TagView { tag, note_count });
    }

    let tag = Tag {
        id: new_id(),
        name,
        created_at: now_iso(),
    };

    sync::mutate(conn, Entity::Tag, &tag.id, |tx| {
        tx.execute(
            "INSERT INTO tag (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![tag.id, tag.name, tag.created_at],
        )?;
        Ok(())
    })?;

    Ok(TagView { tag, note_count: 0 })
}

/// 删标签：连带把它从所有备忘上摘掉。
///
/// 关联是显式删的，不靠 `ON DELETE CASCADE`——单测用的内存库没开 `foreign_keys`，
/// 靠级联的话测试会「过」，真机行为却是另一套。
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    sync::mutate(conn, Entity::Tag, id, |tx| {
        tx.execute("DELETE FROM note_tag WHERE tag_id = ?1", [id])?;
        let changed = tx.execute("DELETE FROM tag WHERE id = ?1", [id])?;
        if changed == 0 {
            // 标签是硬删，行都没了就没法留墓碑——返回错误让事务回滚，
            // 免得同步端收到一条删不掉任何东西的墓碑
            return Err(AppError::NotFound(format!("标签 {id} 不存在")));
        }
        Ok(())
    })
}

/// 某条备忘挂着的标签。
pub fn for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.created_at
           FROM note_tag nt JOIN tag t ON t.id = nt.tag_id
          WHERE nt.note_id = ?1
          ORDER BY t.name, t.id",
    )?;
    let tags = stmt
        .query_map([note_id], row_to_tag)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

/// 整体替换某条备忘的标签。
///
/// `INSERT ... SELECT` 而不是直接 INSERT：传进来的 id 要是已经被别处删了，
/// 静默跳过比让整次保存失败好——用户看到的应该是「这条存上了」。
///
/// **这里不投 outbox**：`note_tag` 是纯关联表，没有自己的语义，标签关系跟着
/// 备忘的快照一起走（见 `sync::shape`）。单独同步它的话，两台设备各改一次标签，
/// 行级 LWW 只会留下其中一份关系。调用方（`note::create` / `note::update`）
/// 已经在外层 `mutate` 里，这里用 `with_tx` 汇进同一个事务即可。
pub fn set_for_note(conn: &Connection, note_id: &str, ids: &[String]) -> AppResult<()> {
    sync::with_tx(conn, |tx| {
        tx.execute("DELETE FROM note_tag WHERE note_id = ?1", [note_id])?;
        for id in ids {
            tx.execute(
                "INSERT OR IGNORE INTO note_tag (note_id, tag_id)
                 SELECT ?1, id FROM tag WHERE id = ?2",
                params![note_id, id],
            )?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::note;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../schema.sql")).unwrap();
        conn
    }

    fn note_with(body: &str, tags: &[&str]) -> note::NewNote {
        note::NewNote {
            body: body.into(),
            tags: Some(tags.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn create_then_list_sorted_by_name() {
        let conn = mem();
        create(&conn, "工作").unwrap();
        create(&conn, "灵感").unwrap();

        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 2);
        // 按名字排：位置稳定，选择器里的 chip 不会每次重排
        let mut names: Vec<_> = all.iter().map(|t| t.tag.name.as_str()).collect();
        names.sort();
        assert_eq!(
            all.iter().map(|t| t.tag.name.as_str()).collect::<Vec<_>>(),
            names
        );
        assert!(all.iter().all(|t| t.note_count == 0));
    }

    #[test]
    fn name_normalized_and_deduped() {
        let conn = mem();
        let first = create(&conn, "  工作  ").unwrap();
        // 用户习惯性敲的 # 要吃掉
        let again = create(&conn, "#工作").unwrap();
        assert_eq!(first.tag.id, again.tag.id);
        assert_eq!(first.tag.name, "工作");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn blank_or_long_name_rejected() {
        let conn = mem();
        assert!(create(&conn, "   ").is_err());
        assert!(create(&conn, "#").is_err());
        assert!(create(&conn, &"字".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert!(create(&conn, &"字".repeat(MAX_NAME_CHARS)).is_ok());
    }

    #[test]
    fn attach_and_replace() {
        let conn = mem();
        let work = create(&conn, "工作").unwrap();
        let idea = create(&conn, "灵感").unwrap();

        let note = note::create(&conn, note_with("写周报", &[&work.tag.id])).unwrap();
        assert_eq!(note.tags.len(), 1);
        assert_eq!(note.tags[0].name, "工作");

        // 换成另一个标签：整体替换，不是追加
        let updated = note::update(
            &conn,
            &note.id,
            note::NotePatch {
                body: None,
                pinned: None,
                tags: Some(vec![idea.tag.id.clone()]),
            },
        )
        .unwrap();
        assert_eq!(
            updated.tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec!["灵感"]
        );

        // 条数跟着走
        let all = list(&conn).unwrap();
        assert_eq!(all.iter().find(|t| t.tag.id == work.tag.id).unwrap().note_count, 0);
        assert_eq!(all.iter().find(|t| t.tag.id == idea.tag.id).unwrap().note_count, 1);
    }

    #[test]
    fn unknown_tag_id_is_skipped() {
        let conn = mem();
        let note = note::create(&conn, note_with("没标签的", &["不存在的 id"])).unwrap();
        assert!(note.tags.is_empty());
    }

    #[test]
    fn delete_clears_relations() {
        let conn = mem();
        let work = create(&conn, "工作").unwrap();
        let note = note::create(&conn, note_with("写周报", &[&work.tag.id])).unwrap();

        delete(&conn, &work.tag.id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
        // 备忘还在，只是标签没了
        assert!(note::get(&conn, &note.id).unwrap().tags.is_empty());
        // 再删一次要说「找不到」
        assert!(delete(&conn, &work.tag.id).is_err());
    }

    #[test]
    fn count_ignores_deleted_notes() {
        let conn = mem();
        let work = create(&conn, "工作").unwrap();
        let note = note::create(&conn, note_with("写周报", &[&work.tag.id])).unwrap();
        assert_eq!(list(&conn).unwrap()[0].note_count, 1);

        note::delete(&conn, &note.id).unwrap();
        assert_eq!(list(&conn).unwrap()[0].note_count, 0);
    }
}
