# AGENTS.md

给在这个仓库里干活的人和 AI 看的约定。**改任何界面之前先读完第 2 节**，
新增交互必须按这套规范实现，不要临时发挥。

---

## 1. 项目速览

Windows 桌面宠物 + 待办提醒。Tauri 2 + React 19 + TypeScript，Rust 侧管数据库、调度、窗口几何。

| 目录 | 内容 |
|---|---|
| `src/pet/` | 立绘渲染、粒子、待机状态机 |
| `src/panel/` | 待办面板、提醒气泡 |
| `src/ui/` | 设计令牌、开关、日期选择器 |
| `src-tauri/src/` | 命令、SQLite、调度器、托盘、窗口 |

**不引入第三方 UI 组件库。** 视觉语言参考 React Bits / Aceternity 那一套
（玻璃质感、高光边、弹性微交互），但全部手写在 `src/ui/` 里，零运行时依赖。
理由：桌宠常驻内存敏感，而第三方库为了一个日历就要拖进 gsap / motion / Tailwind。

---

## 2. 设计规范

### 2.1 唯一来源：`src/ui/tokens.css`

颜色、圆角、阴影、缓动**只能**从 CSS 变量取，禁止在组件里写死色值。
需要新颜色先加变量，再在注释里写清用途。

| 类别 | 变量 | 用途 |
|---|---|---|
| 文字 | `--ink` `--ink-2` `--ink-3` `--ink-4` | 主 / 次 / 辅助 / 占位，逐级变浅 |
| 品牌 | `--brand` `--brand-2` `--brand-3` | 主色 `#355CB6`，浅色用于描边和悬停 |
| 品牌淡 | `--brand-soft` `--brand-ring` | 选中底色 / 焦点光圈 |
| 语义 | `--danger` `--danger-soft` `--warn` | 逾期、错误 |
| 面 | `--surface` `--surface-2` `--surface-3` `--line` `--line-2` | 卡片 / 悬停 / 凹陷 / 分割线 |
| 圆角 | `--r-xl` 20 / `--r-lg` 14 / `--r-md` 10 / `--r-sm` 8 | 面板 / 卡片气泡 / 控件 / 小控件 |
| 阴影 | `--shadow-1` `--shadow-2` | 卡片 / 悬停抬升 |
| 缓动 | `--spring` `--ease` | 落位、按下 / 变色、淡入 |

`--shadow-3`（大外投影）**只用于不透明容器**。透明窗口里禁止使用外投影，见 2.3。

### 2.2 视觉语言

- **冷白玻璃**：面板底是 `linear-gradient(180deg, #fdfdff, #f4f6fd, #eef1fa)`，
  顶部叠一层 `radial-gradient` 淡蓝光晕（`rgba(91,141,239,.18)`）打破纯白的平。
- **高光边**：1px `rgba(22,32,63,.09)`。不要用白色描边——浅色桌面上看不见，
  深色桌面上又像发光的边。
- **强调色克制**：`--brand` 只出现在主操作、选中态、当前值三处。
  一屏里超过三个蓝色元素就说明层级没拉开。
- **层次靠阴影和底色区分，不靠边框堆叠**：卡片白底 + `--shadow-1`，
  悬停 `--shadow-2` 加 `translateY(-1px)`。

### 2.3 透明窗口的三条硬约束

窗口是 `transparent: true`，CSS 里看不见的地方等于「露出桌面」，会直接变成瑕疵：

1. **禁止外投影**。窗口只有 280×132 或 436×356，阴影会被窗口边距裁成一条灰带，
   看起来像蒙在卡片周围的半透明膜。只用 `inset` 高光。
2. **内容必须撑满窗口**，靠 `margin` 留出的空隙一定是透明的。
   需要留白就把窗口改小，别用透明边距。
3. **浮层要么夹进窗口，要么用 `createPortal` + `position:fixed`**。
   `.panel` 有 `overflow: hidden`，普通绝对定位的浮层会被裁掉。

### 2.4 尺寸与间距

