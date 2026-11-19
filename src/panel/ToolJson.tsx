import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../ui/clipboard";
import {
  INDENTS,
  buildLines,
  formatBytes,
  formatJson,
  parseJson,
  type JsonIndent,
  type JsonLine,
} from "./json";
import type { ToolProps } from "./types";

type JsonMode = "format" | "minify";

/**
 * 小于这个长度就同步解析。
 *
 * 为什么不全套防抖：几十个字符的报文解析只要零点几毫秒，套上 160ms 反而会
 * 让「粘贴 → 出结果」之间空一拍。真正需要防的是几十万字符的大文件，
 * 那时候每敲一个键都重新扫一遍才会卡。
 */
const LIVE_LIMIT = 50_000;
const PARSE_DELAY = 160;

const ClearIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

interface RowProps {
  line: JsonLine;
  /** 这个容器当前是不是折着的 */
  folded: boolean;
  onFold: (path: string) => void;
}

/**
 * 格式化结果里的一行。
 *
 * 容器折起来时把 `{ … 3 项 }` 压在同一行：闭括号也得跟过来，
 * 否则屏幕上会出现一个没有收尾的花括号，看着像解析错了。
 */
function JsonRowBase({ line, folded, onFold }: RowProps) {
  const isOpen = line.kind === "open";
  const isClose = line.kind === "close";

  return (
    <div className={`json__line json__line--${line.kind}`}>
      <span className="json__indent" style={{ width: `${line.depth * 12}px` }} aria-hidden="true" />

      {isOpen ? (
        <button
          type="button"
          className={`json__fold${folded ? " json__fold--off" : ""}`}
          onClick={() => onFold(line.path)}
          aria-expanded={!folded}
          aria-label={folded ? "展开这一层" : "折叠这一层"}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.2 1.8 7 5l-3.8 3.2z" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <span className="json__fold json__fold--none" aria-hidden="true" />
      )}

      {line.key !== undefined && (
        <>
          <span className="json__key">{JSON.stringify(line.key)}</span>
          <span className="json__punct">: </span>
        </>
      )}

      {isOpen || isClose ? (
        <span className="json__brace">{line.text}</span>
      ) : (
        <span className={`json__val json__val--${line.type}`}>{line.text}</span>
      )}

      {isOpen && folded && (
        <>
          <span className="json__sum">… {line.size ?? 0} 项</span>
          <span className="json__brace">{line.type === "object" ? "}" : "]"}</span>
        </>
      )}

      {line.comma && <span className="json__brace">,</span>}
    </div>
  );
}

/**
 * 一行几百条时，折叠一次不该把所有行都重画一遍：`line` 是稳定引用，
 * 只有被折叠的那一行 `folded` 会变，其余 memo 直接跳过。
 */
const JsonRow = memo(JsonRowBase);

/**
 * JSON 格式化：粘贴一段，下面实时出格式化 / 压缩结果，可逐层折叠，报错能定位到行。
 *
 * 解析和排版全在 `json.ts`（纯函数、有单测），这里只负责摆位置和接指针。
 * 输入框是普通 textarea，不是代码编辑器——面板只有 436 宽，自绘编辑器（行号、光标、
 * 选中、输入法）的成本远超收益，而用户的真实动作是「从别处复制过来、看一眼、再复制走」。
 */
