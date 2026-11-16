/**
 * 桌宠状态模型。
 *
 * 分三层：
 * - `PetPose`  —— Q 版的一套立绘（11 张素材）
 * - `PetStyle` —— 用哪套美术资源（Q 版 / 写实）
 * - `PetActivity` —— 一个动作 / 状态（18 个），由行为状态机驱动，映射到立绘 + CSS 动效
 *
 * 这样「同一张立绘」可以被多个动作复用（摸头、打瞌睡都用正面图，靠特效区分），
 * 加动作不需要新素材。
 */

export type PetPose =
  | "front"
  | "side"
  | "back"
  | "thinking"
  | "working"
  | "sleep"
  | "playing"
  | "slacking"
  | "bored"
  | "daydreaming"
  | "eating";

/** 写实立绘只有正面站姿，差别全在表情上（由分层 PSD 的「表情」组导出，7 组全用上了） */
export type RealPose =
  | "front"
  | "blush"
  | "heart"
  | "dizzy"
  | "squint"
  | "gloom"
  | "smug"
  | "tears";

/** 立绘风格。Rust 侧 `settings::PetStyle` 序列化成同名小写字符串 */
export type PetStyle = "chibi" | "real";

export type PetActivity =
  /** 常态站立 */
  | "idle"
  /** 鼠标移入的抬头反馈 */
  | "react"
  /** 摸头 */
  | "pat"
  /** 戳一戳 */
  | "poke"
  /** 撒欢 / 任务完成 */
  | "happy"
  /** 沉思 */
  | "think"
  /** 摸鱼（抱着鲸鱼玩偶） */
  | "slack"
  /** 发呆 */
  | "daydream"
  /** 无聊抱膝 */
  | "bored"
  /** 打瞌睡（站着点头） */
  | "doze"
  /** 深睡（盖被子） */
  | "sleep"
  /** 提醒 / 工作 */
  | "work"
  /** 吃点心 */
  | "eat"
  /** 被拖动 */
  | "drag"
  /** 贴边时缩到屏幕外 */
  | "peek"
  /** 被连戳好多次，生气 */
  | "angry"
  /** 被摸了好几下，得意 */
  | "smug"
  /** 撞到屏幕边 / 被冷落，委屈 */
  | "sad";

/** 动作 → 立绘（Q 版） */
export const ACTIVITY_POSE: Record<PetActivity, PetPose> = {
  idle: "front",
  react: "front",
  pat: "front",
  poke: "front",
  happy: "playing",
  think: "thinking",
  slack: "slacking",
  daydream: "daydreaming",
  bored: "bored",
  doze: "front",
  sleep: "sleep",
  work: "working",
  eat: "eating",
  drag: "side",
  peek: "side",
  // Q 版素材已经归档，没有这三张图，借用最接近的姿势 + 动效区分
  angry: "bored",
  smug: "playing",
  sad: "bored",
};

/**
 * 动作 → 立绘（写实版）。
 *
 * 写实素材只有正面，没有侧身和背面，所以「被拖动 / 探头」也用正面，靠贴边时的
 * 镜像和位移表达朝向。表情挑得尽量对得上动作语义：摸头脸红、撒欢和吃东西冒爱心、
 * 戳一戳和沉思眯眼、无聊到转圈。
 */
export const ACTIVITY_POSE_REAL: Record<PetActivity, RealPose> = {
  idle: "front",
  react: "front",
  pat: "blush",
  poke: "squint",
  happy: "heart",
  think: "squint",
  slack: "front",
  daydream: "front",
  bored: "dizzy",
  doze: "front",
  sleep: "front",
  work: "front",
  eat: "heart",
  drag: "front",
  peek: "front",
  angry: "gloom",
  smug: "smug",
  sad: "tears",
};

/** 某套素材下，这个动作该用哪张图 */
export function poseFor(style: PetStyle, activity: PetActivity): string {
  return style === "real" ? ACTIVITY_POSE_REAL[activity] : ACTIVITY_POSE[activity];
}

/** 会撒爱心粒子的动作 */
export const HEART_ACTIVITIES: ReadonlySet<PetActivity> = new Set<PetActivity>([
  "pat",
  "happy",
  "eat",
]);

/** 会冒 zzz 的动作 */
export const ZZZ_ACTIVITIES: ReadonlySet<PetActivity> = new Set<PetActivity>(["doze", "sleep"]);

/** 需要腮红的动作 */
export const BLUSH_ACTIVITIES: ReadonlySet<PetActivity> = new Set<PetActivity>(["pat", "happy"]);

/** 动作的中文名，右键菜单 / 托盘 / 开发预览共用 */
export const ACTIVITY_LABEL: Record<PetActivity, string> = {
  idle: "回神",
  react: "抬头",
  pat: "摸摸头",
  poke: "戳一戳",
  happy: "撒个欢",
  think: "沉思",
  slack: "摸鱼",
  daydream: "发呆",
  bored: "无聊",
  doze: "打瞌睡",
  sleep: "睡觉",
  work: "坐下干活",
  eat: "吃点心",
  drag: "被拖动",
  peek: "探头",
  angry: "生气了",
  smug: "得意",
  sad: "委屈",
};

export interface EyeBox {
  /** 眼睛中心 Y（352 画布坐标系） */
  y: number;
  height: number;
  width: number;
  leftX: number;
  rightX: number;
  /** 侧脸只能看到一只眼睛，右眼坐标无效 */
  single?: boolean;
}

export interface PoseMeta {
  file: string;
  drawRect: { x: number; y: number; w: number; h: number };
  eyes?: EyeBox;
}

export interface PetMeta {
  canvas: number;
  displaySize: number;
  poses: Record<string, PoseMeta>;
}

export const PET_BASE: Record<PetStyle, string> = {
  chibi: "/pet",
  real: "/pet-real",
};

/**
 * 立绘地址。
 *
 * 优先用 meta.json 里的 `file`——写实素材有多个动作共用同一张图的情况，
 * 靠文件名硬拼（`/pet-real/front.webp`）会把「动作名 = 文件名」这个假设焊死。
 */
export function poseUrl(style: PetStyle, pose: string, meta: PetMeta | null): string {
  const file = meta?.poses[pose]?.file ?? `${pose}.webp`;
  return `${PET_BASE[style]}/${file}`;
}

export async function loadPetMeta(style: PetStyle): Promise<PetMeta> {
  const res = await fetch(`${PET_BASE[style]}/meta.json`);
  if (!res.ok) {
    throw new Error(`加载 meta.json 失败：${res.status}`);
  }
  return (await res.json()) as PetMeta;
}
