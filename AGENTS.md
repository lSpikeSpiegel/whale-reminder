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
| 行情 | `--rise` `--fall` | 涨 / 跌，红涨绿跌（**别复用 `--danger`**，见 3.9） |
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
- **动态立绘开不开看素材，不看构建模式**：`src/live2d/availability.ts` 在挂载前探一张贴图
  （`main.tsx` 里等它），探到就用 Live2D，探不到就走静态图。素材（`model.moc3` + `textures/`）
  0.8.0 起入库，所以开发版和 Actions 产物都带得动，探测只是给「素材被裁掉的构建」兜底。
  **没有开关**：0.7.0 起这是默认真形态，`pet_live2d` 这个设置项、`set_pet_live2d` 命令和
  `pet://live` 事件都已经删了，别再把它加回设置页。也别改回 `import.meta.env.DEV`——
  release 同样带着 `assets/live2d/`（`publicDir` 会拷进 `dist`），按构建模式判断只会让它白跑一张静态图。
- **动态立绘的落位分两步，别只做第一步**：先按「顶点包围盒」等比贴底居中画一帧
  （`src/live2d/fit.ts` 的 `fitToViewport`），再按**实际画出来的像素**校正一次
  （`fixFromMeasured`）。只按顶点会小一圈——模型里有顶点摊得比着色范围宽的 drawable，
  实测宽度虚高 25%、高度只差 3%，落位只有该有的 89%。两个函数都是纯函数，有单测。
  启动日志那行 `[live2d] … 落位正确 / ← 构图不对` 是自检（填充率、贴底、居中三条），
  不对才把画布转储到 `%TEMP%\whale-live2d.png`。别把这行删了——构图错了只有它看得出来。
- **尾巴甩动必须在物理之后叠**：`Param_Angle_Rotation84`…`89`（`[0]尾巴`…`[5]尾巴`）是
  physics3 的 Angle Output，物理每帧都会整组覆盖。`WhaleModel.update` 的 `tail` 参数在
  `physics.evaluate` **之后**按节加角度，并自己夹到参数 min/max；写在前面就是白加。
  触发点是 `usePetBehavior` 的 `wag` 计数（`play` / `pat` / `poke` / `sulk` / `wake` 各 +1）、
  呼出面板（Rust `pet::emit_wag` → `pet://wag`）和拖拽结束（`endDrag`）。
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
| `scan` | 当前屏幕的物理像素 | 二维码助手的框选浮层，用完即销毁（见 3.6） |
| `pick` | 当前屏幕的物理像素 | 颜色转换的吸管浮层，用完即销毁（见 3.6） |

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

`panel` 是「62px 导航 + 内容区」两栏，导航六项：搜索 / 待办 / 历史 / 备忘 / 工具 / 设置。
**搜索在最上面，下面接一根短横线**——它是「取东西」，其余五项是「管东西」，
不隔一下的话搜索看着只是待办旁边又一个并列的页。

- 导航项 46×44，图标 17×17（`stroke 1.5`）在上、10.5px 标签在下，竖排居中；
- 选中态是 `--brand-soft` 底 + `--brand` 字，左侧一根 3px 胶囊指示条。
  **指示条要离面板描边 2px**——贴着描边会被读成「被切掉一半的缺口」；
- 切页靠 `.page` 容器的 `key={page}` 重挂载 + 150ms 淡入。这一层必须
  `flex: 1; min-height: 0; display: flex; flex-direction: column`，
  否则里面的列表拿不到 `flex: 1`，高度会塌成 0；
- 页面动画**只用 opacity**。带位移或缩放时 `fit()` 会量到动画中间态，窗口高度要来回收敛；
- 每个页面都要有一个 `data-page-body` 容器给 `fit()` 量高度。**搜索页是例外**，
  见 3.8——它的内容每敲一个字都在变，跟着量就是打字时窗口上下抽动；
- 页面内部改数据（历史页的恢复 / 删除、设置页的清空历史）必须通过 `onDataChanged`
  通知 `Panel` 重拉列表，否则切回待办看到的还是旧数据。
- **有待办时给待办图标点一颗红点**（6px、`--danger`、2px 白圈），**不显示数量**——
  数量在列表头，导航里再写一遍太吵。没有待办就完全不渲染。
