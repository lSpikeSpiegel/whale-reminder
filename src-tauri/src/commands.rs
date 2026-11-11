use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::repository::reminder;
use crate::repository::task::{self, DayBrief, NewTask, TaskPatch};
use crate::repository::{Task, TaskFilter};

/// 取数据库连接。锁中毒说明某个线程在持锁时 panic 了，
/// 此时继续使用连接可能读到不一致状态，直接报错更安全。
fn conn<'a>(db: &'a State<'_, Db>) -> AppResult<MutexGuard<'a, Connection>> {
    db.0.lock()
        .map_err(|_| AppError::Other("数据库连接锁异常，请重启应用".into()))
}

#[tauri::command]
pub fn list_tasks(db: State<'_, Db>, filter: Option<TaskFilter>) -> AppResult<Vec<Task>> {
    let guard = conn(&db)?;
    task::list(&guard, &filter.unwrap_or_default())
}

#[tauri::command]
pub fn create_task(db: State<'_, Db>, input: NewTask) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::create(&guard, input)
}

#[tauri::command]
pub fn update_task(db: State<'_, Db>, id: String, patch: TaskPatch) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::update(&guard, &id, patch)
}

#[tauri::command]
pub fn complete_task(db: State<'_, Db>, id: String, note: Option<String>) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::complete(&guard, &id, note.as_deref())
}

/// 记录用户对追问的回答：done / doing / not_started / ignored
#[tauri::command]
pub fn answer_progress(db: State<'_, Db>, id: String, answer: String) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::answer_progress(&guard, &id, &answer)
}

#[tauri::command]
pub fn reopen_task(db: State<'_, Db>, id: String) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::reopen(&guard, &id)
}

#[tauri::command]
pub fn delete_task(db: State<'_, Db>, id: String) -> AppResult<()> {
    let guard = conn(&db)?;
    task::delete(&guard, &id)
}

#[tauri::command]
pub fn snooze_task(db: State<'_, Db>, id: String, minutes: i64) -> AppResult<Option<String>> {
    let guard = conn(&db)?;
    reminder::snooze(&guard, &id, minutes)
}

#[tauri::command]
pub fn today_brief(db: State<'_, Db>) -> AppResult<DayBrief> {
    let guard = conn(&db)?;
    task::today_brief(&guard)
}
