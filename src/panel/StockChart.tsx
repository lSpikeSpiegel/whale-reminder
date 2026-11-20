import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../ui/clipboard";
import {
  averagePrice,
  axisTime,
  extent,
  formatVolume,
  indexAt,
  movingAverage,
  percentFrom,
  priceTicks,
} from "./kline";
import { direction, formatPercent, signed } from "./stock";
import type { StockBar, StockChartData, StockItem, StockQuote } from "./types";

/** 周期。`min1` 是分时（只画当天），其余是 K 线 */
type Period = "min1" | "day" | "week" | "month";

const PERIODS: { value: Period; label: string }[] = [
  { value: "min1", label: "分时" },
  { value: "day", label: "日K" },
  { value: "week", label: "周K" },
  { value: "month", label: "月K" },
];

/** 均线周期。三条足够看趋势，再多小窗口就糊成一团 */
const MA_PERIODS = [5, 10, 20];

/**
 * 画布高度 = 价格区 + 成交量区 + 时间轴。
 *
 * 高度写死而不是跟着内容走：`fit()` 每次来量一次，canvas 一改尺寸就要重画，
 * 两者互相打架会看到节拍性的抖动。246 在 436 宽的面板里比例正好，
 * 窄到 320 也不会挤成一团。
 */
const CHART_H = 246;
const VOL_H = 44;
const AXIS_H = 15;
/** 右侧留给价格刻度 */
const AXIS_W = 44;
/** 价格区左边距。留 4px 是给第一根 K 线一点呼吸 */
const PAD_LEFT = 4;

/** 自动刷新，和自选列表一个节拍（切走这个页面就停） */
const REFRESH_MS = 30_000;
/**
 * 同标的切来切去别重复打网。
 *
 * 数据挂在模块级：面板关掉再开、切到自选再切回来，都能立刻铺出来，
 * 不用又等一次几百毫秒的请求。
 */
const CACHE_MS = 20_000;
const cache = new Map<string, { data: StockChartData; at: number }>();

const FONT = `11px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;

interface Theme {
  rise: string;
  fall: string;
  ink: string;
  ink3: string;
  ink4: string;
  line: string;
  surface: string;
  brand: string;
  warn: string;
  ma: string[];
}

/**
 * 颜色一律从 CSS 变量读，和面板其它地方同一份出处。
 *
 * canvas 拿不到 currentColor，只能把 `getComputedStyle` 的结果读出来——
 * 读一次缓存住，主题不会在运行中变。
 */
function readTheme(el: Element): Theme {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    rise: pick("--rise", "#c33a32"),
    fall: pick("--fall", "#1c8a55"),
    ink: pick("--ink", "#16203f"),
    ink3: pick("--ink-3", "#8b96b8"),
    ink4: pick("--ink-4", "#aab3cd"),
    line: pick("--line", "rgba(22, 32, 63, 0.08)"),
    surface: pick("--surface", "#ffffff"),
    brand: pick("--brand", "#355cb6"),
    warn: pick("--warn", "#b07d20"),
    ma: [pick("--ma-5", "#355cb6"), pick("--ma-10", "#b07d20"), pick("--ma-20", "#7a5cc4")],
  };
}

/** 把 `#rrggbb` 转成带透明度的 rgba（面积渐变要用它） */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const full =
    hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  if (!full.startsWith("#") || full.length !== 7) return color;

  const r = Number.parseInt(full.slice(1, 3), 16);
  const g = Number.parseInt(full.slice(3, 5), 16);
  const b = Number.parseInt(full.slice(5, 7), 16);
  if ([r, g, b].some((value) => Number.isNaN(value))) return color;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 圆角矩形。WebView2 版本不保证有 `ctx.roundRect`，自己铺一遍 path 最稳 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

interface PaintOptions {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  bars: StockBar[];
  intraday: boolean;
  showMa: boolean;
  prevClose: number | null;
  digits: number;
  hover: { index: number; y: number } | null;
  theme: Theme;
}

/**
 * 画一张图。
 *
 * 分成四层：网格和刻度 → 价格区（蜡烛 / 分时线 + 均线）→ 成交量 → 十字光标和读数。
 * 全部用 CSS px 打底，外面套了 dpr 变换，所以 2 倍屏上也不会发虚。
 */
