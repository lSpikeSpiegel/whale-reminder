import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WEEKDAY, dayDelta, humanDay, toLocalDate, toLocalTime } from "../ui/date";
import type { Task } from "./types";
import "./history.css";

interface Props {
  /** 内容变化后让面板重新量高度 */
  onLayout: () => void;
  /** 恢复 / 删除后待办列表也变了，通知面板重拉一次 */
  onDataChanged: () => void;
}

interface DayGroup {
  key: string;
  label: string;
  items: Task[];
}

/** 「今天 周四」「11月10日 周一」——历史里按完成日分组，得说清是哪天 */
function dayLabel(at: Date | null): string {
  if (at === null || Number.isNaN(at.getTime())) return "更早";
  return `${humanDay(toLocalDate(at))} 周${WEEKDAY[at.getDay()]}`;
}

/** 后端按截止时间排序，历史要按完成时间倒序，这里重排一次再分组 */
function groupByDay(tasks: Task[]): DayGroup[] {
  const groups: DayGroup[] = [];

  for (const task of tasks) {
    const at = task.completed_at === null ? null : new Date(task.completed_at);
    const key = at === null || Number.isNaN(at.getTime()) ? "unknown" : toLocalDate(at);
    const last = groups[groups.length - 1];

    if (last !== undefined && last.key === key) {
      last.items.push(task);
      continue;
    }
    groups.push({ key, label: dayLabel(at), items: [task] });
  }

  return groups;
}

export function History({ onLayout, onDataChanged }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await invoke<Task[]>("list_tasks", {
        filter: { status: "done", limit: 200 },
      });
      setTasks(list);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onLayout();
  }, [onLayout, tasks, error, loading]);

  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")),
    [tasks],
  );

  const groups = useMemo(() => groupByDay(sorted), [sorted]);

  /** 近 7 天完成了几条，给个「最近挺勤快」的参照 */
  const recent = useMemo(
    () =>
      sorted.filter((task) => {
        if (task.completed_at === null) return false;
        const at = new Date(task.completed_at);
        return !Number.isNaN(at.getTime()) && dayDelta(at, new Date()) <= 6;
      }).length,
    [sorted],
  );

  const act = async (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      await load();
      // 恢复会把任务放回待办、删除会让计数变少——两页的数据是一份，得让外面跟着刷新
      onDataChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="list-head">
        <span className="list-head__title">已完成</span>
        <span className="list-head__count">{tasks.length}</span>
        {recent > 0 && <span className="list-head__hint">近 7 天 {recent}</span>}
      </div>

      {error !== null && <div className="panel__error">{error}</div>}

      <ul className="panel__list" data-page-body>
        {groups.map((group) => (
          <Fragment key={group.key}>
            <li className="hist-day">
              {group.label}
              <span className="hist-day__count">{group.items.length}</span>
            </li>
            {group.items.map((task) => (
              <li key={task.id} className="hist">
                <span className="hist__tick" aria-hidden="true">
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M1.5 5.2 3.9 7.6 8.5 2.6"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <div className="hist__body">
                  <span className="hist__title">{task.title}</span>
                  <span className="hist__meta">
                    {task.completed_at === null
                      ? "完成时间未知"
                      : `完成 ${toLocalTime(new Date(task.completed_at))}`}
                  </span>
                </div>
                <div className="hist__acts">
                  <button
                    type="button"
                    className="hist__act"
                    onClick={() => void act(() => invoke("reopen_task", { id: task.id }))}
                    disabled={busy}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    className="hist__act hist__act--danger"
                    onClick={() => void act(() => invoke("delete_task", { id: task.id }))}
                    disabled={busy}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </Fragment>
        ))}

        {!loading && tasks.length === 0 && (
          <li className="panel__empty">
            还没有完成记录
            <span>勾掉一条待办，它就会记在这里</span>
          </li>
        )}
      </ul>
    </>
  );
}