- 间距一律 4 的倍数：卡片内边距 9–11，区块间距 8 / 10 / 12。
- 控件高度：输入框和主按钮 36，次级按钮 29–32，胶囊 24，开关 34×20。
- 面板默认 436 宽；**高度跟着内容走**（见 3.2），不要写死。
  用户拖过边角之后宽度也会变，所以布局别依赖「一定 436」，窄到 320 还得能看。

### 2.5 字体

系统字体栈 `var(--font)`。字号只有这几档，不要临时加：

| 用途 | 字号 / 字重 |
|---|---|
| 面板标题 | 15 / 600 |
| 卡片标题、任务标题 | 13–13.5 / 400–600 |
| 正文、按钮 | 12.5 / 500 |
| 辅助说明、时间 | 11–11.5 / 400 |
| 微型标签、胶囊 | 10.5 / 400–600 |

数字（时间、计数）加 `font-variant-numeric: tabular-nums`，避免跳动。

### 2.6 动效

- 只有两种曲线：`--spring` 用于「落位 / 按下 / 展开」，`--ease` 用于「变色 / 淡入」。
- 时长 140–380ms。按下统一 `transform: scale(.96)`，悬停位移不超过 1px。
- 列表项进场 260ms（`translateY(6px) scale(.985)` → 原位），浮层 180ms。
- 开关拇指按下时宽度 14 → 18（挤扁），松开走弹簧回位。
- 必须写 `@media (prefers-reduced-motion: reduce)` 兜底。

### 2.7 控件

| 场景 | 用什么 | 不要用什么 |
|---|---|---|
| 开关 | `ui/Switch.tsx` | 自己写 checkbox / 原生 input |
| 按钮 | `.ui-btn` + `--primary` / `--ghost` | 新造按钮类名 |
| 小胶囊、类型选择 | `.chip`，选中加 `.chip--on` | 下拉框 |
| 日期 + 时刻 | `ui/DatePicker.tsx` | 原生 `input[type=date/time]` |
| 只有时刻 | `DatePicker` 导出的 `TimeField` | 原生 `input[type=time]` |
| 快捷时刻（1 小时后 / 今早 9 点…） | `ui/date.ts` 的 `quickTimes` + `.chip` | 两边各写一套 |

`DatePicker` 的两种形态：

- `variant="month"`：整月日历浮层，面板里用。
- `variant="days"` + `inline`：最近 7 天横条 + 时分步进器，气泡里用（窗口太小放不下浮层）。

**永远不要用原生日期控件。** WebView2 的原生 date/time 是系统样式，和这套视觉完全冲突，
而且它的弹出层在透明小窗口里会被裁。

**时分默认值一律以当前时间为基准**：用 `nowTime()` / `defaultSlot(h)`，不要写死 `09:00`，
也不要为了「整齐」把分钟归整到 `:00` / `:30`——用户看到 17:00 而自己是 17:43，只会觉得莫名其妙。
开始 / 结束提醒带 1–2 小时提前量，是为了避免默认值落在过去（后端会直接跳过过去时间的提醒），
但分钟必须跟着此刻走。

### 2.8 文案

- 动作按钮用动词短语：「已开始」「15 分钟后」「晚点提醒我」，不用「确定」这种空话
  （除了选择器里的确认）。
- 状态说明写人话：「到开始时间了，动手吧」而不是「开始提醒触发」。
- 空状态给下一步动作：「在上面敲一句话就能记下来」。

### 2.9 两套立绘

桌宠有 Q 版和写实两套素材，设置页「外观」里切。两套共用同一套动作状态机，
差别只在「动作 → 图」这张映射表：

| 风格 | 素材 | 窗口 | 动作映射 |
|---|---|---|---|
| `chibi` | `assets/pet/` 11 张，来自开源桌宠项目 | 176×176（方图，全身但头大） | `ACTIVITY_POSE`，姿势随动作变 |
| `real` | `assets/pet-real/` 8 张（基础姿势 + PSD 的 7 组表情），从 DeepSeek-chan 分层 PSD 导出 | **172×340**（9 头身全身） | `ACTIVITY_POSE_REAL`，只有表情变 |
| `real` + Live2D | `assets/live2d/` 的 moc3（同一个角色的 Q 版模型） | 同 `real`，172×340 | 参数 `key1`…`key13` |