- **导航总高要卡在 340 以内**（面板 356 高时导航可用 340）：应用标记 21 + 六项 264
  + 八道 3px 间距 24 + 分隔线 5 + 上下内边距 20 = 334。加第七项之前先重新算一遍，
  超了会被 `.panel` 的 `overflow: hidden` 直接切掉最后一项（不报错，只是没了）。

### 3.4 面板是「关了就没」的窗口

关闭按钮不是隐藏，是**真关窗口**（`close_panel` → `window.close()`）。下次打开由
`open_panel` 按 `tauri.conf.json` 里那份 `panel` 配置重建，页面重新加载——页签落在搜索页、
表单清空。好处是常驻内存只剩桌宠一个 WebView；代价是下面两条必须守：

- **建窗口不能占着主线程**。`build()` 会把创建请求发给事件循环再等回执，在主线程上调
  就是自己等自己：窗口能出来，但 `build()` 永远不返回、页面永远不加载。从后台线程
  （`std::thread::spawn`）发起才对。
- **`visible(true)` 要在 build 时给**，别建完再 `show()`：Windows 上那样经常不生效，
  窗口一直藏着，看着像「点了没反应」。
- 位置存在 `PanelPos` 里（只在内存，重启后回到 conf 的居中），关之前记一次，重建时摆回去。
- **Esc 也是关面板**，和 × 走同一个命令（`Panel.tsx` 的 window keydown → `close_panel`）。
  它只认「没被别人吃掉的 Esc」：日历浮层、备忘编辑框、搜索框、行情搜索框都会在
  用掉 Esc 时 `preventDefault()`，面板看到 `defaultPrevented` 就让位。**新增一个
  吃 Esc 的控件时记得也 `preventDefault()`**，否则用户收浮层会连带把面板关掉；
  输入法组字中的 Esc（`isComposing`）不算，那是取消候选。
- 托盘点「检查更新」时面板可能是关着的，新窗口还没加载完，事件发过去没人接——
  用 `PendingCheck` 留个标记，页面挂载后 `take_pending_check` 自己来取。

### 3.5 呼出面板的全局快捷键

`shortcut.rs`，默认 `Alt+Space`，存 `settings.json` 的 `panel_shortcut`。

- **`Alt+Space` 会被系统菜单截胡**：窗口虽然是 `decorations: false`，Windows 仍给每个
  顶层窗口挂着系统菜单，焦点窗口按 `Alt+Space` 会在左上角弹出「还原 / 移动 / 关闭」。
  `sysmenu.rs` 用 `SetWindowSubclass` 吞掉空格的三条 `WM_SYSKEY*` 和
  `WM_SYSCOMMAND(SC_KEYMENU)`；启动时遍历已有窗口，之后在 `on_window_event` 的焦点
  事件里补挂。删掉这段，热键每按一次就多弹一个系统菜单。
- **默认值可能被启动器占着**：uTools、PowerToys Run 都默认吃 `Alt+Space`。被占时
  `RegisterHotKey` 直接返回「已被注册」，`bind()` 会退到三键组合——这是预期行为，
  设置页显示的是**实际绑上**的那个，不是用户填的那个。
- **换默认值必须带迁移**：老配置里存的是旧默认 `Control+Alt+Space`，只改常量的话
  老用户升级后还是老键。`settings.rs` 的 `migrate_shortcut` 在第一次读到老配置时换掉
  并置 `shortcut_default_migrated`，只做一次——之后用户自己选回三键组合不会被覆盖。
- **被占时要自己找退路**：`bind()` 顺着 `FALLBACKS` 往下试，返回**第一个真的绑上的**，
  调用方拿它落盘。只「退回默认值」是没用的——默认值可能同样被占，等于什么都没绑。
- **按下和松开各来一条事件**，回调里必须筛 `Pressed`，否则一次按键开一次关，
  看起来像快捷键失灵（见 `lib.rs` 的 `with_handler`）。
- **toggle，收起用 `hide` 不用 `close`**：面板里常常正填着表单，销毁等于白填；隐藏后
  再按回来输入还在，而窗口重新拿到焦点时 `Panel.tsx` 会自己 `refresh()`，不会看到旧列表。
  关闭按钮仍然是真关，那是用户的明确意图，不走这里。
