/**
 * 行情展示换算的单测。
 *
 * 这个模块是纯函数（取数在 Rust），所以直接拿 Node 跑，不用起窗口：
 *
 *   node --experimental-strip-types tools/stock-test.mjs
 *
 * 重点盯三件事：停牌（价格是 null）、平盘（涨跌幅 0）、负零（-0.004 不该显示成「-0.00」）。
 */

import assert from "node:assert/strict";

const { INDEXES, direction, formatChange, formatPercent, formatPrice, inWatch, mergeQuotes, signed, stamp } =
  await import("../src/panel/stock.ts");

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/** 造一条报价：默认是涨的，测试里只改关心的那几个字段 */
const quote = (over = {}) => ({
  secid: "1.600519",
  code: "600519",
  name: "贵州茅台",
  price: 1452.43,
  change: 7.78,
  percent: 1.23,
  prev_close: 1444.65,
  digits: 2,
  ...over,
});

/* ------------------------------------------------------------ 方向 */

test("涨是红、跌是绿、零是平", () => {
  assert.equal(direction(1.23), "up");
  assert.equal(direction(-0.53), "down");
  assert.equal(direction(0), "flat");
});

test("没有涨跌幅就是平盘，别硬上色", () => {
  // 停牌 / 未开盘 / 退市都没有方向，涂成红色等于报了假信号
  assert.equal(direction(null), "flat");
  assert.equal(direction(undefined), "flat");
});

test("负零算平盘", () => {
  assert.equal(direction(-0), "flat");
});

/* ------------------------------------------------------------ 数字格式 */

test("涨跌幅带符号，平盘写 0.00%", () => {
  assert.equal(formatPercent(1.23), "+1.23%");
  assert.equal(formatPercent(-0.53), "-0.53%");
  assert.equal(formatPercent(0), "0.00%");
  assert.equal(formatPercent(null), "—");
});

test("舍入到 0 的负数不写成 -0.00%", () => {
  // 跌 0.004% 会被显示成「-0.00%」，比不写还让人犯嘀咕
  assert.equal(signed(-0.004), "0.00");
  assert.equal(formatPercent(-0.004), "0.00%");
});

test("小数位跟着接口的 digits 走", () => {
  assert.equal(signed(7.78, 2), "+7.78");
  assert.equal(signed(1.2345, 3), "+1.234");
  assert.equal(signed(-1.2345, 3), "-1.234");
});

test("现价按 digits 补齐", () => {
  assert.equal(formatPrice(quote()), "1452.43");
  assert.equal(formatPrice(quote({ price: 1.5, digits: 3 })), "1.500");
});

test("停牌的现价是「—」而不是 0", () => {
  assert.equal(formatPrice(quote({ price: null })), "—");
  assert.equal(formatPrice(null), "—");
  assert.equal(formatChange(quote({ change: null })), "—");
  assert.equal(formatChange(null), "—");
});

test("涨跌额带符号、按现价的位数", () => {
  assert.equal(formatChange(quote()), "+7.78");
  assert.equal(formatChange(quote({ change: -7.78 })), "-7.78");
  assert.equal(formatChange(quote({ change: 0 })), "0.00");
});

/* ------------------------------------------------------------ 自选和报价对齐 */

const watch = [
  { secid: "1.600519", code: "600519", name: "贵州茅台", market: "沪A" },
  { secid: "0.000001", code: "000001", name: "平安银行", market: "深A" },
  { secid: "116.00700", code: "00700", name: "腾讯控股", market: "港股" },
];

test("按自选顺序出行，报价乱序回来也不串行", () => {
  const rows = mergeQuotes(watch, [
    quote({ secid: "116.00700", code: "00700", name: "腾讯控股", price: 380.2, percent: -1.1 }),
    quote({ secid: "1.600519" }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.item.secid),
    ["1.600519", "0.000001", "116.00700"],
  );
  assert.equal(rows[0].quote.price, 1452.43);
  assert.equal(rows[2].quote.percent, -1.1);
});

test("这一轮没问到的标的是 null，不拿上一轮的数字顶上", () => {
  const rows = mergeQuotes(watch, [quote({ secid: "1.600519" })]);
  assert.equal(rows[1].quote, null);
  assert.equal(formatPrice(rows[1].quote), "—");
  assert.equal(formatPercent(rows[1].quote?.percent), "—");
});

test("自选里没有的报价直接丢掉（接口多回也不渲染）", () => {
  const rows = mergeQuotes([watch[0]], [quote(), quote({ secid: "0.000001" })]);
  assert.equal(rows.length, 1);
});

test("自选为空时不报错", () => {
  assert.deepEqual(mergeQuotes([], [quote()]), []);
  assert.deepEqual(mergeQuotes(watch, []).length, 3);
});

test("是否已在自选按 secid 判", () => {
  assert.equal(inWatch(watch, "0.000001"), true);
  assert.equal(inWatch(watch, "1.000001"), false);
  assert.equal(inWatch([], "1.600519"), false);
});

/* ------------------------------------------------------------ 其它 */

test("指数是三个，secid 不能重复", () => {
  assert.equal(INDEXES.length, 3);
  assert.equal(new Set(INDEXES.map((item) => item.secid)).size, 3);
});

test("更新时间到分钟、补零", () => {
  assert.equal(stamp(new Date(2026, 10, 20, 9, 5)), "09:05");
  assert.equal(stamp(new Date(2026, 10, 20, 15, 0)), "15:00");
});

console.log(`\n${passed} passed`);