export function ToolJson({ onLayout }: ToolProps) {
  const [input, setInput] = useState("");
  /** 真正拿去解析的文本：大文件才会和 input 慢半拍 */
  const [text, setText] = useState("");
  const [mode, setMode] = useState<JsonMode>("format");
  const [indent, setIndent] = useState<JsonIndent>(2);
  /** 折起来的容器路径。用路径而不是行号，重新解析后折叠状态还认得自己的位置 */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);

  const noteTimer = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 小文本直接同步，大文本防抖——见 LIVE_LIMIT 的说明
  useEffect(() => {
    if (input.length < LIVE_LIMIT) {
      setText(input);
      return;
    }
    const timer = window.setTimeout(() => setText(input), PARSE_DELAY);
    return () => window.clearTimeout(timer);
  }, [input]);

  const empty = input.trim() === "";
  const parsed = useMemo(() => (text.trim() === "" ? null : parseJson(text)), [text]);
  const doc = parsed !== null && parsed.ok ? parsed.doc : null;
  const error = parsed !== null && !parsed.ok ? parsed.error : null;

  const lines = useMemo(() => (doc === null ? [] : buildLines(doc.root)), [doc]);
  const containers = useMemo(() => lines.filter((line) => line.kind === "open"), [lines]);
  const allFolded = containers.length > 0 && containers.every((line) => folded.has(line.path));

  /** 屏幕上看得到的行：被折叠容器包住的行整段跳过 */
  const visible = useMemo(() => {
    const out: Array<{ line: JsonLine; index: number }> = [];
    let skipUntil = -1;
    lines.forEach((line, index) => {
      if (index <= skipUntil) return;
      out.push({ line, index });
      if (line.kind === "open" && line.close !== undefined && folded.has(line.path)) {
        skipUntil = line.close;
      }
    });
    return out;
  }, [lines, folded]);

  /** 复制的内容必须和屏幕上一致：压缩模式给一行，格式化模式按当前缩进 */
  const output = useMemo(() => {
    if (doc === null) return "";
    return mode === "minify" ? doc.minified : formatJson(doc.root, indent);
  }, [doc, mode, indent]);

  useEffect(() => {
    onLayout();
  }, [onLayout, parsed, mode, indent, folded, note]);

  useEffect(
    () => () => {
      window.clearTimeout(noteTimer.current);
    },
    [],
  );

  const flash = (message: string) => {
    setNote(message);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2000);
  };

  const copy = () => {
    if (output === "") return;
    void copyText(output).then((ok) => flash(ok ? "已复制到剪贴板" : "复制失败，试试选中再按 Ctrl+C"));
  };

  const clear = () => {
    setInput("");
    setText("");
    setFolded(new Set());
    setNote(null);
  };

  const toggleFold = useCallback((path: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const foldAll = () => {
    setFolded(allFolded ? new Set() : new Set(containers.map((line) => line.path)));
  };

  /**
   * 把输入框里出错的字符选中并滚过去。
   *
   * `error.index` 是相对 `text` 的；两者不一样说明防抖还没落地，这次先不选，
   * 免得选到错的地方——用户再点一下就好了。
   */
  const reveal = () => {
    const area = inputRef.current;
    if (area === null || error === null || input !== text) return;
    area.focus();
    area.setSelectionRange(error.index, Math.min(error.index + 1, area.value.length));
    const lineHeight = Number.parseFloat(window.getComputedStyle(area).lineHeight) || 20;
    area.scrollTop = Math.max(0, (error.line - 1) * lineHeight - area.clientHeight / 2);
  };

  const status = empty
    ? "粘贴一段 JSON，下面实时出结果"
    : parsed === null
      ? "正在解析…"
      : error !== null
        ? `第 ${error.line} 行第 ${error.column} 列`
        : doc !== null && doc.stats.depth === 0
          ? `${formatBytes(doc.stats.bytes)} · 单个值`
          : `${doc?.stats.keys ?? 0} 个键 · ${doc?.stats.depth ?? 0} 层 · ${formatBytes(doc?.stats.bytes ?? 0)}`;

  return (
    <section className="tool json">
      <div className="json__formats" role="group" aria-label="输出方式">
        <button
          type="button"
          className={`chip${mode === "format" ? " chip--on" : ""}`}
          onClick={() => {
            setMode("format");
            setNote(null);
          }}
          aria-pressed={mode === "format"}
        >
          格式化
        </button>
        <button
          type="button"
          className={`chip${mode === "minify" ? " chip--on" : ""}`}
          onClick={() => {
            setMode("minify");
            setNote(null);
          }}
          aria-pressed={mode === "minify"}
        >
          压缩
        </button>

        {/* 缩进只对格式化有意义，切到压缩时整组收起来，不占位置 */}
        {mode === "format" && (
          <>
            <span className="json__tag">缩进</span>
            {INDENTS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`chip${indent === item.key ? " chip--on" : ""}`}
                onClick={() => setIndent(item.key)}
                aria-pressed={indent === item.key}
                aria-label={item.aria}
              >
                {item.label}
              </button>
            ))}
          </>
        )}
      </div>

      <textarea
        ref={inputRef}
        className="json__input"
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setNote(null);
        }}
        placeholder={'{"name":"鲸鱼娘","tags":["reminder"]}'}
        aria-label="要处理的 JSON"
        spellCheck={false}
        autoComplete="off"
      />

      <div className="json__bar">
        <span className={`json__stat${error !== null ? " json__stat--bad" : ""}`}>{status}</span>
        {input !== "" && (
          <button type="button" className="json__icon" onClick={clear} title="清空输入" aria-label="清空输入">
            <ClearIcon />
          </button>
        )}
      </div>

      {doc !== null && doc.warnings.length > 0 && (
        <p className="json__warn">
          {doc.warnings[0]}
          {doc.warnings.length > 1 ? `（另有 ${doc.warnings.length - 1} 处）` : ""}
        </p>
      )}

      <div className={`json__out${empty ? " json__out--empty" : ""}`}>
        {!empty && (
          <div className="json__head">
            <span className={`json__head-label${note === null ? "" : " json__head-label--note"}`}>
              {note ?? (error !== null ? "解析失败" : mode === "minify" ? "压缩结果" : "格式化结果")}
            </span>
            {doc !== null && mode === "format" && containers.length > 0 && (
              <button type="button" className="json__link" onClick={foldAll}>
                {allFolded ? "全部展开" : "全部折叠"}
              </button>
            )}
            {doc !== null && (
              <button type="button" className="json__link" onClick={copy}>
                复制
              </button>
            )}
          </div>
        )}

        {empty ? (
          <p className="json__placeholder">粘贴后格式化结果会实时出来，报错会指到具体那一行</p>
        ) : parsed === null ? (
          <p className="json__placeholder">正在解析…</p>
        ) : error !== null ? (
          <div className="json__err">
            <p className="json__err-where">
              第 {error.line} 行第 {error.column} 列
            </p>
            {error.snippet !== "" && (
              <pre className="json__err-code">
                {error.snippet}
                {"\n"}
                <span className="json__err-caret">{" ".repeat(error.caret)}^</span>
              </pre>
            )}
            <p className="json__err-msg">{error.message}</p>
            <button type="button" className="json__link" onClick={reveal}>
              在输入里选中这一处
            </button>
          </div>
        ) : mode === "minify" ? (
          <button type="button" className="json__minified" onClick={copy} title="点击复制压缩结果">
            {doc?.minified}
          </button>
        ) : (
          <div className="json__code">
            {visible.map(({ line, index }) => (
              <JsonRow
                key={index}
                line={line}
                folded={folded.has(line.path)}
                onFold={toggleFold}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
