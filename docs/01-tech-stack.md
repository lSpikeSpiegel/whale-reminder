# Whale Reminder · 技术栈选型

> 版本 v0.2 · 2026-11-11
> v0.2 修订：宠物渲染由 SVG 矢量改为 PNG 位图立绘（第 6 节）
> 决策前提：Windows 单平台 · Tauri v2 · 位图立绘 + 特效层 · 本地 SQLite 单机

---

## 1. 先用产品形态倒推技术约束

选型不从"哪个框架流行"出发，从这个产品的物理形态出发。它有四个硬约束：

| # | 产品要求 | 技术约束 | 影响面 |
|---|---|---|---|
| C1 | 桌宠待机，长期常驻不打扰 | 内存占用要小、可开机自启、必须托盘化 | 桌面壳选型 |
| C2 | 无边框、透明、置顶、可拖拽、可点击穿透 | 需要透明窗口 + 层级控制 + 命中测试 | 桌面壳 + 渲染层 |
| C3 | 定时提醒 / 定时追问进度 | 需要常驻调度器 + 休眠唤醒补偿 | 后端设计 |
| C4 | AI 通过 MCP 直接增删改待办 | 需要独立可被拉起的 stdio 进程 + 共享数据源 | 进程架构 |

C1 直接否掉了 Electron 的默认形态（空载 150MB+，对一个"永远开着但不干活的宠物"是浪费）；C4 决定了**不能只有一个进程**。

---

## 2. 桌面壳：Tauri v2 而非 Electron

| 维度 | Tauri 2.12.5 | Electron 3x |
|---|---|---|
| 安装包 | 3–10 MB | 80–150 MB |
| 空载内存 | 40–70 MB | 150–250 MB |
| 透明无边框窗口 | 支持，`transparent: true` | 支持 |
| 点击穿透 | `set_ignore_cursor_events` | `setIgnoreMouseEvents` |
| 托盘 / 自启 | 官方插件 | 内置 |
| 系统通知 | 官方插件（走 Windows Toast） | 内置 |
| 调试体验 | WebView2 DevTools，够用 | 更成熟 |
| 生态成熟度 | 中 | 高 |

**结论：Tauri v2。** 理由不是"更轻所以更好"，而是这个产品的**主要生命周期是待机**——待机状态下用户对资源占用极其敏感，而 Electron 的资源开销恰好花在待机时（常驻的 Chromium 多进程）。

**代价要提前认下：**
- 本机**没有 Rust 工具链**，需先装 `rustup` + MSVC Build Tools，首次 `cargo build` 约 5–10 分钟
- Rust 侧代码量比 Node 大，迭代反馈慢于前端
- WebView2 在 Win10 1803+ 已内置；Win7/8 不支持（可接受）

> 如果后续发现 Rust 侧成为瓶颈，**降级路径**是保留前端与数据层契约，把壳换回 Electron（前端代码 100% 复用，只有 IPC 层和窗口控制代码要重写）。

---

## 3. 进程架构：一个二进制，两种角色

这是整个设计里最关键的决策。

```
┌──────────────────────────────────────────────────────────┐
│  whale-reminder.exe                                      │
│                                                          │
│  main() ──┬── 无参数 / --gui ──→ GUI 进程（唯一实例）     │
│           │      ├─ 透明桌宠窗口                          │
│           │      ├─ 托盘                                 │
│           │      ├─ 调度器（tokio interval）              │
│           │      └─ repository 层 ──┐                     │
│           │                          │                    │
│           └── --mcp ──────────→ MCP 进程（AI 按需拉起）   │
│                  ├─ rmcp stdio server                     │
│                  └─ repository 层 ──┤                     │
│                                      ▼                    │
│                          %APPDATA%/whale-reminder/         │
│                              whale.db (SQLite, WAL)       │
└──────────────────────────────────────────────────────────┘
```

### 3.1 为什么 MCP 不塞进 GUI 进程

AI 客户端（Claude Desktop / Cursor / Cherry Studio）接入 MCP 的方式是**用 stdio 拉起一个子进程**并接管它的 stdin/stdout。如果把配置指向 GUI 可执行文件：

1. 会启动第二个 GUI 实例，出现两只宠物
2. 即使做了单实例检测让第二实例退出，stdio 管道也随之断开，MCP 握手失败
3. GUI 进程的任何 `println!` / 日志都会污染 JSON-RPC 流，导致协议解析崩溃

