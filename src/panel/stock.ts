/**
 * 行情的展示换算：涨跌方向、数字格式、自选和报价的对齐。
 *
 * 全是纯函数，没有 DOM / IPC 依赖——取数在 Rust（`stock.rs`），这里只管
 * 「一串报价怎么变成几行字」。这样格式化的边界情况（停牌、平盘、负零）
 * 都能用 `tools/stock-test.mjs` 直接跑，不用起窗口。
 */

import type { StockItem, StockQuote } from "./types";

/**
 * 顶部的三个指数。写死在这里是因为它们就是「今天大概什么样」的三个参照，
 * 不需要让用户自己加；换成别的市场（恒生、纳指）时改这一处即可。
 */
export const INDEXES: StockItem[] = [
  { secid: "1.000001", code: "000001", name: "上证指数", market: "沪" },
  { secid: "0.399001", code: "399001", name: "深证成指", market: "深" },
  { secid: "0.399006", code: "399006", name: "创业板指", market: "创" },
];

/** 涨 / 跌 / 平。颜色由 CSS 的 `stock--up` / `stock--down` 决定，红涨绿跌。 */
export type Direction = "up" | "down" | "flat";

/** 自选里的一行：用户存下的标的 + 这一轮问回来的报价（没问到就是 null） */
export interface StockRow {
  item: StockItem;
  quote: StockQuote | null;
}

/**
 * 方向。
 *
 * `null` 当「平」而不是「涨」：停牌、没开盘、这只退市了，都没有方向可言，
 * 给它上色等于报了一个假信号。
 */
export function direction(percent: number | null | undefined): Direction {
  if (percent === null || percent === undefined || percent === 0) return "flat";
  return percent > 0 ? "up" : "down";
}

/**
 * 带符号的定长数字：`+1.23` / `-0.53` / `0.00`。
 *
 * 先按显示精度取整再判正负——直接看原值的话 `-0.001` 会被 `toFixed` 写成
 * 「-0.00」，涨跌幅栏里出现「-0.00%」比什么都不写还让人犯嘀咕。
 */
export function signed(value: number, digits = 2): string {
  const rounded = Number(value.toFixed(digits));
  if (!Number.isFinite(rounded) || rounded === 0) return (0).toFixed(digits);
  return rounded > 0 ? `+${rounded.toFixed(digits)}` : rounded.toFixed(digits);
}

/** 现价。小数位跟着接口的 `digits` 走，债券那种三位小数的才不会错位。 */
export function formatPrice(quote: StockQuote | null): string {
  if (quote === null || quote.price === null) return "—";
  return quote.price.toFixed(quote.digits);
}

/** 涨跌额，带符号 */
export function formatChange(quote: StockQuote | null): string {
  if (quote === null || quote.change === null) return "—";
  return signed(quote.change, quote.digits);
}

/** 涨跌幅，带百分号。涨跌幅固定两位小数，比价位的位数稳定 */
export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return "—";
  return `${signed(percent, 2)}%`;
}

/**
 * 把「自选顺序」和「这一轮报价」对齐成行。
 *
 * 按 secid 配，不按位置配：接口回来的顺序不保证和请求一致，按位置数组
 * 一旦错位就会把 A 的涨跌贴到 B 的名字上——这种错最难看出来。
 */
export function mergeQuotes(items: StockItem[], quotes: StockQuote[]): StockRow[] {
  const byId = new Map(quotes.map((quote) => [quote.secid, quote]));
  return items.map((item) => ({ item, quote: byId.get(item.secid) ?? null }));
}

/** 是否已经在自选里（搜索结果那一行据此显示「已加」并禁用点击） */
export function inWatch(watch: StockItem[], secid: string): boolean {
  return watch.some((item) => item.secid === secid);
}

/** 「更新于 09:23」里的时刻。只到分钟：秒级跳动只会让人以为数据在变。 */
export function stamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
