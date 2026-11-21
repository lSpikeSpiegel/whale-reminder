import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { matchNotes, matchTasks, matchTools, snippet } from "./find";
import { TOOLS } from "./Tools";
import { formatClock } from "../ui/date";
import type {
  Note,
  SearchHit,
  SearchHits,
  SearchHistoryEntry,
  SearchIcon,
  SearchStatus,
  Task,
} from "./types";
import "./search.css";

const panelWindow = getCurrentWindow();

interface Props {
  /** 搜不到东西时的出路：把这句原话丢进待办的输入框 */
  onDraft: (text: string) => void;
  /** 面板每次被唤起都会 +1，用来把这里清干净 */
  token: number;
  /** 面板已经拉回来的待办（未完成），直接在这里过滤，不再多问一次数据库 */
  tasks: Task[];
  /** 点一条工具结果：切到工具页并直接进那个工具 */
  onOpenTool: (key: string) => void;
  /** 点一条待办结果：切到待办页并高亮那一条 */
  onOpenTask: (id: string) => void;
  /** 点一条备忘结果：切到备忘页并高亮那一条 */
  onOpenNote: (id: string) => void;
}

/** 打字停顿多久才发查询。短到不觉得卡，长到不会每敲一个字母起一次进程 */
const DEBOUNCE_MS = 130;

/** 每次问后端要多少条。分组之后一屏最多也就十来行，多了纯属浪费 */
const LIMIT = 20;

/**
 * 自己的东西每组显示几条。
 *
 * 工具和备忘本来就不多，三条足够；待办会积到几十条，给四条。总上限锁住是
 * 为了防止「搜 a」这种宽查询把应用和文件整组挤到屏幕外面去。
 */
const TASK_LIMIT = 4;
const NOTE_LIMIT = 3;
const TOOL_LIMIT = 3;

/**
 * 点开一条结果之后，多久内的重复点击算同一次。
 *
 * 双击的每一下都会派发 `click`，而面板藏起来之前第二下可能已经在事件队列里了。
 * 挡掉它，否则同一个 IDE 会被拉起两个实例（`.port` / `.lock` 直接打架）。
 */
const OPEN_GUARD_MS = 800;

/**
 * Everything 的下载页。
 *
 * 不直接给 `es.exe` 的 zip 链接：那个文件名带版本号（`ES-1.1.0.27.zip`），
 * 发版就失效，写死在代码里等于半年后必然点不动。
 */
const EVERYTHING_DOWNLOAD = "https://www.voidtools.com/downloads/";

const iconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const MagnifierIcon = () => (
  <svg {...iconProps} width={14} height={14}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.4 10.4 14 14" />
  </svg>
);

const AppIcon = () => (
  <svg {...iconProps}>
    <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.6" />
    <path d="M2.6 6.4h10.8" />
  </svg>
);

const FileIcon = () => (
  <svg {...iconProps}>
    <path d="M4 2.6h4.6l3.4 3.4v6.8a1.2 1.2 0 0 1-1.2 1.2H4a1.2 1.2 0 0 1-1.2-1.2V3.8A1.2 1.2 0 0 1 4 2.6z" />
    <path d="M8.4 2.8v3.4H12" />
  </svg>
);

const FolderIcon = () => (
  <svg {...iconProps}>
    <path d="M2.4 5.2c0-.7.6-1.2 1.2-1.2h2.6l1.4 1.8h4.8c.7 0 1.2.5 1.2 1.2v4.6c0 .7-.5 1.2-1.2 1.2H3.6c-.6 0-1.2-.5-1.2-1.2z" />
  </svg>
);

/** 待办：一个打了勾的圈，比三条横线更能说明「这条是能做完的」 */
const TaskIcon = () => (
  <svg {...iconProps}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M5.6 8.2 7.3 9.9l3.3-3.6" />
  </svg>
);

/** 备忘：一张便签，和文件图标的折角区分开（这里没有折角） */
const NoteIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="2.6" width="10" height="10.8" rx="1.4" />
    <path d="M5.4 6h5.2M5.4 8.4h5.2M5.4 10.8h3" />
  </svg>
);

