import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bootCubism } from "./core";
import type { WhaleModel } from "./WhaleModel";
import { unionBox, type PixelBox } from "./fit";
import { allowsBlink, approach, paramsFor } from "./params";
import type { PetActivity } from "../pet/poses";
import "./live2d.css";

interface Props {
  activity: PetActivity;
  /** 任何一步失败都回退到静态立绘，绝不让桌宠开天窗 */
  onFail: (reason: string) => void;
}

/** 目标帧率。桌宠不需要 60fps，30 帧省一半 GPU */
const FPS = 30;
/** 参数朝目标靠拢的时间常数（秒） */
const PARAM_TAU = 0.1;
/** 光标离开后多久把注视收回中间 */
const GAZE_TAU = 0.25;
/**
 * 量落位的那段帧区间（含两端）。
 *
 * 模型加载完先按顶点包围盒落位，跑几帧之后根据**实际像素**校正一次——
 * 顶点比着色范围宽，只靠顶点会小一圈。量的时候注视强制归零、多帧取并集，
 * 免得把「正好转头」的瞬时轮廓当成尺寸。
 */
const SAMPLE_START = 20;
const SAMPLE_END = 40;

const PARAM_IDS = [
  "key1",
  "key2",
  "key3",
  "key4",
  "key5",
  "key6",
  "key7",
  "key8",
  "key9",
  "key10",
  "key11",
  "key12",
  "key13",
  "Movement1",
  "Movement2",
  "Movement3",
  "ParamEyeLOpen",
  "ParamEyeROpen",
  "ParamMouthOpenY",
] as const;

/** 网页里的日志在 tauri dev 的终端里看不见，转发到 Rust 的 stderr */
function report(message: string): void {
  void invoke("web_log", { message }).catch(() => {
    console.log(message);
  });
}

/**
 * 把画布后备存储对齐到元素尺寸（CSS 像素 × DPR）。
 *
 * 返回有没有真的变过：变了就得同步渲染目标，否则离屏缓冲还是旧尺寸。
 * `clientWidth` 在布局没落定时可能是 0，所以要夹一个下限，别让画布变成 0×0。
 */