- **两套立绘窗口尺寸不同**，写实版是瘦长的全身图。窗口长宽比必须和素材一致——
  `object-fit: contain` 只保证不变形，比例不对就在四周留透明边，立绘看着像缩了一圈。
  尺寸在 `settings.rs` 的 `PetStyle::window_size()`，换风格时 `pet::apply_style_size`
  以**底边中点**为锚改窗口（脚不往上跳），贴着边就交给 `dock_to` 重算吸附坐标。
  动态立绘**不换窗口**：那个 moc3 的角色实测宽高比 0.43，和静态写实的 0.506 一个量级。
- **动态立绘的落位分两步，别只做第一步**：先按「顶点包围盒」等比贴底居中画一帧
  （`src/live2d/fit.ts` 的 `fitToViewport`），再按**实际画出来的像素**校正一次
  （`fixFromMeasured`）。只按顶点会小一圈——模型里有顶点摊得比着色范围宽的 drawable，
  实测宽度虚高 25%、高度只差 3%，落位只有该有的 89%。两个函数都是纯函数，有单测。
  启动日志那行 `[live2d] … 落位正确 / ← 构图不对` 是自检（填充率、贴底、居中三条），
  不对才把画布转储到 `%TEMP%\whale-live2d.png`。别把这行删了——构图错了只有它看得出来。
- **只有表情、没有姿势**：PSD 的「动作」组（竖食指 / 举手 / 狗尾草）只补手和袖口，
  原手臂还在，直接叠会变成三只手。真正的姿势变化要接 Live2D 运行时，见
  `docs/07-写实立绘接入.md`。
- 写实立绘头只占上面三成，所以摸头的热区比 Q 版小（`App.tsx` 的 `HEAD_RATIO`）。
- 加风格要动四处：`settings.rs` 的 `PetStyle`（含 `window_size`）、`poses.ts` 的
  `PET_BASE` + `ACTIVITY_POSE_*`、`tools/prepare-real-art.py` 的 `VARIANTS`、
  以及 `HEAD_RATIO`。
- 写实素材的授权是「可署名使用、不可二次分发模型本体」，所以 `assets/pet-real/`
  进版本库，原始 PSD / moc3 / 4K 贴图（约 200MB）在 `.gitignore` 里。
- **写实是默认，Q 版已归档**。Q 版那 11 张是别人画的，加一个表情就得求一张图，
  扩不动；新交互（连戳生气 / 连摸得意 / 甩出去 / 按系统闲置打盹 / 换屏）都只在写实版
  有对应表情，Q 版借最接近的姿势顶一下，不再补素材。
- 素材上限：PSD 里只有 `表情`（7 组）和 `动作`（3 组）可选，`动作` 用不了——
  它只补手和袖口，原手臂还在，叠上去变三只手。详见 `docs/07-写实立绘接入.md` 2.5 节。

---

## 3. 窗口与布局

### 3.1 四个窗口

| label | 尺寸 | 说明 |
|---|---|---|
| `main` | 176×176 / 172×340 | 桌宠，永远置顶。尺寸跟着立绘风格走（见 2.9），启动时按 `settings.json` 的 `pet_style` 现改 |
| `panel` | 436×356–640（可拖拽，最小 320×260，不设上限） | 待办面板，默认高度自适应；关掉即销毁，再开重建（见 3.4） |
| `bubble` | 280×132 / 164 / 208 / 250 | 追问卡 / 截止提醒 / 开始提醒 / 展开选择器 |
| `scan` | 当前屏幕的物理像素 | 二维码助手的框选浮层，用完即销毁（见 3.5） |
| `pick` | 当前屏幕的物理像素 | 颜色转换的吸管浮层，用完即销毁（见 3.5） |

尺寸常量分散在 `tauri.conf.json`、`scheduler.rs`、`Bubble.tsx`、`Panel.tsx`，
改一处要同步另外几处。

