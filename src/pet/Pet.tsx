import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  BLUSH_ACTIVITIES,
  HEART_ACTIVITIES,
  ZZZ_ACTIVITIES,
  poseFor,
  poseUrl,
  type PetActivity,
  type PetMeta,
  type PetStyle,
} from "./poses";
import "./pet.css";

/**
 * Live2D 运行时按需加载。
 *
 * 官方框架 + Core 加起来将近 1 MB，静态立绘是默认形态，绝大多数启动用不上，
 * 所以走 `lazy` 单独切一个 chunk，只有真的开了动态立绘才会下载。
 */
const Live2DPet = lazy(() =>
  import("../live2d/Live2DPet").then((module) => ({ default: module.Live2DPet })),
);

interface PetProps {
  activity: PetActivity;
  meta: PetMeta | null;
  /** 用哪套立绘 */
  style: PetStyle;
  /** 用 Live2D 动态立绘（只有写实风格有模型） */
  live?: boolean;
  /** 动态立绘挂了就回退到静态图，由外面记一笔 */
  onLiveFail?: (reason: string) => void;
  /** 拖拽倾斜角度（度） */
  tilt?: number;
  /** 水平镜像：1 正常，-1 翻转（贴左边时朝右看） */
  flip?: number;
  /** 落地回弹计数，变化即重播一次落地动画 */
  land?: number;
  /** 粒子爆发计数 */
  burst?: number;
}

const FADE_MS = 180;

/**
 * 落地回弹的关键帧（这里就是唯一来源，`pet.css` 里不再有 `@keyframes pet-land`）。
 *
 * 为什么不用 CSS 动画：**重播必须能可靠地重头播**。试过两种更"省事"的写法，都不行：
 *   - `key={land}` 重挂这层 → 里面的 Live2D 画布跟着重挂，模型整个重载；
 *   - 摘掉 `style.animation` 再挂回去（中间强制回流）→ 这版 WebView2 里不生效。
 *
 * `element.animate()` 每次调用都是一个全新的 Animation，一定从第一帧开始。
 */
const LAND_KEYFRAMES = [
  { transform: "scaleY(0.94) scaleX(1.04)" },
  { transform: "scaleY(1.02) scaleX(0.985)", offset: 0.55 },
  { transform: "scale(1)" },
] as const;

const LAND_ANIMATION: KeyframeAnimationOptions = {
  duration: 420,
  easing: "cubic-bezier(0.2, 0.9, 0.3, 1.4)",
};

/** 爱心 / 星星粒子的一次性布局 */
interface Particle {
  id: number;
  left: number;
  top: number;
  size: number;
  delay: number;
  drift: number;
  color: string;
}

const HEART_COLORS = ["#4b8bdc", "#f58ba8", "#c9a227", "#7fb0ff"];

function makeParticles(count: number, seed: number): Particle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: seed * 100 + index,
    left: 22 + Math.random() * 56,
    top: 42 + Math.random() * 16,
    size: 9 + Math.random() * 7,
    delay: Math.random() * 260,
    drift: (Math.random() - 0.5) * 34,
    color: HEART_COLORS[(seed + index) % HEART_COLORS.length],
  }));
}

function Hearts({ burst }: { burst: number }) {
  const particles = useMemo(() => makeParticles(5, burst), [burst]);
  return (
    <div className="fx fx--hearts">
      {particles.map((p) => (
        <span
          key={p.id}
          className="fx__heart"
          style={
            {
              left: `${p.left}%`,
              top: `${p.top}%`,
              fontSize: p.size,
              color: p.color,
              animationDelay: `${p.delay}ms`,
              "--drift": `${p.drift}px`,
            } as CSSProperties
          }
        >
          ♥
        </span>
      ))}
    </div>
  );
}

/** zzz 是循环的：只要她在睡就一直冒 */
function Zzz({ activity }: { activity: PetActivity }) {
  const deep = activity === "sleep";
  return (
    <div className={`fx fx--zzz${deep ? " fx--zzz-deep" : ""}`}>
      {["z", "Z", "z"].map((glyph, index) => (
        <span
          key={`${activity}-${index}`}
          className="fx__z"
          style={
            {
              left: `${60 + index * 7}%`,
              top: `${26 - index * 4}%`,
              fontSize: 11 + index * 4,
              animationDelay: `${index * 780}ms`,
            } as CSSProperties
          }
        >
          {glyph}
        </span>
      ))}
    </div>
  );
}