**所以必须在 `main()` 最早期分流**：检测到 `--mcp` 就走纯 stdio 路径，**不初始化 Tauri、不建窗口、不写 stdout 以外的任何输出**（日志一律走 stderr 或文件）。

```rust
fn main() {
    if std::env::args().any(|a| a == "--mcp") {
        // 独立 tokio runtime，只跑 MCP server，日志重定向到 stderr
        mcp::run_stdio_blocking();
        return;
    }
    whale_reminder_lib::run(); // Tauri 正常启动
}
```

### 3.2 为什么用 rmcp 而不是 Node sidecar

备选方案是打包一个 Node 的 MCP server 作为 sidecar。放弃它的原因：

- 单二进制变成"exe + node 运行时 + js 文件"，安装包回到 40MB+，且首次冷启动慢（MCP 握手有超时）
- 用户在 AI 客户端里配置的路径要指向 sidecar，多一层出错可能
- 官方 Rust SDK **rmcp 3.9.0** 已稳定，`#[tool_router]` / `#[tool]` 宏让工具定义比手写 JSON Schema 更短

**代价**：MCP 工具逻辑要用 Rust 写，前端同学不熟。缓解方式是工具层保持极薄——只做参数校验 + 调用 repository，业务逻辑全在 repository 里。

### 3.3 数据访问必须单点下沉

**这是硬约束，违反它会在两周内失控。**

```
❌ 反例：
   GUI 前端 ──tauri-plugin-sql──→ SQLite
   MCP 工具 ──rusqlite──────────→ SQLite
   （两套 SQL、两套 schema 理解，改表时必有一边漏）

✅ 采用：
   GUI 前端 ──invoke(command)──┐
                               ├──→ repository 层（唯一 SQL 出口）──→ SQLite
   MCP 工具 ──直接调用─────────┘
```

前端**不使用** `tauri-plugin-sql`，所有数据操作走 `#[tauri::command]`。好处不只是"不重复"，还包括：

- 时间计算（下次提醒时间、逾期判定）统一在 Rust 侧，不受前端时区/时钟影响
- MCP 和 GUI 写入的数据经过同一套校验，AI 不可能写出前端渲染不了的数据
- schema 迁移只有一个入口

---

## 4. 数据层：SQLite + WAL

| 项 | 决策 | 理由 |
|---|---|---|
| 引擎 | SQLite（`rusqlite`，`bundled` feature） | 零安装、单文件、多进程并发读 |
| 并发模式 | `PRAGMA journal_mode=WAL` | GUI 与 MCP 两个进程同时读写不互锁 |
| 忙等待 | `busy_timeout = 5000` | 写冲突时自动重试 5s，避免 `SQLITE_BUSY` 直接失败 |
| 位置 | `%APPDATA%\whale-reminder\whale.db` | 不随安装目录，升级不丢数据 |
| 迁移 | 自建 `schema_version` 表 + 顺序 SQL | 比 ORM migration 轻，够用 |

**为什么不选 JSON 文件**：GUI 和 MCP 是两个进程，同时写 JSON 会互相覆盖（无跨进程锁），且"查今天到期的任务"需要全量加载 + 内存过滤。SQLite 的 WAL 天然解决并发，索引解决查询。

**并发写的一个真实风险**：AI 可能在一次对话里连续调用 5 个 `create_task`。WAL 下每次写都要拿写锁，`busy_timeout` 会串行化它们。**不要**在 MCP 工具里开长事务（比如在事务里做网络请求），否则会长时间阻塞 GUI 的写入。

---

## 5. 调度器设计：提醒与追问共用一个引擎

"定时提醒"和"定时询问进度"在数据上是同一件事——都是"某个时刻要触发某个动作"。所以**不做两套定时器**，用一张 `reminder` 表 + 一个 tick 循环。

```
每 15s tick 一次：
  SELECT * FROM reminder
  WHERE state = 'pending' AND next_fire_at <= now()
  ORDER BY next_fire_at
  → 逐条 dispatch：
       kind = 'notify'  → 弹气泡 + 系统通知
       kind = 'ask'     → 弹气泡追问"这个做得怎么样了？"
  → 计算 next_fire_at（重复规则）或置 state='done'
```

### 5.1 为什么用"轮询扫描"而不是 `tokio::sleep_until`

Windows 休眠/待机会让 `sleep_until` 的计时基准漂移，唤醒后要么延迟触发，要么一次性补发一堆。轮询扫描的语义是"**只要我醒着，就把所有该触发但没触发的补上**"，天然具备补偿能力。

