import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../ui/clipboard";
import { formatLabel, isWebLink } from "./format";
import type { ScanEntry } from "../panel/types";
import "./scan.css";

/** `overlay_frame` 的返回：整屏截图（data URL）和它的物理像素尺寸 */
interface Frame {
  image: string;
  width: number;
  height: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `idle` 等框选 / `drag` 正在拉框 / `busy` 识别中 /
 * `done` 认出来了 / `failed` 没认出来
 */
type Phase = "idle" | "drag" | "busy" | "done" | "failed";

/** 小于这个边长当作「点了一下」，不算框选（CSS px） */
const MIN_BOX = 8;
/** 结果卡宽度，和 scan.css 里的 .scan__card 一致 */
const CARD_W = 320;
/** 卡片和框、和窗口边缘之间留的空隙 */
const CARD_GAP = 10;
const EDGE = 12;

/** 把两次指针位置整理成左上角 + 宽高，允许反着拖 */
function boxOf(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/**
 * 框选浮层：铺满鼠标所在那块屏幕，底图是抓下来的桌面截图。
 *
 * 抓屏和建窗口都在 Rust 侧（`scan_start`），这里只负责画框、把框的**比例**
 * 发回去识别、再把结果显示出来。浮层本身不透明——它盖住的是桌面截图，
 * 暗一层才看得出框选边界。
 */
export function ScanOverlay() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [box, setBox] = useState<Box | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [entry, setEntry] = useState<ScanEntry | null>(null);
  const [message, setMessage] = useState("");
  /** 「已复制」「已记为待办」这类一次性反馈 */
  const [note, setNote] = useState<string | null>(null);
  const [cardHeight, setCardHeight] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /** 按下时的坐标；null 表示当前没在拖 */
  const origin = useRef<{ x: number; y: number } | null>(null);
  const noteTimer = useRef(0);

  useEffect(() => {
    invoke<Frame>("overlay_frame")
      .then((next) => {
        setFrame(next);
        setLoadError(null);
      })
      .catch((err) => setLoadError(String(err)));
  }, []);

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

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

  // 卡片高度量出来才好决定摆框下面还是框上面
  useLayoutEffect(() => {
    if (phase !== "done" && phase !== "failed") return;
    const height = cardRef.current?.getBoundingClientRect().height ?? 0;
    if (height > 0) setCardHeight(height);
  }, [phase, entry, note]);

  const flash = (text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 1600);
  };

  const reset = () => {
    setPhase("idle");
    setBox(null);
    setEntry(null);
    setMessage("");
    setNote(null);
    origin.current = null;
  };

  /** 把框换成比例发给后端：窗口内尺寸受 DPI 影响，和截图的物理像素不一定相等 */
  const pick = async (next: Box) => {
    const root = rootRef.current;
    if (root === null) return;
    const size = root.getBoundingClientRect();
    if (size.width < 1 || size.height < 1) return;

    setPhase("busy");
    try {
      const result = await invoke<ScanEntry>("scan_pick", {
        fx: next.x / size.width,
        fy: next.y / size.height,
        fw: next.w / size.width,
        fh: next.h / size.height,
      });
      setEntry(result);
      setPhase("done");
    } catch (err) {
      setMessage(String(err));
      setPhase("failed");
    }
  };

  const localPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 出结果以后，点卡片外面就是「收工」
    if (phase === "done" || phase === "failed") {
      finish();
      return;
    }
    if (phase === "busy") return;

