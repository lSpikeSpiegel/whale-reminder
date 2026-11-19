/**
 * JSON 解析 / 格式化。纯函数、不碰 DOM，和 `codec.ts` / `color.ts` 一个路子，
 * 直接拿 Node 跑单测（`tools/json-test.mjs`）。
 *
 * **为什么不用 `JSON.parse` + `JSON.stringify`**：
 *
 * - **数字会被改掉**。`JSON.parse` 把 19 位以上的整数抹成 double
 *   （`1234567890123456789` → `1234567890123456800`），`1e400` 直接变 `Infinity`，
 *   再 stringify 出来是 `null`。接口报文里的 ID 被改一位就是事故，
 *   所以数字一律保留原文，只做排版。
 * - **报错说不清**。V8 只给英文文案和一个字符下标；这里自己扫一遍，
 *   给中文原因 + 行列号 + 出错那一行的原文。
 * - 顺带能产出折叠需要的行模型（`buildLines`），以及重复键提醒。
 *
 * 严格按 RFC 8259：不认注释、单引号、结尾逗号、前导零、NaN / Infinity。
 * 唯一放宽的是文件头常带的 UTF-8 BOM——粘贴文件内容时它几乎必然出现。
 */

export type JsonIndent = 2 | 4 | "tab";

export type JsonValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

export interface JsonEntry {
  key: string;
  value: JsonNode;
}

/**
 * 解析出来的值。
 *
 * 数字存 `raw` 而不是 `number`：排版不该改变数值，见文首说明。
 * 对象保留条目顺序和重复键——格式化工具只负责看清楚，不替用户做「谁覆盖谁」的决定。
 */
export type JsonNode =
  | { type: "string"; value: string }
  | { type: "number"; raw: string }
  | { type: "boolean"; value: boolean }
  | { type: "null" }
  | { type: "object"; entries: JsonEntry[] }
  | { type: "array"; items: JsonNode[] };

/** 一行格式化结果，给折叠树用 */
export interface JsonLine {
  /** 缩进层数，根是 0 */
  depth: number;
  /** 折叠用的稳定路径，例如 `$["a"][0]["b"]` */
  path: string;
  /** open / close 是容器的括号行，leaf 是单个值 */
  kind: "open" | "leaf" | "close";
  type: JsonValueType;
  /** 对象成员的键名（数组项和根没有） */
  key?: string;
  /** 这一行要显示的文本：叶子是值，容器是 `{` / `[` / `}` / `]` */
  text: string;
  /** 行尾有没有逗号（折叠时靠它决定要不要补一个） */
  comma: boolean;
  /** open 行：对应闭括号行的下标 */
  close?: number;
  /** open 行：容器里有多少项 */
  size?: number;
}

export interface JsonError {
  /** 中文原因 */
  message: string;
  /** 出错字符在原文里的下标，用来在输入框里选中 */
  index: number;
  /** 1 起算的行列号 */
  line: number;
  column: number;
  /** 出错那一行的原文（长行会截断） */
  snippet: string;
  /** `snippet` 里出错处的下标，用来摆 ^ */
  caret: number;
}

export interface JsonStats {
  /** 对象成员总数（嵌套的也算） */
  keys: number;
  /** 最大嵌套层数，纯标量是 0 */
  depth: number;
  /** 原文的 UTF-8 字节数 */
  bytes: number;
}

export interface JsonDoc {
  root: JsonNode;
  /** 一行、没有空格的结果 */
  minified: string;
  stats: JsonStats;
  /** 不致命但值得说的问题（目前只有重复键） */
  warnings: string[];
}

export type JsonParseResult = { ok: true; doc: JsonDoc } | { ok: false; error: JsonError };

/** 超过这个长度就不解析了：再大光扫描就要卡住面板，不如直接说清楚 */
const MAX_CHARS = 2_000_000;

/** 嵌套上限：递归下降解析和之后的递归排版都吃栈，太深会 RangeError */
const MAX_DEPTH = 400;

/** 缩进胶囊：界面只认这三档，文案和实际缩进写在一起，免得两边对不上 */
export const INDENTS: Array<{ key: JsonIndent; label: string; aria: string }> = [
  { key: 2, label: "2 空格", aria: "缩进 2 个空格" },
  { key: 4, label: "4 空格", aria: "缩进 4 个空格" },
  { key: "tab", label: "Tab", aria: "用制表符缩进" },
];

