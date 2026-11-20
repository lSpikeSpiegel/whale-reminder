/**
 * 图表的纯计算单测（`src/panel/kline.ts`）。
 *
 *   node --experimental-strip-types tools/kline-test.mjs
 *
 * 画布本身没法在这儿验，但「刻度落在哪一格」「均线从第几根开始有值」这类算错就
 * 全是视觉 bug 的地方，全部压在这一层——图上看着「有点怪」时，先看这里是不是绿的。
 */

import assert from "node:assert/strict";

const {
  averagePrice,
  axisTime,
  extent,
  formatAmount,
  formatVolume,
  indexAt,
  movingAverage,
  percentFrom,
  priceTicks,
} = await import("../src/panel/kline.ts");

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/** 造一根 K 线，只关心被断言的那几个字段 */
const bar = (close, over = {}) => ({
  time: "2026-11-20",
  open: close,
  close,
  high: close,
  low: close,
  volume: 100,
  amount: 100 * close * 100,
  ...over,
});

/* ------------------------------------------------------------ 均线 */

test("均线：前 n-1 根是 null，之后是算术平均", () => {
  const bars = [1, 2, 3, 4, 5].map((v) => bar(v));
  assert.deepEqual(movingAverage(bars, 3), [null, null, 2, 3, 4]);
});

test("均线：n=1 就是收盘价本身", () => {
  const bars = [1, 2, 3].map((v) => bar(v));
  assert.deepEqual(movingAverage(bars, 1), [1, 2, 3]);
});

test("均线：根数不够就是全 null，不能用 0 糊", () => {
  const bars = [1, 2].map((v) => bar(v));
  assert.deepEqual(movingAverage(bars, 5), [null, null]);
  assert.deepEqual(movingAverage([], 5), []);
});

/* ------------------------------------------------------------ 分时均价 */

test("均价：成交量是「手」，要按 100 股换算", () => {
  // 100 手 = 10000 股，成交额 145000 元 → 均价 14.5
  const bars = [bar(14, { volume: 100, amount: 145000 })];
  assert.deepEqual(averagePrice(bars), [14.5]);
});

test("均价：累计额 ÷ 累计量，越往后越平滑", () => {
  const bars = [
    bar(10, { volume: 100, amount: 10 * 100 * 100 }),
    bar(20, { volume: 100, amount: 20 * 100 * 100 }),
  ];
  assert.deepEqual(averagePrice(bars), [10, 15]);
});

test("均价：还没成交时退回现价，不出 0 / NaN", () => {
  assert.deepEqual(averagePrice([bar(9, { volume: 0, amount: 0 })]), [9]);
});

/* ------------------------------------------------------------ 区间与刻度 */

test("区间：正常取上下界", () => {
  assert.deepEqual(extent([3, 1, 2]), { min: 1, max: 3 });
});

test("区间：空数组 / 全是 NaN 返回 null", () => {
  assert.equal(extent([]), null);
  assert.equal(extent([Number.NaN, Number.POSITIVE_INFINITY]), null);
});

test("区间：最高最低相同（一字板）时给余量，线不会贴在边框上", () => {
  const range = extent([10, 10]);
  assert.ok(range !== null);
  assert.ok(range.min < 10 && range.max > 10, JSON.stringify(range));
});

test("刻度：步长落在整数值上", () => {
  assert.deepEqual(priceTicks(10, 12, 4), [10, 10.5, 11, 11.5, 12]);
  assert.deepEqual(priceTicks(0, 100, 4), [0, 25, 50, 75, 100]);
});

test("刻度：不出现 0.30000000000000004 这种浮点尾巴", () => {
  for (const tick of priceTicks(0, 1, 10)) {
    assert.equal(String(tick).length <= 4, true, String(tick));
  }
});

test("刻度：都在区间内，且至少给得出一个", () => {
  const ticks = priceTicks(1450.13, 1489.07, 4);
  assert.ok(ticks.length >= 2, String(ticks));
  assert.ok(ticks.every((tick) => tick >= 1450.13 && tick <= 1489.07), String(ticks));
});

test("刻度：区间退化成一点时给那一点，不除零", () => {
  assert.deepEqual(priceTicks(5, 5, 4), [5]);
  assert.deepEqual(priceTicks(Number.NaN, 5, 4), []);
});

/* ------------------------------------------------------------ 命中哪一根 */

test("指针 → 下标：左中右都对得上", () => {
  // 100 宽 / 4 根 → 每根 25
  assert.equal(indexAt(0, 0, 100, 4), 0);
  assert.equal(indexAt(24.9, 0, 100, 4), 0);
  assert.equal(indexAt(25, 0, 100, 4), 1);
  assert.equal(indexAt(99, 0, 100, 4), 3);
});

test("指针 → 下标：指到外面夹回两端，空图返回 -1", () => {
  assert.equal(indexAt(-50, 0, 100, 4), 0);
  assert.equal(indexAt(500, 0, 100, 4), 3);
  assert.equal(indexAt(10, 0, 100, 0), -1);
});

/* ------------------------------------------------------------ 涨跌幅 */

test("涨跌幅：相对基准算百分比", () => {
  assert.equal(percentFrom(11, 10), 10);
  assert.ok(Math.abs((percentFrom(9, 10) ?? 0) + 10) < 1e-9);
});

test("涨跌幅：没基准 / 基准为 0 时返回 null", () => {
  assert.equal(percentFrom(11, null), null);
  assert.equal(percentFrom(11, 0), null);
});

/* ------------------------------------------------------------ 文案 */

test("成交量：万手 / 亿手", () => {
  assert.equal(formatVolume(67229), "6.72 万手");
  assert.equal(formatVolume(120000000), "1.20 亿手");
  assert.equal(formatVolume(880), "880 手");
  assert.equal(formatVolume(0), "—");
});

test("成交额：万 / 亿", () => {
  assert.equal(formatAmount(9796311852), "97.96 亿");
  assert.equal(formatAmount(61922130), "6192.21 万");
  assert.equal(formatAmount(880), "880 元");
});

test("时间刻度：日线截成 月-日，分钟线截成 时:分", () => {
  assert.equal(axisTime("2026-11-20", false), "11-20");
  assert.equal(axisTime("2026-11-20 09:31", true), "09:31");
});

console.log(`\n${passed} passed`);