/**
 * 搜索页里的一行。
 *
 * 应用 / 文件那两类带 `hit`（要取系统图标、能「定位」），自己的东西
 * （工具 / 待办 / 备忘）只需要 `run`——点下去就是换页面。
 */
interface Row {
  /** React key，也是键盘选中项的身份 */
  key: string;
  kind: "tool" | "task" | "note" | "app" | "file" | "dir";
  title: string;
  /** 第二行小字：路径 / 一句话说明 / 时间 / 正文片段 */
  meta: string;
  hit?: SearchHit;
  /** 工具自带的图标组件；待办和备忘用上面两个通用图标 */
  Icon?: () => React.JSX.Element;
  run: () => void;
}

/** 待办行第二行：什么时候要做。没定时间就直说，别留一行空白 */
function taskMeta(task: Task): string {
  const at = task.due_at ?? task.start_at;
  return at === null ? "没定时间" : formatClock(at);
}

/** 备忘行第二行：#标签 · 最后改动。相对时间比完整时刻省地方，也更容易扫 */
function noteMeta(note: Note): string {
  const tags = note.tags.map((tag) => `#${tag.name}`).join(" ");
  const at = agoLabel(note.updated_at);
  if (tags === "") return at;
  return at === "" ? tags : `${tags} · ${at}`;
}

/**
 * 图标缓存：面板这次生命周期内，同一个路径只问后端一次。
 *
 * 存 `null` 表示「问过了，取不到」，别每次搜索都为同一个坏路径重试。
 */
const iconCache = new Map<string, string | null>();
/** 正在请求中的路径：打字快时两次查询会同时要同一批图标，别重复问 */
const iconPending = new Set<string>();

/**
 * 批量取结果图标。
 *
 * 图标回来之前先用通用图标顶着，搜索不等图标；一次最多问 60 个路径
 * （后端还有一层按路径的 PNG 缓存，重复搜索不会重新走 Shell）。
 */
