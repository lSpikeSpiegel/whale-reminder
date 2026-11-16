/**
 * 动作 → Live2D 参数。
 *
 * 这套模型的「表情」不是 exp3 文件，而是 13 个 0/1 参数（`key1`…`key13`）——
 * 作者在 VTube Studio 里用键盘 1–9 切表情，绑的就是它们。直接设参数比加载
 * exp3 少一层解析，而且能做平滑过渡（exp3 是硬切）。
 *
 * `Movement1/2/3` 是三个手臂姿势（狗尾草 / 抚胸 / 竖食指），同样 0/1。
 */

import type { PetActivity } from "../pet/poses";

/** 作者留的表情键，名字取自 cdi3.json 里的中文备注 */
const KEY = {
  gloom: "key1", // 1. 黑脸
  tears: "key2", // 2. 落泪
  dizzy: "key3", // 3. 圈圈眼
  heart: "key4", // 4. 爱心眼
  squint: "key5", // 5. > <眼
  smug: "key6", // 6. 屑屑眼
  blush: "key7", // 7. 脸红
  loading: "key8", // 8. 加载
  teeth: "key9", // 9. 大牙
  basin: "key10", // 10. 大钢盆
  glasses: "key11", // 11. 黑框眼镜
  monocle: "key12", // 12. 单片眼镜
  sweat: "key13", // 13. 流冷汗
} as const;

const MOVE = {
  grass: "Movement1", // 狗尾草
  chest: "Movement2", // 抚胸
  point: "Movement3", // 竖食指
} as const;

export interface PetParams {
  /** 0/1 开关类参数，键是参数 id */
  toggles: Record<string, number>;
  /** 眼睛开合 0–1 */
  eyeOpen: number;
  /** 嘴 0–1 */
  mouth: number;
}

const NEUTRAL: PetParams = { toggles: {}, eyeOpen: 1, mouth: 0 };

/** 动作 → 参数。没列出的动作就是默认站姿。 */
export function paramsFor(activity: PetActivity): PetParams {
  switch (activity) {
    case "pat":
      return { toggles: { [KEY.blush]: 1 }, eyeOpen: 1, mouth: 0.15 };
    case "poke":
      return { toggles: { [KEY.squint]: 1 }, eyeOpen: 1, mouth: 0.4 };
    case "happy":
      return { toggles: { [KEY.heart]: 1 }, eyeOpen: 1, mouth: 0.6 };
    case "think":
      return { toggles: { [MOVE.point]: 1 }, eyeOpen: 1, mouth: 0 };
    case "slack":
      return { toggles: { [MOVE.grass]: 1 }, eyeOpen: 1, mouth: 0.2 };
    case "bored":
      return { toggles: { [KEY.dizzy]: 1 }, eyeOpen: 1, mouth: 0.1 };
    case "eat":
      return { toggles: { [KEY.teeth]: 1 }, eyeOpen: 1, mouth: 0.5 };
    case "work":
      return { toggles: { [MOVE.chest]: 1 }, eyeOpen: 1, mouth: 0 };
    case "angry":
      return { toggles: { [KEY.gloom]: 1 }, eyeOpen: 1, mouth: 0.3 };
    case "smug":
      return { toggles: { [KEY.smug]: 1 }, eyeOpen: 1, mouth: 0.25 };
    case "sad":
      return { toggles: { [KEY.tears]: 1 }, eyeOpen: 0.6, mouth: 0.2 };
    case "doze":
      return { toggles: {}, eyeOpen: 0.15, mouth: 0 };
    case "sleep":
      return { toggles: {}, eyeOpen: 0, mouth: 0 };
    default:
      return NEUTRAL;
  }
}

/** 需要闭嘴不眨眼的动作（眨眼会和「眼睛按到 0」打架） */
export function allowsBlink(activity: PetActivity): boolean {
  return activity !== "sleep" && activity !== "doze";
}

/**
 * 逐帧朝目标靠拢。
 *
 * 参数硬切会「啪」地换脸；这里用指数衰减，`tau` 秒内走完约 63%。
 * 0.1 秒左右接近人眨眼的速度，够快但不跳。
 */
export function approach(current: number, target: number, dt: number, tau = 0.1): number {
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}