### 3.2 面板高度自适应

窗口尺寸写死在 conf 里会留下大片空白，所以由前端量内容高度、调 `panel_resize` 改窗口。
量的时候注意：

- 列表是 `flex: 1`，`scrollHeight` 永远等于 `clientHeight`，**量不出内容高度**，
  只能量「最后一个子元素的底边」到面板顶边的距离；
- `getBoundingClientRect` **不含外边距**，最后一条的 `margin-bottom` 要单独加回来，
  否则窗口差 6px，列表会莫名冒出滚动条；
- 改完尺寸布局会变，要再量一次收敛（上限 3 次，别写成死循环）；
- 窗口在 conf 里是 `resizable: false`，但 `set_size` 照样生效——**实测过**：无边框窗口的
  程序化改尺寸不受 resizable 影响（以前那句「resizable:false 会禁掉 set_size」是误判）。
  保持 false 是有意的：resizable:true 时 Tauri 会在窗口外圈挂一层只覆盖边框的原生子窗口
  做命中测试，它会把最外侧几像素的鼠标全吃掉。

**手动拖拽改尺寸**（`ui/ResizeHandles.tsx` + `tray.rs`）：

- **拖拽是前端自己算的**，不用 `startResizeDragging`：那个 API 只往事件循环投一条消息就
  返回，实测拖不动，而且拿不到结果。现在 pointerdown 记下指针和窗口的起点，pointermove
  按位移调 `setSize` / `setPosition`，rAF 压到每帧一次。
- **这些调用要在 `capabilities/default.json` 里显式授权**：`allow-set-size`、
  `allow-outer-size`、`allow-set-position`、`allow-scale-factor`。Tauri v2 的窗口命令默认
  大多不给，缺一条就被拒——而 `invoke` 的 reject 如果被 `.catch(() => {})` 吞掉，表现就是
  「拖了没反应」，极难查。**别吞这类错误，至少 `console.error` 出来。**
- 坐标全用 `event.screenX/screenY`（CSS px）：它和窗口逻辑尺寸是同一套单位，位移可以直接
  加减，不用管 DPI 缩放。从左边/上边拖时要同时挪位置，右边/下边只改尺寸。
- 拖完的尺寸**从窗口 resize 事件里认**：`Panel` 用 `autoSizesRef` 记住「fit() 刚要求的
  尺寸」，事件和其中任何一个都对不上才当用户拖的（记一串，因为 fit() 收敛会连改两次）。
- 一旦用户拖过，`lockedRef` 锁住，`fit()` 不再改窗口（内容多了就滚动）。尺寸存
  `settings.json` 的 `panel_size`（逻辑像素），下次开面板在 `create_panel` 里直接按它
  build，不先按出厂尺寸闪一下。设置页「面板 → 恢复自动」把它清掉并重新量一次。

### 3.3 面板左侧导航

`panel` 是「62px 导航 + 内容区」两栏，导航五项：待办 / 历史 / 备忘 / 工具 / 设置。

- 导航项 46×44，图标 17×17（`stroke 1.5`）在上、10.5px 标签在下，竖排居中；
- 选中态是 `--brand-soft` 底 + `--brand` 字，左侧一根 3px 胶囊指示条。
  **指示条要离面板描边 2px**——贴着描边会被读成「被切掉一半的缺口」；
- 切页靠 `.page` 容器的 `key={page}` 重挂载 + 150ms 淡入。这一层必须
  `flex: 1; min-height: 0; display: flex; flex-direction: column`，
  否则里面的列表拿不到 `flex: 1`，高度会塌成 0；
- 页面动画**只用 opacity**。带位移或缩放时 `fit()` 会量到动画中间态，窗口高度要来回收敛；
- 每个页面都要有一个 `data-page-body` 容器给 `fit()` 量高度；
- 页面内部改数据（历史页的恢复 / 删除、设置页的清空历史）必须通过 `onDataChanged`
  通知 `Panel` 重拉列表，否则切回待办看到的还是旧数据。