function syncCanvasSize(canvas: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

/**
 * 落位要满足的三条几何事实，**和「包围盒量得准不准」无关**
 * （顶点包围盒比实际着色区域宽 25%，拿它当基准会误报）：
 *
 *   1. 有一个方向被填满（≥90%）——不是缩在角落里；
 *   2. 两个方向都没溢出——没被裁；
 *   3. 贴底、水平居中。
 */
function layoutIssues(box: PixelBox, width: number, height: number): string[] {
  const fill = Math.max((box.right - box.left) / width, (box.bottom - box.top) / height);
  const issues: string[] = [];
  if (fill <= 0.9) issues.push(`只填了 ${(fill * 100).toFixed(0)}%`);
  if (fill > 1.001) issues.push("溢出窗口");
  const bottomGap = height - box.bottom;
  if (bottomGap > 4) issues.push(`离底 ${bottomGap}px`);
  const offCenter = Math.abs((box.left + box.right) / 2 - width / 2);
  if (offCenter > 4) issues.push(`偏心 ${offCenter.toFixed(1)}px`);
  return issues;
}

function describeLayout(box: PixelBox, width: number, height: number): string {
  return `${box.right - box.left}×${box.bottom - box.top} @ (${box.left},${box.top}) / 画布 ${width}×${height}`;
}

/** 把当前画布存成 PNG（`%TEMP%\whale-live2d.png`），构图不对时才调 */
function dumpPixels(model: WhaleModel): void {
  const raw = model.readRaw();
  if (!raw) return;
  const flipped = new Uint8Array(raw.pixels.length);
  const stride = raw.width * 4;
  for (let row = 0; row < raw.height; row += 1) {
    flipped.set(
      raw.pixels.subarray((raw.height - 1 - row) * stride, (raw.height - row) * stride),
      row * stride,
    );
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < flipped.length; i += chunk) {
    binary += String.fromCharCode(...flipped.subarray(i, i + chunk));
  }
  void invoke("web_dump_pixels", {
    width: raw.width,
    height: raw.height,
    rgbaBase64: btoa(binary),
  }).catch(() => {});
}

/**
 * Live2D 立绘。
 *
 * 和静态立绘是同一层「皮肤」：外面还是 `.pet__land` / `.pet__breathe` 那套壳，
 * 只是把 `<img>` 换成一块 WebGL 画布。壳上的 CSS 动效（落地回弹、拖拽倾斜、
 * 贴边镜像）继续生效，呼吸和眨眼交给模型自己——所以 `.pet--live` 会关掉
 * `pet-breathe`，不然会叠成两套呼吸。
 */
export function Live2DPet({ activity, onFail }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<WhaleModel | null>(null);
  const activityRef = useRef(activity);
  const gazeRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const [ready, setReady] = useState(false);
  activityRef.current = activity;

  const fail = useCallback(
    (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      report(`[live2d] 回退到静态立绘：${reason}`);
      onFail(reason);
    },
    [onFail],
  );

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let timer = 0;
    let observer: ResizeObserver | null = null;

    void (async () => {
      try {
        await bootCubism();
        const canvas = canvasRef.current;
        if (!canvas) throw new Error("画布还没挂上");

        const gl = canvas.getContext("webgl", {
          alpha: true,
          premultipliedAlpha: true,
          antialias: true,
        });
        if (!gl) throw new Error("WebGL 不可用");

        // 渲染目标要按后备存储尺寸建，所以尺寸必须先定下来
        syncCanvasSize(canvas);

        // Core 就位之后才能 import 模型类：它引用的框架模块在顶层就要用 Live2DCubismCore
        const { WhaleModel } = await import("./WhaleModel");
        const model = new WhaleModel();
        await model.load(canvas, gl);
        if (disposed) {
          model.release();
          return;
        }
        modelRef.current = model;

        // 换屏、改缩放比例、切立绘风格都会让元素尺寸变，离屏缓冲得跟着走
        observer = new ResizeObserver(() => {
          if (disposed) return;
          if (!syncCanvasSize(canvas)) return;
          model.resize(canvas.width, canvas.height);
        });
        observer.observe(canvas);

        setReady(true);

        const current = new Map<string, number>(
          PARAM_IDS.map((id) => [
            id,
            id.startsWith("key") || id.startsWith("Movement") ? 0 : 1,
          ]),
        );
        let last = performance.now();
        let frames = 0;
        /** 量落位用的并集框 */
        let sample: PixelBox | null = null;

        const frame = () => {
          raf = requestAnimationFrame(frame);
          const now = performance.now();
          const elapsed = now - last;
          if (elapsed < 1000 / FPS) return;
          last = now;
          const dt = Math.min(elapsed / 1000, 0.1);

          // 注视：光标在窗口里就跟着走，离开就慢慢回中间。
          // 量落位的那段时间强制归零——转头会把头发甩到一边，量出来的是瞬时轮廓。
          const gaze = gazeRef.current;
          const sampling = frames >= SAMPLE_START && frames <= SAMPLE_END;
          if (sampling) {
            gaze.x = 0;
            gaze.y = 0;
          } else {
            gaze.x = approach(gaze.x, gaze.tx, dt, GAZE_TAU);
            gaze.y = approach(gaze.y, gaze.ty, dt, GAZE_TAU);
          }

          const target = paramsFor(activityRef.current);
          for (const id of PARAM_IDS) {
            let goal = 0;
            if (id === "ParamEyeLOpen" || id === "ParamEyeROpen") goal = target.eyeOpen;
            else if (id === "ParamMouthOpenY") goal = target.mouth;
            else goal = target.toggles[id] ?? 0;
            const value = approach(current.get(id) ?? 0, goal, dt, PARAM_TAU);
            current.set(id, value);
            model.setParam(id, value);
          }

          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          model.update(dt, { x: gaze.x, y: gaze.y }, allowsBlink(activityRef.current));
          // 传设备像素：视口和裁剪空间都以绘图缓冲为准
          model.draw(canvas.width, canvas.height);

          frames += 1;

          // 20–40 帧连着量、取并集（呼吸和头发物理一直在动，单帧不准），
          // 量完按实际像素校正一次落位
          if (sampling) {
            const shot = model.measure();
            if (shot.box) sample = unionBox(sample, shot.box);
            if (frames === SAMPLE_END) {
              if (!sample) {
                report("[live2d] 一直是全透明——没画上");
              } else if (layoutIssues(sample, shot.width, shot.height).length === 0) {
                report(`[live2d] ${describeLayout(sample, shot.width, shot.height)} 落位正确`);
              } else if (model.calibrate(sample, shot.width, shot.height)) {
                report(
                  `[live2d] ${describeLayout(sample, shot.width, shot.height)} ` +
                    `${layoutIssues(sample, shot.width, shot.height).join("、")}，已按实际像素校正`,
                );
              }
            }
          }

          // 校正之后复核一次：真对了才算数
          if (frames === SAMPLE_END + 20) {
            const shot = model.measure();
            if (!shot.box) {
              report("[live2d] 校正后变成全透明——出问题了");
              dumpPixels(model);
              return;
            }
            const issues = layoutIssues(shot.box, shot.width, shot.height);
            report(
              `[live2d] ${describeLayout(shot.box, shot.width, shot.height)}` +
                (issues.length ? ` ← ${issues.join("、")}` : " 落位正确"),
            );
            if (issues.length) dumpPixels(model);
          }
        };
        raf = requestAnimationFrame(frame);
      } catch (err) {
        if (!disposed) fail(err);
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      observer?.disconnect();
      modelRef.current?.release();
      modelRef.current = null;
    };
  }, [fail]);

  // 注视：直接听 window 的 mousemove。桌宠窗口很小，鼠标只要在窗口里就会触发；
  // 不用给画布开 pointer-events，免得和外面的摸头 / 拖拽抢命中。
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const gaze = gazeRef.current;
      gaze.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      gaze.ty = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    };
    const onLeave = () => {
      gazeRef.current.tx = 0;
      gazeRef.current.ty = 0;
    };
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div className="live2d">
      <canvas ref={canvasRef} className={`live2d__canvas${ready ? " live2d__canvas--on" : ""}`} />
    </div>
  );
}
