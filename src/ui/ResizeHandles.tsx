import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import "./resize.css";

/**
 * 拖拽方向。`@tauri-apps/api` 里这个类型没导出（只作为参数类型出现），这里照抄一份。
 */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/** 和 Rust 侧 `MIN_PANEL_WIDTH` / `MIN_PANEL_HEIGHT` 对齐，改一处要同步另一处 */
const MIN_WIDTH = 320;
const MIN_HEIGHT = 260;

const win = getCurrentWindow();

const HANDLES: { dir: ResizeDirection; className: string }[] = [
  { dir: "North", className: "rz rz--n" },
  { dir: "South", className: "rz rz--s" },
  { dir: "West", className: "rz rz--w" },
  { dir: "East", className: "rz rz--e" },
  // 角排在后面：同层级时后渲染的在上，角才压得住边的端点
  { dir: "NorthWest", className: "rz rz--nw" },
  { dir: "NorthEast", className: "rz rz--ne" },
  { dir: "SouthWest", className: "rz rz--sw" },
  { dir: "SouthEast", className: "rz rz--se" },
];

/** 一次拖拽的起点快照。全部用逻辑像素，和 `setSize` / `setPosition` 的单位一致 */
interface Session {
  dir: ResizeDirection;
  /** 按下时的指针位置（CSS px，等于逻辑像素） */
  pointerX: number;
  pointerY: number;
  /** 按下时的窗口位置和尺寸 */
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * 八向缩放热区。
 *
 * **不用 `startResizeDragging`**：那个 API 只是往事件循环投一条消息就返回，实测
 * 拖不动（而且无边框窗口外圈本来就有一层原生子窗口在抢鼠标，两层叠着更难查）。
 * 这里自己算：pointerdown 记下指针和窗口的起点，pointermove 按位移改 `setSize` /
 * `setPosition`，用 rAF 压到每帧一次。
 *
 * 坐标全用 `event.screenX/screenY`（CSS px）——它和窗口的逻辑尺寸是同一套单位，
 * 所以位移可以直接加减，不用管 DPI 缩放。
 *
 * 拖完的尺寸不从这里回传：每次 `setSize` 都会触发窗口 resize 事件，
 * 由 `Panel` 统一判断「这是用户拖的」并落盘（见 Panel.tsx 里的 autoSizesRef）。
 */
export function ResizeHandles() {
  const session = useRef<Session | null>(null);
  const frame = useRef(0);
  /** 每帧只发一次 IPC：pointermove 比 60Hz 密得多，不压会堆一串请求 */
  const pending = useRef<{
    width: number;
    height: number;
    x: number;
    y: number;
    move: boolean;
  } | null>(null);

  useEffect(
    () => () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const flush = () => {
    frame.current = 0;
    const next = pending.current;
    pending.current = null;
    if (next === null) return;

    // 失败不吞：缺权限时这些调用会被直接拒掉，静默失败最难查（踩过一次）
    win.setSize(new LogicalSize(next.width, next.height)).catch((err) => {
      console.error("[resize] setSize 失败", err);
    });
    // 只有从左边/上边拖才会改位置，其余方向别白发一次 IPC
    if (next.move) {
      win.setPosition(new LogicalPosition(next.x, next.y)).catch((err) => {
        console.error("[resize] setPosition 失败", err);
      });
    }
  };

  const begin = async (dir: ResizeDirection, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 不拦的话，拖拽起点会被 WebView 当成选文字 / 拖图片
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    // 合成事件的属性在 await 之后不一定还在，先把指针位置取出来
    const pointerX = event.screenX;
    const pointerY = event.screenY;

    try {
      const scale = await win.scaleFactor();
      const size = (await win.outerSize()).toLogical(scale);
      const pos = (await win.outerPosition()).toLogical(scale);

      session.current = {
        dir,
        pointerX,
        pointerY,
        originX: pos.x,
        originY: pos.y,
        width: size.width,
        height: size.height,
      };
    } catch (err) {
      // 十有八九是 capabilities 里少了 allow-outer-size / allow-scale-factor
      console.error("[resize] 取窗口尺寸失败", err);
    }
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = session.current;
    if (start === null) return;

    const dx = event.screenX - start.pointerX;
    const dy = event.screenY - start.pointerY;

    const east = start.dir.includes("East");
    const west = start.dir.includes("West");
    const south = start.dir.includes("South");
    const north = start.dir.includes("North");

    const width = Math.max(MIN_WIDTH, Math.round(start.width + (east ? dx : 0) - (west ? dx : 0)));
    const height = Math.max(
      MIN_HEIGHT,
      Math.round(start.height + (south ? dy : 0) - (north ? dy : 0)),
    );

    // 从左边/上边拖：右/下边不动，所以窗口整体要跟着挪
    const x = west ? Math.round(start.originX + (start.width - width)) : start.originX;
    const y = north ? Math.round(start.originY + (start.height - height)) : start.originY;

    pending.current = { width, height, x, y, move: west || north };
    if (frame.current === 0) frame.current = requestAnimationFrame(flush);
  };

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    if (session.current === null) return;
    session.current = null;

    // 松手时把最后一帧没发出去的尺寸补上，否则会差几像素
    if (frame.current !== 0) {
      cancelAnimationFrame(frame.current);
      flush();
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <>
      {HANDLES.map(({ dir, className }) => (
        <div
          key={dir}
          className={className}
          onPointerDown={(event) => void begin(dir, event)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