- tick 间隔 15s：提醒延迟最多 15s，用户可接受；CPU 开销可忽略（一次带索引的查询）
- 启动时立即执行一次 tick，处理关机期间错过的提醒
- 补发策略：**同一任务错过多条提醒时只发最新一条**，避免唤醒后连弹 10 个气泡

### 5.2 提醒去重

每条 reminder 记录 `last_fired_at` 和 `fire_count`。dispatch 时先做一次乐观更新：

```sql
UPDATE reminder SET last_fired_at = ?, fire_count = fire_count + 1
WHERE id = ? AND (last_fired_at IS NULL OR last_fired_at < ?)
```

受影响行数为 0 说明已被另一个进程（或上一轮 tick）处理，跳过。这样即使 tick 重入也不会重复弹窗。

### 5.3 追问进度的时间策略

"定时询问进度"不是固定间隔，而是**跟随截止时间倒推**：

| 场景 | 追问时机 |
|---|---|
| 任务有 deadline | deadline 前 50%、前 80%、前 95% 各追问一次 |
| 任务无 deadline，只有开始时间 | 开始后 1h、4h、24h 各追问一次 |
| 用户连续 2 次回答"还没开始" | 降低频率，改为每天一次 |
| 任务已逾期 | 每天 09:30 追问一次，直到完成或用户静音 |

这套规则写进 `scheduler::plan_progress_checks()`，是纯函数，可单测。

---

## 6. 宠物渲染：PNG 位图 + SVG 特效层

> 本节在 v0.2 修订：原方案为「SVG 矢量绘制宠物」，后因确定复用[鲸鱼娘立绘](https://github.com/pokerface-1224/deepseek-whale-girl-pet)而改为位图方案。形象细节见 [04-pet-character-design.md](04-pet-character-design.md)。

### 6.1 为什么是位图而不是矢量

| | PNG 位图 + 特效层 | SVG 矢量重绘 |
|---|---|---|
| 形象质量 | 现成 11 张高质量立绘 | 厚涂渐变、蕾丝边很难还原 |
| 体积 | 345 KB（11 张 WebP） | < 100 KB |
| 动画能力 | 只能切图 + 缩放 + 叠加特效 | 真形变，可做肢体动画 |
| 美术成本 | 0 | 需要较强手绘能力 |

选位图的决定性理由是**形象质量**：这套立绘的厚涂质感和细节密度，用 SVG 手写几乎不可能还原到同等水平，而桌宠的第一印象完全由形象决定。代价是失去骨骼动画能力，用「呼吸缩放 + 眨眼叠加 + 状态切换」补偿。

### 6.2 宠物状态机

```
        ┌──────────┐  鼠标靠近   ┌──────────┐
        │  idle    │───────────→│  react   │
        │ 待机站立 │←───────────│  上浮眨眼 │
        └────┬─────┘   离开     └──────────┘
             │
    ┌────────┼────────┬──────────┬───────────┐
    ▼        ▼        ▼          ▼           ▼
┌───────┐┌───────┐┌───────┐┌────────┐┌─────────┐
│ drag  ││ remind││ think ││ sleep  ││ celebrate│
│被拖拽 ││提醒中 ││追问中 ││夜间休眠││ 任务完成 │
└───────┘└───────┘└───────┘└────────┘└─────────┘
```

状态由 Rust 侧事件驱动（`emit("pet://state", "remind")`），前端只做渲染，不自己判断业务状态。每个状态对应一张立绘，映射关系见形象设计文档第 4 节。

### 6.3 透明窗口 + 点击穿透的坑

**Tauri 做不到像素级命中测试。** 窗口是一个矩形，即使宠物只占中间一块，四周透明区域仍然会拦截鼠标点击，导致用户点不到底下的桌面图标。

参考仓库（C#）用 `WS_EX_LAYERED | WS_EX_TOOLWINDOW` + `UpdateLayeredWindow` 提交完整 ARGB 表面，Windows 会对 alpha=0 的区域自动穿透，做到了**真正的逐像素命中**。Tauri 走 WebView2 合成器渲染，拿不到这条路径。

死结在这里：

```
1. 窗口初始 set_ignore_cursor_events(true)  → 全窗口穿透
2. 前端监听 mousemove 判断是否在宠物身上（此时收不到事件，因为已穿透）
```

第 2 步无解。**本项目采用的方案**：

```
1. 立绘预处理时裁到紧包围盒（见 tools/prepare-art.py）
2. 窗口尺寸收缩到 176×176，几乎贴着角色轮廓
3. 前端 <body> 设 pointer-events: none，立绘容器设 pointer-events: auto
```

裁到紧包围盒后，透明区域只剩窗口四个角，误拦截面积很小。**不要**做全屏透明窗口 + 动态 `set_ignore_cursor_events` 切换，那需要高频 IPC 调用，会拖垮主线程。

> **升级路径**：若四角挡鼠标确实影响体验，把桌宠本体改成 Rust 原生分层窗口（`windows` crate + `UpdateLayeredWindow`），气泡和面板仍走 WebView2。该改动只影响渲染层，不触碰任何业务代码与数据层。

---

## 7. 完整依赖清单

### Rust 侧

```toml
[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2.12", features = ["tray-icon", "image-png"] }
tauri-plugin-notification = "2"
tauri-plugin-autostart = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-single-instance = "2"

rmcp = { version = "3.9", features = ["server", "transport-io", "macros"] }
rusqlite = { version = "0.32", features = ["bundled", "chrono"] }

tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde"] }
schemars = "0.8"        # rmcp 工具参数需要 JsonSchema
uuid = { version = "1", features = ["v7", "serde"] }
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

> `uuid v7` 而非 v4：v7 带时间戳，主键天然有序，`ORDER BY id` 就等于按创建时间排序，省一个索引。

### 前端侧

```json
{
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "zustand": "^5",
    "date-fns": "^4",
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-notification": "^2",
    "@tauri-apps/plugin-global-shortcut": "^2"
  },
  "devDependencies": {
    "typescript": "^5",
    "vite": "^7",
    "@vitejs/plugin-react": "^5",
    "tailwindcss": "^4"
  }
}
```

**前端框架说明**：选 React 是因为生态与 AI 编码辅助的语料最厚。这个产品的前端只有两个界面（桌宠气泡 + 待办面板），组件总数不超过 20 个，**换 Vue / Svelte 的迁移成本很低**——如果你更熟别的框架，替换不影响任何架构决策（数据契约在 Rust 侧）。

---

## 8. 前置依赖与开工检查

```bash
# 1. Rust 工具链（本机当前缺失）
winget install Rustlang.Rustup
rustup default stable-x86_64-pc-windows-msvc