- **录制期间热键不再 toggle**：设置页点「改键」之后，用户按的第一个组合很可能就是
  当前那个。注销再挂回这条路一旦被打断（面板被关、渲染进程崩），热键就永久失效。
  所以只把 `Capturing` 置位，`on_pressed` 改成「发 `shortcut://captured` 事件」，
  面板不动。退出录制态的出口有三个：`set_panel_shortcut`、`resume_shortcut`、
  `close_panel`——少一个就会出现「按了没反应，重启才好」，临时注册的键也会漏在里面。
- **注册过的组合收不到 keydown，录制走事件**：`RegisterHotKey` 注册过的组合按下去会被
  系统吞掉，而前端录制器靠 `keydown`。所以录制期间后端把按到的组合从热键回调里推给
  前端（`shortcut://captured`），前端收到就直接落盘——这顺带解决了「录不到当前组合」
  的老限制。
- **`Alt+Space` 是单向门的例外，必须临时注册**：它不在注册状态时会被窗口的系统菜单
  吃掉（`DefWindowProc` 的 `SC_KEYMENU`），`keydown` 永远到不了 webview——所以把热键
  改走之后，纯前端录制器再也录不回它。`begin_capture` 因此在录制期间临时注册它，
  拿到 `WM_HOTKEY` 后当正常结果回传；占不住（被启动器占着）时命令返回 `false`，
  设置页会提示一句。`end_capture` 的三个出口负责摘掉，别把这段删了。
- **录制器只认 `e.code`**：插件的主键白名单就是 `keyboard-types` 那套 Code 名字，
  `KeyA` / `Digit1` / `Space` / `ArrowUp` / `Numpad0` 可以直接透传；
  `IntlBackslash`、`NumpadComma` 这类它不认，录之前用 `hotkeyCode()` 挡掉。
- **系统保留的组合仍然录不到也绑不上**：`Win+L`、`Ctrl+Alt+Del`、`Alt+Tab` 这些被
  系统自己吃掉的，`RegisterHotKey` 也会失败，不是录制器的锅。
- **必须带修饰键**：裸字母做全局热键会把正常打字全抢走，录制器直接拒绝并给提示。
- 启动时那行 `[shortcut] 已绑定 …` 是自检：快捷键「按了没反应」时，先看它有没有出现。

### 3.6 全屏截图浮层（`scan` / `pick`）

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

### 3.7 工具页：清单 → 详情

「工具」页只做入口：一行一个工具（图标 + 名称 + 一句话 + ›），点进去才是详情，
左上角「‹ 全部工具」返回，页头标题跟着换成工具名（`Tools` 通过 `onTitle` 回传）。

- **新增工具只改 `src/panel/Tools.tsx` 的 `TOOLS` 数组**：写一个 `ToolXxx.tsx`、
  在 `toolIcons.tsx` 加图标、加一条定义，别的都不用动。
- 工具的 `View` **只返回内容片段**（一串 `<section>`），不要自己套 `page__body`——
  滚动容器、返回按钮、页头标题、高度自适应都由 `Tools` 统一管。
- 还没实现的工具用 `soon("打算做成什么样")` 占位：清单里能点进去，详情页显示
  「待开发」+ 一句预告。真做的时候把那条的 `View` 换成自己的组件即可。
  六项现在都实现了，`soon` 没有调用方，留着给下一个占位工具（导出着，不算死代码）。
- 清单行高固定、数量不限，**别让某个工具把整页占满**——详情都在下一层。
- **顺序不写死**：按打开次数倒序排（`tool_open` 记一次、`tool_usage` 读回来，
  存在 `data_dir/tool_usage.json`），次数相同的保持 `TOOLS` 里的声明顺序。
  所以数组顺序只是「都没用过时的默认顺序」，加工具时按重要性写就行，不用管位置。

### 3.8 搜索页（面板默认页）

`src/panel/Search.tsx` + `src-tauri/src/search.rs`。**面板打开第一眼就是它**，
热键唤起也回到它（`panel://shown`）。

- **`panel://shown` 只在「隐藏 → 显示」时发**（`tray.rs`）。窗口本来就在、只是被别的
  程序压住，那叫「提到前面」，不能把用户正在填的表单和翻到的页冲掉。前端收到它同时做
  两件事：`setPage("search")` 和 `recall + 1`（搜索页靠这个 token 清空输入框——切页会
  重挂载，但「本来就在搜索页」时不会，只能靠 props 通知）。
