import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** 自动检查的节流间隔。面板每次显示都会走到这里，别把 GitHub 当接口刷。 */
const AUTO_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "whale.update.checkedAt";

/** 托盘「检查更新」发过来的事件，和 tray.rs 里的常量保持一致 */
const CHECK_EVENT = "update://check";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * 检查更新 + 下载安装。
 *
 * 全部走 updater 的 JS API：Rust 侧只注册插件，这样下载进度能直接喂给界面，
 * 不用在前后端之间来回传状态。
 */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const pending = useRef<Update | null>(null);
  const busy = useRef(false);

  const run = useCallback(async (manual: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setState({ kind: "checking" });

    try {
      const update = await check();
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

      if (update === null) {
        pending.current = null;
        setState({ kind: "uptodate" });
        return;
      }

      pending.current = update;
      setState({
        kind: "available",
        version: update.version,
        notes: update.body ?? null,
      });
    } catch (err) {
      // 自动检查失败不打扰用户：断网、仓库还没发过版都会走到这里
      console.warn("[update] 检查更新失败", err);
      setState(manual ? { kind: "error", message: describe(err) } : { kind: "idle" });
    } finally {
      busy.current = false;
    }
  }, []);

  // 面板在启动时就已经创建（只是隐藏着），这里检查一次就等于启动自检
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
    if (Date.now() - last < AUTO_CHECK_INTERVAL) return;
    void run(false);
  }, [run]);

  // 托盘菜单点「检查更新」→ 强制检查，忽略节流
  useEffect(() => {
    const unlisten = listen(CHECK_EVENT, () => void run(true));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [run]);

  // 「已是最新版本」只是给个反馈，三秒后自己收起来
  useEffect(() => {
    if (state.kind !== "uptodate") return;
    const timer = window.setTimeout(() => setState({ kind: "idle" }), 3000);
    return () => window.clearTimeout(timer);
  }, [state.kind]);

  const install = useCallback(async () => {
    const update = pending.current;
    if (update === null) return;

    let total = 0;
    let received = 0;
    setState({ kind: "downloading", version: update.version, percent: 0 });

    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            received += event.data.chunkLength;
            setState({
              kind: "downloading",
              version: update.version,
              percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
            });
            break;
          case "Finished":
            setState({ kind: "installing", version: update.version });
            break;
        }
      });

      // Windows 上安装器接管后会直接结束当前进程，这行只是其他平台的兜底
      await relaunch();
    } catch (err) {
      console.error("[update] 安装失败", err);
      setState({ kind: "error", message: describe(err) });
    }
  }, []);

  const dismiss = useCallback(() => setState({ kind: "idle" }), []);

  return { state, checkNow: () => void run(true), install, dismiss };
}
