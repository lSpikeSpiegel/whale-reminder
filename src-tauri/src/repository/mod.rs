pub mod reminder;
pub mod task;

use serde::{Deserialize, Serialize};

/// 提醒的精简视图，随 Task 一起返回给前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderView {
    pub id: String,
    pub kind: String,
    pub next_fire_at: String,
    pub state: String,
}

/// 完整的待办对象。GUI 与 MCP 共用同一结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: i64,
    pub due_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub estimate_min: Option<i64>,
    pub tags: Vec<String>,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub reminders: Vec<ReminderView>,
    pub ask_count: i64,
}

/// 列表查询条件。所有字段都是可选的，默认返回未完成的任务。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFilter {
    /// todo | doing | done | all，缺省等价于 todo（含 doing）
    pub status: Option<String>,
    /// 标题与描述的关键词模糊匹配
    pub query: Option<String>,
    pub limit: Option<i64>,
}
