import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DatePicker } from "../ui/DatePicker";
import { formatClock, inMinutes, quickTimes, toIso, toLocalDate, toLocalTime } from "../ui/date";
import "./bubble.css";

interface FiredReminder {
  reminder_id: string;
  task_id: string;
  kind: string;
  /** ask 追问 / start 开始时间到 / due 临近或到截止 */
  phase: string;
  title: string;
  due_at: string | null;
}

const win = getCurrentWindow();

/** 追问气泡：一行三个回答按钮，和 tauri.conf.json 里的 132 对齐 */
const ASK_HEIGHT = 132;
/** 截止提醒：主操作一行 + 快捷时刻一行，卡片实测 136 */
const DUE_HEIGHT = 156;
/** 开始提醒：主操作 + 快捷时刻 + 晚点提醒，三行按钮，卡片实测 172 */
const START_HEIGHT = 196;
/** 展开时间选择器后的高度。撑高是往上长（内容底部对齐），多给几像素不会露白 */
const PICKER_HEIGHT = 250;

/** 每种提醒的窗口高度。Rust 侧 `scheduler.rs` 里的同名常量要跟着改 */
function heightFor(phase: string): number {
  if (phase === "start") return START_HEIGHT;
  if (phase === "ask") return ASK_HEIGHT;
  return DUE_HEIGHT;
}

function describe(item: FiredReminder): string {
  const minutes =
    item.due_at === null
      ? null
      : Math.round((new Date(item.due_at).getTime() - Date.now()) / 60000);

  if (item.phase === "ask") {
    if (minutes === null) return "做到哪一步了？";
    if (minutes > 0) return `还有 ${minutes} 分钟到截止，做得怎么样了？`;
    if (minutes === 0) return "到点了，做完了吗？";
    return `已逾期 ${-minutes} 分钟，还做吗？`;
  }

  // 开始提醒的重点是「该动手了」，顺带报一下离截止还有多久
  if (item.phase === "start") {
    if (minutes === null || minutes <= 0) return "到开始时间了，动手吧";
    return `到开始时间了 · 距截止还有 ${minutes} 分钟`;
  }

  if (minutes === null) return "该做了";
  if (minutes > 0) return `距截止还有 ${minutes} 分钟`;
  if (minutes === 0) return "到点了";
  return `已逾期 ${-minutes} 分钟`;
}

