import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HEART_ACTIVITIES, type PetActivity } from "./poses";

/**
 * 待机行为状态机。
 *
 * 两把尺子分开量，这是和上一版最大的区别：
 *
 * - **away**（系统闲置）：用户多久没碰键鼠。只有这个能让她打盹、睡死——
 *   人在写代码时她该安静待着，不该自顾自地睡过去；反过来人真离开了，
 *   几分钟就该睡着。数据来自 Rust 的 `system_idle`（Windows 走 GetLastInputInfo）。
 * - **sincePet**（多久没理我）：只影响「无聊程度」，发呆、摸鱼、抱膝都用它。
 *   用户一直在用电脑但从不点她，她照样会越来越颓。
 *
 *   0–20s     常态站立（呼吸）
 *   20s–90s   发呆 / 沉思
 *   90s+      摸鱼 / 无聊
 *   离开 4min 打瞌睡 → 8min 睡死（夜间阈值 0.45 折）
 *
 * 另外两件「互动记忆」：
 * - 短时间内连戳 5 下 → 生气，并进入一段冷战期，摸头也只会被顶回来；
 * - 连摸 3 下 → 得意。
 */

const TICK_MS = 900;
/** 系统闲置轮询间隔。打盹是分钟级的，2 秒的粒度够用，也不会太吵 */
const IDLE_POLL_MS = 2_000;

/** 各档位进入阈值（毫秒） */
const DREAMY_AFTER = 20_000;
const LAZY_AFTER = 90_000;
const DOZY_AFTER = 4 * 60_000;
const ASLEEP_AFTER = 8 * 60_000;
const NIGHT_FACTOR = 0.45;

/** 连戳判定：2.5 秒内 5 下 */
const POKE_WINDOW = 2_500;
const POKE_LIMIT = 5;
/** 生气之后的冷战时长：这段时间里摸头也会被顶回来 */
const ANGRY_COOLDOWN = 12_000;
/** 连摸判定：6 秒内 3 下 */
const PAT_WINDOW = 6_000;
const PAT_LIMIT = 3;

/** 台词：只在她「主动说话」的时机出现，避免话痨 */
const LINES: Partial<Record<PetActivity, string[]>> = {
  pat: ["唔…好舒服～", "再摸一下嘛…", "头发要乱啦！", "嘿嘿…被摸到了"],
  poke: ["呀！", "干嘛戳我～", "在的在的", "别闹啦…"],
  happy: ["今天也要加油哦！", "嘿咻～", "心情不错！"],
  think: ["这个 bug 到底在哪…", "让我想想…", "唔，逻辑好像不通"],
  slack: ["就摸五分钟鱼…", "假装在思考", "休息一下下…", "反正也没人看见"],
  daydream: ["云好像棉花糖…", "什么时候能下班呀", "海里的风是什么味道呢"],
  bored: ["好无聊…", "理理我嘛", "你已经很久没看我了"],
  doze: ["困…", "眼皮好重…", "再撑一下…"],
  sleep: ["Zzz…", "呼…呼…"],
  work: ["开始干活！", "专注模式启动", "这条我盯着呢"],
  eat: ["唔姆唔姆…", "好吃！", "谢谢投喂～"],
  drag: ["要带我去哪～", "轻点轻点…", "晕…"],
  peek: ["就靠这儿了", "视野不错～"],
  idle: ["桌面巡逻中～", "我在这儿呢"],
  angry: ["哼！不理你了", "再戳我就咬人！", "讨厌啦…", "够了吧你！"],
  smug: ["嘿嘿…知道我的好了吧", "再多摸几下也行", "哼哼～"],
  sad: ["呜…撞到了", "好疼…", "干嘛把我丢出去…"],
};

type Band = "calm" | "dreamy" | "lazy" | "dozy" | "asleep";

const BAND_ACTIVITIES: Record<Band, PetActivity[]> = {
  calm: ["idle"],
  dreamy: ["daydream", "think", "idle"],
  lazy: ["slack", "bored", "daydream"],
  dozy: ["doze", "doze", "idle"],
  asleep: ["sleep"],
};