export function indentUnit(indent: JsonIndent): string {
  return indent === "tab" ? "\t" : " ".repeat(indent);
}

/* ---------------------------------------------------------------- 数字 */

/** JSON 的数字只有这一种写法。y 是粘性匹配，从当前位置往后吃 */
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LEADING_ZERO = /-?0\d/y;
const DOT_FIRST = /-?\./y;

/* ---------------------------------------------------------------- 解析 */

class ParseError extends Error {
  index: number;

  constructor(index: number, message: string) {
    super(message);
    this.name = "ParseError";
    this.index = index;
  }
}

interface Duplicate {
  key: string;
  /** 第一次出现的位置 */
  first: number;
  /** 重复出现的位置 */
  again: number;
}

interface ParsedDoc {
  root: JsonNode;
  duplicates: Duplicate[];
  depth: number;
}

/**
 * 严格 JSON 解析。
 *
 * 递归下降，每个函数只管自己那一段。所有报错都带「从哪开始」——
 * 对象 / 数组没闭合时报开括号的位置，比报文件末尾更好找。
 */
function parseDocument(text: string): ParsedDoc {
  const len = text.length;
  let i = 0;
  let maxDepth = 0;
  const duplicates: Duplicate[] = [];

  const peek = (): string | undefined => (i < len ? text[i] : undefined);

  function fail(at: number, message: string): never {
    throw new ParseError(Math.min(at, len), message);
  }

  /** 粘性匹配：只看当前位置，不吃掉别的 */
  function sticky(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = i;
    return pattern.exec(text);
  }

  /** JSON 的空白只有这四个字符；文件头的 BOM 额外放行一次 */
  function skipSpace(): void {
    if (i === 0 && text.charCodeAt(0) === 0xfeff) i = 1;
    while (i < len) {
      const ch = text[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i += 1;
        continue;
      }
      break;
    }
  }

  function parseValue(level: number): JsonNode {
    skipSpace();
    const ch = peek();
    if (ch === undefined) fail(i, "内容到这里就断了：还有括号或引号没有合上");
    if (ch === "{") return parseObject(level);
    if (ch === "[") return parseArray(level);
    if (ch === '"') return { type: "string", value: parseString() };
    if (ch === "t") {
      expectWord("true");
      return { type: "boolean", value: true };
    }
    if (ch === "f") {
      expectWord("false");
      return { type: "boolean", value: false };
    }
    if (ch === "n") {
      expectWord("null");
      return { type: "null" };
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    return fail(i, unexpected(ch));
  }

  function expectWord(word: string): void {
    if (!text.startsWith(word, i)) fail(i, `这里应该写 ${word}`);
    i += word.length;
  }

  function unexpected(ch: string): string {
    if (ch === "'") return "JSON 的字符串只能用双引号";
    if (ch === ",") return "这里多了一个逗号";
    if (ch === "}") return "这里应该是一个值，却先遇到了 }";
    if (ch === "]") return "这里应该是一个值，却先遇到了 ]";
    if (ch === "+") return "数字前面不能写 +";
    if (ch === ".") return "小数点前面要有数字（写 0.5，不要写 .5）";
    if (ch === "/") return "JSON 不支持注释";
    if (/[A-Za-z_]/.test(ch)) return "这里应该是一个值；不认识的单词先看看是不是少了双引号";
    if (ch.trim() === "") return "这里有一个看不见的字符";
    return `这里出现了意外的字符 "${ch}"`;
  }

  function parseNumber(): JsonNode {
    const start = i;
    if (sticky(LEADING_ZERO) !== null) fail(start, "数字不能有前导零（写 0.5，不要写 00.5）");
    if (text[start] === "+") fail(start, "数字前面不能写 +，正数直接写数字");
    if (sticky(DOT_FIRST) !== null) fail(start, "小数点前面要有数字（写 0.5，不要写 .5）");

    NUMBER.lastIndex = start;
    const match = NUMBER.exec(text);
    if (match === null) fail(start, "这里应该是一个数字");
    const raw = match[0];
    i = start + raw.length;

    const next = peek();
    if (next !== undefined && /[0-9A-Za-z_.+\-]/.test(next)) {
      if (next === ".") fail(i, "小数点后面要有数字");
      if (next === "e" || next === "E") fail(i, "指数的 e 后面要跟数字（写 1e3）");
      if (/[0-9]/.test(next)) fail(i, "数字中间不能夹着别的字符");
      fail(i, `数字后面不能直接跟着 "${next}"`);
    }
    return { type: "number", raw };
  }

  function parseString(): string {
    const start = i;
    i += 1;
    let out = "";
    while (i < len) {
      const ch = text[i];
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === "\\") {
        out += parseEscape();
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        fail(i, ch === "\n" ? "字符串里不能直接换行，要写成 \\n" : "字符串里有控制字符，要写成 \\u00XX");
      }
      out += ch;
      i += 1;
    }
    fail(start, "字符串没有闭合：少了一个结尾的双引号");
  }

  const ESCAPES: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };

  function parseEscape(): string {
    const at = i;
    i += 1;
    const ch = peek();
    if (ch === undefined) fail(at, "反斜杠后面没有东西了");
    const simple = ESCAPES[ch];
    if (simple !== undefined) {
      i += 1;
      return simple;
    }
    if (ch === "u") {
      const hex = text.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(at, "\\u 后面要跟 4 位十六进制，比如 \\u4e2d");
      i += 5;
      return String.fromCharCode(parseInt(hex, 16));
    }
    fail(at, `不认识的转义 \\${ch}`);
  }

  function parseObject(level: number): JsonNode {
    const start = i;
    const nested = level + 1;
    if (nested > MAX_DEPTH) fail(i, `嵌套太深了（超过 ${MAX_DEPTH} 层）`);
    if (nested > maxDepth) maxDepth = nested;

    i += 1;
    const entries: JsonEntry[] = [];
    const firstSeen = new Map<string, number>();

    skipSpace();
    if (peek() === "}") {
      i += 1;
      return { type: "object", entries };
    }

    for (;;) {
      skipSpace();
      const ch = peek();
      if (ch === undefined) fail(start, "对象没有闭合：少了 }");
      if (ch !== '"') {
        fail(i, ch === "}" ? "这里多了一个逗号：最后一项后面不用写 ," : "对象的键必须用双引号包起来");
      }

      const keyAt = i;
      const key = parseString();
      const first = firstSeen.get(key);
      if (first === undefined) firstSeen.set(key, keyAt);
      else duplicates.push({ key, first, again: keyAt });

      skipSpace();
      if (peek() !== ":") fail(i, "键名后面少了冒号");
      i += 1;

      const value = parseValue(nested);
      entries.push({ key, value });

      skipSpace();
      const next = peek();
      if (next === ",") {
        const commaAt = i;
        i += 1;
        skipSpace();
        // 报在逗号上而不是后面的 }：用户要找的是那个多余的逗号
        if (peek() === "}") fail(commaAt, "这里多了一个逗号：最后一项后面不用写 ,");
        continue;
      }
      if (next === "}") {
        i += 1;
        return { type: "object", entries };
      }
      if (next === undefined) fail(start, "对象没有闭合：少了 }");
      if (next === "]") fail(i, "括号对不上：这里是 { 开的对象，应该用 } 收尾");
      if (next === "/") fail(i, "JSON 不支持注释（// 和 /* */ 都不行）");
      fail(i, "键值对之间少了逗号，或者这里应该写 }");
    }
  }

  function parseArray(level: number): JsonNode {
    const start = i;
    const nested = level + 1;
    if (nested > MAX_DEPTH) fail(i, `嵌套太深了（超过 ${MAX_DEPTH} 层）`);
    if (nested > maxDepth) maxDepth = nested;

    i += 1;
    const items: JsonNode[] = [];

    skipSpace();
    if (peek() === "]") {
      i += 1;
      return { type: "array", items };
    }

    for (;;) {
      items.push(parseValue(nested));
      skipSpace();
      const next = peek();
      if (next === ",") {
        const commaAt = i;
        i += 1;
        skipSpace();
        if (peek() === "]") fail(commaAt, "这里多了一个逗号：最后一项后面不用写 ,");
        continue;
      }
      if (next === "]") {
        i += 1;
        return { type: "array", items };
      }
      if (next === undefined) fail(start, "数组没有闭合：少了 ]");
      if (next === "}") fail(i, "括号对不上：这里是 [ 开的数组，应该用 ] 收尾");
      if (next === "/") fail(i, "JSON 不支持注释（// 和 /* */ 都不行）");
      fail(i, "数组元素之间少了逗号，或者这里应该写 ]");
    }
  }

  skipSpace();
  if (i >= len) fail(0, "还没有内容：先粘贴一段 JSON");
  const root = parseValue(0);
  skipSpace();
  if (i < len) {
    if (text[i] === "/") fail(i, "JSON 不支持注释（// 和 /* */ 都不行）");
    fail(i, "JSON 已经结束了，后面的内容解析不了");
  }

  return { root, duplicates, depth: maxDepth };
}

