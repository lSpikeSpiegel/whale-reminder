/**
 * 编解码：Base64 / URL / HTML 实体 / 时间戳 / Unicode 转义。
 *
 * 和 `color.ts` 一样全是纯函数、不碰 DOM——转换要跟着按键实时跑，走 IPC 没必要，
 * 而且能直接拿 Node 跑单测（`tools/codec-test.mjs`）。
 *
 * 约定：
 * - 文本格式一律按 UTF-8 处理，中文和 emoji 不该被截成乱码；
 * - 解不开就返回 `{ ok: false, error }` 说明原因，**不要猜**——猜错了用户更难发现；
 * - 时间戳的「编码」是日期 → 戳，「解码」是戳 → 日期，方向对用户来说就是这两个词。
 */

export type CodecKey = "base64" | "url" | "html" | "time" | "unicode";

/** 编码 / 解码。时间戳那两个方向叫「日期 → 戳」「戳 → 日期」，见 FORMATS */
export type CodecMode = "encode" | "decode";

/** 附加读数的一行（时间戳的秒 / 毫秒 / UTC） */
export interface CodecRow {
  key: string;
  value: string;
}

export type CodecResult =
  | { ok: true; text: string; rows: CodecRow[] }
  | { ok: false; error: string };

const ok = (text: string, rows: CodecRow[] = []): CodecResult => ({ ok: true, text, rows });
const fail = (error: string): CodecResult => ({ ok: false, error });

/* ---------------------------------------------------------------- Base64 */

/** `data:image/png;base64,` 这类前缀：从网页或 CSS 里粘过来常常带着 */
const DATA_URL = /^data:[\w.+-]+\/[\w.+-]+;base64,/i;

function bytesToBase64(bytes: Uint8Array): string {
  // 不用 `String.fromCharCode(...bytes)`：长文本会撑爆调用栈，逐字节拼更稳
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function encodeBase64(text: string): CodecResult {
  return ok(bytesToBase64(new TextEncoder().encode(text)));
}

export function decodeBase64(raw: string): CodecResult {
  // 从别处粘来的 Base64 常带换行、URL 安全字符（-_）、省略的 =，一并容忍
  const body = raw
    .replace(DATA_URL, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");

  if (body === "") return fail("没有可解的内容");
  if (!/^[A-Za-z0-9+/]+$/.test(body)) {
    return fail("不是合法的 Base64：只允许 A–Z a–z 0–9 + / =");
  }

  const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return fail("不是合法的 Base64：长度对不上（缺字符或多了字符）");
  }

  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  try {
    // fatal 才会在非法 UTF-8 上抛错——默认会悄悄塞一堆 �，看着像解成功了
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("解出来不是 UTF-8 文本，可能是图片或压缩包");
  }
}

/* ---------------------------------------------------------------- URL */

export function encodeUrl(text: string): CodecResult {
  try {
    return ok(encodeURIComponent(text));
  } catch {
    return fail("有落单的代理字符（半个 emoji），没法编码");
  }
}

export function decodeUrl(text: string): CodecResult {
  try {
    // 不把 `+` 当空格：encodeURIComponent 从不产出 `+`，把它读成空格反而会改坏路径
    return ok(decodeURIComponent(text));
  } catch {
    return fail("有残缺的 % 转义（比如 %ZZ，或者结尾只剩半个 %A），补全再试");
  }
}

/* ---------------------------------------------------------------- HTML 实体 */

/** 编码只转这五个：它们在文本里出现就会改变结构，别的字符没有转义的道理 */
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function encodeHtml(text: string): CodecResult {
  return ok(text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]));
}

/**
 * 命名实体只收常用的这批——完整表有一千多条，工具里用不上，
 * 认不出的原样留着（浏览器也是这么处理的），不会把文本改坏。
 */
const HTML_NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  times: "×",
  divide: "÷",
  plusmn: "±",
  minus: "−",
  deg: "°",
  micro: "µ",
  para: "¶",
  sect: "§",
  middot: "·",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  permil: "‰",
  prime: "′",
  Prime: "″",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  curren: "¤",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  ne: "≠",
  le: "≤",
  ge: "≥",
  infin: "∞",
  radic: "√",
  sum: "∑",
  check: "✓",
  hearts: "♥",
  spades: "♠",
  clubs: "♣",
  diams: "♦",
};