function Sparkles() {
  return (
    <div className="fx fx--sparkles">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="fx__spark"
          style={
            {
              left: `${18 + index * 28}%`,
              top: `${30 + (index % 2) * 14}%`,
              animationDelay: `${index * 180}ms`,
            } as CSSProperties
          }
        >
          ✦
        </span>
      ))}
    </div>
  );
}

export function Pet({
  activity,
  meta,
  style,
  live = false,
  onLiveFail,
  tilt = 0,
  flip = 1,
  land = 0,
  burst = 0,
}: PetProps) {
  const pose = poseFor(style, activity);
  const eyes = meta?.poses[pose]?.eyes;

  // 交叉淡入：切图时保留旧图淡出，避免硬切。
  // 记的是「已上屏的地址」而不是姿势名——换立绘风格时姿势名可能没变
  // （idle 还是 front），只比姿势就不会淡入。
  const currentSrc = poseUrl(style, pose, meta);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const shown = useRef({ key: `${style}:${pose}`, src: currentSrc });

  useEffect(() => {
    const key = `${style}:${pose}`;
    if (shown.current.key === key) {
      shown.current.src = currentSrc;
      return;
    }
    setOutgoing(shown.current.src);
    shown.current = { key, src: currentSrc };
    const timer = window.setTimeout(() => setOutgoing(null), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [style, pose, currentSrc]);

  const scale = meta ? meta.displaySize / meta.canvas : 0.5;

  const landRef = useRef<HTMLDivElement | null>(null);

  /**
   * 落地回弹：挂载时播一次，`land` 每变一次再播一次。
   *
   * 关键点是**不能重挂子树**——里面是 WebGL 画布，重挂一次就要重新下载 16MB 的
   * moc3 加 5 张 4096² 贴图（"拖一下就重载一次"就是这么来的）。
   * 用 `element.animate()` 在不重挂的前提下从头播，见上面 `LAND_KEYFRAMES` 的注释。
   */
  useEffect(() => {
    const node = landRef.current;
    if (!node) return;
    // 系统开了「减少动态效果」就不弹，和 pet.css 里那条 media query 一致
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    node.animate(LAND_KEYFRAMES as unknown as Keyframe[], LAND_ANIMATION);
  }, [land]);

  /** 腮红放在眼睛下方偏外侧，位置由眼睛坐标推出来，不用额外标定 */
  const blushStyle = (centerX: number, outward: number): CSSProperties | undefined =>
    eyes
      ? {
          left: (centerX + outward * eyes.width * 0.35 - eyes.width * 0.45) * scale,
          top: (eyes.y + eyes.height * 0.55) * scale,
          width: eyes.width * 0.9 * scale,
          height: eyes.height * 0.42 * scale,
        }
      : undefined;

  const rootStyle = {
    "--tilt": `${tilt}deg`,
    "--flip": flip,
  } as CSSProperties;

  return (
    <div className={`pet pet--${activity}${live ? " pet--live" : ""}`} style={rootStyle}>
      <div className="pet__land" ref={landRef}>
        <div className="pet__breathe">
          {live ? (
            <Suspense fallback={null}>
              <Live2DPet activity={activity} onFail={onLiveFail ?? noop} />
            </Suspense>
          ) : (
            <>
              {outgoing && (
                <img className="pet__img pet__img--out" src={outgoing} alt="" draggable={false} />
              )}
              <img className="pet__img" src={currentSrc} alt="鲸鱼娘" draggable={false} />
              {eyes && BLUSH_ACTIVITIES.has(activity) && (
                <>
                  <span className="pet__blush" style={blushStyle(eyes.leftX, -1)} />
                  {!eyes.single && (
                    <span className="pet__blush" style={blushStyle(eyes.rightX, 1)} />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {HEART_ACTIVITIES.has(activity) && <Hearts burst={burst} />}
      {ZZZ_ACTIVITIES.has(activity) && <Zzz activity={activity} />}
      {activity === "happy" && <Sparkles />}
    </div>
  );
}

/** 没传 onLiveFail 时的兜底，避免每次渲染都新建一个函数 */
function noop(): void {
  /* 动态立绘失败但没人接：什么都不做，静态图会顶上 */
}
