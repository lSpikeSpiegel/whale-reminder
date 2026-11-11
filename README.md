# Whale Reminder

一个会盯着你干活、并且能听 AI 指挥的 Windows 桌面宠物。

待机时是一位站在桌面上的鲸鱼女仆娘；需要时双击展开待办面板。待办支持定时提醒和定时追问进度，并对外提供 MCP 工具，让 AI 可以直接增删改完成待办。

---

## 文档

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [01-tech-stack.md](docs/01-tech-stack.md) | 技术栈选型、进程架构、依赖版本、风险登记 | 开工前 / 架构有争议时 |
| [02-product-prototype.md](docs/02-product-prototype.md) | 产品定位、三种界面态、状态机、交互流程、MVP 范围 | 讨论"要不要做这个功能"时 |
| [03-data-and-mcp-contract.md](docs/03-data-and-mcp-contract.md) | 表结构、状态流转、8 个 MCP 工具定义、并发策略 | 写任何代码前 |
| [04-pet-character-design.md](docs/04-pet-character-design.md) | 形象授权、配色板、素材处理、状态映射、动画规格 | 改宠物表现时 |

---

## 技术决策速查

| 项 | 决策 | 理由 |
|---|---|---|
| 桌面壳 | Tauri 2.12.5（非 Electron） | 常驻待机场景对内存敏感，40–70MB vs 150–250MB |
| 平台 | 仅 Windows | 透明窗口 / 点击穿透 / 自启在单平台最省成本 |
| 进程 | 单二进制双角色，`--mcp` 分流 | MCP 必须独立进程，否则 stdio 被 GUI 污染 |
| 数据 | SQLite + WAL，`repository` 层单点出口 | 双进程并发；前端不用 `tauri-plugin-sql` |
| 调度 | 单表 `reminder` + 15s 轮询 tick | 轮询天然支持休眠唤醒补偿与去重 |
| 宠物 | PNG 位图立绘（11 张 WebP / 345KB）+ CSS 特效层 | 形象质量优先；换状态成本低，无需美术资源 |
| MCP | rmcp 3.9.0，stdio transport | 官方 Rust SDK，单二进制无 sidecar |

---

## 素材与授权

桌宠立绘来自 [deepseek-whale-girl-pet](https://github.com/pokerface-1224/deepseek-whale-girl-pet)，采用 **CC BY-NC-SA 4.0**：

| | |
|---|---|
| 角色原作者 | 上善 |
| 二次设计 / 立绘 | zipzippipe |

**仅限个人非商业使用，须署名，衍生作品须同协议。一旦商业化，必须全部替换。** 详见 [assets/pet/ATTRIBUTION.md](assets/pet/ATTRIBUTION.md)。

素材由 `tools/prepare-art.py` 处理：裁透明边距 → 缩放到 352×352 → 底部对齐 → WebP 压缩，16MB 降到 345KB。

---

## 当前状态

- [x] 技术栈选型
- [x] 产品原型设计
- [x] 数据模型与 MCP 工具契约
- [x] 桌宠形象素材（11 张立绘 WebP + 托盘/应用图标）
- [x] M1 骨架：Tauri 项目 + 透明窗口 + 鲸鱼娘立绘 + 托盘 + 位置持久化
- [x] M2 数据：SQLite + repository + 迁移 + 待办面板
- [x] M3 提醒：调度器 + 气泡提醒 + 自动收起
- [x] M4 MCP：`--mcp` 分流 + 8 个工具 + stdio 握手验证
- [x] M5 追问：按截止倒推的追问计划 + 三按钮回答 + 连续拖延自动降级
- [x] M6 打磨：无边框面板、开机自启、NSIS 打包

---

## 目录结构

```
whale-reminder/
├── src/                      前端（React 19 + TypeScript）
│   ├── App.tsx               桌宠容器：拖拽、状态机入口
│   └── pet/                  立绘渲染、眨眼、状态映射
├── src-tauri/                Rust 侧
│   ├── src/main.rs           入口（M4 将在此分流 --mcp）
│   ├── src/lib.rs            Tauri 装配
│   ├── src/window.rs         窗口位置恢复与防抖持久化
│   ├── src/tray.rs           托盘与右键菜单
│   └── src/config.rs         配置文件读写
├── assets/pet/               立绘素材（WebP + meta.json + 图标）
├── tools/prepare-art.py      立绘处理脚本
└── docs/                     设计文档
```

## 开发

```bash
pnpm install        # 安装依赖
pnpm tauri dev      # 开发模式，热重载
pnpm tauri build    # 打包 NSIS 安装包
```

开发模式下可用数字键 `1`–`7` 预览各状态立绘（idle / react / remind / think / sleep / celebrate / drag），用于验证 6 张素材都能正常加载。

---

## MCP 接入

AI 客户端通过 stdio 拉起 `whale-reminder.exe --mcp`。这条路径**完全不初始化 Tauri**、不建任何窗口，stdout 只走 JSON-RPC（日志一律走 stderr）。

### Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "whale-reminder": {
      "command": "C:\\Program Files\\Whale Reminder\\whale-reminder.exe",
      "args": ["--mcp"]
    }
  }
}
```

开发期直接指向 `D:\code\fe\whale-reminder\src-tauri\target\debug\whale-reminder.exe`。

### Cursor

项目根新建 `.cursor/mcp.json`，结构相同。

### 提供的工具

| 工具 | 作用 |
|---|---|
| `list_tasks` | 列出待办，可按状态 / 关键词过滤 |
| `get_task` | 按 id 查单条，含提醒计划 |
| `create_task` | 创建待办，带 due_at 时自动生成提前 30 / 10 分钟提醒 |
| `update_task` | 改字段（**不能**设 `done`） |
| `complete_task` | 完成，同时关停所有提醒 |
| `delete_task` | 软删除，必须传 `confirm: true` |
| `snooze_reminder` | 推迟下次提醒 N 分钟 |
| `get_today_brief` | 今日完成 / 待办 / 逾期统计 |

### 手动验证

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| ./whale-reminder.exe --mcp
```