export function Bubble() {
  const [item, setItem] = useState<FiredReminder | null>(null);
  const [speech, setSpeech] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 「晚点提醒我」展开的时间选择器 */
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState({ date: "", time: "" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const pending = listen<FiredReminder>("reminder://fire", (event) => {
      // 提醒优先级最高，台词让位
      setSpeech(null);
      setPicking(false);
      setError(null);
      setItem(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 桌宠的台词：没有按钮，冒几秒就收
  useEffect(() => {
    const pending = listen<string>("pet://say", (event) => {
      setSpeech(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (speech === null || item !== null) return;
    const timer = window.setTimeout(() => {
      setSpeech(null);
      void win.hide();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [speech, item]);

  // 15 秒无操作自动收起，避免气泡一直挡在屏幕上。
  // 正在挑时间时不计时——Rust 那边展开选择器时会换成 60 秒。
  useEffect(() => {
    if (item === null || picking) return;
    const timer = window.setTimeout(() => {
      setItem(null);
      void win.hide();
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [item, picking]);

  const dismiss = async () => {
    setItem(null);
    setPicking(false);
    setError(null);
    await win.hide();
  };

  const complete = async () => {
    if (item === null || busy) return;
    setBusy(true);
    try {
      await invoke("complete_task", { id: item.task_id, note: null });
      await dismiss();
    } catch (err) {
      console.error("[bubble] 标记完成失败", err);
    } finally {
      setBusy(false);
    }
  };

  /** 已开始：把任务置为进行中，started_at 由后端补上 */
  const startTask = async () => {
    if (item === null || busy) return;
    setBusy(true);
    try {
      await invoke("update_task", { id: item.task_id, patch: { status: "doing" } });
      await dismiss();
    } catch (err) {
      console.error("[bubble] 标记开始失败", err);
    } finally {
      setBusy(false);
    }
  };

  /** 把这条提醒挪到指定时刻。按 reminder 挪，一次性提醒已经 done 也能复活 */
  const reschedule = async (at: Date) => {
    if (item === null || busy) return;
    setBusy(true);
    try {
      await invoke("reschedule_reminder", {
        reminderId: item.reminder_id,
        at: at.toISOString(),
      });
      await dismiss();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const openPicker = async () => {
    if (item === null) return;
    const slot = inMinutes(15);
    setError(null);
    setWhen({ date: toLocalDate(slot), time: toLocalTime(slot) });
    setPicking(true);
    try {
      await invoke("bubble_resize", { height: PICKER_HEIGHT });
    } catch (err) {
      console.error("[bubble] 撑高失败", err);
    }
  };

  const closePicker = async () => {
    setPicking(false);
    setError(null);
    try {
      await invoke("bubble_resize", {
        height: item === null ? ASK_HEIGHT : heightFor(item.phase),
      });
    } catch (err) {
      console.error("[bubble] 缩回失败", err);
    }
  };

  const confirmWhen = async () => {
    const iso = toIso(when.date, when.time);
    if (iso === null) {
      setError("时间格式不对");
      return;
    }
    const at = new Date(iso);
    if (at.getTime() <= Date.now()) {
      setError("提醒时间要晚于现在");
      return;
    }
    await reschedule(at);
  };

  const answer = async (value: "done" | "doing" | "not_started") => {
    if (item === null || busy) return;
    setBusy(true);
    try {
      await invoke("answer_progress", { id: item.task_id, answer: value });
      await dismiss();
    } catch (err) {
      console.error("[bubble] 回答失败", err);
    } finally {
      setBusy(false);
    }
  };

  // 提醒卡优先；没有提醒时退化成一句台词
  if (item === null) {
    if (speech === null) return null;
    return (
      <div className="bubble bubble--say">
        <p className="bubble__say">{speech}</p>
      </div>
    );
  }

  const isAsk = item.phase === "ask";
  const isStart = item.phase === "start";
  /** 快捷时刻：追问气泡在问进度，不需要改时间 */
  const quick = isAsk ? [] : quickTimes(isStart ? "start" : "due");

  const quickRow = quick.length > 0 && (
    <div className="bubble__quick">
      {quick.map((slot) => (
        <button
          key={slot.label}
          className="chip bubble__chip"
          onClick={() => void reschedule(slot.at)}
          disabled={busy}
          title={`改到${formatClock(slot.at.toISOString())}`}
        >
          {slot.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`bubble${picking ? " bubble--tall" : ""}`}>
      <p className="bubble__title">{item.title}</p>
      <p className={`bubble__meta${error !== null ? " bubble__meta--error" : ""}`}>
        {error ?? describe(item)}
      </p>

      {picking ? (
        <>
          <DatePicker
            inline
            variant="days"
            date={when.date}
            time={when.time}
            onChange={(date, time) => setWhen({ date, time })}
            ariaLabel="下一次提醒时间"
          />
          <div className="bubble__actions">
            <button className="bubble__btn" onClick={() => void closePicker()} disabled={busy}>
              取消
            </button>
            <button
              className="bubble__btn bubble__btn--primary"
              onClick={() => void confirmWhen()}
              disabled={busy}
            >
              确定
            </button>
          </div>
        </>
      ) : (
        <div className="bubble__actions">
          {isAsk ? (
            <>
              <button
                className="bubble__btn bubble__btn--primary"
                onClick={() => void answer("done")}
                disabled={busy}
              >
                已完成
              </button>
              <button className="bubble__btn" onClick={() => void answer("doing")} disabled={busy}>
                进行中
              </button>
              <button
                className="bubble__btn"
                onClick={() => void answer("not_started")}
                disabled={busy}
              >
                还没开始
              </button>
            </>
          ) : isStart ? (
            /* 五个操作一行放不下（「晚点提醒我」会被挤扁），主操作单独一行，
               快捷时刻和「15 分钟后 / 晚点提醒我」各占一行 */
            <div className="bubble__stack">
              <button
                className="bubble__btn bubble__btn--primary"
                onClick={() => void startTask()}
                disabled={busy}
              >
                已开始
              </button>
              {quickRow}
              <div className="bubble__row">
                <button
                  className="bubble__btn"
                  onClick={() => void reschedule(inMinutes(15))}
                  disabled={busy}
                >
                  15 分钟后
                </button>
                <button
                  className="bubble__btn"
                  onClick={() => void openPicker()}
                  disabled={busy}
                >
                  晚点提醒我
                </button>
              </div>
            </div>
          ) : (
            <div className="bubble__stack">
              <div className="bubble__row">
                <button
                  className="bubble__btn bubble__btn--primary"
                  onClick={() => void complete()}
                  disabled={busy}
                >
                  已完成
                </button>
                <button
                  className="bubble__btn"
                  onClick={() => void reschedule(inMinutes(15))}
                  disabled={busy}
                >
                  15 分钟后
                </button>
              </div>
              {quickRow}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
