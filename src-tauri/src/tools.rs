//! 工具页的「打开次数」统计。
//!
//! 只服务一件事：决定工具清单的先后——用得多的排前面。所以数据极小
//! （一个 key 一个计数），直接存 `data_dir/tool_usage.json`，不用进 SQLite。
//!
//! 计数只增不减：用户清掉记录也不会让常用的工具「掉队」，
//! 排序是使用习惯的沉淀，不是临时状态。

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

fn usage_path() -> PathBuf {
    crate::db::data_dir().join("tool_usage.json")
}

/// 读不出来就当没统计过：文件缺失、被改坏、字段对不上，都不该让工具页打不开。
fn load() -> BTreeMap<String, u32> {
    std::fs::read(usage_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(usage: &BTreeMap<String, u32>) -> AppResult<()> {
    let bytes = serde_json::to_vec(usage)
        .map_err(|err| AppError::Other(format!("工具使用记录编码失败：{err}")))?;
    crate::fsutil::write_atomic(&usage_path(), &bytes)
}

/// 计一次数。抽成纯函数是为了能直接单测——文件读写的失败路径不参与排序逻辑。
fn bump(usage: &mut BTreeMap<String, u32>, key: &str) -> u32 {
    let count = usage.entry(key.to_owned()).or_insert(0);
    // 计数溢出没有实际意义，饱和就好，别在几万次点击后回绕成 0
    *count = count.saturating_add(1);
    *count
}

/// 当前各工具被打开过多少次。没出现过的 key 前端按 0 处理。
#[tauri::command]
pub fn tool_usage() -> BTreeMap<String, u32> {
    load()
}

/// 记一次打开，返回最新的计数表——前端拿返回值直接重排，不用再问一次。
#[tauri::command]
pub fn tool_open(key: String) -> AppResult<BTreeMap<String, u32>> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Invalid("工具 key 不能为空".into()));
    }

    let mut usage = load();
    bump(&mut usage, key);
    save(&usage)?;
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::bump;
    use std::collections::BTreeMap;

    #[test]
    fn first_open_starts_from_one() {
        let mut usage = BTreeMap::new();
        assert_eq!(bump(&mut usage, "qr"), 1);
        assert_eq!(usage.get("qr"), Some(&1));
    }

    #[test]
    fn repeated_opens_add_up() {
        let mut usage = BTreeMap::new();
        for expected in 1..=3 {
            assert_eq!(bump(&mut usage, "color"), expected);
        }
        assert_eq!(usage.len(), 1);
    }

    #[test]
    fn keys_are_counted_separately() {
        let mut usage = BTreeMap::new();
        bump(&mut usage, "qr");
        bump(&mut usage, "json");
        bump(&mut usage, "qr");
        assert_eq!(usage.get("qr"), Some(&2));
        assert_eq!(usage.get("json"), Some(&1));
    }

    #[test]
    fn counter_saturates_instead_of_wrapping() {
        let mut usage = BTreeMap::from([("qr".to_string(), u32::MAX)]);
        assert_eq!(bump(&mut usage, "qr"), u32::MAX);
    }
}