- **有待办时给待办图标点一颗红点**（6px、`--danger`、2px 白圈），**不显示数量**——
  数量在列表头，导航里再写一遍太吵。没有待办就完全不渲染。

### 3.4 面板是「关了就没」的窗口

关闭按钮不是隐藏，是**真关窗口**（`close_panel` → `window.close()`）。下次打开由
`open_panel` 按 `tauri.conf.json` 里那份 `panel` 配置重建，页面重新加载——页签回到待办、
表单清空。好处是常驻内存只剩桌宠一个 WebView；代价是下面两条必须守：

- **建窗口不能占着主线程**。`build()` 会把创建请求发给事件循环再等回执，在主线程上调
  就是自己等自己：窗口能出来，但 `build()` 永远不返回、页面永远不加载。从后台线程
  （`std::thread::spawn`）发起才对。
- **`visible(true)` 要在 build 时给**，别建完再 `show()`：Windows 上那样经常不生效，
  窗口一直藏着，看着像「点了没反应」。
- 位置存在 `PanelPos` 里（只在内存，重启后回到 conf 的居中），关之前记一次，重建时摆回去。
- 托盘点「检查更新」时面板可能是关着的，新窗口还没加载完，事件发过去没人接——
  用 `PendingCheck` 留个标记，页面挂载后 `take_pending_check` 自己来取。

### 3.5 全屏截图浮层（`scan` / `pick`）

「二维码助手 → 开始框选」和「颜色转换 → 取色」点下去时临时建出来的窗口，关掉就销毁、不常驻。
**抓屏、建窗口、收尾这三件事两个工具共用一份**，代码在 `src-tauri/src/overlay.rs`
（业务在 `scanner.rs` / `color.rs`，界面在 `src/scan/`）：

- `scan`：框选一块去认码（`src/scan/ScanOverlay.tsx`）。
- `pick`：光标处出放大镜，点一下取屏幕上的颜色（`src/scan/PickOverlay.tsx`）。
  这层**不能压暗**，否则读数全偏；系统光标也藏起来（`cursor: none`），
  否则箭头正好挡住要取的那个像素。
- **尺寸 = 鼠标所在那块屏幕的物理像素**，位置也是物理坐标。建窗口时先按逻辑像素
  给个初值，`build()` 之后立刻用 `set_position` / `set_size` 钉死——混合 DPI 下
  逻辑换算会差几像素，而浮层必须和底图严丝合缝。
- **先藏面板再抓屏**，中间等 140ms 让桌面重绘，否则底图里会留下面板的残影。
- 位置一律用**归一化比例**（0–1）或物理像素换回图片坐标。窗口的 CSS 尺寸和截图的
  物理像素在 200% 缩放下不是 1:1，按比例换算两边都不会偏。
- 关窗口（Esc / 点外面 / Alt+F4）统一走 `WindowEvent::Destroyed`，在那里把面板叫回来、
  顺手丢掉整屏 PNG——一张 4K 截图常驻内存太浪费。
- 浮层回传的数据走各自的命令（`scan_pick` / `pick_commit`）；吸到的颜色存在
  `PickedColor` 里，面板拿回焦点后 `pick_take` 自己取——面板这时才刚显示，
  发事件过去会赶在页面就绪之前。
- 生成二维码走 `qr_encode`，只回 `'0'/'1'` 模块矩阵，前端 canvas 画。别在后端编 PNG：
  同一个矩阵既要上屏又要导出，画一次就够。
- 这个窗口铺满整屏，是唯一可以放心用 `--shadow-3` 的地方（投影不会被窗口边裁掉）。

### 3.6 工具页：清单 → 详情

「工具」页只做入口：一行一个工具（图标 + 名称 + 一句话 + ›），点进去才是详情，
左上角「‹ 全部工具」返回，页头标题跟着换成工具名（`Tools` 通过 `onTitle` 回传）。

- **新增工具只改 `src/panel/Tools.tsx` 的 `TOOLS` 数组**：写一个 `ToolXxx.tsx`、
  在 `toolIcons.tsx` 加图标、加一条定义，别的都不用动。
