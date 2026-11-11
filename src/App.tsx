import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Pet } from "./pet/Pet";
import { Panel } from "./panel/Panel";
import { Bubble } from "./panel/Bubble";
import { loadPetMeta, type PetMeta, type PetState } from "./pet/poses";
import "./App.css";

const appWindow = getCurrentWindow();

/** 开发期用数字键预览各状态，验证 6 张立绘都能正常加载 */
const DEV_KEYS: Record<string, PetState> = {
  "1": "idle",
  "2": "react",
  "3": "remind",
  "4": "think",
  "5": "sleep",
  "6": "celebrate",
  "7": "drag",
};

/** 窗口停止移动多久后回到 idle */
const DRAG_SETTLE_MS = 260;

function PetView() {
  const [meta, setMeta] = useState<PetMeta | null>(null);
  const [state, setState] = useState<PetState>("idle");

  /** 鼠标是否停在宠物身上 */
  const hovered = useRef(false);
  /** 停手回 idle 的计时器 */
  const settleTimer = useRef(0);

  const backToIdle = useCallback(() => {
    // 鼠标还压在宠物上时回到 hover 态，避免立绘忽然掉下来
    setState((s) => (s === "drag" ? (hovered.current ? "react" : "idle") : s));
  }, []);

  useEffect(() => {
    loadPetMeta()
      .then(setMeta)
      .catch((err) => console.error("[pet] 元数据加载失败", err));
  }, []);

  // 拖拽期间切到 side 立绘，窗口停止移动后回到 idle。
  // 关键：Moved 只有窗口真的位移时才会派发，单击（按下即抬起、位置没变）
  // 根本不会有这个事件，所以立绘不会被卡在侧面。
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    appWindow
      .onMoved(() => {
        window.clearTimeout(settleTimer.current);
        setState("drag");
        settleTimer.current = window.setTimeout(backToIdle, DRAG_SETTLE_MS);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      window.clearTimeout(settleTimer.current);
      unlisten?.();
    };
  }, [backToIdle]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      const next = DEV_KEYS[e.key];
      if (next) setState(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 收到提醒时切到 remind 立绘，6 秒后自动回 idle
  useEffect(() => {
    let timer = 0;
    const pending = listen("reminder://fire", () => {
      setState("remind");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setState((s) => (s === "remind" ? "idle" : s));
      }, 6000);
    });
    return () => {
      window.clearTimeout(timer);
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const handleMouseDown = useCallback(async (e: MouseEvent) => {
    if (e.button !== 0) return;
    // 这里不切立绘：只负责把窗口交给系统拖动。
    // 立绘由 Moved 事件驱动，避免"点一下就变侧面"。
    try {
      await appWindow.startDragging();
    } catch (err) {
      console.error("[pet] 拖拽启动失败", err);
      backToIdle();
    }
  }, [backToIdle]);

  return (
    <div
      className="stage"
      onMouseEnter={() => {
        hovered.current = true;
        setState((s) => (s === "idle" ? "react" : s));
      }}
      onMouseLeave={() => {
        hovered.current = false;
        setState((s) => (s === "react" ? "idle" : s));
      }}
    >
      <div className="pet-hit" onMouseDown={handleMouseDown}>
        <Pet state={state} meta={meta} />
      </div>
    </div>
  );
}

function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "panel") return <Panel />;
  if (view === "bubble") return <Bubble />;
  return <PetView />;
}

export default App;