export function decodeHtml(text: string): CodecResult {
  const out = text.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        // 超出 Unicode 范围的码点留着原样，别让 fromCodePoint 抛异常
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        return String.fromCodePoint(code);
      }
      return HTML_NAMED[body] ?? whole;
    },
  );
  return ok(out);
}

/* ---------------------------------------------------------------- Unicode 转义 */

/** 换行、制表符写成 `\n` `\t` 更好认，别的控制字符还是走 `\uXXXX` */
const UNICODE_SHORT: Record<string, string> = {
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
};

const UNICODE_BACK: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

export function encodeUnicode(text: string): CodecResult {
  let out = "";
  // 按码点遍历：直接按 UTF-16 单元走会把 emoji 拆成两半
  for (const ch of text) {
    if (ch === "\\") {
      out += "\\\\";
      continue;
    }
    const short = UNICODE_SHORT[ch];
    if (short !== undefined) {
      out += short;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    // 可见 ASCII 原样留着，转成 \u0078 反而看不出原文
    if (code >= 0x20 && code < 0x7f) {
      out += ch;
      continue;
    }
    out += code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return ok(out);
}

export function decodeUnicode(text: string): CodecResult {
  const out = text.replace(
    /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g,
    (whole, braced: string | undefined, u4: string | undefined, x2: string | undefined, ch: string | undefined) => {
      if (braced !== undefined) {
        const code = parseInt(braced, 16);
        return code > 0x10ffff ? whole : String.fromCodePoint(code);
      }
      if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
      if (x2 !== undefined) return String.fromCharCode(parseInt(x2, 16));
      // 认不出的转义（比如 Windows 路径里的 `\d`）原样留着，别把 `C:\dir` 吃掉一个字符
      return UNICODE_BACK[ch ?? ""] ?? whole;
    },
  );
  return ok(out);
}

/* ---------------------------------------------------------------- 时间戳 */

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `2026-11-13 11:17:05`，本地时区 */
function formatLocal(date: Date, withMs: boolean): string {
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withMs ? `${base}.${pad(date.getMilliseconds(), 3)}` : base;
}

/** `2026-11-13 03:17:05`，UTC */
function formatUtc(date: Date, withMs: boolean): string {
  const base =
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return withMs ? `${base}.${pad(date.getUTCMilliseconds(), 3)}` : base;
}

/**
 * 认这些写法：
 * `2026-11-13 11:17` / `2026-11-13T11:17:05` / `2026-11-13T11:17:05.123Z` /
 * `2026-11-13T11:17:05+08:00` / `2026/11/13` / `2026年11月13日`。
 * 不带时区的按本地时间算——用户敲的就是自己表上的时间。
 *
 * 自己用正则拆而不是丢给 `new Date(string)`：后者对 `2026-11-13` 按 UTC、
 * 对 `2026-11-13 11:17` 按本地，同一个输入差 8 小时，解释起来很费劲。
 */
function parseDateTime(input: string): Date | null {
  const match =
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,3}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      input.trim(),
    );
  if (match === null) return null;

  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const milli = frac === undefined ? 0 : Number(frac.padEnd(3, "0"));

  // 先把明显越界的挡掉：Date 会把 2 月 31 日悄悄滚到 3 月，不拦就「猜」错了
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const utc = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  const probe = new Date(utc);
  // 月份/日期回读一遍，2 月 31 日这种会被 Date 挪到 3 月，对不上就是非法日期
  if (probe.getUTCDate() !== day || probe.getUTCMonth() !== month - 1) return null;

  if (zone === undefined) {
    const local = new Date(year, month - 1, day, hour, minute, second, milli);
    return Number.isNaN(local.getTime()) ? null : local;
  }

  if (zone.toUpperCase() === "Z") return probe;

  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  return new Date(utc - offset * 60_000);
}