/* ---------------------------------------------------------------- 报错定位 */

/** 字符下标 → 行列号（都从 1 开始） */
export function locate(text: string, index: number): { line: number; column: number } {
  const at = Math.max(0, Math.min(index, text.length));
  const before = text.slice(0, at);
  const line = before.split(/\r\n|\r|\n/).length;
  const lastBreak = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
  return { line, column: at - lastBreak };
}

/** 出错那一行的原文 + 脱字符位置；长行按出错处左右各截一段 */
function lineSnippet(text: string, index: number): { snippet: string; caret: number } {
  const at = Math.max(0, Math.min(index, text.length));
  const back = Math.max(0, at - 1);
  const start = Math.max(text.lastIndexOf("\n", back), text.lastIndexOf("\r", back)) + 1;

  let end = text.length;
  const lf = text.indexOf("\n", at);
  const cr = text.indexOf("\r", at);
  if (lf !== -1) end = lf;
  if (cr !== -1 && cr < end) end = cr;

  let line = text.slice(start, end).replace(/\t/g, "  ");
  let caret = text.slice(start, at).replace(/\t/g, "  ").length;

  // BOM 是零宽的，留在原文里只会让 ^ 偏一格
  if (line.startsWith("\ufeff")) {
    line = line.slice(1);
    caret = Math.max(0, caret - 1);
  }

  const LIMIT = 76;
  if (line.length <= LIMIT) return { snippet: line, caret };

  const from = Math.max(0, Math.min(caret - 34, line.length - LIMIT));
  const head = from > 0 ? "…" : "";
  const tail = from + LIMIT < line.length ? "…" : "";
  return {
    snippet: head + line.slice(from, from + LIMIT) + tail,
    caret: caret - from + head.length,
  };
}