    const point = localPoint(event);
    origin.current = point;
    setCursor(point);
    setBox({ x: point.x, y: point.y, w: 0, h: 0 });
    setPhase("drag");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = localPoint(event);
    setCursor(point);
    if (origin.current === null) return;
    setBox(boxOf(origin.current, point));
  };

  const handleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const start = origin.current;
    origin.current = null;
    if (start === null) return;

    const next = boxOf(start, localPoint(event));
    // 点一下、拖了一两像素：当没框，退回等待状态
    if (next.w < MIN_BOX || next.h < MIN_BOX) {
      setBox(null);
      setPhase("idle");
      return;
    }

    setBox(next);
    void pick(next);
  };

  /* ------------------------------------------------------------ 布局计算 */

  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;

  // 底图和窗口的尺寸比：框的 CSS 尺寸乘上去就是用户眼里的「截图像素」
  const pixelRatio = frame !== null && viewWidth > 0 ? frame.width / viewWidth : 1;
  const sizeLabel =
    box === null
      ? ""
      : `${Math.round(box.w * pixelRatio)} × ${Math.round(box.h * pixelRatio)}`;

  const cardAt = (() => {
    if (box === null) return { left: EDGE, top: EDGE };
    const height = cardHeight || 190;
    const left = Math.min(Math.max(EDGE, box.x), viewWidth - CARD_W - EDGE);

    let top = box.y + box.h + CARD_GAP;
    if (top + height > viewHeight - EDGE) top = box.y - height - CARD_GAP;
    // 上下都放不下（框基本占满屏幕）就夹回窗口里，宁可压住框也别溢出
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, viewHeight - height - EDGE));
    return { left, top };
  })();

  const showCard = phase === "done" || phase === "failed";

  return (
    <div
      ref={rootRef}
      className={`scan${showCard ? " scan--idle" : ""}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onContextMenu={(event) => {
        event.preventDefault();
        finish();
      }}
      role="dialog"
      aria-label="框选要识别的码"
    >
      {frame !== null && (
        <img className="scan__shot" src={frame.image} alt="" draggable={false} />
      )}

      {/* 遮罩用超大外扩阴影挖洞：洞就是框本身，比拿四块黑边拼干净 */}
      <div
        className={`scan__shade${box === null ? " scan__shade--full" : ""}`}
        style={
          box === null
            ? undefined
            : { left: box.x, top: box.y, width: box.w, height: box.h }
        }
      />

      {box !== null && box.w > 0 && (
        <div
          className="scan__sel"
          style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        >
          <span className="scan__corner scan__corner--tl" />
          <span className="scan__corner scan__corner--tr" />
          <span className="scan__corner scan__corner--bl" />
          <span className="scan__corner scan__corner--br" />
          {box.w > 60 && box.h > 26 && <span className="scan__size">{sizeLabel}</span>}
        </div>
      )}

      {/* 还没开始拖的时候给两条准星，方便对准 */}
      {phase === "idle" && cursor !== null && (
        <>
          <span className="scan__cross scan__cross--v" style={{ left: cursor.x }} />
          <span className="scan__cross scan__cross--h" style={{ top: cursor.y }} />
        </>
      )}

      {!showCard && (
        <div className="scan__hint">
          {loadError !== null ? (
            <span>{loadError}</span>
          ) : phase === "busy" ? (
            <>
              <span className="scan__spin" aria-hidden="true" />
              <span>正在识别…</span>
            </>
          ) : (
            <>
              <span>拖动框选要识别的二维码或条形码</span>
              <kbd className="scan__kbd">Esc</kbd>
              <span className="scan__hint-dim">退出</span>
            </>
          )}
        </div>
      )}

      {showCard && (
        <div
          ref={cardRef}
          className="scan__card"
          style={{ left: cardAt.left, top: cardAt.top, width: CARD_W }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="scan__card-head">
            <span className={`scan__format${phase === "failed" ? " scan__format--fail" : ""}`}>
              {phase === "done" && entry !== null ? formatLabel(entry.format) : "没认出来"}
            </span>
            <button
              type="button"
              className="scan__close"
              onClick={finish}
              aria-label="关闭"
              title="关闭"
            >
              ×
            </button>
          </div>

          {phase === "done" && entry !== null ? (
            <p className="scan__text">{entry.text}</p>
          ) : (
            <p className="scan__fail">{message}</p>
          )}

          {note !== null && <p className="scan__note">{note}</p>}

          <div className="scan__actions">
            {phase === "done" && entry !== null ? (
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn--primary"
                  onClick={() => {
                    void copyText(entry.text).then((ok) => {
                      if (!ok) {
                        flash("复制失败，选中文字手动复制吧");
                        return;
                      }
                      flash("已复制");
                      // 留一拍让人看见反馈，再把面板叫回来
                      window.setTimeout(finish, 620);
                    });
                  }}
                >
                  复制
                </button>
                {isWebLink(entry.text) && (
                  <button
                    type="button"
                    className="ui-btn ui-btn--ghost"
                    onClick={() => {
                      void invoke("open_url", { url: entry.text })
                        .then(() => {
                          flash("已在浏览器打开");
                          window.setTimeout(finish, 620);
                        })
                        .catch((err) => flash(String(err)));
                    }}
                  >
                    打开
                  </button>
                )}
                <button
                  type="button"
                  className="ui-btn ui-btn--ghost"
                  onClick={() => {
                    void invoke("create_task", {
                      input: { title: entry.text.slice(0, 120) },
                    })
                      .then(() => {
                        flash("已记为待办");
                        window.setTimeout(finish, 620);
                      })
                      .catch((err) => flash(String(err)));
                  }}
                >
                  记为待办
                </button>
              </>
            ) : null}
            <button type="button" className="ui-btn scan__again" onClick={reset}>
              重新框选
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
