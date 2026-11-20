/**
 * 图片处理的纯算术：目标尺寸、裁剪框、格式与文件名。
 *
 * 真正的像素操作在 `canvas` 里（浏览器自带的解码器），这里只算「从哪儿裁多少、
 * 缩到多大、存成什么名字」——这类算错了界面看着只是「图有点糊 / 有点变形」，
 * 很难一眼发现，所以必须能单测（`tools/image-test.mjs`）。
 */

/** 输出格式。`keep` 表示保持原扩展名对应的格式 */
export type ImageFormat = "keep" | "jpeg" | "png" | "webp";

/** 裁剪比例。`none` 不裁，其余按比例居中裁 */
export type CropRatio = "none" | "1:1" | "4:3" | "16:9";

/** 支持的编码格式（`keep` 解析后的结果） */
export type OutputFormat = "jpeg" | "png" | "webp";

/** 长边限制。0 = 保持原始尺寸，不放大 */
export const MAX_EDGES: { value: number; label: string }[] = [
  { value: 0, label: "原尺寸" },
  { value: 1920, label: "1920" },
  { value: 1280, label: "1280" },
  { value: 800, label: "800" },
];

/** 质量档。给三档就够——精确到 0.05 的滑块对这个面板来说是伪需求 */
export const QUALITIES: { value: number; label: string }[] = [
  { value: 0.92, label: "高" },
  { value: 0.8, label: "中" },
  { value: 0.65, label: "小" },
];

/** 裁剪比例选项 */
export const CROPS: { value: CropRatio; label: string }[] = [
  { value: "none", label: "不裁" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "16:9", label: "16:9" },
];

/** 比例 → 宽高比。`none` 用 0 表示「不裁」 */
function ratioOf(crop: CropRatio): number {
  switch (crop) {
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "16:9":
      return 16 / 9;
    default:
      return 0;
  }
}

/**
 * 按扩展名推「保持原格式」是哪种。
 *
 * 认不出来按 PNG：它是唯一能无损装下任意内容的格式，选错了也不会糊。
 */
export function resolveFormat(format: ImageFormat, name: string): OutputFormat {
  if (format !== "keep") return format;

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "webp") return "webp";
  return "png";
}

export function mimeOf(format: OutputFormat): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** 落盘用的扩展名。`jpeg` 一律写成 `jpg`，和 Rust 侧的白名单对齐 */
export function extOf(format: OutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

/** PNG 不吃 quality 参数，界面上要把质量那排藏掉 */
export function usesQuality(format: OutputFormat): boolean {
  return format !== "png";
}

export interface CropPlan {
  /** 从原图的哪一块开始取 */
  sx: number;
  sy: number;
  /** 取多大一块 */
  sw: number;
  sh: number;
  /** 画到画布上多大 */
  dw: number;
  dh: number;
}

/**
 * 算这一次要「从原图哪儿裁、缩到多大」。
 *
 * 顺序是**先裁后缩**：先按比例在原图里取最大的居中矩形，再按长边限制等比缩小。
 * 反过来（先缩再裁）在极限参数下会多丢一次精度——比如先把 8000px 缩到 800 再裁 1:1，
 * 边角那一圈像素白算了。
 *
 * `maxEdge` 大于原图时不放大：放大会糊，而且没人需要「把 640 的小图存成 1920」。
 */
export function planSize(
  source: { width: number; height: number },
  crop: CropRatio,
  maxEdge: number,
): CropPlan {
  const width = Math.max(1, Math.round(source.width));
  const height = Math.max(1, Math.round(source.height));

  let sw = width;
  let sh = height;
  const ratio = ratioOf(crop);

  if (ratio > 0) {
    if (width / height > ratio) {
      // 原图更宽：以高为准，左右各裁一点
      sw = Math.round(height * ratio);
      sh = height;
    } else {
      sw = width;
      sh = Math.round(width / ratio);
    }
    sw = Math.max(1, Math.min(sw, width));
    sh = Math.max(1, Math.min(sh, height));
  }

  const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(sw, sh)) : 1;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  return {
    sx: Math.floor((width - sw) / 2),
    sy: Math.floor((height - sh) / 2),
    sw,
    sh,
    dw,
    dh,
  };
}

/** 文件名主干：去掉目录和扩展名 */
export function stemOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 存盘用的文件名（不含扩展名）。
 *
 * 带上尺寸：同一个原图换个质量再存一次，两次的文件名不会撞，用户一眼能看出
 * 「1920 那张」和「800 那张」是同一个源出的。
 */
export function outputStem(name: string, width: number, height: number): string {
  return `${stemOf(name)}-${width}x${height}`;
}

/** 字节数给人看：`2.4 MB` / `320 KB` */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const kb = 1024;
  if (bytes >= kb * kb) return `${(bytes / (kb * kb)).toFixed(1)} MB`;
  if (bytes >= kb) return `${Math.round(bytes / kb)} KB`;
  return `${Math.round(bytes)} B`;
}

/**
 * 相对原图小了多少（百分比）。
 *
 * 负数表示反而变大了（比如把一张小 JPEG 存成 PNG）——界面要如实说「大了 12%」，
 * 不能只显示一个好看的「省了 -12%」。
 */
export function savingPercent(before: number, after: number): number {
  if (!Number.isFinite(before) || before <= 0) return 0;
  return ((before - after) / before) * 100;
}

/** 「小了 73%」/「大了 12%」/「大小基本没变」 */
export function savingLabel(before: number, after: number): string {
  const percent = savingPercent(before, after);
  if (Math.abs(percent) < 1) return "大小基本没变";
  return percent > 0 ? `小了 ${Math.round(percent)}%` : `大了 ${Math.round(-percent)}%`;
}
