/**
 * K 线 / 分时图的纯计算：均线、均价、坐标刻度、档位换算。
 *
 * 画图在 `StockChart.tsx`（canvas），这里只算数——`tools/kline-test.mjs` 直接跑，
 * 不用起窗口。图表最容易出错的地方是「刻度算错一格」，而那类错误在截图里看着
 * 只是「有点怪」，所以这部分必须能单测。
 */

import type { StockBar } from "./types";

/**
 * 简单移动平均。前 n-1 个点是 `null`：不够 n 根就是没有值，
 * 用 0 糊上去会让均线从左上角窜出来一条假线。
 */
export function movingAverage(bars: StockBar[], n: number): (number | null)[] {
  if (n < 1) return bars.map(() => null);

  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/**
 * 分时图的均价线：累计成交额 ÷ 累计成交量。
 *
 * 成交量单位是「手」，1 手 = 100 股，所以要乘 100——少乘这一下均价会比现价高一百倍。
 * 还没成交时用现价顶上，别让第一根出现 0 或 NaN。
 */
export function averagePrice(bars: StockBar[]): number[] {
  let amount = 0;
  let volume = 0;
  return bars.map((bar) => {
    amount += bar.amount;
    volume += bar.volume;
    if (volume <= 0) return bar.close;
    return amount / (volume * 100);
  });
}

/** 一段数值的上下界。空数组 / 全是 NaN 返回 null */
export function extent(values: number[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  // 一根 K 线开盘价收盘价完全相同（停牌 / 一字板）时给点余量，
  // 否则那根线会贴在画布边框上，看着像「没画出来」
  if (min === max) {
    const pad = Math.abs(min) * 0.002 || 0.01;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/**
 * 价格刻度：把区间切成 count 段，落在 1 / 2 / 2.5 / 5 / 10 这类「整」步长上。
 *
 * 直接用区间除以段数会得到 3.7 这种刻度，右侧一列数字歪歪扭扭，读起来很费劲。
 */
export function priceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 1) return [];
  if (min === max) return [min];

  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;

  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-6; value += step) {
    // 浮点累加会出 0.30000000000000004，落到刻度上就是「右侧标签很长」
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

/** 指针的 x → 第几根。夹在 [0, count-1]，指到空白处也算最近的那根 */
export function indexAt(x: number, left: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return -1;
  const index = Math.floor(((x - left) / width) * count);
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * 相对昨收的涨跌幅。分时图的读数用得上——K 线看的是这根自己的涨跌，
 * 分时看的是「今天到现在涨了多少」。
 */
export function percentFrom(price: number, base: number | null): number | null {
  if (base === null || !Number.isFinite(price) || !Number.isFinite(base) || base === 0) return null;
  return ((price - base) / base) * 100;
}

/** 成交量：手 → 「6.72 万手」/「1.20 亿手」 */
export function formatVolume(hand: number): string {
  if (!Number.isFinite(hand) || hand <= 0) return "—";
  if (hand >= 1e8) return `${(hand / 1e8).toFixed(2)} 亿手`;
  if (hand >= 1e4) return `${(hand / 1e4).toFixed(2)} 万手`;
  return `${Math.round(hand)} 手`;
}

/** 成交额：元 → 「97.96 亿」/「6192.21 万」 */
export function formatAmount(yuan: number): string {
  if (!Number.isFinite(yuan) || yuan <= 0) return "—";
  if (yuan >= 1e8) return `${(yuan / 1e8).toFixed(2)} 亿`;
  if (yuan >= 1e4) return `${(yuan / 1e4).toFixed(2)} 万`;
  return `${Math.round(yuan)} 元`;
}

/** 图表 x 轴上的时间刻度：日线「11-20」，分钟线「09:31」 */
export function axisTime(time: string, intraday: boolean): string {
  if (!intraday) {
    const date = time.split(" ")[0];
    const [, month, day] = date.split("-");
    return month !== undefined && day !== undefined ? `${month}-${day}` : date;
  }
  const clock = time.split(" ")[1] ?? time;
  return clock.slice(0, 5);
}
