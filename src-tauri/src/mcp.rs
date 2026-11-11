use std::sync::{Arc, Mutex};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    service::ServiceExt,
    tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData as McpError, ServerHandler,
};
use rusqlite::Connection;
use serde::Deserialize;

use crate::db;
use crate::error::AppResult;
use crate::repository::reminder;
use crate::repository::task::{self, NewTask, TaskPatch};
use crate::repository::TaskFilter;

/// MCP server。与 GUI 共用同一个 SQLite 文件，但走自己独立的连接。
#[derive(Clone)]
pub struct WhaleServer {
    db: Arc<Mutex<Connection>>,
    /// 由 `#[tool_router]` 宏生成，`#[tool_handler]` 在运行时读取
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

// ---------- 工具入参 ----------

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListTasksInput {
    /// todo | doing | done | all，缺省只返回未完成的
    status: Option<String>,
    /// 在标题和描述里做模糊匹配
    query: Option<String>,
    /// 最多返回多少条，默认 50
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct TaskIdInput {
    task_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateTaskInput {
    /// 待办标题
    title: String,
    description: Option<String>,
    /// ISO 8601 UTC，例如 2026-11-12T02:00:00Z（北京时间减 8 小时）
    due_at: Option<String>,
    /// 0 低 / 1 普通 / 2 高 / 3 紧急
    priority: Option<i64>,
    estimate_min: Option<i64>,
    tags: Option<Vec<String>>,
    /// 相对截止时间的提前秒数，负数。-1800 表示提前 30 分钟。
    /// 不传用默认值 [-1800, -600]，传空数组表示不提醒。
    remind_offsets: Option<Vec<i64>>,
    /// 是否开启定时追问，默认 true
    ask_progress: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdateTaskInput {
    task_id: String,
    title: Option<String>,
    description: Option<String>,
    due_at: Option<String>,
    /// 为 true 时清空截止时间
    clear_due: Option<bool>,
    priority: Option<i64>,
    /// 只能是 todo / doing / archived；标记完成请用 complete_task
    status: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CompleteTaskInput {
    task_id: String,
    /// 完成备注，可选
    note: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeleteTaskInput {
    task_id: String,
    /// 必须为 true，否则拒绝执行
    confirm: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SnoozeInput {
    task_id: String,
    /// 推迟多少分钟，默认 15
    minutes: Option<i64>,
}

fn text_result(value: serde_json::Value) -> CallToolResult {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    CallToolResult::success(vec![ContentBlock::text(text)])
}

#[tool_router]
impl WhaleServer {
    pub fn new(conn: Connection) -> Self {
        Self {
            db: Arc::new(Mutex::new(conn)),
            tool_router: Self::tool_router(),
        }
    }

    /// 所有工具都通过这里访问数据库，保证与 GUI 走同一套 repository 逻辑。
    fn run<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> Result<T, McpError> {
        let guard = self
            .db
            .lock()
            .map_err(|_| McpError::internal_error("数据库连接锁异常", None))?;
        f(&guard).map_err(|e| McpError::internal_error(e.to_string(), None))
    }

    #[tool(
        description = "列出待办事项。当用户问「我还有什么没做」「今天有什么安排」时使用。\
                       不传 status 时默认只返回未完成的（todo + doing）。"
    )]
    fn list_tasks(
        &self,
        Parameters(input): Parameters<ListTasksInput>,
    ) -> Result<CallToolResult, McpError> {
        let filter = TaskFilter {
            status: input.status,
            query: input.query,
            limit: input.limit,
        };
        let tasks = self.run(|conn| task::list(conn, &filter))?;

        Ok(text_result(serde_json::json!({
            "server_now": db::now_iso(),
            "total": tasks.len(),
            "tasks": tasks,
        })))
    }

    #[tool(description = "按 id 获取单条待办的完整信息，包含提醒计划。")]
    fn get_task(
        &self,
        Parameters(input): Parameters<TaskIdInput>,
    ) -> Result<CallToolResult, McpError> {
        let found = self.run(|conn| task::get(conn, &input.task_id))?;
        Ok(text_result(serde_json::json!({
            "server_now": db::now_iso(),
            "task": found,
        })))
    }

    #[tool(
        description = "创建一条待办。当用户表达「要做什么事」并希望被记住或提醒时使用。\
                       若用户提到了时间（如「明天上午」「周五前」），必须换算成 ISO 8601 UTC 填入 due_at，不要留空。\
                       默认会自动创建提前 30 分钟和 10 分钟的提醒。"
    )]
    fn create_task(
        &self,
        Parameters(input): Parameters<CreateTaskInput>,
    ) -> Result<CallToolResult, McpError> {
        let new_task = NewTask {
            title: input.title,
            description: input.description.unwrap_or_default(),
            due_at: input.due_at,
            priority: input.priority,
            estimate_min: input.estimate_min,
            tags: input.tags.unwrap_or_default(),
            source: Some("ai".to_string()),
            remind_offsets: input.remind_offsets,
            ask_progress: input.ask_progress,
        };
        let created = self.run(|conn| task::create(conn, new_task))?;

        Ok(text_result(serde_json::json!({
            "server_now": db::now_iso(),
            "task": created,
        })))
    }

    #[tool(
        description = "修改已有待办。只传需要改的字段，未传的保持不变。要清空截止时间请传 clear_due=true。\
                       注意：标记完成必须用 complete_task，不能通过 status 设成 done。"
    )]
    fn update_task(
        &self,
        Parameters(input): Parameters<UpdateTaskInput>,
    ) -> Result<CallToolResult, McpError> {
        let patch = TaskPatch {
            title: input.title,
            description: input.description,
            due_at: input.due_at,
            clear_due: input.clear_due.unwrap_or(false),
            priority: input.priority,
            status: input.status,
            tags: input.tags,
        };
        let updated = self.run(|conn| task::update(conn, &input.task_id, patch))?;

        Ok(text_result(serde_json::json!({
            "server_now": db::now_iso(),
            "task": updated,
        })))
    }

    #[tool(description = "把待办标记为已完成。会自动关停该任务的所有提醒。")]
    fn complete_task(
        &self,
        Parameters(input): Parameters<CompleteTaskInput>,
    ) -> Result<CallToolResult, McpError> {
        let done = self.run(|conn| task::complete(conn, &input.task_id, input.note.as_deref()))?;
        let remaining = self.run(|conn| {
            task::list(conn, &TaskFilter::default()).map(|list| list.len())
        })?;

        Ok(text_result(serde_json::json!({
            "server_now": db::now_iso(),
            "task": done,
            "remaining_pending": remaining,
        })))
    }

    #[tool(
        description = "删除待办（软删除，30 天内可恢复）。这是破坏性操作，\
                       必须先向用户确认，得到明确同意后再传 confirm=true 调用。"
    )]
    fn delete_task(
        &self,
        Parameters(input): Parameters<DeleteTaskInput>,
    ) -> Result<CallToolResult, McpError> {
        if !input.confirm {
            return Err(McpError::invalid_params(
                "CONFIRM_REQUIRED: 删除是破坏性操作，请先向用户确认，再传 confirm=true",
                None,
            ));
        }
        let task_id = input.task_id;
        self.run(|conn| task::delete(conn, &task_id))?;

        Ok(text_result(serde_json::json!({
            "deleted": true,
            "task_id": task_id,
        })))
    }

    #[tool(
        description = "把某条待办的下一次提醒推迟指定分钟数。\
                       用户说「等会儿再说」「半小时后提醒我」时使用。"
    )]
    fn snooze_reminder(
        &self,
        Parameters(input): Parameters<SnoozeInput>,
    ) -> Result<CallToolResult, McpError> {
        let minutes = input.minutes.unwrap_or(15);
        let next = self.run(|conn| reminder::snooze(conn, &input.task_id, minutes))?;

        Ok(text_result(serde_json::json!({
            "server_now": db::now_iso(),
            "next_fire_at": next,
        })))
    }

    #[tool(
        description = "获取今天的进度摘要：完成数、待办数、逾期数。\
                       用于回答「我今天进度怎么样」这类复盘问题。"
    )]
    fn get_today_brief(&self) -> Result<CallToolResult, McpError> {
        let brief = self.run(task::today_brief)?;

        Ok(text_result(serde_json::json!({
            "server_now": db::now_iso(),
            "date": chrono::Local::now().format("%Y-%m-%d").to_string(),
            "summary": brief,
        })))
    }
}

#[tool_handler]
impl ServerHandler for WhaleServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "whale-reminder",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_instructions(
                "Whale Reminder 桌面待办管理。\
                 所有时间参数必须是 ISO 8601 UTC 格式，例如 2026-11-12T02:00:00Z（北京时间需减 8 小时）。\
                 每个工具返回都带 server_now 字段，用它作为当前时间基准来换算相对时间。\
                 创建带 due_at 的任务会自动生成提前 30 分钟和 10 分钟的提醒。\
                 删除前必须先向用户确认，再传 confirm=true。"
                    .to_string(),
            )
    }
}

/// `--mcp` 模式的入口。走纯 stdio，不初始化 Tauri、不建任何窗口。
///
/// 注意：这个函数内部任何地方都不能往 stdout 打印东西，
/// 否则会污染 JSON-RPC 流导致协议解析失败。日志一律走 stderr。
pub fn run_blocking() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("无法创建 tokio 运行时");

    let result = runtime.block_on(async {
        let conn = db::open()?;
        let service = WhaleServer::new(conn).serve(stdio()).await?;
        service.waiting().await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    });

    if let Err(err) = result {
        eprintln!("[mcp] 服务异常退出: {err}");
        std::process::exit(1);
    }
}