- **不参与高度自适应**：这一页没有 `data-page-body`。结果每敲一个字都换一批，跟着内容
  改窗口高度会让面板在打字时上下抽动。窗口保持打开时的尺寸，列表自己滚。
- **两条腿**：应用 = 扫开始菜单（全局 + 当前用户）和桌面的 `.lnk` / `.url`，几百个文件、
  毫秒级，永远可用；文件 = 优先交给 Everything，够不着才用「桌面 / 文档 / 下载」的本地索引。
- **文件搜索走 `es.exe`，不走 `Everything64.dll`**：DLL 是同步接口、还能直接拿 UTF-16 路径，
  但它要求 Everything 安装目录里恰好带着那个 DLL，而且得手写 `unsafe` FFI——DLL 不在时
  拿不到任何反馈，只能静默失效。CLI 的失败有明确退出码，出问题能看见、能降级。
  真要压延迟再换 DLL，接口都收在 `run_es` 一处。
- **`es.exe` 的三个坑**：`-i` 是「区分大小写」（不是忽略），所以别传；输出列跟着
  `es.ini` 和版本变，只能取每行**最后一个制表符后面**那段再按「像不像绝对路径」过滤；
  退出码 7 = IPC 失败、8 = Everything 没在跑，都当「降级」而不是「出错」。
  另外它的 stdout 跟着控制台代码页走（中文系统是 GBK），UTF-8 解不开时要按 GB18030 再来一遍，
  否则中文路径会变成替换字符——路径看着在，就是打不开。
- **`es.exe` 只在建索引时探一次**，所以搜索页状态行旁边有个「重新检测」（`search_reindex`）：
  先开面板后装 Everything 的人不用重启。
- **打开结果走 `ShellExecuteW`**，不拼 `cmd /c start`：路径里的空格、`&`、中文都不好转义，
  而且 `start` 会把第一个带引号的参数当成窗口标题。`.lnk` 也直接交给它，不用自己解析目标。
- **「点了没反应」先看这两行日志**：`[search] 已交给系统打开：… → rc=` 和
  `[search] 打开失败：… → rc=…`。rc ≤ 32 是失败，错误码会被翻成人话（权限、没有打开方式…）。
  **rc 成立但窗口没出来**，八成不是 ShellExecute 的问题，而是进程环境被污染了——
  典型是继承到 `ELECTRON_RUN_AS_NODE=1`：Electron 应用会以 Node 模式一闪而过（实测
  `OpenCode.exe --version` 打印的是 `v24.22.0`）。`lib.rs::scrub_electron_env` 在启动时清掉它，
  因为本应用常常是从别的 Electron 程序的终端里起来的（IDE 内置终端、启动器、开发时的 shell）。
- **打分只看名字**（`score`）：完全相等 > 从头匹配 > 命中靠前 > 包含 > 子序列（`vsc` →
  Visual Studio Code）。单字查询不开子序列——否则一个「v」满屏都是命中。
- **结果行不做进场动画**：每敲一个字整屏都换一遍，动画只会变成抖动（待办列表那种
  260ms 落位是给「一次新增一条」用的）。
- **结果用真实图标 / 缩略图**：`icons.rs` 走 Shell 的 `IShellItemImageFactory` 取 48px
  PNG（图片是缩略图，其它文件是系统图标），转成 data URL；`search_icons` 一批拿完，
  前后端各一层缓存，取不到才退回通用 SVG。命令在 `spawn_blocking` 里跑，进去先
  `CoInitializeEx`；HBITMAP 是**预乘 alpha**，要反预乘再编 PNG，否则透明边发黑
  （细节在模块头注释）。
- **点开结果立刻把面板藏掉**，再做 `search_open`。启动 IDE 要好几秒，面板杵在原地
  会让人以为「没点上」而反复点，同一个程序被拉起两个实例——JetBrains 的 `.port` /
  `.lock` 会直接报 `AccessDeniedException` + `Address already in use`（实机证据：日志里
  同一个 `Android Studio.lnk` 连着出现四次打开请求）。两道保险：`OPEN_GUARD_MS`（800ms）
  吃掉双击的第二下；后端对「应用」还有同路径 4 秒去重（`search.rs` 的
  `repeated_within`）。失败时把面板 `show` 回来，错误行还在。
- 搜不到东西时给一条出路：「记为待办」把那句话原样塞进待办输入框（`onDraft`），
  不直接建任务——让人还能改一遍再回车。

