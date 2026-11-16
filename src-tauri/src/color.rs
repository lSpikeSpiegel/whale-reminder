//! 颜色转换工具的「取色历史」。
//!
//! 只存 `#rrggbb` 字符串，最近用过的排在最前。换算本身在前端做
//! （拖拾色器要每帧算，走一趟 IPC 不值得），这里只负责「记住用过哪些」。

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// 最多记这么多条。一行色块在面板里正好摆满，再多就得换行
const LIMIT: usize = 12;

fn history_path() -> PathBuf {
    crate::db::data_dir().join("color_history.json")
}

fn load() -> Vec<String> {
    std::fs::read(history_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(list: &[String]) -> AppResult<()> {
    let bytes = serde_json::to_vec(list)
        .map_err(|err| AppError::Other(format!("取色历史编码失败：{err}")))?;
    crate::fsutil::write_atomic(&history_path(), &bytes)
}

/// `#rrggbb`，小写。别的写法一律不收——历史里混着多种格式，色块就不好画了。
fn is_hex(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// 把颜色挪到最前面：已经有就提前，没有就插进去，然后裁到上限。
///
/// 抽成纯函数是为了能直接单测——文件读写的失败路径跟「怎么排队」无关。
fn push(list: &mut Vec<String>, hex: &str) -> bool {
    if !is_hex(hex) {
        return false;
    }
    list.retain(|item| item != hex);
    list.insert(0, hex.to_owned());
    list.truncate(LIMIT);
    true
}

#[tauri::command]
pub fn color_history() -> Vec<String> {
    load()
}

/// 记一次取色，返回最新的历史——前端拿返回值直接重画，不用再问一次。
#[tauri::command]
pub fn color_remember(hex: String) -> AppResult<Vec<String>> {
    let hex = hex.trim().to_ascii_lowercase();
    let mut list = load();
    if !push(&mut list, &hex) {
        return Err(AppError::Invalid("颜色格式不对，需要 #rrggbb".into()));
    }
    save(&list)?;
    Ok(list)
}

#[tauri::command]
pub fn color_clear() -> AppResult<Vec<String>> {
    save(&[])?;
    Ok(Vec::new())
}

/* ------------------------------------------------------------------ 吸管 */

/// 吸到的颜色，等面板重新拿到焦点时取走。
///
/// 浮层是另一个窗口，吸完就关；面板这时还没回来，事件发过去也没人接。
/// 留个值让面板自己来取（和 `take_pending_check` 一个套路），比赌事件时序稳。
#[derive(Default)]
pub struct PickedColor(Mutex<Option<String>>);

/// 开始吸管取色：藏面板、抓屏、开浮层，全由 `overlay` 干。
#[tauri::command]
pub fn pick_start(app: AppHandle) -> AppResult<()> {
    crate::overlay::start(&app, "pick", "pick", "取色")
}

/// 吸完一个颜色：记下来、关浮层。面板回来后会 `pick_take` 取走。
#[tauri::command]
pub fn pick_commit(app: AppHandle, hex: String) -> AppResult<()> {
    let hex = hex.trim().to_ascii_lowercase();
    if !is_hex(&hex) {
        return Err(AppError::Invalid("颜色格式不对，需要 #rrggbb".into()));
    }

    if let Some(state) = app.try_state::<PickedColor>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(hex);
        }
    }

    crate::overlay::close(&app);
    Ok(())
}

/// 面板拿回焦点时来取一次。没有就返回 None。
#[tauri::command]
pub fn pick_take(app: AppHandle) -> Option<String> {
    let state = app.try_state::<PickedColor>()?;
    let mut guard = state.0.lock().ok()?;
    guard.take()
}

#[cfg(test)]
mod tests {
    use super::{push, LIMIT};

    fn hex(value: &str) -> String {
        value.to_owned()
    }

    #[test]
    fn newest_goes_first() {
        let mut list = Vec::new();
        assert!(push(&mut list, "#ff0000"));
        assert!(push(&mut list, "#00ff00"));
        assert_eq!(list, vec![hex("#00ff00"), hex("#ff0000")]);
    }

    #[test]
    fn existing_color_moves_to_front_without_duplicating() {
        let mut list = vec![hex("#ff0000"), hex("#00ff00"), hex("#0000ff")];
        assert!(push(&mut list, "#0000ff"));
        assert_eq!(list, vec![hex("#0000ff"), hex("#ff0000"), hex("#00ff00")]);
    }

    #[test]
    fn keeps_at_most_limit_entries() {
        let mut list = Vec::new();
        for index in 0..LIMIT + 4 {
            push(&mut list, &format!("#0000{index:02x}"));
        }
        assert_eq!(list.len(), LIMIT);
        // 最后推进去的在最前
        assert_eq!(list[0], format!("#0000{:02x}", LIMIT + 3));
    }

    #[test]
    fn rejects_anything_but_rrggbb() {
        let mut list = Vec::new();
        assert!(!push(&mut list, "#fff"));
        assert!(!push(&mut list, "355cb6"));
        assert!(!push(&mut list, "#355cb6ff"));
        assert!(!push(&mut list, "#gggggg"));
        assert!(list.is_empty());
    }
}