function makeError(text: string, index: number, message: string): JsonError {
  const { line, column } = locate(text, index);
  const { snippet, caret } = lineSnippet(text, index);
  return { message, index: Math.max(0, Math.min(index, text.length)), line, column, snippet, caret };
}

/* ---------------------------------------------------------------- 排版 */

/** 叶子的展示文本：字符串重新转义、数字用原文、空容器写成一对括号 */
export function leafText(node: JsonNode): string {
  switch (node.type) {
    case "string":
      return JSON.stringify(node.value);
    case "number":
      return node.raw;
    case "boolean":
      return node.value ? "true" : "false";
    case "null":
      return "null";
    case "object":
      return "{}";
    case "array":
      return "[]";
  }
}

/** 按缩进排版。和折叠树共用 `leafText`，两边不会出现「树里是一个样、复制出来另一个样」 */
export function formatJson(root: JsonNode, indent: JsonIndent): string {
  return write(root, indentUnit(indent), 0);
}

function write(node: JsonNode, unit: string, level: number): string {
  if (node.type === "object" && node.entries.length > 0) {
    const inner = node.entries
      .map((entry) => unit.repeat(level + 1) + JSON.stringify(entry.key) + ": " + write(entry.value, unit, level + 1))
      .join(",\n");
    return "{\n" + inner + "\n" + unit.repeat(level) + "}";
  }
  if (node.type === "array" && node.items.length > 0) {
    const inner = node.items
      .map((item) => unit.repeat(level + 1) + write(item, unit, level + 1))
      .join(",\n");
    return "[\n" + inner + "\n" + unit.repeat(level) + "]";
  }
  return leafText(node);
}

