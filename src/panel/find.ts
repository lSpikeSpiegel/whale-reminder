/**
 * 搜索页里「自己的东西」怎么匹配：小工具、待办、备忘。
 *
 * 应用和文件那两条腿在 Rust（Everything / 本地索引），因为要扫磁盘；
 * 这三类数据本来就在前端手里——工具是常量表，待办跟着面板走，备忘进这一页时读一次——
 * 所以匹配放在这里，不用等 IPC：敲第一个字就出来，也不会和文件搜索抢那几百毫秒。
 *
 * 全是纯函数，没有 DOM / IPC 依赖，`tools/find-test.mjs` 直接跑。
 */

import type { Note, Task } from "./types";

/** 小工具在搜索里的样子。`Tools.tsx` 的 `TOOLS` 结构比这个宽，取需要的几个字段即可 */
export interface ToolMeta {
  key: string;
  name: string;
  desc: string;
}

/**
 * 打分。分数只用来排同组内的先后，不是绝对值。
 *
 * 只认「相等 / 开头 / 包含」三档，**不做子序列**：「vsc → Visual Studio Code」
 * 那套是给应用名用的，套到中文备忘正文上，几乎每句话都能凑出一个子序列，
 * 结果是一搜一大片、还都不相关。子序列只在小工具名字上用（见 `scoreFuzzy`）。
 */
export function scoreText(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (needle === "" || haystack === "") return 0;
  if (haystack === needle) return 1000;

  const at = haystack.indexOf(needle);
  if (at === 0) return 800;
  // 命中越靠前越相关。`at` 封顶 60：再往后扣成负数也没意义，都是「有但很勉强」
  if (at > 0) return 700 - Math.min(at, 60);
  return 0;
}

/**
 * 名字类字段的匹配：先按 `scoreText`，不中再看能不能按顺序凑出来。
 *
 * 只管 `text`——用来匹配「JSON 格式化」这种短名字，`js` / `json` 都能命中。
 */
export function scoreFuzzy(text: string, query: string): number {
  const direct = scoreText(text, query);
  if (direct > 0) return direct;

  const needle = query.trim().toLowerCase();
  // 一个字不做模糊：中文单字凑出来的命中全是噪声
  if (needle.length < 2) return 0;

  let cursor = 0;
  for (const ch of text.toLowerCase()) {
    if (ch === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 200;
  }
  return 0;
}

/** 按分数从高到低排；同分保持传进来的顺序（工具清单的自定义顺序、待办的截止顺序） */
function rank<T>(items: T[], score: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, value: score(item) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((row) => row.item);
}

/**
 * 小工具。
 *
 * 三个入口都试：名字（支持子序列）、一句话说明、还有 `key`——`key` 是英文短名，
 * 「qr」找二维码助手、「stock」找行情，比逼用户打中文顺手。
 */
export function matchTools<T extends ToolMeta>(tools: T[], query: string): T[] {
  return rank(tools, (tool) =>
    Math.max(
      scoreFuzzy(tool.name, query),
      // 说明和 key 只是辅助：命中它们说明「可能是这个」，不该压过名字直接命中。
      // 权重按「名字前缀 800 / key 完全相等 700 / 说明开头 480」排，正好差一档
      Math.round(scoreText(tool.desc, query) * 0.6),
      Math.round(scoreText(tool.key, query) * 0.7),
    ),
  );
}

/** 待办：标题为主，描述次之 */
export function matchTasks(tasks: Task[], query: string): Task[] {
  return rank(tasks, (task) =>
    Math.max(
      scoreText(task.title, query),
      Math.round(scoreText(task.description, query) * 0.8),
    ),
  );
}

/**
 * 备忘：正文为主，标签次之。
 *
 * 标签压到 0.7：正文开头命中（800）排在「标签完全相等」前面——搜「工作」时，
 * 用户想看的大半是正文提到工作的那条，而不是恰好挂了个 #工作 标签的。
 */
export function matchNotes(notes: Note[], query: string): Note[] {
  return rank(notes, (note) => {
    const body = scoreText(note.body, query);
    const tags = note.tags.reduce(
      (best, tag) => Math.max(best, Math.round(scoreText(tag.name, query) * 0.7)),
      0,
    );
    return Math.max(body, tags);
  });
}

/**
 * 从备忘正文里截一句「为什么命中」的片段。
 *
 * 一律按码点切（`Array.from`），否则 emoji 会被切成半个字符，界面上是个方框。
 * 命中位置前后各留一点上下文，比只显示开头更能说明这条为什么会出现。
 */
export function snippet(body: string, query: string, width = 30): string {
  // 换行压成空格：结果行只有一行，留着一堆 \n 也只是被 CSS 当成空白
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat === "") return "";

  const chars = Array.from(flat);
  const needle = Array.from(query.trim().toLowerCase());
  const haystack = Array.from(flat.toLowerCase());

  let at = -1;
  if (needle.length > 0) {
    // 朴素滑窗：正文最多几千字，没必要上 KMP
    search: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (haystack[i + j] !== needle[j]) continue search;
      }
      at = i;
      break;
    }
  }

  // 命中点放在偏左三分之一处：前面留一点上下文，后面能多露几个字
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(width / 3));
  const text = chars.slice(start, start + width).join("");
  const head = start > 0 ? "…" : "";
  const tail = start + width < chars.length ? "…" : "";
  return `${head}${text}${tail}`;
}