**最近打开（搜索页空态）**

- **只记「打开过」的条目，不记搜索词**。回到空输入框时，人想看的是「上次打开的那个文件」，
  不是「我上周搜过什么」。所以记录写在 `search_open` 里，不在 `search_query` 里。
- 存 `data_dir/search_history.json`（走 `fsutil::write_atomic`，和 `tool_usage.json` 一个路子），
  最多 **9 条**（3 列 × 3 行，436 宽的面板里正好一屏）。同一路径只留一行——比路径时忽略
  大小写和结尾反斜杠（Everything 给目录补的那条）。文件读坏了就当没有历史，不能让搜索页打不开。
- **打开成功才记**：文件已经被删的条目留在历史里，只会让人反复点到同一个错误。
- 空输入时铺成网格（`repeat(auto-fill, minmax(92px, 1fr))`，面板拖窄了自动掉成两列）。
  每张卡片是 `<button>`，右上角的 × 是它的**兄弟节点**——button 不能套 button，
  套了消除不掉「点叉也把文件打开」。
- 卡片顺序即数组顺序（后端已经按最近打开排好），前端不再排一次；`search_open` /
  `search_forget` 都返回整份历史，前端直接替换，不用二次查询。

**自己的东西也搜（待办 / 备忘 / 小工具）**

分组顺序是「离自己由近到远」：待办 → 备忘 → 工具 → 应用 → 文件。

- **这三类在前端过滤，不进 Rust**：工具就是 `Tools.tsx` 的 `TOOLS`（导出给搜索页用）、
  待办是 `Panel` 已经拉回来的 `tasks`、备忘进页面时 `list_notes` 读一次（`token` 变了再读）。
  好处是敲第一个字就出来，不用等 Everything 那几百毫秒。
- **匹配规则在 `src/panel/find.ts`**（纯函数，`tools/find-test.mjs` 19 个用例）：
  相等 > 开头 > 包含，**不做子序列**——「vsc → Visual Studio Code」那套套到中文正文上，
  几乎每句话都能凑出一个子序列，一搜一大片。子序列只给小工具名字用，`key` 顺便当英文别名
  （`qr` / `stock`）。
- **权重有讲究**：名字命中 800 > 小工具 key 完全相等 700 > 说明命中 480；
  待办标题 > 描述；备忘正文开头 > 标签完全相等（否则搜「工作」先给一堆挂了 #工作 的条目）。
- **组间不混排**：路径命中和标题命中不可比，混着排只会让人猜不透它凭什么在前面。
  组内按分数排、每组限量（待办 4 / 备忘 3 / 工具 3），别让「搜 a」把应用和文件挤出屏幕。
- **点工具 = 直接进那个工具**（`Tools` 的 `initial`，只在挂载时认一次——页面切换本来就重挂载）；
  **点待办 / 备忘 = 换页 + 滚到 + 点亮 1.6 秒**（`Panel` 的 `focus` / `flashTask`，
  `Notes` 的 `focusId`）。手动点导航会把 `focus` 清掉，否则下次进那一页又闪上次那条。
- **选中项只在查询变了时归零**，别在结果回来时归零：待办 / 备忘是即时的、文件要等 Rust，
  等文件回来再归零会把用户刚用 ↓ 挪到的位置抢走。结果变少时另外把下标收进范围。
- **备忘的第二行是正文片段**（`snippet`）：备忘没有标题，按码点截命中处那一段
  （`Array.from`，否则 emoji 会被切成半个字符），比只显示开头更能说明它为什么在这儿。

### 3.9 行情工具（`ToolStock.tsx` + `stock.rs`）

「工具 → 行情」：三个大盘指数 + 搜标的 + 自选涨跌。数据来自东方财富网页版在用的两个
公开 JSON 接口——搜索回 `QuoteID`（`1.600519` 这样「市场号.代码」），报价接口直接认它。

- **取数放在 Rust，不在前端 `fetch`**：WebView2 里跨域要对方给 CORS 头，这两个接口都不给，
  前端硬发只会卡在预检上，错误还只有一句 `Failed to fetch`。
- **自选只存标的，不存价格**：`data_dir/stock_watch.json`（走 `fsutil::write_atomic`），
  价格每次现问。昨天的收盘价留在本地只会误导人。