/** 日期 → 时间戳。主结果是秒（十位，接口里最常见），毫秒和 UTC 挂在下面 */
export function toTimestamp(input: string): CodecResult {
  const date = parseDateTime(input);
  if (date === null) {
    return fail("认不出这个时间，写成 2026-11-13 11:17 或 2026-11-13T11:17:05+08:00");
  }
  const ms = date.getTime();
  return ok(String(Math.floor(ms / 1000)), [
    { key: "毫秒", value: String(ms) },
    { key: "UTC", value: formatUtc(date, false) },
  ]);
}

/**
 * 时间戳 → 日期。
 *
 * 单位靠位数猜：≥ 1e11 当毫秒（十一位的「秒」要到公元 5138 年，实际不存在），
 * 其余当秒。小数秒也认，`1762994225.5` 就是带 500 毫秒。
 */
export function fromTimestamp(input: string): CodecResult {
  const text = input.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return fail("时间戳得是一串数字（秒或毫秒）");

  const value = Number(text);
  if (!Number.isFinite(value)) return fail("这个数字太大，算不出时间");

  const ms = Math.abs(value) >= 1e11 ? Math.round(value) : Math.round(value * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return fail("这个数字超出能表示的时间范围");

  const withMs = ms % 1000 !== 0;
  return ok(formatLocal(date, withMs), [
    { key: "秒", value: String(Math.floor(ms / 1000)) },
    { key: "毫秒", value: String(ms) },
    { key: "UTC", value: formatUtc(date, withMs) },
  ]);
}

/* ---------------------------------------------------------------- 格式清单 */

export interface CodecFormat {
  key: CodecKey;
  /** 格式胶囊上的名字 */
  label: string;
  /** 两个方向的名字。默认就是「编码 / 解码」，时间戳换成人话 */
  encode: string;
  decode: string;
  placeholder: string;
  /** 一行提示：这一格式容易踩的坑 */
  hint: string;
}

/**
 * 格式清单。**新增格式只改这里 + 上面的两个纯函数**，
 * 界面会自己长出胶囊和方向按钮（见 `ToolCodec`）。
 */
export const FORMATS: CodecFormat[] = [
  {
    key: "base64",
    label: "Base64",
    encode: "编码",
    decode: "解码",
    placeholder: "要编码的文字，或者一段 Base64…",
    hint: "按 UTF-8 编；解码认 URL 安全的 - _ 和省略的 =",
  },
  {
    key: "url",
    label: "URL",
    encode: "编码",
    decode: "解码",
    placeholder: "要转义的文字，或者 %E4%B8%AD 这样的串…",
    hint: "空格编成 %20；解码不把 + 当空格",
  },
  {
    key: "html",
    label: "HTML 实体",
    encode: "编码",
    decode: "解码",
    placeholder: "要转义的文字，或者 &lt;p&gt; 这样的串…",
    hint: "编码只转 & < > \" '；解码认命名实体和 &#38; / &#x26;",
  },
  {
    key: "time",
    label: "时间戳",
    encode: "日期 → 戳",
    decode: "戳 → 日期",
    placeholder: "2026-11-13 11:17，或者 1762994225…",
    hint: "不带时区的按本地算；纯数字 10 位当秒、13 位当毫秒",
  },
  {
    key: "unicode",
    label: "Unicode",
    encode: "转义",
    decode: "还原",
    placeholder: "要转义的文字，或者 \\u4e2d 这样的串…",
    hint: "非 ASCII 转成 \\uXXXX；解码还认 \\u{...} 和 \\xXX",
  },
];

export const FORMAT_MAP: Record<CodecKey, CodecFormat> = Object.fromEntries(
  FORMATS.map((item) => [item.key, item]),
) as Record<CodecKey, CodecFormat>;

/** 按当前格式和方向转一次。空输入直接给空结果，让界面显示空状态 */
export function runCodec(key: CodecKey, mode: CodecMode, text: string): CodecResult {
  if (text.trim() === "") return ok("");
  switch (key) {
    case "base64":
      return mode === "encode" ? encodeBase64(text) : decodeBase64(text);
    case "url":
      return mode === "encode" ? encodeUrl(text) : decodeUrl(text);
    case "html":
      return mode === "encode" ? encodeHtml(text) : decodeHtml(text);
    case "time":
      return mode === "encode" ? toTimestamp(text) : fromTimestamp(text);
    case "unicode":
      return mode === "encode" ? encodeUnicode(text) : decodeUnicode(text);
  }
}
