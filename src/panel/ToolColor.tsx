import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { copyText } from "../ui/clipboard";
import { clamp, formats, hsvToRgb, parseColor, rgbToHsv, toHex, type Hsv, type Rgb } from "./color";
import type { ToolProps } from "./types";

/** 打开时先摆品牌色，比随机一个颜色更有「这是本项目的工具」的感觉 */
const BRAND = "#355cb6";

/** 取色历史最多几条，和 Rust 侧的 LIMIT 对齐（一行色块正好摆满） */
const HISTORY_LIMIT = 12;

/** 浮层抓屏失败时 Rust 推过来的事件（见 overlay.rs 的 EVENT_ERROR） */
const OVERLAY_ERROR = "overlay://error";

const HUE_GRADIENT =
  "linear-gradient(to right, #ff0000 0%, #ffff00 16.6%, #00ff00 33.3%, #00ffff 50%, #0000ff 66.6%, #ff00ff 83.3%, #ff0000 100%)";

const win = getCurrentWindow();

/** 吸管图标：斜向的取色管 */
const EyedropperIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2.4 13.6 2.8 11 9.6 4.2l2.2 2.2-6.8 6.8z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path
      d="M8.8 3.4 10.6 1.6a1.9 1.9 0 0 1 2.7 2.7l-1.8 1.8"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * 颜色转换：HEX / RGB / HSL 互转 + 拾色器 + 屏幕吸管 + 取色历史。
 *
 * 换算全在 `color.ts`（纯函数、有单测），这里只负责把结果摆上去和接指针。
 * 拾色器是手写的——原生 `<input type="color">` 会弹系统对话框，和面板的视觉完全冲突。
 */