/** 每个档位里单个动作的持续时间（毫秒） */
const BAND_HOLD: Record<Band, [number, number]> = {
  calm: [6_000, 10_000],
  dreamy: [11_000, 19_000],
  lazy: [14_000, 26_000],
  dozy: [18_000, 34_000],
  asleep: [120_000, 240_000],
};

function isNight(date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= 23 || hour < 7;
}

/**
 * 选档位。两把尺子各管一半：`away` 决定睡不睡，`sincePet` 决定颓不颓。
 *
 * `away` 一定不大于 `sincePet`（点桌宠本身也算系统输入），所以两段判断不会打架。
 */
function bandFor(away: number, sincePet: number): Band {
  const k = isNight() ? NIGHT_FACTOR : 1;
  if (away >= ASLEEP_AFTER * k) return "asleep";
  if (away >= DOZY_AFTER * k) return "dozy";
  if (sincePet >= LAZY_AFTER) return "lazy";
  if (sincePet >= DREAMY_AFTER) return "dreamy";
  return "calm";
}

function randomOf<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickOther(pool: readonly PetActivity[], current: PetActivity): PetActivity {
  const rest = pool.filter((item) => item !== current);
  return randomOf(rest.length > 0 ? rest : pool);
}

function holdFor(band: Band): number {
  const [min, max] = BAND_HOLD[band];
  return min + Math.random() * (max - min);
}

/** 只留下窗口期内的时间戳，顺便把新的一次塞进去 */
function within(stamps: number[], now: number, windowMs: number): number[] {
  return [...stamps, now].filter((at) => now - at < windowMs);
}

export interface PetBehavior {
  /** 当前动作 */
  activity: PetActivity;
  /** 粒子爆发计数，每次摸头 / 撒欢都会 +1，用来重播动画 */
  burst: number;
  /** 摸头 */
  pat: () => void;
  /** 戳一戳（连戳 5 下会生气） */
  poke: () => void;
  /** 指定动作演一段时间，之后回到自动状态机 */
  play: (activity: PetActivity, holdMs?: number) => void;
  /** 撞到屏幕边之类的「小意外」，演一下委屈 */
  sulk: () => void;
  /** 把她叫醒 / 重置空闲计时 */
  wake: () => void;
  /** 只重置空闲计时，不改变当前动作 */
  touch: () => void;
  /** 冒一句台词 */
  say: (text: string) => void;
}

