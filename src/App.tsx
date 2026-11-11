import { useCallback, useEffect, useState, type MouseEvent } from "react";
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

function PetView() {
  const [meta, setMeta] = useState<PetMeta | null>(null);
  const [state, setState] = useState<PetState>("idle");

  useEffect(() => {
    loadPetMeta()
      .then(setMeta)
      .catch((err) => console.error("[pet] 元数据加载失败", err));
  }, []);

  // 拖拽期间切到 side 立绘，窗口停止移动后回到 idle
  useEffect(() => {
    let timer = 0;
    let unlisten: (() => void) | undefined;

    appWindow
      .onMoved(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          setState((s) => (s === "drag" ? "idle" : s));
        }, 260);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

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
    setState("drag");
    try {
      await appWindow.startDragging();
    } catch (err) {
      console.error("[pet] 拖拽启动失败", err);
      setState("idle");
    }
  }, []);

  return (
    <div
      className="stage"
      onMouseEnter={() => setState((s) => (s === "idle" ? "react" : s))}
      onMouseLeave={() => setState((s) => (s === "react" ? "idle" : s))}
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
