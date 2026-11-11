import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./bubble.css";

interface FiredReminder {
  reminder_id: string;
  task_id: string;
  kind: string;
  title: string;
  due_at: string | null;
}

const win = getCurrentWindow();

function describe(item: FiredReminder): string {
  const isAsk = item.kind === "ask";

  if (item.due_at === null) {
    return isAsk ? "做到哪一步了？" : "该做了";
  }

  const minutes = Math.round(
    (new Date(item.due_at).getTime() - Date.now()) / 60000,
  );

  if (isAsk) {
    if (minutes > 0) return `还有 ${minutes} 分钟到截止，做得怎么样了？`;
    if (minutes === 0) return "到点了，做完了吗？";
    return `已逾期 ${-minutes} 分钟，还做吗？`;
  }

  if (minutes > 0) return `距截止还有 ${minutes} 分钟`;
  if (minutes === 0) return "到点了";
  return `已逾期 ${-minutes} 分钟`;
}

export function Bubble() {
  const [item, setItem] = useState<FiredReminder | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pending = listen<FiredReminder>("reminder://fire", (event) => {
      setItem(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 15 秒无操作自动收起，避免气泡一直挡在屏幕上
  useEffect(() => {
    if (item === null) return;
    const timer = window.setTimeout(() => {
      setItem(null);
      void win.hide();
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [item]);

  const dismiss = async () => {
    setItem(null);
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

  const snooze = async () => {
    if (item === null || busy) return;
    setBusy(true);
    try {
      await invoke("snooze_task", { id: item.task_id, minutes: 15 });
      await dismiss();
    } catch (err) {
      console.error("[bubble] 推迟提醒失败", err);
    } finally {
      setBusy(false);
    }
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

  if (item === null) return null;

  const isAsk = item.kind === "ask";

  return (
    <div className="bubble">
      <p className="bubble__title">{item.title}</p>
      <p className="bubble__meta">{describe(item)}</p>
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
            <button
              className="bubble__btn"
              onClick={() => void answer("doing")}
              disabled={busy}
            >
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
        ) : (
          <>
            <button
              className="bubble__btn bubble__btn--primary"
              onClick={() => void complete()}
              disabled={busy}
            >
              已完成
            </button>
            <button
              className="bubble__btn"
              onClick={() => void snooze()}
              disabled={busy}
            >
              15 分钟后
            </button>
          </>
        )}
      </div>
    </div>
  );
}