function paint(options: PaintOptions) {
  const { ctx, width, height, bars, theme, digits } = options;
  ctx.clearRect(0, 0, width, height);
  if (bars.length === 0) return;

  const left = PAD_LEFT;
  const right = width - AXIS_W;
  const plotW = Math.max(10, right - left);
  const priceTop = 8;
  const priceBottom = height - AXIS_H - VOL_H - 8;
  const priceH = priceBottom - priceTop;
  const volTop = priceBottom + 8;
  const volBottom = height - AXIS_H;

  const step = plotW / bars.length;
  const centerX = (index: number) => left + step * (index + 0.5);
  const bodyW = Math.max(1, Math.min(9, step * 0.62));

  /* ---------------------------------------------------------- 价格区间 */

  const averages = options.intraday ? averagePrice(bars) : [];
  const mas = options.showMa
    ? MA_PERIODS.map((n, i) => ({ n, color: theme.ma[i] ?? theme.brand, values: movingAverage(bars, n) }))
    : [];

  const values: number[] = [];
  for (const bar of bars) values.push(bar.high, bar.low);
  if (options.intraday) {
    values.push(...averages);
    if (options.prevClose !== null) values.push(options.prevClose);
  } else {
    for (const line of mas) {
      for (const value of line.values) if (value !== null) values.push(value);
    }
  }

  const raw = extent(values) ?? { min: 0, max: 1 };
  let min = raw.min;
  let max = raw.max;

  if (options.intraday && options.prevClose !== null) {
    // 分时按昨收对称：0% 那条线落在正中，涨跌幅两边等长，一眼能看出今天偏强还是偏弱
    const base = options.prevClose;
    const deviation = Math.max(Math.abs(max - base), Math.abs(min - base)) * 1.06 || base * 0.01;
    min = base - deviation;
    max = base + deviation;
  } else {
    const pad = (max - min) * 0.06;
    min -= pad;
    max += pad;
  }

  const span = max - min || 1;
  const mapY = (value: number) => priceBottom - ((value - min) / span) * priceH;

  /* ---------------------------------------------------------- 网格 + 刻度 */

  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  for (const tick of priceTicks(min, max, 4)) {
    const y = Math.round(mapY(tick)) + 0.5;

    ctx.strokeStyle = theme.line;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    ctx.fillStyle = theme.ink4;
    ctx.textAlign = "right";
    ctx.fillText(tick.toFixed(digits), width - 3, y);
  }

  // 成交量区不需要刻度线，给一条分隔就够，免得和价格区抢视线
  ctx.strokeStyle = theme.line;
  ctx.beginPath();
  ctx.moveTo(left, Math.round(volTop) + 0.5);
  ctx.lineTo(right, Math.round(volTop) + 0.5);
  ctx.stroke();

  /* ---------------------------------------------------------- 价格区 */

  if (options.intraday) {
    const closes = bars.map((bar) => bar.close);

    // 面积：从现价线铺到底，颜色是品牌色的淡渐变
    const gradient = ctx.createLinearGradient(0, priceTop, 0, priceBottom);
    gradient.addColorStop(0, withAlpha(theme.brand, 0.16));
    gradient.addColorStop(1, withAlpha(theme.brand, 0));
    ctx.beginPath();
    ctx.moveTo(centerX(0), mapY(closes[0]));
    for (let i = 1; i < closes.length; i += 1) ctx.lineTo(centerX(i), mapY(closes[i]));
    ctx.lineTo(centerX(closes.length - 1), priceBottom);
    ctx.lineTo(centerX(0), priceBottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 均价线先画（压在现价线下面），它是辅助参照
    ctx.strokeStyle = theme.warn;
    ctx.lineWidth = 1;
    ctx.beginPath();
    averages.forEach((value, i) => {
      const x = centerX(i);
      const y = mapY(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.strokeStyle = theme.brand;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    closes.forEach((value, i) => {
      const x = centerX(i);
      const y = mapY(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 昨收：虚线基准，涨跌就是相对这条线的
    if (options.prevClose !== null) {
      const y = Math.round(mapY(options.prevClose)) + 0.5;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = theme.ink4;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.restore();
    }
  } else {
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      const color = bar.close >= bar.open ? theme.rise : theme.fall;
      const x = Math.round(centerX(i)) + 0.5;

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, mapY(bar.high));
      ctx.lineTo(x, mapY(bar.low));
      ctx.stroke();

      // 实体至少 1px：开盘收盘同价时别让它彻底消失
      const yOpen = mapY(bar.open);
      const yClose = mapY(bar.close);
      const top = Math.min(yOpen, yClose);
      const height2 = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(centerX(i) - bodyW / 2, top, bodyW, height2);
    }

    ctx.lineWidth = 1.2;
    for (const line of mas) {
      ctx.strokeStyle = line.color;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < bars.length; i += 1) {
        const value = line.values[i];
        if (value === null) {
          started = false;
          continue;
        }
        const x = centerX(i);
        const y = mapY(value);
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------- 成交量 */

  const maxVolume = Math.max(...bars.map((bar) => bar.volume), 1);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    // 分时按「和上一分钟比」，K 线按「和自己开盘比」——两种图的常规着色
    const up = options.intraday
      ? bar.close >= (i === 0 ? (options.prevClose ?? bar.open) : bars[i - 1].close)
      : bar.close >= bar.open;
    const h = Math.max(0.5, (bar.volume / maxVolume) * (volBottom - volTop));

    ctx.fillStyle = withAlpha(up ? theme.rise : theme.fall, 0.55);
    ctx.fillRect(centerX(i) - bodyW / 2, volBottom - h, bodyW, h);
  }

  /* ---------------------------------------------------------- 时间轴 */

  ctx.fillStyle = theme.ink4;
  ctx.textBaseline = "middle";
  const marks = [...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1])];
  for (const index of marks) {
    ctx.textAlign = index === 0 ? "left" : index === bars.length - 1 ? "right" : "center";
    ctx.fillText(
      axisTime(bars[index].time, options.intraday),
      centerX(index),
      height - AXIS_H / 2,
    );
  }

  /* ---------------------------------------------------------- 均线图例 */

  if (!options.intraday && mas.length > 0) {
    const at = options.hover?.index ?? bars.length - 1;
    let x = left + 2;
    ctx.textAlign = "left";
    for (const line of mas) {
      const value = line.values[at];
      const text = `MA${line.n} ${value === null ? "—" : value.toFixed(digits)}`;
      ctx.fillStyle = line.color;
      ctx.fillText(text, x, priceTop + 6);
      x += ctx.measureText(text).width + 10;
    }
  }

  /* ---------------------------------------------------------- 十字光标 */

  const hover = options.hover;
  if (hover === null || hover.index < 0 || hover.index >= bars.length) return;

  const bar = bars[hover.index];
  const x = centerX(hover.index);
  const y = Math.min(priceBottom, Math.max(priceTop, hover.y));

  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = theme.ink4;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, priceTop);
  ctx.lineTo(Math.round(x) + 0.5, volBottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(left, Math.round(y) + 0.5);
  ctx.lineTo(right, Math.round(y) + 0.5);
  ctx.stroke();
  ctx.restore();

  // 右侧跟着鼠标走的价格标签
  const priceAt = min + ((priceBottom - y) / priceH) * span;
  ctx.fillStyle = theme.ink;
  roundRect(ctx, width - AXIS_W + 1, y - 8, AXIS_W - 3, 16, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(priceAt.toFixed(digits), width - AXIS_W / 2, y);

  /* ---------------------------------------------------------- 读数卡片 */

  const base = options.intraday
    ? (options.prevClose ?? bar.open)
    : hover.index > 0
      ? bars[hover.index - 1].close
      : bar.open;
  const pct = percentFrom(bar.close, base);
  const pctText = pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;

  // 两列布局：K 线六个字段（开高低收涨跌量），分时四个（价均涨跌量）
  const entries: { label: string; value: string; tone: string }[] = options.intraday
    ? [
        { label: "价", value: bar.close.toFixed(digits), tone: theme.ink },
        { label: "均", value: (averages[hover.index] ?? bar.close).toFixed(digits), tone: theme.ink },
        { label: "涨跌", value: pctText, tone: pct !== null && pct < 0 ? theme.fall : pct !== null && pct > 0 ? theme.rise : theme.ink },
        { label: "量", value: formatVolume(bar.volume), tone: theme.ink },
      ]
    : [
        { label: "开", value: bar.open.toFixed(digits), tone: theme.ink },
        { label: "高", value: bar.high.toFixed(digits), tone: theme.rise },
        { label: "低", value: bar.low.toFixed(digits), tone: theme.fall },
        { label: "收", value: bar.close.toFixed(digits), tone: theme.ink },
        { label: "涨跌", value: pctText, tone: pct !== null && pct < 0 ? theme.fall : pct !== null && pct > 0 ? theme.rise : theme.ink },
        { label: "量", value: formatVolume(bar.volume), tone: theme.ink },
      ];

  const rows = Math.ceil(entries.length / 2);
  const boxW = 134;
  const boxH = 26 + rows * 18;
  let boxX = x + 14;
  if (boxX + boxW > right) boxX = x - 14 - boxW;
  boxX = Math.max(left, boxX);
  const boxY = Math.min(priceBottom - boxH, Math.max(priceTop, y - boxH / 2));

  ctx.fillStyle = theme.surface;
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  roundRect(ctx, boxX, boxY, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.fillStyle = theme.ink3;
  ctx.fillText(bar.time, boxX + 9, boxY + 13);

  entries.forEach((entry, index) => {
    const tx = boxX + 9 + (index % 2) * 64;
    const ty = boxY + 31 + Math.floor(index / 2) * 18;

    ctx.fillStyle = theme.ink4;
    ctx.fillText(entry.label, tx, ty);
    ctx.fillStyle = entry.tone;
    ctx.fillText(entry.value, tx + 16, ty);
  });
}

interface Props {
  item: StockItem;
  /** 自选那边这一轮的报价，头部那行数字用它 */
  quote: StockQuote | null;
  onBack: () => void;
  onLayout: () => void;
}

/**
 * 单个标的的图表页：分时 / 日 K / 周 K / 月 K，带均线和成交量。
 *
 * **手写 canvas，不引图表库**：这个面板对内存敏感（AGENTS 第 1 节），
 * 而一张 K 线图要的东西——坐标映射、蜡烛、均线、十字光标——加起来不到 300 行，
 * 引 ECharts / lightweight-charts 至少要拖进几百 KB 和一套自己的主题体系。
 *
 * 高度是写死的（`CHART_H`），所以 `onLayout` 只在加载态 / 错误行出现时跑：
 * 画布尺寸一变就要重画，和「窗口跟着内容长」放一起会互相打架。
 */
export function StockChart({ item, quote, onBack, onLayout }: Props) {
  const [period, setPeriod] = useState<Period>("min1");
  /** 0 不复权 / 1 前复权。分时不用它 */
  const [fqt, setFqt] = useState(1);
  const [showMa, setShowMa] = useState(true);
  const [data, setData] = useState<StockChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeRef = useRef<Theme | null>(null);
  const hover = useRef<{ index: number; y: number } | null>(null);
  const raf = useRef(0);
  const seq = useRef(0);
  const noteTimer = useRef(0);

  const intraday = period === "min1";

  useEffect(() => {
    const el = wrapRef.current;
    if (el !== null) themeRef.current = readTheme(el);
  }, []);

  // 画布宽度跟着容器走（用户可能把面板拖窄）
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      const effectiveFqt = intraday ? 1 : fqt;
      const key = `${item.secid}:${period}:${effectiveFqt}`;

      if (!force) {
        const hit = cache.get(key);
        if (hit !== undefined && Date.now() - hit.at < CACHE_MS) {
          setData(hit.data);
          setError(null);
          setLoading(false);
          return;
        }
      }

      const mine = ++seq.current;
      setLoading(true);
      try {
        const next = await invoke<StockChartData>("stock_chart", {
          secid: item.secid,
          period,
          fqt: effectiveFqt,
        });
        if (mine !== seq.current) return;
        cache.set(key, { data: next, at: Date.now() });
        setData(next);
        setError(null);
      } catch (err) {
        if (mine !== seq.current) return;
        console.error("[stock] K 线拉取失败", err);
        setError("取不到这段行情，检查一下网络");
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [item.secid, period, fqt, intraday],
  );

  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => void load(true), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // 换周期 / 复权就重新取，光标位置也要清掉（否则会停在上一张图的第 N 根）
  useEffect(() => {
    hover.current = null;
  }, [period, fqt, item.secid]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null || width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(CHART_H * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${CHART_H}px`;

    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const theme = themeRef.current ?? readTheme(canvas);
    themeRef.current = theme;

    paint({
      ctx,
      width,
      height: CHART_H,
      bars: data?.bars ?? [],
      intraday,
      showMa,
      prevClose: data?.prev_close ?? null,
      digits: data?.digits ?? 2,
      hover: hover.current,
      theme,
    });
  }, [data, width, intraday, showMa]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 画布高度是写死的，只有「加载中 / 报错 / 没行情」这三行会改变总高度
  useEffect(() => {
    onLayout();
  }, [onLayout, loading, error, data?.bars.length]);

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const bars = data?.bars ?? [];
    if (canvas === null || bars.length === 0 || width === 0) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    hover.current = {
      index: indexAt(x, PAD_LEFT, Math.max(10, width - AXIS_W - PAD_LEFT), bars.length),
      y: Math.min(y, CHART_H - AXIS_H),
    };

    // 每帧最多重画一次：pointermove 的密度远高于屏幕刷新率
    if (raf.current !== 0) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = 0;
      draw();
    });
  };

  const leave = () => {
    if (hover.current === null) return;
    hover.current = null;
    draw();
  };

  useEffect(() => () => {
    if (raf.current !== 0) window.cancelAnimationFrame(raf.current);
  }, []);

  /** 头部那行：优先用实时报价，没有就退回最后一根 K 线 */
  const head = useMemo(() => {
    const last = data?.bars[data.bars.length - 1] ?? null;
    const digits = quote?.digits ?? data?.digits ?? 2;
    const price = quote?.price ?? last?.close ?? null;

    if (quote?.percent !== null && quote?.percent !== undefined) {
      return {
        price: quote.price,
        change: quote.change,
        percent: quote.percent,
        digits,
        direction: direction(quote.percent),
      };
    }

    const base = intraday
      ? (data?.prev_close ?? null)
      : (data?.bars[data.bars.length - 2]?.close ?? null);
    const percent = price === null ? null : percentFrom(price, base);
    return {
      price,
      change: price === null || base === null ? null : price - base,
      percent,
      digits,
      direction: direction(percent),
    };
  }, [quote, data, intraday]);

  const copy = () => {
    void copyText(item.code).then((ok) => {
      setNote(ok ? `已复制 ${item.code}` : "复制失败");
      window.clearTimeout(noteTimer.current);
      noteTimer.current = window.setTimeout(() => setNote(null), 1800);
    });
  };

  const bars = data?.bars ?? [];

  return (
    <>
      <button type="button" className="tools__back" onClick={onBack}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M9.8 3.4 5.2 8l4.6 4.6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        自选
      </button>

      <section className="tool stock__detail">
        <div className="stock__detail-head">
          <button type="button" className="stock__id stock__id--button" onClick={copy} title="复制代码">
            <span className="stock__name">{item.name}</span>
            <span className="stock__meta">
              {note ?? `${item.code}${item.market === "" ? "" : ` · ${item.market}`}`}
            </span>
          </button>
          <span className={`stock__num stock--${head.direction}`}>
            <span className="stock__big">
              {head.price === null ? "—" : head.price.toFixed(head.digits)}
            </span>
            <span className="stock__delta">
              {head.change === null ? "—" : signed(head.change, head.digits)}{" "}
              {formatPercent(head.percent)}
            </span>
          </span>
        </div>

        <div className="stock__chips">
          {PERIODS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className={`chip${period === entry.value ? " chip--on" : ""}`}
              onClick={() => setPeriod(entry.value)}
              aria-pressed={period === entry.value}
            >
              {entry.label}
            </button>
          ))}

          {/* 分时没有复权一说，也没有均线；切过去就整组收起来，别摆一排按不动的按钮 */}
          {!intraday && (
            <>
              <span className="stock__chips-sep" aria-hidden="true" />
              <button
                type="button"
                className={`chip${fqt === 1 ? " chip--on" : ""}`}
                onClick={() => setFqt(1)}
                aria-pressed={fqt === 1}
              >
                前复权
              </button>
              <button
                type="button"
                className={`chip${fqt === 0 ? " chip--on" : ""}`}
                onClick={() => setFqt(0)}
                aria-pressed={fqt === 0}
              >
                不复权
              </button>
              <button
                type="button"
                className={`chip${showMa ? " chip--on" : ""}`}
                onClick={() => setShowMa(!showMa)}
                aria-pressed={showMa}
              >
                均线
              </button>
            </>
          )}
        </div>

        <div className="stock__canvas-wrap" ref={wrapRef} onPointerLeave={leave}>
          <canvas
            ref={canvasRef}
            className="stock__canvas"
            onPointerMove={move}
            role="img"
            aria-label={`${item.name} 的${intraday ? "分时" : "K 线"}图`}
          />
          {loading && <span className="stock__chart-note">加载中…</span>}
          {!loading && error !== null && <span className="stock__chart-note stock--down">{error}</span>}
          {!loading && error === null && bars.length === 0 && (
            <span className="stock__chart-note">这段时间没有行情</span>
          )}
        </div>
      </section>
    </>
  );
}
