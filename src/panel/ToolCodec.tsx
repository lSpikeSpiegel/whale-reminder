import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../ui/clipboard";
import { FORMATS, FORMAT_MAP, runCodec, type CodecKey, type CodecMode } from "./codec";
import type { ToolProps } from "./types";

/** 交换：上下两支箭头，和清单里的编解码图标同一套线条 */
const SwapIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M4.6 2.6v10.8M2.2 11 4.6 13.4 7 11"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.4 13.4V2.6M9 5l2.4-2.4L13.8 5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ClearIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/**
 * 编解码：Base64 / URL / HTML 实体 / 时间戳 / Unicode 转义。
 *
 * 一次只做一件事：选格式 → 选方向 → 上面输入、下面出结果。
 * 转换跟着按键实时跑（都是纯函数，够快），所以没有「转换」按钮；
 * 结果整块可点即复制，时间戳那几个读数一行一个，点哪行复制哪行。
 */
export function ToolCodec({ onLayout }: ToolProps) {
  const [key, setKey] = useState<CodecKey>("base64");
  const [mode, setMode] = useState<CodecMode>("encode");
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef(0);

  const format = FORMAT_MAP[key];
  const result = useMemo(() => runCodec(key, mode, input), [key, mode, input]);
  const empty = input.trim() === "";

  useEffect(() => {
    onLayout();
  }, [onLayout, key, mode, input, note]);

  useEffect(
    () => () => {
      window.clearTimeout(noteTimer.current);
    },
    [],
  );

  const flash = (text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2000);
  };

  const copy = (value: string) => {
    if (value === "") return;
    void copyText(value).then((done) => flash(done ? "已复制到剪贴板" : "复制失败，试试选中再按 Ctrl+C"));
  };

  /**
   * 换格式。切到时间戳时顺手挑个方向：
   * 粘进来一串数字多半是想知道「这是哪天」，反过来则是想换出时间戳。
   */
  const pick = (next: CodecKey) => {
    setKey(next);
    setNote(null);
    if (next === "time") setMode(/^\d{9,}$/.test(input.trim()) ? "decode" : "encode");
  };

  /** 把结果放回输入，再反向转一次——「互转」就是这么用的 */
  const swap = () => {
    if (!result.ok || result.text === "") return;
    setInput(result.text);
    setMode(mode === "encode" ? "decode" : "encode");
    setNote(null);
  };

  return (
    <section className="tool codec">
      <div className="codec__formats" role="group" aria-label="编码格式">
        {FORMATS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`chip${item.key === key ? " chip--on" : ""}`}
            onClick={() => pick(item.key)}
            aria-pressed={item.key === key}
          >
            {item.label}
          </button>
        ))}
      </div>

      <textarea
        className="codec__input"
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setNote(null);
        }}
        placeholder={format.placeholder}
        aria-label="输入内容"
        spellCheck={false}
        autoComplete="off"
      />

      <div className="codec__bar">
        <div className="codec__dir" role="group" aria-label="转换方向">
          <button
            type="button"
            className={`chip${mode === "encode" ? " chip--on" : ""}`}
            onClick={() => setMode("encode")}
            aria-pressed={mode === "encode"}
          >
            {format.encode}
          </button>
          <button
            type="button"
            className={`chip${mode === "decode" ? " chip--on" : ""}`}
            onClick={() => setMode("decode")}
            aria-pressed={mode === "decode"}
          >
            {format.decode}
          </button>
        </div>

        <div className="codec__acts">
          {input !== "" && (
            <button
              type="button"
              className="codec__icon"
              onClick={() => {
                setInput("");
                setNote(null);
              }}
              title="清空输入"
              aria-label="清空输入"
            >
              <ClearIcon />
            </button>
          )}
          <button
            type="button"
            className="codec__icon"
            onClick={swap}
            disabled={!result.ok || result.text === ""}
            title="把结果放回输入，反向再转一次"
            aria-label="交换输入和结果"
          >
            <SwapIcon />
          </button>
        </div>
      </div>

      <div className={`codec__out${empty ? " codec__out--empty" : ""}`}>
        {empty ? (
          <p className="codec__placeholder">在上面粘贴或敲点东西，结果会实时出来</p>
        ) : !result.ok ? (
          <p className="codec__error">{result.error}</p>
        ) : (
          <>
            <button
              type="button"
              className="codec__result"
              onClick={() => copy(result.text)}
              title="点击复制结果"
            >
              <span className="codec__text">{result.text}</span>
              <span className="codec__copy" aria-hidden="true">
                复制
              </span>
            </button>
            {result.rows.length > 0 && (
              <div className="codec__rows">
                {result.rows.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    className="codec__row"
                    onClick={() => copy(row.value)}
                    title={`点击复制 ${row.value}`}
                  >
                    <span className="codec__row-key">{row.key}</span>
                    <span className="codec__row-val">{row.value}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <p className={`codec__hint${note === null ? "" : " codec__hint--note"}`}>
        {note ?? format.hint}
      </p>
    </section>
  );
}