- **`fltt=2` 不能省**：不带它给的是乘过 100 的整数，少这层换算就是「小数点错位」的经典 bug。
- **停牌回的是 `"-"` 不是数字**，解析时当 `None`（界面显示「—」）。读成 0 会显示成「平盘」，
  那是错的信息，比空着更糟。
- **红涨绿跌**用 `--rise` / `--fall`，不要复用 `--danger`——红色在这里是「涨」不是「出错」；
  涨跌幅是 `null` 时按平盘上灰，别给它上色。
- **搜索结果和自选共用一块列表区**（互斥显示）：若让结果浮在自选上方，浮层要用 portal + fixed
  才不被 `.panel` 的 overflow 裁掉，而两层列表叠着时窗口高度每敲一个字都要来回收敛。
  搜索列表固定 240px 自己滚，`onLayout` 只在「进 / 出搜索」和自选增减时跑。
- **反馈、搜索状态、更新时刻共用列表头右侧那一格**：再单独吐一行提示会让面板高度随状态跳。
- 刷新 30 秒一次（切走页面就停）；失败时**保留上一轮的数字**——断网把列表清空，用户会以为自选丢了。
- 换指数改 `stock.ts` 的 `INDEXES`，secid 写死：`1.000001` 上证 / `0.399001` 深成 / `0.399006` 创业板。

**图表（`StockChart.tsx` + `kline.ts`）**

点自选里的一行进去：分时 / 日K / 周K / 月K，带 MA5/10/20、成交量、十字光标读数、前复权切换。

- **手写 canvas，不引图表库**：坐标映射、蜡烛、均线、光标加起来不到 300 行；引 ECharts /
  lightweight-charts 是几百 KB 加一套自己的主题体系，和「零运行时依赖」直接冲突。
- **`beg=0` 千万别传**：它的意思是「从最早一根开始」，会回 2001 年的**前复权**数据，
  而前复权 = 原价 − 累计分红，老股算出来是负数（实测茅台 `preKPrice: -313.3`）。
  只传 `end` + `lmt`；少 `end` 接口又回 `data: null`。
- **成交量单位是「手」**：分时均价 = 累计成交额 ÷（累计成交量 × 100），少乘这一百倍，
  均价线会跑到图外面去。
- **分时按昨收对称**：上下界取「离昨收最远的那个偏离」两边对折，0% 线落在正中，
  涨多少跌多少一眼等长；K 线则按最高最低加 6% 余量。
- **画布高度写死（`CHART_H`）**：改尺寸就要重画，和 `fit()` 的「高度跟着内容走」互相打架，
  抖动会非常明显。宽度才跟着容器走（ResizeObserver），窄到 320 也能看。
- **颜色从 CSS 变量读**（`getComputedStyle`）：canvas 拿不到 `currentColor`。均线用
  `--ma-5/10/20`（蓝 / 琥珀 / 紫），**不复用涨跌红绿**——三条线要能和蜡烛分开看。
- **十字光标每帧最多画一次**（rAF 合帧）：pointermove 的密度远高于屏幕刷新率，
  逐事件重画会在 160 根 K 线上掉帧。
- **点行的行为变了**：自选行以前是「点一下复制代码」，现在是「进图」。
  复制挪到图表页头（点名字 / 代码那一块就是复制，反馈写在同一行的小字上）。

### 3.10 图片处理（`ToolImage.tsx` + `image.rs`）

拖一张图或一个文件夹进来（也可以点「选择图片」），选格式 / 质量 / 长边 / 裁剪，另存或覆盖回本地。

- **压缩和转码都在 canvas 里做**（`drawImage` + `toBlob`），Rust 只负责读文件和写文件。
  引一套 Rust 图像库（image / oxipng / libwebp）要编很久、体积也大，而这个面板只做
  「随手压一下」——浏览器的解码器和编码器本来就是系统自带的。
- **拖拽走 Tauri 的 `onDragDropEvent`，不是 HTML5 的 `drop`**：Tauri 窗口默认
  `dragDropEnabled: true`，它会拦下 HTML5 拖拽，但换来的是**真实文件路径**——
  存盘时才能存回原图旁边。点「选择图片」走隐藏的 `<input type="file">`，WebView 不给路径，
  那就落到 `%USERPROFILE%\Pictures\Whale Reminder`。
- **预览和体积都是真编出来的**：选项一改就重编一次（140ms 防抖），「小了 73%」来自
  真实字节数，不是按质量估的。PNG 不吃 quality，所以切到 PNG 时整排质量胶囊收起来，
  别摆一排点了没反应的按钮。