export function usePetBehavior(docked = false): PetBehavior {
  const [activity, setActivity] = useState<PetActivity>("idle");
  const [burst, setBurst] = useState(0);

  const activityRef = useRef<PetActivity>("idle");
  const holdUntilRef = useRef(0);
  const pinnedRef = useRef(false);
  const lastActiveRef = useRef(Date.now());
  const lastLineRef = useRef("");
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  /** 系统闲置毫秒数；null 表示拿不到（纯浏览器里跑），退回按 sincePet 算 */
  const systemIdleRef = useRef<number | null>(null);
  /** 上一轮是不是处于「离开」状态，用来判断「刚回来」 */
  const wasAwayRef = useRef(false);
  const pokeStampsRef = useRef<number[]>([]);
  const patStampsRef = useRef<number[]>([]);
  const angryUntilRef = useRef(0);

  const say = useCallback((text: string) => {
    if (!text) return;
    lastLineRef.current = text;
    invoke("pet_say", { text }).catch(() => {
      // 开发期在纯浏览器里跑没有这个命令，静默跳过
    });
  }, []);

  const apply = useCallback((next: PetActivity, holdMs: number) => {
    activityRef.current = next;
    holdUntilRef.current = Date.now() + holdMs;
    setActivity(next);
    if (HEART_ACTIVITIES.has(next)) setBurst((value) => value + 1);
  }, []);

  const touch = useCallback(() => {
    lastActiveRef.current = Date.now();
  }, []);

  const play = useCallback(
    (next: PetActivity, holdMs = 5_200) => {
      pinnedRef.current = true;
      apply(next, holdMs);
    },
    [apply],
  );

  const speakFor = useCallback(
    (next: PetActivity, chance = 1) => {
      const pool = LINES[next];
      if (!pool || pool.length === 0) return;
      if (Math.random() > chance) return;
      const candidates = pool.filter((line) => line !== lastLineRef.current);
      say(randomOf(candidates.length > 0 ? candidates : pool));
    },
    [say],
  );

  /** 摸头。冷战期会被顶回来；连摸三下变得意 */
  const pat = useCallback(() => {
    touch();
    const now = Date.now();
    pinnedRef.current = true;

    if (now < angryUntilRef.current) {
      apply("angry", 1_400);
      say("哼，还在生气呢");
      return;
    }

    patStampsRef.current = within(patStampsRef.current, now, PAT_WINDOW);
    if (patStampsRef.current.length >= PAT_LIMIT) {
      patStampsRef.current = [];
      apply("smug", 3_200);
      speakFor("smug");
      return;
    }

    apply("pat", 1_500);
    speakFor("pat");
  }, [apply, speakFor, touch]);

  /** 戳一戳。2.5 秒内戳满 5 下就翻脸 */
  const poke = useCallback(() => {
    touch();
    const now = Date.now();
    pinnedRef.current = true;

    pokeStampsRef.current = within(pokeStampsRef.current, now, POKE_WINDOW);
    if (pokeStampsRef.current.length >= POKE_LIMIT) {
      pokeStampsRef.current = [];
      angryUntilRef.current = now + ANGRY_COOLDOWN;
      apply("angry", 4_000);
      speakFor("angry");
      return;
    }

    apply("poke", 1_200);
    speakFor("poke", 0.75);
  }, [apply, speakFor, touch]);

  const sulk = useCallback(() => {
    pinnedRef.current = true;
    apply("sad", 2_600);
    speakFor("sad");
  }, [apply, speakFor]);

  const wake = useCallback(() => {
    touch();
    const current = activityRef.current;
    const deep = current === "sleep" || current === "doze";
    pinnedRef.current = true;
    if (deep) {
      apply("happy", 1_800);
      say("呼噜……唔，醒啦！");
      return;
    }
    apply("idle", 3_000);
  }, [apply, say, touch]);

  // 系统闲置：只有人真的离开才让她睡，人在用电脑时她只是「无聊」
  useEffect(() => {
    let alive = true;
    const poll = () => {
      invoke<number>("system_idle")
        .then((seconds) => {
          if (alive) systemIdleRef.current = seconds * 1000;
        })
        .catch(() => {
          // 非 Tauri 环境：保持 null，退回按 sincePet 算
        });
    };
    poll();
    const timer = window.setInterval(poll, IDLE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 状态机心跳：只在「当前动作演完」且「没被用户钉住」时才换动作
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const sincePet = now - lastActiveRef.current;
      const systemIdle = systemIdleRef.current;
      const away = systemIdle === null ? sincePet : Math.min(systemIdle, sincePet);

      // 刚回来：从瞌睡里被叫醒，主动打个招呼
      const wasAway = wasAwayRef.current;
      wasAwayRef.current = away >= DOZY_AFTER;
      if (wasAway && away < 3_000 && !pinnedRef.current) {
        const current = activityRef.current;
        if (current === "sleep" || current === "doze") {
          apply("happy", 2_200);
          say("唔…你回来啦");
          return;
        }
      }

      if (now < holdUntilRef.current) return;
      pinnedRef.current = false;

      const band = bandFor(away, sincePet);
      // 贴着屏幕边的时候，常态改成侧身靠着，别站着挡路
      const pool: PetActivity[] =
        band === "calm" && dockedRef.current ? ["peek"] : BAND_ACTIVITIES[band];
      const current = activityRef.current;

      // 一半概率留在当前动作，避免每 10 秒就换一次脸
      const stay = pool.includes(current) && pool.length > 1 && Math.random() < 0.5;
      const next = stay ? current : pickOther(pool, current);

      if (next === current && band !== "asleep") {
        holdUntilRef.current = now + holdFor(band);
        return;
      }

      apply(next, holdFor(band));
      // 摸鱼、发呆这类「有情绪」的动作，偶尔嘀咕一句
      if (next === "slack" || next === "daydream" || next === "bored") {
        speakFor(next, 0.25);
      }
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, [apply, speakFor]);

  return useMemo(
    () => ({ activity, burst, pat, poke, play, sulk, wake, touch, say }),
    [activity, burst, pat, poke, play, sulk, wake, touch, say],
  );
}