# 2. MSVC Build Tools（cargo 链接需要）
winget install Microsoft.VisualStudio.2022.BuildTools
#   安装时勾选 "Desktop development with C++"

# 3. 验证
cargo -V && rustc -V
```

WebView2：Win10 1803+ / Win11 已内置，无需安装。

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| GUI 未运行时，AI 添加的待办到点无人提醒 | 核心体验断裂 | 开机自启 + 托盘常驻；UI 明确显示"桌宠未运行"；P2 加 Windows 计划任务兜底 |
| MCP 进程写库后 GUI 不刷新 | 用户看到过期数据 | 调度器 tick 时顺带比对 `PRAGMA data_version`，变化则 `emit` 让前端 refetch |
| 透明窗口误拦截点击 | 用户点不到桌面 | 窗口收缩到包围盒 + `pointer-events` 分层（见 6.3） |
| 休眠唤醒后提醒风暴 | 一次弹十几个气泡 | 同一任务只补发最新一条（见 5.1） |
| Rust 侧开发速度慢 | 工期拉长 | 工具层保持薄；业务逻辑集中在 repository；先跑通一条端到端链路再铺功能 |
| AI 误删/误改待办 | 数据丢失 | 软删除（`deleted_at`）+ MCP 的 `delete_task` 要求显式确认参数 |

---

## 10. 一页纸结论

- **壳**：Tauri 2.12.5，Windows only，NSIS 打包
- **进程**：单二进制双角色，`--mcp` 分流，GUI 与 MCP 各自独立运行
- **数据**：SQLite + WAL，`repository` 层是唯一 SQL 出口，前端不用 `tauri-plugin-sql`
- **调度**：单表 `reminder` + 15s 轮询 tick，天然支持休眠补偿与去重
- **宠物**：PNG 位图立绘（11 张 WebP 共 345KB）+ CSS 特效层，Rust 驱动状态机，窗口 176×176 包围盒解决点击穿透
- **MCP**：rmcp 3.9.0，stdio transport，工具层只做校验 + 转发
- **唯一前置缺口**：Rust 工具链未安装
