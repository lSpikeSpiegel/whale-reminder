import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { copyText } from "../ui/clipboard";
import { formatClock } from "../ui/date";
import { formatLabel } from "../scan/format";
import { QrIcon } from "./toolIcons";
import type { QrMatrix, ScanEntry, ToolProps } from "./types";

const win = getCurrentWindow();

/** 浮层抓屏失败时 Rust 推过来的事件（见 scanner.rs 的 EVENT_ERROR） */
const SCAN_ERROR = "overlay://error";

/** 生成的二维码四周留几个模块的静区。少了扫码器认不出边，多了图显小 */
const QUIET_MODULES = 4;
/** 每个模块画多少像素。画得比显示尺寸大，缩下去才锐利 */
const MODULE_PIXELS = 8;

/**
 * 二维码助手：扫码（框选屏幕去认）和生成（文字转码）两件事放一页。
 *
 * 名字合成一个是有意的——在用户脑子里它们是同一件事，拆成两个入口反而要多想一次。
 * 页面结构由外层 `Tools` 提供（滚动容器 + 返回按钮 + 页头标题），这里只管内容。
 */
export function ToolQr({ onLayout }: ToolProps) {
  /* ---------------------------------------------------------------- 扫码 */

  const [history, setHistory] = useState<ScanEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 面板已经藏起来、浮层还没回来的那一小段 */
  const [starting, setStarting] = useState(false);
  /** 清空要点两下：第一次变成「确定清空？」，3 秒不点自己退回去 */
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef(0);
  const noteTimer = useRef(0);

  /* ---------------------------------------------------------------- 生成 */

  const [qrText, setQrText] = useState("");
  const [qr, setQr] = useState<QrMatrix | null>(null);
  const [qrNote, setQrNote] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const reload = useCallback(() => {
    invoke<ScanEntry[]>("scan_history")
      .then((list) => {
        setHistory(list);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    onLayout();
  }, [onLayout, history, error, note, starting, confirming, qr, qrNote]);

  useEffect(() => {
    const pending = listen<string>(SCAN_ERROR, (event) => {
      setStarting(false);
      setError(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 去框选时面板是藏着的，浮层那边写进历史后没人通知这里；
  // 重新拿到焦点就补一次（顺便把「正在打开」的状态收掉）
  useEffect(() => {
    const pending = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      setStarting(false);
      reload();
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [reload]);

  useEffect(
    () => () => {
      window.clearTimeout(confirmTimer.current);
      window.clearTimeout(noteTimer.current);
    },
    [],
  );

  // 矩阵变了就重画：先铺白底，再按模块涂黑
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || qr === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const side = (qr.size + QUIET_MODULES * 2) * MODULE_PIXELS;
    canvas.width = side;
    canvas.height = side;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, side, side);
    // 用墨色而不是纯黑：和面板其它文字一个色，对比度也够扫码
    ctx.fillStyle = "#16203f";
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.modules[y * qr.size + x] !== "1") continue;
        ctx.fillRect(
          (x + QUIET_MODULES) * MODULE_PIXELS,
          (y + QUIET_MODULES) * MODULE_PIXELS,
          MODULE_PIXELS,
          MODULE_PIXELS,
        );
      }
    }
  }, [qr]);

  const flash = (text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2200);
  };

  const start = () => {
    if (starting) return;
    setError(null);
    setNote(null);
    setStarting(true);
    // 成功后 Rust 会把面板藏起来，这里拿不到「浮层已就绪」的回执；
    // 失败会走 SCAN_ERROR 事件把状态收回来。
    invoke("scan_start").catch((err) => {
      setStarting(false);
      setError(String(err));
    });
  };

  const copy = (entry: ScanEntry) => {
    void copyText(entry.text).then((ok) => flash(ok ? "已复制" : "复制失败，试试长按选中"));
  };

  const forget = (id: string) => {
    invoke<ScanEntry[]>("scan_forget", { id })
      .then(setHistory)
      .catch((err) => setError(String(err)));
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
    invoke<ScanEntry[]>("scan_clear_history")
      .then((list) => {
        setHistory(list);
        flash("记录已清空");
      })
      .catch((err) => setError(String(err)));
  };

  /* ---------------------------------------------------------------- 生成动作 */

  const generate = () => {
    const text = qrText.trim();
    if (text === "" || generating) return;
    setGenerating(true);
    invoke<QrMatrix>("qr_encode", { text })
      .then((next) => {
        setQr(next);
        setQrNote(null);
      })
      .catch((err) => setQrNote(String(err)))
      .finally(() => setGenerating(false));
  };

  const copyImage = () => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    canvas.toBlob((blob) => {
      if (blob === null) {
        setQrNote("生成图片失败，试试「保存图片」");
        return;
      }
      navigator.clipboard
        .write([new ClipboardItem({ "image/png": blob })])
        .then(() => setQrNote("图片已复制，去粘贴吧"))
        .catch(() => setQrNote("这个环境不让写剪贴板，用「保存图片」吧"));
    }, "image/png");
  };

  const saveImage = () => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // 只发 base64 本体，`data:image/png;base64,` 前缀由 Rust 侧不需要
    const data = canvas.toDataURL("image/png").split(",")[1] ?? "";
    invoke<string>("save_qr_image", { data })
      .then((path) => setQrNote(`已保存：${path.split(/[\\/]/).pop() ?? path}`))
      .catch((err) => setQrNote(String(err)));
  };

  return (
    <>
      {error !== null && <div className="panel__error">{error}</div>}

      <section className="tool">
        <div className="tool__head">
          <span className="tool__icon" aria-hidden="true">
            <QrIcon />
          </span>
          <div className="tool__intro">
            <h2 className="tool__name">扫码识别</h2>
            <p className="tool__desc">框选屏幕上的二维码或条形码，自动识别。</p>
          </div>
        </div>

        <div className="tool__foot">
          <button
            type="button"
            className="ui-btn ui-btn--primary tool__start"
            onClick={start}
            disabled={starting}
          >
            {starting ? "正在打开…" : "开始框选"}
          </button>
          <span className="tool__hint">{note ?? "点完面板会自动收起，Esc 取消"}</span>
        </div>
      </section>

      <section className="tool">
        <div className="tool__head">
          <span className="tool__icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M2.6 5.4h6.4M2.6 9.4h4.4M2.6 13.4h6.4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <rect
                x="11.6"
                y="6"
                width="6"
                height="6"
                rx="1.4"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M13.5 7.9h2.2v2.2h-2.2z" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div className="tool__intro">
            <h2 className="tool__name">文字转二维码</h2>
            <p className="tool__desc">把文字或网址变成二维码，扫一下带走。</p>
          </div>
        </div>

        <div className="tool__row">
          <input
            className="composer__input"
            value={qrText}
            onChange={(event) => setQrText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") generate();
            }}
            placeholder="一段文字或网址…"
            aria-label="要转成二维码的文字"
          />
          <button
            type="button"
            className="ui-btn ui-btn--primary tool__gen"
            onClick={generate}
            disabled={generating || qrText.trim() === ""}
          >
            {generating ? "生成中" : "生成"}
          </button>
        </div>

        {qr !== null && (
          <div className="qr">
            <canvas ref={canvasRef} className="qr__canvas" aria-label="生成的二维码" />
            <div className="qr__side">
              <button type="button" className="ui-btn ui-btn--ghost" onClick={copyImage}>
                复制图片
              </button>
              <button type="button" className="ui-btn ui-btn--ghost" onClick={saveImage}>
                保存图片
              </button>
              <button
                type="button"
                className="ui-btn qr__drop"
                onClick={() => {
                  setQr(null);
                  setQrNote(null);
                }}
              >
                收起
              </button>
            </div>
          </div>
        )}

        {qrNote !== null && (
          <p className="tool__note" title={qrNote}>
            {qrNote}
          </p>
        )}
      </section>

      <div className="list-head">
        <span className="list-head__title">最近识别</span>
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

      <ul className="tool__list">
        {history.map((entry) => (
          <li key={entry.id} className="scan-row">
            <button
              type="button"
              className="scan-row__main"
              onClick={() => copy(entry)}
              title={`${entry.text}\n点击复制`}
            >
              <span className="scan-row__format">{formatLabel(entry.format)}</span>
              <span className="scan-row__text">{entry.text}</span>
              <span className="scan-row__at">{formatClock(entry.at)}</span>
            </button>
            <button
              type="button"
              className="scan-row__del"
              onClick={() => forget(entry.id)}
              title="删除这条记录"
              aria-label="删除这条记录"
            >
              删除
            </button>
          </li>
        ))}
        {history.length === 0 && (
          <li className="panel__empty">
            还没扫过东西
            <span>点上面的「开始框选」，框住二维码试试</span>
          </li>
        )}
      </ul>
    </>
  );
}