function useIcons(paths: string[]): Record<string, string | null> {
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  // paths 每次渲染都是新数组，用拼出来的 key 当依赖，避免 effect 空转
  const key = paths.join("\u0000");

  useEffect(() => {
    const list = key === "" ? [] : key.split("\u0000");
    if (list.length === 0) return;
    let alive = true;

    // 先把缓存过的铺上：同一个路径第二次出现时不要闪回通用图标
    setIcons((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const path of list) {
        const cached = iconCache.get(path);
        if (cached !== undefined && next[path] !== cached) {
          next[path] = cached;
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const missing = list
      .filter((path) => !iconCache.has(path) && !iconPending.has(path))
      .slice(0, 60);
    if (missing.length === 0) return;
    for (const path of missing) iconPending.add(path);

    void invoke<SearchIcon[]>("search_icons", { paths: missing })
      .then((entries) => {
        for (const entry of entries) iconCache.set(entry.path, entry.icon);
        if (!alive) return;
        setIcons((prev) => {
          const next = { ...prev };
          for (const entry of entries) next[entry.path] = entry.icon;
          return next;
        });
      })
      .catch(() => {
        /* 取不到就继续用通用图标，不影响搜索 */
      })
      .finally(() => {
        for (const path of missing) iconPending.delete(path);
      });

    return () => {
      alive = false;
    };
  }, [key]);

  return icons;
}

function Badge({ kind, icon }: { kind: SearchHit["kind"]; icon?: string | null }) {
  return (
    <span className="search__badge" aria-hidden="true">
      {icon != null ? (
        // 系统图标是 48px PNG，显示时缩到 18/24；alt 留空，名字就在旁边
        <img src={icon} alt="" draggable={false} />
      ) : kind === "app" ? (
        <AppIcon />
      ) : kind === "dir" ? (
        <FolderIcon />
      ) : (
        <FileIcon />
      )}
    </span>
  );
}

/**
 * 结果行左边的图标。
 *
 * 应用 / 文件走系统图标（`Badge`），自己的东西用通用图形：小工具用它自己的图标
 * （和工具清单里同一个，一眼能认出来），待办是勾选圈，备忘是便签。
 */
function RowBadge({ row, icon }: { row: Row; icon: string | null }) {
  if (row.kind === "app" || row.kind === "file" || row.kind === "dir") {
    return <Badge kind={row.kind} icon={icon} />;
  }

  const Icon = row.Icon;
  return (
    <span className={`search__badge search__badge--${row.kind}`} aria-hidden="true">
      {Icon !== undefined ? <Icon /> : row.kind === "task" ? <TaskIcon /> : <NoteIcon />}
    </span>
  );
}

/**
 * 这一屏的结果到底是怎么搜出来的，得让用户看得见。
 *
 * 三种情况要分开说：接上了 Everything（全盘）、装了但缺 es.exe（只有常用目录）、
 * 压根没装（只有常用目录）。笼统写一句「未检测到 Everything」会让人以为装了也没用。
 */
function engineHint(status: SearchStatus | null, hits: SearchHits | null, busy: boolean): string {
  if (status === null) return "正在准备搜索…";
  if (!status.ready) return "正在建索引…";
  if (busy && hits === null) return "正在搜索…";
  if (hits?.notice != null) return hits.notice;
  if (status.es !== null) return "Everything · 连全盘一起搜";
  if (status.everything) return "Everything 少了命令行工具 es.exe，只搜了常用目录";
  return "本地索引 · 只搜桌面、文档、下载";
}

/**
 * 「刚刚 / 12 分钟前 / 昨天 / 11-06」。
 *
 * 历史卡片下面那行小字。超过一个月的直接给日期——「37 天前」还得自己换算，
 * 不如让人一眼看到是哪天。
 */
function agoLabel(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "";

  const minutes = Math.floor((Date.now() - time.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;

  const month = `${time.getMonth() + 1}`.padStart(2, "0");
  const day = `${time.getDate()}`.padStart(2, "0");
  return `${month}-${day}`;
}

export function Search({
  onDraft,
  token,
  tasks,
  onOpenTool,
  onOpenTask,
  onOpenNote,
}: Props) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHits | null>(null);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  /** 最近打开过的应用 / 文件，空输入时铺成网格 */
  const [recent, setRecent] = useState<SearchHistoryEntry[]>([]);
  /**
   * 备忘。面板没把备忘缓存在上层（备忘页自己读自己写），所以进这一页时读一次，
   * 之后每次被唤起再读——比每次都问数据库省，也不会看到别处已经删掉的条目。
   */
  const [notes, setNotes] = useState<Note[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  /**
   * 查询序号。每次发请求都 +1，回来时对不上就丢掉——
   * 打字快的时候会有两三个查询同时在飞，慢的那次回来了不能盖掉新的结果。
   */
  const seq = useRef(0);
  /** 上一次点开结果的时间，用来吃掉双击的第二下 */
  const lastOpenAt = useRef(0);

  const query = text.trim();

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await invoke<SearchStatus>("search_status"));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // 最近打开。读不出来就当空的——记录坏了不该让搜索本身不能使
  useEffect(() => {
    void invoke<SearchHistoryEntry[]>("search_history")
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  // 备忘：进页面读一次，每次唤起（token 变）再读一次。
  // 读失败就当没有备忘——搜东西这件事不该被一个次要的数据源拦住
  useEffect(() => {
    void invoke<Note[]>("list_notes", { filter: null })
      .then(setNotes)
      .catch(() => setNotes([]));
  }, [token]);

  // 索引在后台线程里建，建好之前搜文件是空的。600ms 一问，建好就停。
  useEffect(() => {
    if (status === null || status.ready) return;
    const timer = window.setTimeout(() => void loadStatus(), 600);
    return () => window.clearTimeout(timer);
  }, [status, loadStatus]);

  // 面板被重新唤起：输入框、结果、选中项一起归零，回到「打开就能敲」的状态
  useEffect(() => {
    setText("");
    setHits(null);
    setActive(0);
    setBusy(false);
    setError(null);
    seq.current += 1;
    inputRef.current?.focus();
  }, [token]);

  useEffect(() => {
    if (query === "") {
      // 作废还在飞的那次：它回来时会发现序号对不上，不会把结果贴回空输入框下面
      seq.current += 1;
      setHits(null);
      setBusy(false);
      setActive(0);
      return;
    }

    setBusy(true);
    // 换了查询就把选中项收回第一条。**不放在结果回来时**：待办 / 备忘是即时的、
    // 应用和文件要等 Rust，等文件回来再归零会把用户刚用 ↓ 挪到的位置抢走
    setActive(0);
    const timer = window.setTimeout(() => {
      const mine = ++seq.current;
      void invoke<SearchHits>("search_query", { text: query, limit: LIMIT })
        .then((result) => {
          if (mine !== seq.current) return;
          setHits(result);
          setError(null);
        })
        .catch((err) => {
          if (mine === seq.current) setError(String(err));
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  /**
   * 点开一条结果。
   *
   * 两条和手感有关的规矩：
   * 1. **先把面板藏掉再发请求**。启动 IDE 要好几秒，面板杵在原地只会让人以为
   *    「没点上」而反复点，同一个程序被拉起两个实例（JetBrains 的 `.port` 锁
   *    当场报 AccessDenied / Address already in use）。uTools 那种「点完就消失」
   *    才是启动器该有的反馈。
   * 2. **`OPEN_GUARD_MS` 内只认一次**，见常量注释。
   */
  const open = useCallback(async (hit: SearchHit) => {
    const now = Date.now();
    if (now - lastOpenAt.current < OPEN_GUARD_MS) return;
    lastOpenAt.current = now;

    // 藏起来失败（比如在纯浏览器里跑）不影响打开，只是少一下反馈
    const hiding = panelWindow.hide().catch(() => {});

    try {
      // 后端顺手记一条「最近打开」，返回值就是重排后的历史，直接铺回去
      setRecent(
        await invoke<SearchHistoryEntry[]>("search_open", {
          path: hit.path,
          name: hit.name,
          kind: hit.kind,
        }),
      );
      setError(null);
    } catch (err) {
      // 界面上是一行红字，但终端里看不到——顺手转一份到 dev 日志，方便排查「点了没反应」
      setError(String(err));
      void invoke("web_log", { message: `[search] 打开失败：${err}` });
      // 面板已经藏起来了：叫回来让用户看见错误。页面没卸载，查询和错误行都还在
      void hiding
        .then(() => panelWindow.show())
        .then(() => panelWindow.setFocus())
        .catch(() => {});
    }
  }, []);

  /**
   * 分组的搜索结果。
   *
   * 顺序是「离自己由近到远」：自己写下的（待办 / 备忘）→ 自己想用的（工具）→
   * 机器上的（应用 / 文件）。组内按相关度排，**组间不混排**——一个路径命中
   * 和一个标题命中本来就不可比，混着排只会让人猜不透它凭什么在前面。
   *
   * 待办 / 备忘 / 工具是纯前端过滤，敲第一个字就出来，不用等 Rust 那边的
   * Everything；应用和文件仍然是一次 `search_query` 的结果（有防抖）。
   */
  const sections = useMemo(() => {
    if (query === "") return [];

    const hitRow = (hit: SearchHit): Row => ({
      key: `${hit.kind}:${hit.path}`,
      kind: hit.kind,
      title: hit.name,
      meta: hit.path,
      hit,
      run: () => void open(hit),
    });

    return [
      {
        key: "task",
        label: "待办",
        rows: matchTasks(tasks, query)
          .slice(0, TASK_LIMIT)
          .map<Row>((task) => ({
            key: `task:${task.id}`,
            kind: "task",
            title: task.title,
            meta: taskMeta(task),
            run: () => onOpenTask(task.id),
          })),
      },
      {
        key: "note",
        label: "备忘",
        rows: matchNotes(notes, query)
          .slice(0, NOTE_LIMIT)
          .map<Row>((note) => ({
            key: `note:${note.id}`,
            kind: "note",
            // 备忘没有标题，正文就是标题：截命中处那一段，一眼能看出它为什么在这儿
            title: snippet(note.body, query, 26) || "（空备忘）",
            meta: noteMeta(note),
            run: () => onOpenNote(note.id),
          })),
      },
      {
        key: "tool",
        label: "工具",
        rows: matchTools(TOOLS, query)
          .slice(0, TOOL_LIMIT)
          .map<Row>((tool) => ({
            key: `tool:${tool.key}`,
            kind: "tool",
            title: tool.name,
            meta: tool.desc,
            Icon: tool.Icon,
            run: () => onOpenTool(tool.key),
          })),
      },
      { key: "app", label: "应用", rows: (hits?.apps ?? []).map(hitRow) },
      { key: "file", label: "文件", rows: (hits?.files ?? []).map(hitRow) },
    ].filter((section) => section.rows.length > 0);
  }, [query, tasks, notes, hits, open, onOpenTask, onOpenNote, onOpenTool]);

  /** 摊平成一串：键盘上下走的就是这个顺序（和渲染同一份数据，不会对不上） */
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  /** 结果和最近打开一起去重，批量问一次图标。只有应用 / 文件带系统图标 */
  const iconPaths = useMemo(() => {
    const unique = new Set<string>();
    for (const row of rows) {
      if (row.hit !== undefined) unique.add(row.hit.path);
    }
    for (const entry of recent) unique.add(entry.path);
    return [...unique];
  }, [rows, recent]);
  const icons = useIcons(iconPaths);

  // 选中项要跟着滚进来（上下键翻到第十条时，它得在可视区里）
  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  // 结果变少时把选中项收进范围。不做的话按回车会落空——明明看着有结果却打不开
  useEffect(() => {
    setActive((prev) => (prev < rows.length ? prev : 0));
  }, [rows.length]);

  /** 从最近打开里摘掉一条（卡片右上角的 ×） */
  const forget = useCallback(async (path: string) => {
    try {
      setRecent(await invoke<SearchHistoryEntry[]>("search_forget", { path }));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const clearHistory = useCallback(async () => {
    try {
      await invoke("search_history_clear");
      setRecent([]);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const reveal = useCallback(async (hit: SearchHit) => {
    try {
      await invoke("search_reveal", { path: hit.path });
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const clear = () => {
    setText("");
    inputRef.current?.focus();
  };

  /**
   * 重新建索引 + 重新找一次 es.exe。
   *
   * `es.exe` 只在建索引时探一次，所以「先开面板、后装 Everything」的人不重启就永远
   * 接不上。这个按钮把这条路补上：重建（几十万条以内一秒）完再读一次状态。
   */
  const recheck = async () => {
    try {
      setStatus(null);
      await invoke("search_reindex");
      // 重建是后台线程，给它一拍再读状态；没建好这边会继续轮询（见上面那个 effect）
      window.setTimeout(() => void loadStatus(), 400);
    } catch (err) {
      setError(String(err));
    }
  };

  /** 搜不到东西时给条出路：打开 Everything 的下载页（装本体 / 补 es.exe 都在这一页） */
  const openDownload = async () => {
    try {
      await invoke("open_url", { url: EVERYTHING_DOWNLOAD });
    } catch (err) {
      setError(String(err));
    }
  };

  /** 上下键在结果里走一圈，回车打开当前那条 */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((prev) => (prev + step + rows.length) % rows.length);
      return;
    }

    if (event.key === "Enter") {
      const row = rows[active];
      if (row !== undefined) {
        event.preventDefault();
        // 文件是「打开」，自己的东西是「跳过去」——两条路都收在 row.run 里
        row.run();
      }
      return;
    }

    if (event.key === "Escape") {
      // 有字先清字，并且吃掉这个 Esc（面板看到 defaultPrevented 就不关）；
      // 空着就不拦了，让它冒上去，由 Panel 统一关面板——「清掉 → 关掉」
      // 两步走，比先跳回待办页再关更顺
      if (text !== "") {
        event.preventDefault();
        clear();
      }
    }
  };

  let cursor = 0;

  return (
    <div className="search">
      <div className="search__box">
        <span className="search__glyph">
          <MagnifierIcon />
        </span>
        <input
          ref={inputRef}
          className="search__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜应用、文件、待办、备忘…"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label="搜索本机的应用和文件，以及待办、备忘、小工具"
        />
        {text !== "" && (
          <button type="button" className="search__clear" onClick={clear} title="清空" aria-label="清空搜索">
            ×
          </button>
        )}
      </div>

      <div className="search__meta">
        {/* title 里放索引的真实覆盖面：桌面 / 文档 / 下载可能被重定向到 OneDrive 或别的盘，
            文字里写死「桌面、文档、下载」，鼠标悬停才看得到具体是哪几个目录 */}
        <p
          className="search__engine"
          title={
            status === null
              ? undefined
              : `${status.apps} 个应用 · ${status.files} 个文件${
                  status.roots.length > 0 ? `\n${status.roots.join("\n")}` : ""
                }`
          }
        >
          {engineHint(status, hits, busy)}
        </p>
        {/* 装了 Everything 却没接上时给个出口：es.exe 可能刚放进 PATH，不用重启应用 */}
        {status !== null && status.ready && status.es === null && (
          <button type="button" className="search__recheck" onClick={() => void recheck()}>
            重新检测
          </button>
        )}
      </div>

      {error !== null && <div className="panel__error">{error}</div>}

      <div className="search__body" ref={bodyRef}>
        {query === "" ? (
          recent.length > 0 ? (
            /* 空着的时候先给「上次打开的那个东西」——比一句「敲名字就行」有用得多 */
            <div className="search__recent">
              <div className="search__group">
                <span>最近打开</span>
                <button
                  type="button"
                  className="search__group-act"
                  onClick={() => void clearHistory()}
                >
                  清空
                </button>
              </div>
              <ul className="search__grid">
                {recent.map((entry) => (
                  <li key={entry.path} className="recent">
                    <button
                      type="button"
                      className="recent__open"
                      onClick={() => void open(entry)}
                      title={entry.path}
                    >
                      <Badge kind={entry.kind} icon={icons[entry.path]} />
                      <span className="recent__name">{entry.name}</span>
                      <span className="recent__meta">{agoLabel(entry.at)}</span>
                    </button>
                    {/* 删除按钮只能是卡片的兄弟节点，不能嵌在那个 button 里 */}
                    <button
                      type="button"
                      className="recent__del"
                      onClick={() => void forget(entry.path)}
                      title="从最近打开里移除"
                      aria-label="从最近打开里移除"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="search__empty">
              <span className="search__empty-title">找应用、文件、待办、备忘</span>
              <span className="search__empty-note">
                敲名字就行，首字母也行（<code>vsc</code> 能找到 Visual Studio Code）。
                <br />
                自己的待办、备忘和小工具也会一起找，点一下就跳过去。
                <br />
                ↑↓ 挑，回车打开，Esc 清空。
              </span>
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="search__empty">
            <span className="search__empty-title">{busy ? "在找了…" : `没搜到「${query}」`}</span>
            {!busy && (
              <>
                <span className="search__empty-note">
                  {status !== null && status.es === null
                    ? "只搜了桌面、文档、下载；接上 Everything 就能连全盘一起搜。"
                    : "换个说法试试，两三个字的片段比整句好使。"}
                </span>
                <div className="search__empty-acts">
                  {/* 搜不到东西，多半是脑子里那句话本身就是一件要做的事——顺手记下来 */}
                  <button type="button" className="chip" onClick={() => onDraft(query)}>
                    记为待办
                  </button>
                  {status !== null && status.es === null && (
                    <button type="button" className="chip" onClick={() => void openDownload()}>
                      {/* 装了就差命令行工具，那是两个不同的动作，别用同一句话糊过去 */}
                      {status.everything ? "补上 es.exe" : "装 Everything"}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          sections.map((section) => (
            <div className="search__group-block" key={section.key}>
              <div className="search__group">
                <span>{section.label}</span>
                <span className="search__group-count">{section.rows.length}</span>
              </div>
              <ul className="search__list">
                {section.rows.map((row) => {
                  const index = cursor++;
                  return (
                    <li
                      key={row.key}
                      ref={(node) => {
                        rowRefs.current[index] = node;
                      }}
                      className={`search__row${index === active ? " search__row--on" : ""}`}
                      onMouseMove={() => setActive(index)}
                      onClick={row.run}
                      title={row.meta}
                    >
                      <RowBadge row={row} icon={row.hit === undefined ? null : icons[row.hit.path]} />
                      <span className="search__text">
                        <span className="search__name">{row.title}</span>
                        <span className="search__path">{row.meta}</span>
                      </span>
                      {/* 只给文件和目录「在文件夹中显示」，应用本来就是个快捷方式 */}
                      {(row.kind === "file" || row.kind === "dir") && row.hit !== undefined && (
                        <button
                          type="button"
                          className="search__reveal"
                          onClick={(event) => {
                            event.stopPropagation();
                            void reveal(row.hit!);
                          }}
                        >
                          定位
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