正常应输出 initialize 响应（`serverInfo.name` 为 `whale-reminder`）和 8 个工具定义。

---

## 打包

```bash
pnpm tauri build
```

| 产物 | 大小 |
|---|---|
| `src-tauri/target/release/whale-reminder.exe` | 8.2 MB |
| `src-tauri/target/release/bundle/nsis/Whale Reminder_0.1.0_x64-setup.exe` | **3.1 MB** |

NSIS 安装包，双击安装。首次运行会自动注册开机自启（之后可在托盘菜单里关掉）。

> 开发模式下自启注册的是 `target\debug\whale-reminder.exe`。如果装过安装版却发现自启指向 debug 路径，删掉 `%APPDATA%\com.whalereminder.app\.autostart-initialized` 再启动一次即可重新注册。

---

## 环境

| 组件 | 要求 | 本机状态 |
|---|---|---|
| Rust | stable-x86_64-pc-windows-msvc | 1.99.1 已装 |
| Visual Studio | 含「使用 C++ 的桌面开发」 | 2026 Community 已装 |
| WebView2 | Win10 1803+ / Win11 内置 | 156 / 157 已装 |
| Node / pnpm | 22+ / 10+ | 22.22 / 10.12 |

`~/.cargo/bin` 已加入用户 PATH。若终端里找不到 `cargo`，是当前终端进程早于安装启动，重开终端即可。

**cargo 下载卡住时**：国内网络下 cargo 的 HTTP/2 多路复用会导致下载极慢（实测 17 分钟只下 8 个包）。关掉多路复用即可：

```bash
export CARGO_HTTP_MULTIPLEXING=false
cargo build
```

---

## 已识别的四个坑

1. **`--mcp` 模式下 stdout 只能有 JSON-RPC** —— 任何 `println!` 都会导致协议解析失败，日志必须走 `eprintln!` 或文件。
2. **透明窗口会拦截点击** —— Tauri 无法做像素级命中测试，方案是把窗口收缩到宠物包围盒（176×176），而不是全屏透明层。
3. **GUI 未运行时 AI 加的待办没人提醒** —— 靠开机自启 + 托盘常驻缓解，UI 上要明确提示状态。
4. **休眠唤醒后提醒风暴** —— 同一任务错过多条提醒时只补发最新一条。