export function ToolColor({ onLayout }: ToolProps) {
  // HSV 才是「真相」：灰阶和纯黑在 RGB 里丢了色相，直接存 RGB 会让色相条跳回红色
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(parseColor(BRAND) ?? { r: 53, g: 92, b: 182 }));
  const [input, setInput] = useState(BRAND);
  const [note, setNote] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  /** 清空要点两下：第一次变成「确定清空？」，3 秒不点自己退回去 */
  const [confirming, setConfirming] = useState(false);
  /** 吸管浮层正在开着（面板已经藏起来了） */
  const [picking, setPicking] = useState(false);

  const noteTimer = useRef(0);
  const confirmTimer = useRef(0);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const svDrag = useRef(false);
  const hueDrag = useRef(false);
  /** 输入框正在被编辑时，别让颜色变化把它覆盖掉 */
  const inputFocused = useRef(false);

  const rgb = hsvToRgb(hsv);
  const { hex, rgb: rgbText, hsl: hslText } = formats(rgb);
  /** 指针抬起时要读「此刻」的颜色，state 还可能是上一帧的 */
  const hexRef = useRef(hex);
  hexRef.current = hex;

  const flash = useCallback((text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2000);
  }, []);

  const remember = useCallback((value: string) => {
    invoke<string[]>("color_remember", { hex: value })
      .then((list) => setHistory(list.slice(0, HISTORY_LIMIT)))
      .catch(() => {
        /* 落盘失败也不打断取色 */
      });
  }, []);

  /** 只换颜色，不动输入框、不记历史——打字和拖拾色器走这里 */
  const setColor = useCallback((parsed: Rgb) => {
    const next = rgbToHsv(parsed);
    // 灰色没有色相，保留当前色相，别让色相条「啪」地跳回红色
    setHsv((prev) => ({ ...next, h: next.s === 0 || next.v === 0 ? prev.h : next.h }));
  }, []);

  /** 确认一个颜色：改色 + 回填规范写法 + 记进历史 */
  const useColor = useCallback(
    (value: string) => {
      const parsed = parseColor(value);
      if (parsed === null) {
        flash("认不出这个颜色");
        return;
      }
      setColor(parsed);
      setInput(toHex(parsed));
      remember(toHex(parsed));
    },
    [setColor, remember, flash],
  );

  // 颜色被别处改了（拾色器、吸管、历史色块）就同步到输入框；
  // 用户正在输入框里打字时不动它，否则「#F00」会被瞬间改写成「#ff0000」
  useEffect(() => {
    if (!inputFocused.current) setInput(hex);
  }, [hex]);

  useEffect(() => {
    invoke<string[]>("color_history")
      .then(setHistory)
      .catch(() => {
        /* 历史读不出来不影响用 */
      });
  }, []);

  useEffect(() => {
    onLayout();
  }, [onLayout, note, history, confirming]);

  useEffect(
    () => () => {
      window.clearTimeout(noteTimer.current);
      window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  // 吸管浮层关掉、面板拿回焦点时，把吸到的颜色取走
  useEffect(() => {
    const pending = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      setPicking(false);
      void invoke<string | null>("pick_take")
        .then((value) => {
          if (value !== null) useColor(value);
        })
        .catch(() => {
          /* 没吸到东西就什么都不做 */
        });
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [useColor]);

  // 抓屏失败时浮层根本不会出现，只能靠事件把话说回面板
  useEffect(() => {
    const pending = listen<string>(OVERLAY_ERROR, (event) => {
      setPicking(false);
      flash(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [flash]);

  const copy = (text: string) => {
    void copyText(text).then((ok) => flash(ok ? `已复制 ${text}` : "复制失败"));
  };

  /* ---------------------------------------------------------------- 吸管 */

  const pickFromScreen = () => {
    if (picking) return;
    setPicking(true);
    setNote(null);
    invoke("pick_start").catch((err) => {
      setPicking(false);
      flash(String(err));
    });
  };

  /* ---------------------------------------------------------------- 拾色器 */

  const applySv = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = svRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return;
    const s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
    setHsv((prev) => ({ ...prev, s, v }));
  };

  const applyHue = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = hueRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;
    const h = clamp((event.clientX - rect.left) / rect.width, 0, 1) * 360;
    setHsv((prev) => ({ ...prev, h }));
  };

  const armClear = () => {
    if (!confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 3500);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirming(false);
    invoke<string[]>("color_clear")
      .then(setHistory)
      .catch((err) => flash(String(err)));
  };

  const rows = [
    { key: "HEX", value: hex },
    { key: "RGB", value: rgbText },
    { key: "HSL", value: hslText },
  ];

  return (
    <>
      <section className="tool">
        <div className="color__preview">
          <span className="color__swatch" style={{ background: hex }} aria-hidden="true" />
          <div className="color__values">
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                className="color__value"
                onClick={() => copy(row.value)}
                title={`点击复制 ${row.value}`}
              >
                <span className="color__key">{row.key}</span>
                <span className="color__text">{row.value}</span>
                <span className="color__copy" aria-hidden="true">
                  复制
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="tool__row">
          <input
            className="composer__input"
            value={input}
            onChange={(event) => {
              const text = event.target.value;
              setInput(text);
              // 每改一次就试解析：合法就立刻同步预览 / 换算 / 拾色器，
              // 不合法（比如刚敲了「#35」）就先不动，等用户写完
              const parsed = parseColor(text);
              if (parsed !== null) setColor(parsed);
            }}
            onFocus={() => {
              inputFocused.current = true;
            }}
            onBlur={() => {
              inputFocused.current = false;
              if (parseColor(input) === null) {
                // 认不出来就还原，别把半截乱码留在框里
                setInput(hex);
                if (input.trim() !== "") flash("认不出这个颜色，已还原");
                return;
              }
              useColor(input);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") useColor(input);
            }}
            placeholder="#355cb6 / rgb(53,92,182) / hsl(222,55%,46%)"
            aria-label="输入颜色"
            spellCheck={false}
          />
          <button
            type="button"
            className="ui-btn ui-btn--ghost color__pick"
            onClick={pickFromScreen}
            disabled={picking}
            title="从屏幕任意位置吸取颜色"
          >
            <EyedropperIcon />
            {picking ? "取色中" : "取色"}
          </button>
        </div>

        {note !== null && <p className="color__note">{note}</p>}
      </section>

      <section className="tool">
        <span className="color__label">拾色器</span>
        <div
          ref={svRef}
          className="color__sv"
          style={{
            background: `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, rgba(255, 255, 255, 0)), hsl(${hsv.h} 100% 50%)`,
          }}
          onPointerDown={(event) => {
            svDrag.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            applySv(event);
          }}
          onPointerMove={(event) => {
            if (svDrag.current) applySv(event);
          }}
          onPointerUp={(event) => {
            if (!svDrag.current) return;
            svDrag.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            remember(hexRef.current);
          }}
          role="slider"
          aria-label="饱和度和明度"
          aria-valuetext={hex}
          tabIndex={-1}
        >
          <span
            className="color__sv-dot"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>

        <div
          ref={hueRef}
          className="color__hue"
          style={{ background: HUE_GRADIENT }}
          onPointerDown={(event) => {
            hueDrag.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            applyHue(event);
          }}
          onPointerMove={(event) => {
            if (hueDrag.current) applyHue(event);
          }}
          onPointerUp={(event) => {
            if (!hueDrag.current) return;
            hueDrag.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            remember(hexRef.current);
          }}
          role="slider"
          aria-label="色相"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          tabIndex={-1}
        >
          <span className="color__hue-dot" style={{ left: `${(hsv.h / 360) * 100}%` }} />
        </div>
      </section>

      <div className="list-head">
        <span className="list-head__title">最近取色</span>
        <span className="list-head__count">{history.length}</span>
        {history.length > 0 && (
          <button
            type="button"
            className={`tool__clear${confirming ? " tool__clear--armed" : ""}`}
            onClick={armClear}
          >
            {confirming ? "确定清空？" : "清空"}
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <p className="color__empty">还没取过色，拖一下上面的拾色器，或者用吸管吸屏幕</p>
      ) : (
        <div className="color__history">
          {history.map((value) => (
            <button
              key={value}
              type="button"
              className={`color__chip${value === hex ? " color__chip--on" : ""}`}
              style={{ background: value }}
              onClick={() => useColor(value)}
              title={value}
              aria-label={`使用 ${value}`}
            />
          ))}
        </div>
      )}
    </>
  );
}
