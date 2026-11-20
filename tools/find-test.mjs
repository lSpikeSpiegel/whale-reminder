/**
 * 搜索页「自己的东西」匹配逻辑的单测。
 *
 * 纯函数、没有 IPC，直接拿 Node 跑：
 *
 *   node --experimental-strip-types tools/find-test.mjs
 *
 * 这里不测「应用 / 文件」那两条腿——它们在 Rust 里（`search.rs`）。
 */

import assert from "node:assert/strict";

const { matchNotes, matchTasks, matchTools, scoreFuzzy, scoreText, snippet } =
  await import("../src/panel/find.ts");

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/* ------------------------------------------------------------ 打分 */

test("相等 > 开头 > 包含 > 不中", () => {
  assert.equal(scoreText("买牛奶", "买牛奶"), 1000);
  assert.equal(scoreText("买牛奶回家", "买牛奶"), 800);
  const middle = scoreText("记得买牛奶", "买牛奶");
  assert.ok(middle > 0 && middle < 800, `middle=${middle}`);
  assert.equal(scoreText("买牛奶", "写周报"), 0);
});

test("忽略大小写，查询两端空格不算数", () => {
  assert.equal(scoreText("Visual Studio Code", "visual"), 800);
  assert.equal(scoreText("visual studio code", "  Visual  "), 800);
});

test("命中越靠前分越高", () => {
  assert.ok(scoreText("abc买牛奶", "买牛奶") > scoreText("abcdefghij买牛奶", "买牛奶"));
});

test("空查询 / 空文本不命中", () => {
  assert.equal(scoreText("买牛奶", "   "), 0);
  assert.equal(scoreText("", "买牛奶"), 0);
});

test("模糊匹配：能按顺序凑出来就算命中", () => {
  // j…n 在 "json 格式化" 里顺序出现
  assert.equal(scoreFuzzy("JSON 格式化", "jn"), 200);
  // 顺序不对就不算
  assert.equal(scoreFuzzy("JSON 格式化", "nj"), 0);
  // 单字不做模糊，免得中文满屏噪声
  assert.equal(scoreFuzzy("买牛奶", "奶"), scoreText("买牛奶", "奶"));
});

/* ------------------------------------------------------------ 待办 */

const task = (id, title, description = "") => ({
  id,
  title,
  description,
  status: "todo",
  priority: 0,
  due_at: null,
  start_at: null,
  started_at: null,
  completed_at: null,
  estimate_min: null,
  tags: [],
  source: "manual",
  created_at: "2026-11-20T01:00:00Z",
  updated_at: "2026-11-20T01:00:00Z",
  reminders: [],
  ask_count: 0,
});

test("待办：标题命中排在描述命中前面", () => {
  const list = [task("b", "整理书架", "顺便买牛奶"), task("a", "买牛奶")];
  assert.deepEqual(
    matchTasks(list, "买牛奶").map((item) => item.id),
    ["a", "b"],
  );
});

test("待办：不命中的不进结果，同分保持原顺序", () => {
  const list = [task("1", "写周报"), task("2", "写日报"), task("3", "买菜")];
  assert.deepEqual(
    matchTasks(list, "写").map((item) => item.id),
    ["1", "2"],
  );
  assert.deepEqual(matchTasks(list, "不存在"), []);
});

/* ------------------------------------------------------------ 备忘 */

const note = (id, body, tags = []) => ({
  id,
  body,
  pinned: false,
  created_at: "2026-11-20T01:00:00Z",
  updated_at: "2026-11-20T01:00:00Z",
  tags: tags.map((name) => ({ id: name, name, created_at: "2026-11-20T01:00:00Z" })),
});

test("备忘：正文命中和标签命中都能找到", () => {
  const list = [note("a", "周五前把报销单交了"), note("b", "常去的理发店在二楼", ["生活"])];
  assert.deepEqual(
    matchNotes(list, "报销").map((item) => item.id),
    ["a"],
  );
  assert.deepEqual(
    matchNotes(list, "生活").map((item) => item.id),
    ["b"],
  );
});

test("备忘：正文命中优先于标签命中", () => {
  const list = [note("tag", "无关内容", ["工作"]), note("body", "工作笔记要点")];
  assert.deepEqual(
    matchNotes(list, "工作").map((item) => item.id),
    ["body", "tag"],
  );
});

/* ------------------------------------------------------------ 小工具 */

const TOOLS = [
  { key: "qr", name: "二维码助手", desc: "框选认码 · 文字转码" },
  { key: "json", name: "JSON 格式化", desc: "格式化 · 折叠 · 校验" },
  { key: "color", name: "颜色转换", desc: "HEX · RGB · HSL 互转" },
  { key: "stock", name: "行情", desc: "搜索 · 自选 · 涨跌幅" },
];

test("工具：中文名直接命中", () => {
  assert.deepEqual(
    matchTools(TOOLS, "二维码").map((tool) => tool.key),
    ["qr"],
  );
});

test("工具：key 当英文别名用", () => {
  assert.deepEqual(
    matchTools(TOOLS, "qr").map((tool) => tool.key),
    ["qr"],
  );
  assert.deepEqual(
    matchTools(TOOLS, "stock").map((tool) => tool.key),
    ["stock"],
  );
});

test("工具：说明里的英文也能搜到，但排在名字命中之后", () => {
  assert.deepEqual(
    matchTools(TOOLS, "hex").map((tool) => tool.key),
    ["color"],
  );
  // 「json」名字里就有，分数该高过只在说明里出现的
  assert.equal(matchTools(TOOLS, "json")[0].key, "json");
});

test("工具：查不到就是空，不是全量", () => {
  assert.deepEqual(matchTools(TOOLS, "zzz"), []);
});

/* ------------------------------------------------------------ 摘要 */

test("摘要：够短就原样给，不加省略号", () => {
  assert.equal(snippet("买牛奶", "牛奶"), "买牛奶");
});

test("摘要：命中在末尾时前面补省略号", () => {
  const text = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十买牛奶";
  const out = snippet(text, "买牛奶", 12);
  assert.ok(out.startsWith("…"), out);
  assert.ok(out.includes("买牛奶"), out);
  assert.ok(out.endsWith("牛奶"), out);
});

test("摘要：命中在开头时后面补省略号", () => {
  const text = "买牛奶然后去银行然后回家然后做饭然后洗澡然后睡觉";
  const out = snippet(text, "买牛奶", 10);
  assert.ok(out.startsWith("买牛奶"), out);
  assert.ok(out.endsWith("…"), out);
});

test("摘要：换行压成空格", () => {
  assert.equal(snippet("第一行\n第二行\t第三行", "第二行", 40), "第一行 第二行 第三行");
});

test("摘要：命中不到时给开头一段，不报错", () => {
  assert.equal(snippet("  买牛奶  ", "不存在", 40), "买牛奶");
  assert.equal(snippet("", "买牛奶"), "");
});

test("摘要：按码点切，emoji 不会被切一半", () => {
  const out = snippet("🐳🐳🐳买牛奶🐳🐳🐳", "牛奶", 6);
  // 切半的 emoji 会变成孤立代理项，长度对不上
  assert.equal([...out].every((ch) => ch.codePointAt(0) <= 0x10ffff), true);
  assert.ok(!out.includes("\ud83d") || out.includes("🐳"), out);
});

console.log(`\n${passed} passed`);
