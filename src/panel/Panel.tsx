import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UpdateBanner } from "./UpdateBanner";
import { useUpdater } from "./useUpdater";
import "./panel.css";

interface ReminderView {
  id: string;
  kind: string;
  next_fire_at: string;
  state: string;
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  due_at: string | null;
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

interface DayBrief {
  total: number;
  done: number;
  pending: number;
  overdue: number;
}

const win = getCurrentWindow();

function isOverdue(task: Task): boolean {
  return !!task.due_at && new Date(task.due_at).getTime() < Date.now();
}

function formatDue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Panel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [brief, setBrief] = useState<DayBrief | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const updater = useUpdater();

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

  const add = async () => {
    const value = title.trim();
    if (!value) return;
    try {
      await invoke("create_task", { input: { title: value } });
      setTitle("");
      await refresh();
    } catch (err) {
      setError(String(err));
    }
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

  return (
    <div className="panel">
      <header className="panel__head" data-tauri-drag-region>
        <div className="panel__titles" data-tauri-drag-region>
          <h1 className="panel__title" data-tauri-drag-region>
            待办
          </h1>
          <p className="panel__stat" data-tauri-drag-region>
            今天完成 {brief?.done ?? 0} · 待办 {brief?.pending ?? 0}
            {brief !== null && brief.overdue > 0 && (
              <span className="panel__stat--alert"> · 逾期 {brief.overdue}</span>
            )}
          </p>
        </div>
        <button
          className="panel__close"
          onClick={() => void win.hide()}
          title="收起"
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

      <div className="panel__add">
        <input
          className="panel__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="添加待办，回车保存"
          autoFocus
        />
        <button className="panel__submit" onClick={() => void add()}>
          添加
        </button>
      </div>

      {error !== null && <div className="panel__error">{error}</div>}

      <ul className="panel__list">
        {tasks.map((task) => (
          <li
            key={task.id}
            className={`task${isOverdue(task) ? " task--overdue" : ""}`}
          >
            <button
              className="task__check"
              onClick={() => void complete(task.id)}
              title="标记完成"
              aria-label="标记完成"
            />
            <div className="task__body">
              <span className="task__title">{task.title}</span>
              {task.due_at !== null && (
                <span className="task__meta">{formatDue(task.due_at)}</span>
              )}
            </div>
            <button
              className="task__del"
              onClick={() => void remove(task.id)}
              title="删除"
            >
              删除
            </button>
          </li>
        ))}
      </ul>

      {!loading && tasks.length === 0 && (
        <p className="panel__empty">
          还没有待办。
          <br />
          在上面敲一句话就能记下来。
        </p>
      )}
    </div>
  );
}