- 工具的 `View` **只返回内容片段**（一串 `<section>`），不要自己套 `page__body`——
  滚动容器、返回按钮、页头标题、高度自适应都由 `Tools` 统一管。
- 还没实现的工具用 `soon("打算做成什么样")` 占位：清单里能点进去，详情页显示
  「待开发」+ 一句预告。真做的时候把那条的 `View` 换成自己的组件即可。
- 清单行高固定、数量不限，**别让某个工具把整页占满**——详情都在下一层。
- **顺序不写死**：按打开次数倒序排（`tool_open` 记一次、`tool_usage` 读回来，
  存在 `data_dir/tool_usage.json`），次数相同的保持 `TOOLS` 里的声明顺序。
  所以数组顺序只是「都没用过时的默认顺序」，加工具时按重要性写就行，不用管位置。

---

## 4. 代码约定

- **Tauri 命令边界一律 snake_case**：`NewTask` / `TaskPatch` 带 `deny_unknown_fields`，
  键名拼错会直接报错。曾经因为 `rename_all = "camelCase"` 把 `start_at` 静默丢了，
  排查成本很高。
- **时间存 UTC RFC3339**，只在展示层转本地时区。
- **提醒的来源标记**：开始时提醒在 `rule` 里写 `{"type":"once","origin":"start"}`，
  气泡靠它决定按钮。新增提醒类型沿用这个做法，别靠时间字段猜。
- **写文件必须走 `fsutil::write_atomic`**，不要 `fs::write`。直接覆盖写会在断电 / 磁盘满时
  留下半截 JSON，而读失败是**静默**退化成默认值——用户的面板尺寸、气泡时长就这么没了，
  没人会发现。临时文件名带 pid（`.name.pid.tmp`）：GUI 和 MCP 是两个进程，可能同时写同一个文件。
- **数据库坏了不静默重建**。`db::open_or_recover` 启动时跑 `PRAGMA quick_check`；坏了先把
  `whale.db` 连同 `-wal` / `-shm` 一起改名成 `whale.corrupt-<时间>.db`（**不删**，人工还有东西可捞），
  再从 `backups/` 里挑第一份**真能打开**的恢复；一份都没有才建空库。恢复动作记一条
  `event_log`（`action = 'db.recovered'`），用户以后能在历史里看到。
- **备份用 `VACUUM INTO`，不要复制 `.db` 文件**。WAL 模式下未 checkpoint 的数据还在 `-wal` 里，
  复制出来的库缺最近的写入。6 小时一份、留 7 份，跑在独立线程（`backup::spawn`）上，
  不和 15 秒一跳的调度器混在一起。
- **改 `task` / `note` / `reminder` / `tag` 的行，必须走 `sync::mutate`**，不要直接 `conn.execute`。
  它负责推进 `hlc` 并投 `outbox`，三件事同事务；绕过去就是「数据改了但没进队列」的静默丢失，
  本地完全看不出来，等用户换设备才发现。`sync.rs` 末尾的
  `repository_writes_all_land_in_the_outbox` 是护栏：新增写函数忘了接，跑测试会直接挂。
  批量改多行用 `mutate_many`（先把 id 取出来，改完就查不到了）。
- **别拿 `updated_at` 当同步版本号**。它是秒级的、依赖设备时钟，而且 `note::set_pinned`
  为了列表顺序稳定故意不更新它。定序一律用 `hlc`（`src/hlc.rs`，27 字符定长，
  字典序即全序）。这套拆分是刻意的：`updated_at` 管业务排序，`hlc` 管同步定序。
- 改 Rust 后 `tauri dev` 会重编并重启，HMR 不生效；`cargo test` 会被运行中的 dev 持锁挡住，
  要么先停 dev，要么等它编译完。
