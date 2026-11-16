/**
 * 颜色换算：HEX / RGB / HSL / HSV 互转 + 文本解析。
 *
 * 全是纯函数，没有 DOM 依赖——拾色器拖动时要每帧算，走 IPC 不划算，
 * 所以换算放在前端；Rust 那边只负责存「取色历史」。
 *
 * 约定：RGB 分量是 0–255 的浮点数（展示前再取整），HSL 的 h 是 0–360、
 * s/l 是 0–100（和 CSS 一致），HSV 的 s/v 是 0–1（和拾色器的位置比例一致）。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** 收进 0–255 并取整 */
const byte = (value: number): number => Math.round(clamp(value, 0, 255));

/** RGB → `#rrggbb`（小写补零） */
export function toHex({ r, g, b }: Rgb): string {
  const part = (value: number) => byte(value).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function toRgbString(rgb: Rgb): string {
  return `rgb(${byte(rgb.r)}, ${byte(rgb.g)}, ${byte(rgb.b)})`;
}

export function toHslString(rgb: Rgb): string {
  const { h, s, l } = rgbToHsl(rgb);
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}

/** 三种格式一起给：卡片上三行是同一时刻的快照，分三次算容易对不上 */
export function formats(rgb: Rgb): { hex: string; rgb: string; hsl: string } {
  return { hex: toHex(rgb), rgb: toRgbString(rgb), hsl: toHslString(rgb) };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rr = clamp(r, 0, 255) / 255;
  const gg = clamp(g, 0, 255) / 255;
  const bb = clamp(b, 0, 255) / 255;

  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const delta = max - min;

  // 灰色没有色相，也没有饱和度
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };

  const s = delta / (1 - Math.abs(2 * l - 1));

  let h: number;
  if (max === rr) {
    h = ((gg - bb) / delta) % 6;
  } else if (max === gg) {
    h = (bb - rr) / delta + 2;
  } else {
    h = (rr - gg) / delta + 4;
  }
  h *= 60;
  if (h < 0) h += 360;

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return {
    r: (rgb[0] + m) * 255,
    g: (rgb[1] + m) * 255,
    b: (rgb[2] + m) * 255,
  };
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rr = clamp(r, 0, 255) / 255;
  const gg = clamp(g, 0, 255) / 255;
  const bb = clamp(b, 0, 255) / 255;

  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rr) h = ((gg - bb) / delta) % 6;
    else if (max === gg) h = (bb - rr) / delta + 2;
    else h = (rr - gg) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return {
    r: (rgb[0] + m) * 255,
    g: (rgb[1] + m) * 255,
    b: (rgb[2] + m) * 255,
  };
}

function numbersIn(text: string): number[] {
  return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * 把用户敲进来的任意一种写法解析成 RGB。
 *
 * 认这些：`#355CB6` / `355cb6` / `#3CB` / `rgb(53, 92, 182)` / `rgba(…)`（丢掉 alpha）/
 * `hsl(222, 55%, 46%)` / `53 92 182`（裸三元组，按 RGB 读）。
 * 认不出来返回 null，由调用方提示——不要猜，猜错了用户更难发现。
 */
export function parseColor(input: string): Rgb | null {
  const text = input.trim().toLowerCase();
  if (text === "") return null;

  const hex = text.startsWith("#") ? text.slice(1) : text;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const numbers = numbersIn(text);

  if (text.startsWith("hsl")) {
    if (numbers.length < 3) return null;
    return hslToRgb({ h: numbers[0], s: numbers[1], l: numbers[2] });
  }

  if (text.startsWith("rgb")) {
    if (numbers.length < 3) return null;
    return { r: byte(numbers[0]), g: byte(numbers[1]), b: byte(numbers[2]) };
  }

  // 裸三元组：只允许数字、空格、逗号、小数点，免得把别的东西误读成颜色
  if (numbers.length === 3 && /^[\d\s,.]+$/.test(text)) {
    return { r: byte(numbers[0]), g: byte(numbers[1]), b: byte(numbers[2]) };
  }

  return null;
}
