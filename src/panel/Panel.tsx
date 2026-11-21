import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UpdateBanner } from "./UpdateBanner";
import { useUpdater } from "./useUpdater";
import { History } from "./History";
import { Notes } from "./Notes";
import { Search } from "./Search";
import { Settings } from "./Settings";
import { Tools } from "./Tools";
import { Switch } from "../ui/Switch";
import { ResizeHandles } from "../ui/ResizeHandles";
import { DatePicker, TimeField } from "../ui/DatePicker";
import {
  WEEKDAY,
  defaultSlot,
  formatClock,
  nowTime,
  quickTimes,
  toIso,
  toLocalDate,
  toLocalTime,
} from "../ui/date";
import type { DayBrief, SettingsView, Task } from "./types";
import "./panel.css";

type Page = "search" | "todo" | "notes" | "history" | "tools" | "settings";
type RecurType = "daily" | "weekly" | "workday" | "holiday";

/**
 * 面板从「藏着」变回「摆出来」时后端推过来的事件（见 `tray.rs` 的 `EVENT_SHOWN`）。
 *
 * 收到它就回到搜索页并把输入框清空：热键唤起是「重新开始」，不应该接着上次那一页。
 */
const PANEL_SHOWN = "panel://shown";

const RECUR_TYPES: { value: RecurType; label: string }[] = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "workday", label: "工作日" },
  { value: "holiday", label: "节假日" },
];

/**
 * 每种循环规则的说明。每周不用写——它展开的是一排星期几，看一眼就懂。
 * 这里必须按类型逐一给文案，别再写「不是 A 就是 B」的二元判断，
 * 否则新增类型或者选中「每天」时会显示成节假日那句。
 *
 * 长度控制在 8 个字以内：这行右边还有时分步进器，写长了会折成两行。
 */
const RECUR_HINT: Record<Exclude<RecurType, "weekly">, string> = {
  daily: "含周末和节假日",
  workday: "跳过法定节假日",
  holiday: "只在法定节假日当天",
};

/* ---------------------------------------------------------------- 侧边栏图标 */
/* 手写 16×16 描边图标，和面板其它图形一个口径：stroke 1.5、圆角端点 */