- **重播动效不要用 `key` 重挂子树**。`Pet` 的落地回弹原来靠 `key={land}` 重挂
  `.pet__land`，静态图时没成本；接了 Live2D 之后每拖一次就把画布一起重挂，
  模型得重下 16MB 的 moc3 和 5 张 4096² 贴图，表现为「拖一下就重载一次」。
  现在改成摘掉 `animation` → 强制回流 → 挂回去，DOM 和 WebGL 上下文都不动。
  凡是包着 `<canvas>` / iframe 的节点，都别用 key 来重播动画。
- 新增交互要给出可见反馈（台词、状态、动效），不要静默成功。
- **`.bubble__btn` 自带 `flex: 1`**，放进纵向的 `.bubble__stack` 会按纵向 basis 分高度，
  几行按钮一起被压扁（卡片比内容矮，窗口顶部露出一片透明还挡桌面点击）。栈里的子项要
  用更具体的选择器写成 `flex: none`，横排的 `.bubble__row` / `.bubble__quick` 里才是 `flex: 1`。
- **气泡高度和按钮行数绑定**：改按钮行数必须同步 `scheduler.rs` 的 `*_SIZE` 和 `Bubble.tsx`
  的 `*_HEIGHT`。量法：`grabwin.py bubble x` 抓窗口，卡片顶边到窗口顶边的差值就是多余留白
  （留白会挡住桌面点击），差值接近 0 才对。

---

## 5. 验收

**分工：AI 负责开发 + 单测 + 把项目跑起来，界面和功能由用户自己测。**

改完代码按这个顺序收尾：

```bash
npx tsc --noEmit -p tsconfig.json                      # 前端类型
node --experimental-strip-types tools/color-test.mjs    # 前端纯逻辑（颜色换算）
node --experimental-strip-types tools/codec-test.mjs    # 前端纯逻辑（编解码）
node --experimental-strip-types tools/live2d-fit-test.mjs  # 前端纯逻辑（Live2D 落位）
cd src-tauri && cargo test --lib                        # 后端 138 个用例
```

两条都过了，**再把 `tauri dev` 起起来留在后台**，用户直接在窗口里点。几条实操：

- **先跑测试再起 dev**：`cargo test` 会被运行中的 dev 持锁挡住，顺序反了得先停进程。
- `tauri dev` 要求 cargo 在 PATH 里，bash 下要先 `export PATH="$HOME/.cargo/bin:$PATH"`。
- 后台起、输出重定向到 `.workbuddy-ai/dev.log`；起来后确认进程在（`tasklist | grep -i whale`），
  再把「已经起好了」告诉用户。
- **重启前先确认端口是空的**：`tauri dev` 会拉起 `pnpm dev`（vite，占 1420），
  停掉外层进程时 vite 常常变成孤儿继续占端口，下一次启动就 `EADDRINUSE` 直接退出。
  排查：`netstat -ano | grep :1420` 找 PID，确认是本项目的 vite（命令行里带
  `node_modules/.pnpm/vite`）再 `taskkill //PID <pid> //F`，然后重启。
- 起起来之后**不要**截图、模拟点击、做 UI 自动化——那是用户的事，AI 到「进程在跑」为止。

**逻辑放哪、怎么测**：

- 需要落盘、系统能力（截屏、写文件、注册表）的 → Rust，写 `#[cfg(test)]` 单测。
- 纯换算 / 解析 / 格式化 → 放 `src/panel/*.ts` 的纯函数里（不放 JSX），
  用 `tools/*-test.mjs` 跑：`node --experimental-strip-types` 能直接 import `.ts`，
  不用装测试框架（`tools/color-test.mjs` 是样板）。
- 界面里只留「摆位置、接指针」，判断一律别写进 JSX。

用户自测时可能会用到下面这些脚本（AI 不用跑）：

```bash
python .workbuddy-ai/grabwin.py panel out   # PrintWindow 抓窗口，不受遮挡
python .workbuddy-ai/shot.py panel out      # 截屏幕区域（窗口必须在最前）
python .workbuddy-ai/demo-bubble.py wait    # 插一条马上要响的提醒，验证气泡
```

`grabwin.py` 把透明区域渲染成黑色，正好用来检查「窗口里有没有多余的东西」——
四角出现非纯黑就说明有东西溢出了。
