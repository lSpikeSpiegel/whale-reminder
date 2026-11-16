import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { toHex } from "../panel/color";
import "./pick.css";

/** `overlay_frame` 的返回：整屏截图（data URL）和它的物理像素尺寸 */
interface Frame {
  image: string;
  width: number;
  height: number;
}

/** 放大镜取多少像素的源区域（截图像素） */
const SRC_SIDE = 15;
/** 放大镜每 1 个截图像素画多大（画布像素） */
const ZOOM = 16;
/** 放大镜在屏幕上的直径（CSS px），和 pick.css 里的 .pick__canvas 一致 */
const LOUPE_CSS = 120;
/** 放大镜离光标多远，免得盖住要取的那个点 */
const LOUPE_GAP = 18;

/**
 * 吸管浮层：铺满一块屏幕的冻结截图，光标处出放大镜，点一下取色。
 *
 * 和二维码的框选浮层共用 `overlay` 那套抓屏 + 建窗口，这里只负责：
 * 铺底图、跟着光标放大、算出光标那一个像素的颜色、点完把色值送回去。
 *
 * 光标本身藏起来（`cursor: none`），位置由十字线和放大镜代替——
 * 系统箭头压在像素上会挡住要取的那个点。
 */
export function PickOverlay() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [hex, setHex] = useState("#000000");

  const imageRef = useRef<HTMLImageElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  /** 只用来读「光标下那一个像素」，1×1，不参与显示 */
  const probeRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    invoke<Frame>("overlay_frame")
      .then((next) => {
        setFrame(next);
        setLoadError(null);
      })
      .catch((err) => setLoadError(String(err)));
  }, []);

  /** 关掉浮层。窗口销毁时 Rust 那边会把面板叫回来。 */
  const finish = useCallback(() => {
    void invoke("overlay_close").catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  /**
   * 读出光标那一个像素的颜色。
   *
   * 单独用一张 1×1 画布取样，而不是从放大镜里读：贴到屏幕边缘时放大镜的源区域
   * 会越界被裁，画面会偏，但「用户点的是哪个像素」不能跟着偏。
   */
  const pixelAt = (x: number, y: number): string | null => {
    const image = imageRef.current;
    if (image === null || frame === null || !image.complete || image.naturalWidth === 0) {
      return null;
    }

    // 窗口 CSS 尺寸和截图像素不一定是 1:1（200% 缩放下差一倍）
    const ratio = frame.width / window.innerWidth;
    const px = Math.min(frame.width - 1, Math.max(0, Math.round(x * ratio)));
    const py = Math.min(frame.height - 1, Math.max(0, Math.round(y * ratio)));

    const ctx = probeRef.current?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (ctx === null) return null;

    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(image, px, py, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return toHex({ r, g, b });
  };

  /** 画放大镜：以光标为中心取 15×15，最近邻放大 16 倍 */
  const drawLoupe = (x: number, y: number) => {
    const image = imageRef.current;
    const canvas = loupeRef.current;
    if (image === null || canvas === null || frame === null) return;
    if (!image.complete || image.naturalWidth === 0) return;

    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const ratio = frame.width / window.innerWidth;
    const px = x * ratio;
    const py = y * ratio;

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      image,
      px - (SRC_SIDE - 1) / 2,
      py - (SRC_SIDE - 1) / 2,
      SRC_SIDE,
      SRC_SIDE,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  };

  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setPoint({ x, y });
    drawLoupe(x, y);
    const next = pixelAt(x, y);
    if (next !== null) setHex(next);
  };

  const handleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    // 用按下那一刻的坐标重新取一次，别用 state 里的（可能是上一帧的）
    const next = pixelAt(event.clientX - rect.left, event.clientY - rect.top);
    if (next === null) return;
    void invoke("pick_commit", { hex: next }).catch((err) => setLoadError(String(err)));
  };

  /* ------------------------------------------------------------ 放大镜位置 */

  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;

  // 默认在光标右下，靠近边缘时翻到另一侧，别让放大镜被窗口裁掉
  const loupeAt = (() => {
    if (point === null) return { left: -9999, top: -9999 };
    let left = point.x + LOUPE_GAP;
    let top = point.y + LOUPE_GAP;
    if (left + LOUPE_CSS > viewWidth - 8) left = point.x - LOUPE_CSS - LOUPE_GAP;
    // 放大镜下面还有一行色值，一起算进去
    if (top + LOUPE_CSS + 30 > viewHeight - 8) top = point.y - LOUPE_CSS - LOUPE_GAP - 30;
    return { left, top };
  })();

  return (
    <div
      className="pick"
      onPointerMove={handleMove}
      onPointerDown={handleDown}
      onContextMenu={(event) => {
        event.preventDefault();
        finish();
      }}
      role="dialog"
      aria-label="从屏幕取色"
    >
      {frame !== null && (
        <img ref={imageRef} className="pick__shot" src={frame.image} alt="" draggable={false} />
      )}

      {/* 隐藏的 1×1 画布，只用来精确读一个像素 */}
      <canvas ref={probeRef} width={1} height={1} className="pick__probe" />

      {point !== null && (
        <>
          <span className="pick__cross pick__cross--v" style={{ left: point.x }} />
          <span className="pick__cross pick__cross--h" style={{ top: point.y }} />
          <div className="pick__loupe" style={loupeAt}>
            <canvas
              ref={loupeRef}
              className="pick__canvas"
              width={SRC_SIDE * ZOOM}
              height={SRC_SIDE * ZOOM}
            />
            <span className="pick__hex">{hex}</span>
          </div>
        </>
      )}

      <div className="pick__hint">
        {loadError !== null ? (
          <span>{loadError}</span>
        ) : (
          <>
            <span>移动取色，点一下确认</span>
            <kbd className="pick__kbd">Esc</kbd>
            <span className="pick__hint-dim">取消</span>
          </>
        )}
      </div>
    </div>
  );
}