/** 压缩：去掉所有可有可无的空白，数字同样保留原文 */
export function minifyJson(root: JsonNode): string {
  if (root.type === "object") {
    return "{" + root.entries.map((entry) => JSON.stringify(entry.key) + ":" + minifyJson(entry.value)).join(",") + "}";
  }
  if (root.type === "array") return "[" + root.items.map(minifyJson).join(",") + "]";
  return leafText(root);
}

/**
 * 把值摊平成一行行，给折叠树用。
 *
 * `path` 是折叠状态的键：只按下标存的话，改一下输入就会折叠到别人身上。
 * 用「键名 + 下标」拼路径，重新解析也能对得上。
 */
export function buildLines(root: JsonNode): JsonLine[] {
  const lines: JsonLine[] = [];

  function push(node: JsonNode, depth: number, path: string, key: string | undefined, comma: boolean): void {
    if (node.type === "object" && node.entries.length > 0) {
      const open: JsonLine = {
        depth,
        path,
        kind: "open",
        type: "object",
        key,
        text: "{",
        comma,
        size: node.entries.length,
      };
      lines.push(open);
      node.entries.forEach((entry, index) => {
        push(
          entry.value,
          depth + 1,
          `${path}[${JSON.stringify(entry.key)}]`,
          entry.key,
          index < node.entries.length - 1,
        );
      });
      open.close = lines.length;
      lines.push({ depth, path, kind: "close", type: "object", text: "}", comma });
      return;
    }

    if (node.type === "array" && node.items.length > 0) {
      const open: JsonLine = {
        depth,
        path,
        kind: "open",
        type: "array",
        key,
        text: "[",
        comma,
        size: node.items.length,
      };
      lines.push(open);
      node.items.forEach((item, index) => {
        push(item, depth + 1, `${path}[${index}]`, undefined, index < node.items.length - 1);
      });
      open.close = lines.length;
      lines.push({ depth, path, kind: "close", type: "array", text: "]", comma });
      return;
    }

    // 空对象 / 空数组当成叶子：没有内容可折，多一个三角只是噪音
    lines.push({ depth, path, kind: "leaf", type: node.type, key, text: leafText(node), comma });
  }

  push(root, 0, "$", undefined, false);
  return lines;
}

/* ---------------------------------------------------------------- 统计 */

function countKeys(node: JsonNode): number {
  if (node.type === "object") {
    return node.entries.reduce((sum, entry) => sum + 1 + countKeys(entry.value), 0);
  }
  if (node.type === "array") return node.items.reduce((sum, item) => sum + countKeys(item), 0);
  return 0;
}

/** 1543 → `1.5 KB`。只给状态行看，别太较真 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function duplicateWarnings(text: string, duplicates: Duplicate[]): string[] {
  if (duplicates.length === 0) return [];
  const out = duplicates.slice(0, 3).map((dup) => {
    const first = locate(text, dup.first).line;
    const again = locate(text, dup.again).line;
    return `键 ${JSON.stringify(dup.key)} 重复了（第 ${first} 行和第 ${again} 行），两条都留着，真正读的时候只有一条生效`;
  });
  const rest = duplicates.length - 3;
  if (rest > 0) out.push(`还有 ${rest} 处重复的键`);
  return out;
}

/* ---------------------------------------------------------------- 入口 */

export function parseJson(text: string): JsonParseResult {
  if (text.length > MAX_CHARS) {
    return {
      ok: false,
      error: makeError(text, 0, "内容太大了（超过 2 MB）：拆小一点，或者在编辑器里先处理"),
    };
  }

  try {
    const { root, duplicates, depth } = parseDocument(text);
    return {
      ok: true,
      doc: {
        root,
        minified: minifyJson(root),
        stats: {
          keys: countKeys(root),
          depth,
          bytes: new TextEncoder().encode(text).length,
        },
        warnings: duplicateWarnings(text, duplicates),
      },
    };
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    return { ok: false, error: makeError(text, err.index, err.message) };
  }
}