- **JPEG 要先铺白底**：canvas 里的透明区域编码成 JPEG 会变成黑色。
- **文件名永远在 Rust 侧再洗一遍**（`sanitize_stem`）：`..`、`/`、`:` 漏一个就能写到
  别的地方去。重名自动变 `名字 (2).jpg`。
- **位图要主动 `close()`**：换图、卸载都关掉。`ImageBitmap` 占的是几百 MB 级的堆，
  等 GC 就是「处理两张 4K 图之后面板开始卡」。
- 「打开位置」复用 `search_reveal`（它本来就是个通用的路径定位命令，不专属搜索页）。
- 字节走 base64 过 IPC：比 JSON 数字数组省三分之二，20MB 以内的图来回都在百毫秒级。

**批量（拖文件夹）**

- `image_open` 合一：是文件夹就回清单（**只看第一层**，上限 200 张，多了如实说
  「先处理前 N 张」），是图片就回数据。判断放在有文件系统的一侧，前端不用先 stat。
- **不递归**：递归一次可能几百张，面板要转好几分钟，而用户拖文件夹时想的多半是
  「这一层这批图」。
- **顺序处理，一张一个循环**：读 → 解码 → 编码 → 立刻 `bitmap.close()` → 下一张。
  并发起来内存会翻几倍，而这里根本不缺那点时间。
- **选项改了不自动重跑**，只在列表上方提示「选项改过了」并给一个「重新处理」按钮——
  四十张图每点一下胶囊都重编一轮，谁也等不起。单张模式才做实时重编。
- **批量里的「原格式」是各存各的**：格式按每张自己的文件名推（`resolveFormat(format, job.name)`），
  不能拿单张那套「一个 target 走到底」。

**保存：另存还是覆盖**

- 点「保存」先就地展开一个选择条（不用浮层——`.panel` 的 overflow 会裁掉浮层）：
  「另存一份」/「覆盖原图」。选进来的图没有原路径，只给「另存」。
- **覆盖 = `image_save(..., replace: true)`**：同格式覆盖原路径；换格式写到新后缀，
  **先写成功再删旧文件**（写失败时原图还在）。换格式时目标名要是已经被另一张图占着
  （同名的 png 和 jpg 并存过），直接报错——那一下会顺手毁掉别人的文件。
- 覆盖是不可逆的，所以按钮描红边、下面写清后果（「原图是 .png，会被换成 .jpg，原文件删除」），
  别和「另存」长成一个样。

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
- **动作菜单有两份，加动作要同时改**：右键菜单在 `App.tsx`（`MENU_STATES` / `MENU_MOODS`），
  托盘在 `tray.rs`（`act:*`）。漏一处只是那个动作在某个入口里消失；前端在 `pet://action`
  收到未知动作时会忽略并打日志，不会把立绘渲染成 undefined。
  **菜单只放点了有变化的动作**：回神 / 抬头 / 发呆 / 被拖动 / 探头 在 Live2D 下都是默认
  参数、静态版也只是换个呼吸曲线，点了像没反应，所以不做菜单项（动作本身还在，由手势和
  状态机驱动）。打瞌睡和睡觉只留「睡觉」；「坐下干活」只由提醒触发，也不放进菜单。
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
node --experimental-strip-types tools/json-test.mjs     # 前端纯逻辑（JSON 解析 / 排版）
node --experimental-strip-types tools/stock-test.mjs    # 前端纯逻辑（行情格式化 / 自选对齐）
node --experimental-strip-types tools/find-test.mjs     # 前端纯逻辑（搜索页的匹配与摘要）
node --experimental-strip-types tools/kline-test.mjs    # 前端纯逻辑（均线 / 刻度 / 均价）
node --experimental-strip-types tools/image-test.mjs    # 前端纯逻辑（裁剪 / 缩放 / 文件名）
node --experimental-strip-types tools/live2d-fit-test.mjs  # 前端纯逻辑（Live2D 落位）
cd src-tauri && cargo test --lib                        # 后端 190 个用例
```

想确认行情接口本身还活着（改了参数、对方换域名时最先炸的是这里），单独跑：

```bash
cd src-tauri && cargo test --lib -- --ignored   # 只跑标了 #[ignore] 的真接口冒烟
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
