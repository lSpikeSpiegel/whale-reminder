import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
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

/**
 * 按下与抬起的位置差不超过这个值（CSS px）就算"没动"，判定为单击。
 * 留一点容差是因为按下时鼠标几乎不可能一像素都不抖。
 */
const CLICK_TOLERANCE = 3;
/**
 * 单击随机切换的状态池。
 * 不含 idle / react —— 这两者都是正面图，而且鼠标正悬停着，切过去等于没反应；
 * 其余 5 个状态对应 5 张不同的立绘。
 */
const CLICK_STATES: PetState[] = ["remind", "think", "sleep", "celebrate", "drag"];
/** 随机状态停留多久后自动回到常态 */
const CLICK_STATE_MS = 3200;

interface Point {
  x: number;
  y: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 取屏幕坐标（窗口会被拖动，用屏幕坐标才稳定） */
function pointOf(e: PointerEvent): Point {
  return { x: e.screenX, y: e.screenY };
}

function PetView() {
  const [meta, setMeta] = useState<PetMeta | null>(null);
  const [state, setState] = useState<PetState>("idle");

  /** 鼠标是否停在宠物身上 */
  const hovered = useRef(false);
  /** 随机状态停留的计时器 */
  const stateTimer = useRef(0);
  /** 上一次随机到的状态，避免连续两次相同 */
  const lastPicked = useRef<PetState | null>(null);
  /** 按下时的屏幕坐标；null 表示当前没有按下 */
  const pressOrigin = useRef<Point | null>(null);
  /** 本次按下是否已经交棒给系统拖拽 */
  const dragging = useRef(false);

  /** 常态：鼠标还停在宠物上就用 hover 态，避免立绘忽然掉下来 */
  const restState = useCallback((): PetState => (hovered.current ? "react" : "idle"), []);

  /** 左键单击：随机切一个状态，停留几秒后自己回到常态 */
  const playRandomState = useCallback(() => {
    const pool = CLICK_STATES.filter((s) => s !== lastPicked.current);
    const next = pool[Math.floor(Math.random() * pool.length)] ?? "celebrate";
    lastPicked.current = next;

    window.clearTimeout(stateTimer.current);
    setState(next);
    stateTimer.current = window.setTimeout(() => {
      // 期间如果被提醒抢走了状态，就不要覆盖
      setState((s) => (s === next ? restState() : s));
    }, CLICK_STATE_MS);
  }, [restState]);

  useEffect(() => {
    loadPetMeta()
      .then(setMeta)
      .catch((err) => console.error("[pet] 元数据加载失败", err));
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

  useEffect(() => () => window.clearTimeout(stateTimer.current), []);

  const handlePointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 只记下起点，不动状态、也不立刻开始拖拽
    pressOrigin.current = pointOf(e);
    dragging.current = false;
    // 抓住指针：光标冲出这 176px 小窗口后，move / up 事件仍然能收到
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const origin = pressOrigin.current;
    if (!origin || dragging.current) return;
    // 越过容差 = 这是拖拽，把窗口交给系统跟随光标；
    // 之后不再参与单击判定，状态也保持原样
    if (distance(origin, pointOf(e)) <= CLICK_TOLERANCE) return;
    dragging.current = true;
    appWindow.startDragging().catch((err) => {
      console.error("[pet] 拖拽启动失败", err);
      dragging.current = false;
    });
  }, []);

  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const origin = pressOrigin.current;
      pressOrigin.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // 拖拽过：位置变了但状态不变，直接收工
      if (!origin || dragging.current) return;
      // 抬起位置和按下位置不一致，说明手在拖，不当作单击
      if (distance(origin, pointOf(e)) > CLICK_TOLERANCE) return;
      playRandomState();
    },
    [playRandomState],
  );

  const handlePointerCancel = useCallback(() => {
    pressOrigin.current = null;
    dragging.current = false;
  }, []);

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
      <div
        className="pet-hit"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
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
