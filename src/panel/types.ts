/** 面板三个页面共用的数据结构，和 Rust 侧 serde 出来的字段一一对应。 */

export interface ReminderView {
  id: string;
  kind: string;
  /** 规则 JSON，循环提醒靠它渲染「每天 09:00」这类标签 */
  rule: string;
  next_fire_at: string;
  state: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  due_at: string | null;
  start_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  estimate_min: number | null;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  reminders: ReminderView[];
  ask_count: number;
}

export interface DayBrief {
  total: number;
  done: number;
  pending: number;
  overdue: number;
}

/** `get_settings` / `set_*` 的返回，字段对应 commands.rs 的 SettingsView */
export interface SettingsView {
  bubble_seconds: number;
  autostart: boolean;
  version: string;
  data_dir: string;
  /** 面板被手动拖过之后的尺寸（逻辑像素）；null 表示高度跟着内容走 */
  panel_size: { width: number; height: number } | null;
  /** 桌宠立绘风格，对应 settings.rs 的 PetStyle */
  pet_style: "chibi" | "real";
  /** 是否用 Live2D 动态立绘（只在写实风格下生效） */
  pet_live2d: boolean;
  /** 呼出待办面板的全局快捷键，规范写法："Alt+Space" */
  panel_shortcut: string;
}

/** 一条扫码记录，对应 scanner.rs 的 ScanEntry */
export interface ScanEntry {
  id: string;
  text: string;
  /** ZXing 的格式名（QR_CODE / EAN_13…），展示前用 scan/format.ts 翻成中文 */
  format: string;
  /** UTC RFC3339 */
  at: string;
}

/** `qr_encode` 的返回：不带静区的模块矩阵，前端负责画 */
export interface QrMatrix {
  /** 边长（模块数） */
  size: number;
  /** 行优先的 '0'/'1' 串，'1' 是黑块 */
  modules: string;
}

/** 一个标签，对应 tag.rs 的 Tag */
export interface Tag {
  id: string;
  name: string;
  /** UTC RFC3339 */
  created_at: string;
}

/** 带「有多少条备忘在用」的标签，对应 tag.rs 的 TagView（serde flatten 成扁平结构） */
export interface TagView extends Tag {
  note_count: number;
}

/** 一条备忘，对应 note.rs 的 Note */
export interface Note {
  id: string;
  body: string;
  /** 置顶的排在列表最前面 */
  pinned: boolean;
  /** UTC RFC3339 */
  created_at: string;
  /** UTC RFC3339，改正文/标签时才更新（置顶不动它） */
  updated_at: string;
  /** 挂在这条备忘上的标签，按名字排 */
  tags: Tag[];
}

/** 工具页面拿到的 props：内容变了就喊一声，面板好重新量高度 */
export interface ToolProps {
  onLayout: () => void;
}

/** 一条搜索结果，对应 search.rs 的 Hit */
export interface SearchHit {
  name: string;
  /** 完整路径（应用是 .lnk 的路径，交给 ShellExecute 能直接启动目标） */
  path: string;
  kind: "app" | "file" | "dir";
}

/** `search_icons` 的返回：某个路径的真实图标 / 缩略图（PNG data URL）；null 表示取不到 */
export interface SearchIcon {
  path: string;
  icon: string | null;
}

/** `search_query` 的返回，对应 search.rs 的 Hits */
export interface SearchHits {
  apps: SearchHit[];
  files: SearchHit[];
  /** 这批文件结果从哪来的：借了 Everything 的全盘索引，还是只搜了常用目录 */
  engine: "everything" | "index" | "none";
  /** 降级原因，直接显示给用户看（比如「Everything 没在运行」） */
  notice: string | null;
}

/** `search_status` 的返回，对应 search.rs 的 SearchStatus */
export interface SearchStatus {
  /** 找到的 es.exe 路径；null 表示没接上 Everything 的命令行（≠ 没装 Everything） */
  es: string | null;
  /** 装了 Everything 本体 */
  everything: boolean;
  /** 索引建好没有（后台线程在建，冷启动时会先看到 false） */
  ready: boolean;
  apps: number;
  files: number;
  /** 本地索引覆盖的目录，降级时要把这几个目录说给用户听 */
  roots: string[];
}

/** 一个标的（搜索结果和自选条目共用），对应 stock.rs 的 StockItem */
export interface StockItem {
  /** 数据源的标的编号，「市场号.代码」，如 1.600519 / 116.00700；报价接口原样收 */
  secid: string;
  code: string;
  name: string;
  /** 市场标签：沪A / 深A / 港股 / 美股 / 基金…（老版本存的自选可能没有） */
  market: string;
}

/** 一条报价，对应 stock.rs 的 StockQuote。停牌时价格那几个字段是 null */
export interface StockQuote {
  secid: string;
  code: string;
  name: string;
  price: number | null;
  change: number | null;
  percent: number | null;
  prev_close: number | null;
  /** 价格的小数位（接口的 f1），格式化时照它走 */
  digits: number;
}

/** 一条「最近打开」记录，对应 search.rs 的 HistoryEntry */
export interface SearchHistoryEntry {
  name: string;
  path: string;
  kind: "app" | "file" | "dir";
  /** 最后一次打开的时刻（UTC RFC3339），卡片下面那行「3 小时前」靠它算 */
  at: string;
}