const iconProps = {
  width: 17,
  height: 17,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const TodoIcon = () => (
  <svg {...iconProps}>
    <path d="M2.5 4.5h11M2.5 8.5h11M2.5 12.5h7" />
  </svg>
);

/** 搜索：一个放大镜。放在导航最上面，它是面板打开时默认落在的那一页 */
const SearchIcon = () => (
  <svg {...iconProps}>
    <circle cx="7.2" cy="7.2" r="4.4" />
    <path d="M10.5 10.5 14 14" />
  </svg>
);

const HistoryIcon = () => (
  <svg {...iconProps}>
    <circle cx="8" cy="8" r="5.7" />
    <path d="M8 4.9V8l2.2 1.5" />
  </svg>
);

/** 备忘：一张折角的便签，和待办那三条横线区分开 */
const NoteIcon = () => (
  <svg {...iconProps}>
    <path d="M3.4 2.6h5.6l3.6 3.6v6.4a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V3.8a1.2 1.2 0 0 1 1.2-1.2z" />
    <path d="M8.9 2.8v3.4h3.4" />
    <path d="M4.8 9h4.4M4.8 11.4h2.6" />
  </svg>
);

const SettingsIcon = () => (
  <svg {...iconProps}>
    <path d="M2.5 5.5h3.4M10.6 5.5h2.9M2.5 10.5h5.4M12.4 10.5h1.1" />
    <circle cx="8.2" cy="5.5" r="1.9" fill="currentColor" stroke="none" />
    <circle cx="10.6" cy="10.5" r="1.9" fill="currentColor" stroke="none" />
  </svg>
);

/** 四宫格：一屏小工具的通用符号，比画个扳手更像「工具集」 */
const ToolsIcon = () => (
  <svg {...iconProps}>
    <rect x="2.4" y="2.4" width="4.4" height="4.4" rx="1.2" />
    <rect x="9.2" y="2.4" width="4.4" height="4.4" rx="1.2" />
    <rect x="2.4" y="9.2" width="4.4" height="4.4" rx="1.2" />
    <path d="M9.6 9.6h1.8v1.8H9.6zM12.6 12.6h1.8v1.8h-1.8z" fill="currentColor" stroke="none" />
  </svg>
);

const NAV: { key: Page; label: string; Icon: () => React.JSX.Element }[] = [
  { key: "search", label: "搜索", Icon: SearchIcon },
  { key: "todo", label: "待办", Icon: TodoIcon },
  { key: "history", label: "历史", Icon: HistoryIcon },
  { key: "notes", label: "备忘", Icon: NoteIcon },
  { key: "tools", label: "工具", Icon: ToolsIcon },
  { key: "settings", label: "设置", Icon: SettingsIcon },
];

const PAGE_TITLE: Record<Page, string> = {
  search: "搜索",
  todo: "待办",
  notes: "备忘录",
  history: "历史待办",
  tools: "小工具",
  settings: "设置",
};

const win = getCurrentWindow();

/** 从搜索页跳过来时，目标那条点亮多久。够看清是哪一条，又不至于一直挂着 */
const FLASH_MS = 1600;

function isOverdue(task: Task): boolean {
  return !!task.due_at && new Date(task.due_at).getTime() < Date.now();
}

/** 开始/结束时间合成一行；同一天的话只在开头说一次日期 */
function formatSpan(task: Task): string {
  const start = task.start_at ? formatClock(task.start_at) : "";
  const due = task.due_at ? formatClock(task.due_at) : "";

  if (start && due) {
    const startDay = start.split(" ")[0];
    const dueDay = due.split(" ")[0];
    return startDay === dueDay ? `${start} → ${due.split(" ")[1]}` : `${start} → ${due}`;
  }
  if (due) return due;
  if (start) return `${start} 开始`;
  return "";
}

/** 从提醒规则里读出循环标签，比如「每天 09:00」「每周一三五 09:00」 */
function recurLabel(task: Task): string | null {
  for (const reminder of task.reminders) {
    let rule: { type?: string; time?: string; days?: number[] };
    try {
      rule = JSON.parse(reminder.rule);
    } catch {
      continue;
    }
    const time = rule.time ?? "";
    switch (rule.type) {
      case "daily":
        return `每天 ${time}`;
      case "weekly": {
        const days = (rule.days ?? []).map((d) => WEEKDAY[d] ?? "").join("");
        return days ? `每周${days} ${time}` : null;
      }
      case "workday":
        return `工作日 ${time}`;
      case "holiday":
        return `节假日 ${time}`;
      default:
        continue;
    }
  }
  return null;
}

export function Panel() {
  // 打开面板第一眼就是搜索：这个面板一半的用途是「随手叫出来找点东西」，
  // 让人先看到一屏待办、再自己点一下搜索，等于每次都多一步
  const [page, setPage] = useState<Page>("search");
  /** 每次「唤起」+1，搜索页靠它把输入框和结果清干净（切页会重挂载了，同页则靠它） */
  const [recall, setRecall] = useState(0);
  /** 工具页进去某个工具后由子页面写进来，换页头标题用；回清单时是 null */
  const [toolTitle, setToolTitle] = useState<string | null>(null);
  /**
   * 从搜索页点过来时要去哪：工具要直接进那个工具，待办 / 备忘要高亮那一条。
   * 手动点导航换页会把它清掉——那已经不是「从搜索跳过来」了。
   */
  const [focus, setFocus] = useState<{ kind: "tool" | "task" | "note"; id: string } | null>(null);
  /** 正在闪的那条待办；时间到了自己熄灭 */
  const [flashTask, setFlashTask] = useState<string | null>(null);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [brief, setBrief] = useState<DayBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");

  // 开始时提醒
  const [startOn, setStartOn] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");

  // 结束时提醒
  const [endOn, setEndOn] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");

  // 循环提醒
  const [recurOn, setRecurOn] = useState(false);
  const [recurType, setRecurType] = useState<RecurType>("daily");
  const [recurDays, setRecurDays] = useState<number[]>([]);
  const [recurTime, setRecurTime] = useState(nowTime);

  const updater = useUpdater();

  const panelRef = useRef<HTMLDivElement>(null);
  const fitTimer = useRef(0);
  const fitTry = useRef(0);
  /**
   * 面板尺寸是不是用户手动拖出来的。
   *
   * 一旦为 true，`fit()` 就不再按内容改窗口——否则用户刚拖完，列表一变就把尺寸
   * 打回去了。初始按 true 处理，等 `get_settings` 回来说「没存过尺寸」才放开：
   * 反过来的话，有保存尺寸时窗口会先被 fit 改小一次，肉眼可见地跳一下。
   */
  const lockedRef = useRef(true);
  /**
   * `fit()` 最近几次要求的尺寸。
   *
   * 窗口 resize 事件分不清「用户拖的」和「我们自己改的」，就靠它比一下：
   * 和其中任何一个对得上就是 fit() 干的，全对不上才是用户拖出来的尺寸。
   * 记一串而不是只记最后一个——`fit()` 要收敛，会连着改两次，第二次的预期值
   * 会盖掉第一次，只留一个的话前一次 resize 会被误判成用户拖拽。
   */
  const autoSizesRef = useRef<{ width: number; height: number }[]>([]);
  /** 拖拽会连着来一堆 resize 事件，停手 400ms 才落盘 */
  const sizeSaveTimer = useRef(0);

  /**
   * 让窗口高度跟着内容走。
   *
   * 窗口尺寸在 tauri.conf 里写死，只有一两条待办时下面会空一大片。
   * 这里量出「面板顶边到当前页最后一个元素的底边」，回头去改窗口尺寸。
   *
   * 三个页面各自声明一个 `data-page-body` 容器（列表 / 设置分组），
   * 哪个挂载了量哪个——比给每个页面传 ref 省事，也不会量错页。
   */
  const fit = useCallback(() => {
    window.clearTimeout(fitTimer.current);
    fitTimer.current = window.setTimeout(() => {
      // 用户自己拖过尺寸，就别再替他决定窗口多高
      if (lockedRef.current) return;

      const panel = panelRef.current;
      const body = panel?.querySelector<HTMLElement>("[data-page-body]") ?? null;
      if (panel === null || body === null) return;

      // 列表是 flex:1，会被拉满，scrollHeight 永远等于 clientHeight，
      // 只能量「最后一行子元素的底边」到面板顶边的距离。
      // 注意 getBoundingClientRect 不含外边距，最后一条的下边距要单独加回来，
      // 少了它窗口就差 6px，列表于是莫名其妙冒出滚动条。
      const last = body.lastElementChild;
      const bottom =
        last === null ? body.getBoundingClientRect().bottom : last.getBoundingClientRect().bottom;
      const marginBottom =
        last === null ? 0 : Number.parseFloat(getComputedStyle(last).marginBottom) || 0;

      const desired = Math.min(
        640,
        // 12 = 列表底部内边距，16 = 面板上下外边距，2 = 余量
        Math.max(
          356,
          Math.round(bottom - panel.getBoundingClientRect().top + marginBottom + 12 + 16 + 2),
        ),
      );

      if (Math.abs(desired - window.innerHeight) < 4) {
        fitTry.current = 0;
        return;
      }
      // 改完窗口布局会变，需要再量一次；给 3 次机会收敛，免得来回抖
      if (fitTry.current >= 3) return;
      fitTry.current += 1;

      // 记下这次要求的尺寸：随后的 resize 事件要靠它认出「是自己改的」
      autoSizesRef.current = [...autoSizesRef.current.slice(-3), { width: 436, height: desired }];
      void invoke("panel_resize", { height: desired })
        .then(() => {
          window.setTimeout(fit, 120);
        })
        .catch(() => {
          fitTry.current = 0;
        });
    }, 80);
  }, []);

  useEffect(() => {
    fitTry.current = 0;
    fit();
    return () => window.clearTimeout(fitTimer.current);
  }, [
    fit,
    page,
    tasks,
    startOn,
    endOn,
    recurOn,
    recurType,
    recurDays,
    error,
    loading,
    brief,
  ]);

  /**
   * 窗口尺寸变了：和 `fit()` 要的不一样，就是用户自己拖的——锁住自动高度并记住。
   *
   * 不挂在拖拽热区的 pointerdown 上：`startResizeDragging` 的 Promise 在拖拽开始时就
   * resolve，拿不到结果；而无边框窗口的边缘本来就是系统在管，拖拽可能压根不经过前端。
   * 盯着 resize 事件才是唯一可靠的信源。
   */
  useEffect(() => {
    const pending = win.onResized(({ payload }) => {
      void win.scaleFactor().then((scale) => {
        const size = payload.toLogical(scale);
        const width = Math.round(size.width);
        const height = Math.round(size.height);

        const auto = autoSizesRef.current;
        if (
          auto.some(
            (size) => Math.abs(size.width - width) <= 2 && Math.abs(size.height - height) <= 2,
          )
        ) {
          return; // 我们自己刚要求的，别当成用户操作
        }

        lockedRef.current = true;
        window.clearTimeout(sizeSaveTimer.current);
        sizeSaveTimer.current = window.setTimeout(() => {
          void invoke("set_panel_size", { size: { width, height } }).catch((err) =>
            setError(String(err)),
          );
        }, 400);
      });
    });

    return () => {
      void pending.then((unlisten) => unlisten());
      window.clearTimeout(sizeSaveTimer.current);
    };
  }, []);

  /** 设置页点了「恢复自动」：放开锁，立刻按内容重新量一次 */
  const unlockSize = useCallback(() => {
    lockedRef.current = false;
    fitTry.current = 0;
    fit();
  }, [fit]);

  // 没存过尺寸才继续「高度跟着内容走」；存过就保持用户拖出来的样子
  useEffect(() => {
    void invoke<SettingsView>("get_settings")
      .then((settings) => settings.panel_size)
      // 设置读不出来就按「没存过」处理，至少高度还能自适应
      .catch(() => null)
      .then((size) => {
        if (size !== null) return;
        lockedRef.current = false;
        fit();
      });
  }, [fit]);

  const refresh = useCallback(async () => {
    try {
      const [list, summary] = await Promise.all([
        invoke<Task[]>("list_tasks", { filter: null }),
        invoke<DayBrief>("today_brief"),
      ]);
      setTasks(list);
      setBrief(summary);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 面板收起期间数据库可能被别人改过（比如 AI 通过 MCP 建了任务），
  // 每次重新拿到焦点就再拉一次，避免看到过期列表。
  useEffect(() => {
    const pending = win.onFocusChanged(({ payload: focused }) => {
      if (focused) void refresh();
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [refresh]);

  // 面板从「藏着」被叫回来：回到搜索页，输入框（连同上次的查询和选中项）清干净。
  // 只在隐藏→显示时发这条事件，所以窗口只是被别的程序压住、又被提到前面时，
  // 用户正在填的表单和翻到的页都不会被冲掉。
  useEffect(() => {
    const pending = win.listen(PANEL_SHOWN, () => {
      setPage("search");
      setRecall((prev) => prev + 1);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  /**
   * Esc 关面板，和右上角那个 × 走同一条路（真关窗口，下次打开重新加载）。
   *
   * 只挂在冒泡阶段，并且认 `defaultPrevented`：日历浮层（`ui/DatePicker`）、
   * 备忘编辑框、搜索页、行情搜索框自己会吃掉 Esc，它们都 `preventDefault()` 了，
   * 这里看到就让位——别让人按一下连浮层带面板一起关掉。
   * 设置页录热键时在捕获阶段就 `stopPropagation`，根本走不到这里。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 输入法候选框里的 Esc 是「取消候选」，不是关面板
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      void invoke("close_panel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 已经亮过一次的待办 id：列表刷新时别再闪一遍 */
  const flashedRef = useRef<string | null>(null);

  /**
   * 从搜索页点过来时，把目标那条滚进视野并点亮一下。
   *
   * 用 `querySelector` 而不是维护一张 ref 表：列表是内联渲染的，为每一行挂 ref
   * 只为偶尔一次跳转不值当。id 是 uuid，拼进选择器没有转义问题。
   */
  useEffect(() => {
    if (page !== "todo" || focus === null || focus.kind !== "task") return;
    if (flashedRef.current === focus.id) return;

    const node = panelRef.current?.querySelector<HTMLElement>(`[data-task-id="${focus.id}"]`);
    // 还没渲染出来（数据在路上）：tasks 一变这个 effect 会再跑一次
    if (node == null) return;

    flashedRef.current = focus.id;
    node.scrollIntoView({ block: "nearest" });
    setFlashTask(focus.id);
    const timer = window.setTimeout(() => setFlashTask(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [page, focus, tasks.length]);

  /** 搜索页点了一条工具：切到工具页并直接进去 */
  const openTool = useCallback((key: string) => {
    setFocus({ kind: "tool", id: key });
    setPage("tools");
  }, []);

  /** 搜索页点了一条待办：切到待办页并把那条点亮 */
  const openTask = useCallback((id: string) => {
    setFocus({ kind: "task", id });
    setPage("todo");
  }, []);

  /** 搜索页点了一条备忘：切到备忘页并把那条点亮 */
  const openNote = useCallback((id: string) => {
    setFocus({ kind: "note", id });
    setPage("notes");
  }, []);

  const resetForm = () => {
    setTitle("");
    setStartOn(false);
    setStartDate("");
    setStartTime("");
    setEndOn(false);
    setEndDate("");
    setEndTime("");
    setRecurOn(false);
    setRecurType("daily");
    setRecurDays([]);
    setRecurTime(nowTime());
  };

  const add = async () => {
    const value = title.trim();
    if (!value) return;

    const startAt = startOn ? toIso(startDate, startTime) : null;
    const dueAt = endOn ? toIso(endDate, endTime) : null;

    if (startOn && !startAt) {
      setError("请选择开始时间");
      return;
    }
    if (endOn && !dueAt) {
      setError("请选择结束时间");
      return;
    }
    if (recurOn && recurType === "weekly" && recurDays.length === 0) {
      setError("每周循环至少要选一天");
      return;
    }

    const recur = recurOn
      ? {
          type: recurType,
          ...(recurType === "weekly" ? { days: [...recurDays].sort() } : {}),
          time: recurTime || nowTime(),
        }
      : null;

    try {
      await invoke("create_task", {
        input: {
          title: value,
          start_at: startAt,
          due_at: dueAt,
          // 准点提醒：结束时间那一刻响一次
          remind_offsets: dueAt ? [0] : null,
          recur,
        },
      });
      resetForm();
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleStart = (next: boolean) => {
    setStartOn(next);
    if (next && startDate === "") {
      const slot = defaultSlot(1);
      setStartDate(slot.date);
      setStartTime(slot.time);
    }
  };

  const toggleEnd = (next: boolean) => {
    setEndOn(next);
    if (next && endDate === "") {
      const slot = defaultSlot(2);
      setEndDate(slot.date);
      setEndTime(slot.time);
    }
  };

  /** 快捷时间：设置开始时间，并顺手把开关打开 */
  const quickStart = (date: Date) => {
    setStartOn(true);
    setStartDate(toLocalDate(date));
    setStartTime(toLocalTime(date));
  };

  /** 快捷时间：设置结束时间，并顺手把开关打开 */
  const quickEnd = (date: Date) => {
    setEndOn(true);
    setEndDate(toLocalDate(date));
    setEndTime(toLocalTime(date));
  };

  const toggleWeekday = (day: number) => {
    setRecurDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  };

  const complete = async (id: string) => {
    try {
      await invoke("complete_task", { id, note: null });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await invoke("delete_task", { id });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const pending = useMemo(
    () => tasks.filter((task) => task.status !== "done").length,
    [tasks],
  );

  return (
    <div className="panel" ref={panelRef}>
      <nav className="rail" aria-label="主导航">
        <span className="rail__mark" data-tauri-drag-region aria-hidden="true" />
        {NAV.map(({ key, label, Icon }) => (
          <Fragment key={key}>
            <button
              type="button"
              className={`rail__item${page === key ? " rail__item--on" : ""}`}
              onClick={() => {
                // 手动换页就不是「从搜索跳过来的」了，把目标清掉，
                // 免得下次再进待办 / 备忘时又闪一下上次那条
                setFocus(null);
                setPage(key);
              }}
              aria-current={page === key ? "page" : undefined}
              aria-label={key === "todo" && pending > 0 ? `${label}，还有 ${pending} 项没做完` : label}
            >
              {/* 红点只表示「有没做完的」，不显示数量——数量在列表头，别在导航里再吵一次 */}
              <span className="rail__icon">
                <Icon />
                {key === "todo" && pending > 0 && <span className="rail__dot" aria-hidden="true" />}
              </span>
              <span className="rail__label">{label}</span>
            </button>
            {/* 搜索是「取东西」，下面几项是「管东西」。一根短横线把两类分开，
                免得搜索看起来只是待办旁边又一个并列的页 */}
            {key === "search" && <span className="rail__sep" aria-hidden="true" />}
          </Fragment>
        ))}
        <span className="rail__gap" data-tauri-drag-region aria-hidden="true" />
      </nav>

      <div className="panel__main">
        <header className="panel__head" data-tauri-drag-region>
          <div className="panel__brand" data-tauri-drag-region>
            <div className="panel__titles" data-tauri-drag-region>
              <h1 className="panel__title" data-tauri-drag-region>
                {/* 工具页进去某个工具后，页头跟着换成工具名，标题栏才不空 */}
                {page === "tools" && toolTitle !== null ? toolTitle : PAGE_TITLE[page]}
              </h1>
              {page === "todo" && (
                <p className="panel__stat" data-tauri-drag-region>
                  今天完成 {brief?.done ?? 0} · 待办 {brief?.pending ?? 0}
                  {brief !== null && brief.overdue > 0 && (
                    <span className="panel__stat--alert"> · 逾期 {brief.overdue}</span>
                  )}
                </p>
              )}
            </div>
          </div>
          {/* 关掉就是真关窗口，下次打开重新加载（状态、翻到哪页都归零） */}
          <button
            className="panel__close"
            onClick={() => void invoke("close_panel")}
            title="关闭"
            aria-label="关闭面板"
          >
            ×
          </button>
        </header>

        <UpdateBanner
          state={updater.state}
          onInstall={() => void updater.install()}
          onCheck={updater.checkNow}
          onDismiss={updater.dismiss}
        />

        {/* key 跟着页面变：切页时整块重挂载，页面淡入和列表进场都会重放。
            这一层必须自己撑成 flex 列，否则里面的列表拿不到 flex:1，量高度会错。 */}
        <div className="page" key={page}>
          {page === "search" ? (
            <Search
              token={recall}
              tasks={tasks}
              onOpenTool={openTool}
              onOpenTask={openTask}
              onOpenNote={openNote}
              onDraft={(text) => {
                // 搜不到东西时那句话往往本身就是件要做的事：原样塞进待办输入框，
                // 让人还能改一遍再回车，而不是替他直接建一条
                setTitle(text);
                setPage("todo");
              }}
            />
          ) : page === "notes" ? (
            <Notes onLayout={fit} focusId={focus?.kind === "note" ? focus.id : null} />
          ) : page === "history" ? (
            <History onLayout={fit} onDataChanged={() => void refresh()} />
          ) : page === "tools" ? (
            <Tools
              onLayout={fit}
              onTitle={setToolTitle}
              initial={focus?.kind === "tool" ? focus.id : null}
            />
          ) : page === "settings" ? (
            <Settings onLayout={fit} onDataChanged={() => void refresh()} onResetSize={unlockSize} />
          ) : (
            <>
              <div className="composer">
                <input
                  className="composer__input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void add();
                  }}
                  placeholder="记一件要做的事…"
                  autoFocus
                />
                <button className="ui-btn ui-btn--primary composer__add" onClick={() => void add()}>
                  添加
                </button>
              </div>

              <section className="card">
                <div className="option">
                  <Switch on={startOn} label="开始时提醒" onChange={toggleStart} />
                  <button
                    type="button"
                    className="option__label"
                    onClick={() => toggleStart(!startOn)}
                  >
                    开始时提醒
                  </button>
                  {startOn && (
                    <DatePicker
                      date={startDate}
                      time={startTime}
                      onChange={(date, time) => {
                        setStartDate(date);
                        setStartTime(time);
                      }}
                      ariaLabel="开始时间"
                    />
                  )}
                </div>

                {/* 快捷时刻和气泡共用一套：开始往早上挪，结束往傍晚挪。
                    已经过去的整点不渲染，所以上午只剩「1 小时后 / 明早 9 点」。 */}
                {startOn && (
                  <div className="option option--sub">
                    {quickTimes("start").map((slot) => (
                      <button
                        key={slot.label}
                        type="button"
                        className="chip"
                        onClick={() => quickStart(slot.at)}
                      >
                        {slot.label}
                      </button>
                    ))}
                  </div>
                )}

                <div className="option">
                  <Switch on={endOn} label="结束时提醒" onChange={toggleEnd} />
                  <button type="button" className="option__label" onClick={() => toggleEnd(!endOn)}>
                    结束时提醒
                  </button>
                  {endOn && (
                    <DatePicker
                      date={endDate}
                      time={endTime}
                      onChange={(date, time) => {
                        setEndDate(date);
                        setEndTime(time);
                      }}
                      ariaLabel="结束时间"
                    />
                  )}
                </div>

                {endOn && (
                  <div className="option option--sub">
                    {quickTimes("due").map((slot) => (
                      <button
                        key={slot.label}
                        type="button"
                        className="chip"
                        onClick={() => quickEnd(slot.at)}
                      >
                        {slot.label}
                      </button>
                    ))}
                  </div>
                )}

                <div className="option">
                  <Switch on={recurOn} label="循环提醒" onChange={setRecurOn} />
                  <button type="button" className="option__label" onClick={() => setRecurOn(!recurOn)}>
                    循环提醒
                  </button>
                  {recurOn && (
                    <div className="option__chips">
                      {RECUR_TYPES.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          className={`chip${recurType === item.value ? " chip--on" : ""}`}
                          onClick={() => setRecurType(item.value)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {recurOn && (
                  <div className="option option--sub">
                    {recurType === "weekly" ? (
                      <div className="option__chips">
                        {WEEKDAY.map((label, day) => (
                          <button
                            key={label}
                            type="button"
                            className={`chip chip--day${recurDays.includes(day) ? " chip--on" : ""}`}
                            onClick={() => toggleWeekday(day)}
                            aria-pressed={recurDays.includes(day)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="option__hint">{RECUR_HINT[recurType]}</span>
                    )}
                    <TimeField value={recurTime} onChange={setRecurTime} />
                  </div>
                )}
              </section>

              {error !== null && <div className="panel__error">{error}</div>}

              <div className="list-head">
                <span className="list-head__title">待办</span>
                <span className="list-head__count">{pending}</span>
              </div>

              <ul className="panel__list" data-page-body>
                {tasks.map((task) => {
                  const span = formatSpan(task);
                  const recur = recurLabel(task);
                  return (
                    <li
                      key={task.id}
                      data-task-id={task.id}
                      className={`task${isOverdue(task) ? " task--overdue" : ""}${
                        flashTask === task.id ? " task--flash" : ""
                      }`}
                    >
                      <button
                        className="task__check"
                        onClick={() => void complete(task.id)}
                        title="标记完成"
                        aria-label="标记完成"
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                          <path
                            d="M1.5 5.2 3.9 7.6 8.5 2.6"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <div className="task__body">
                        <span className="task__title">{task.title}</span>
                        {(span !== "" || recur !== null) && (
                          <span className="task__meta">
                            {span}
                            {span !== "" && recur !== null && " · "}
                            {recur !== null && <span className="task__badge">{recur}</span>}
                          </span>
                        )}
                      </div>
                      <button className="task__del" onClick={() => void remove(task.id)} title="删除">
                        删除
                      </button>
                    </li>
                  );
                })}
                {!loading && tasks.length === 0 && (
                  <li className="panel__empty">
                    还没有待办
                    <span>在上面敲一句话就能记下来</span>
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* 八向缩放热区。放在最外层、fixed 定位，正好落在窗口那圈 8px 透明边距里 */}
      <ResizeHandles />
    </div>
  );
}
