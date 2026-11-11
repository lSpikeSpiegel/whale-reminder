/** 桌宠状态机 —— 由 Rust 侧事件驱动，前端只负责渲染 */

export type PetState =
  | "idle"
  | "react"
  | "remind"
  | "think"
  | "sleep"
  | "celebrate"
  | "drag";

/** 状态 → 立绘映射（见 docs/04-pet-character-design.md 第 4 节） */
export const STATE_POSE: Record<PetState, string> = {
  idle: "front",
  react: "front",
  remind: "working",
  think: "thinking",
  sleep: "sleep",
  celebrate: "playing",
  drag: "side",
};

export interface EyeBox {
  /** 眼睛中心 Y（352 画布坐标系） */
  y: number;
  height: number;
  width: number;
  leftX: number;
  rightX: number;
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

export const PET_BASE = "/pet";

export function poseUrl(pose: string): string {
  return `${PET_BASE}/${pose}.webp`;
}

export async function loadPetMeta(): Promise<PetMeta> {
  const res = await fetch(`${PET_BASE}/meta.json`);
  if (!res.ok) {
    throw new Error(`加载 meta.json 失败：${res.status}`);
  }
  return (await res.json()) as PetMeta;
}
