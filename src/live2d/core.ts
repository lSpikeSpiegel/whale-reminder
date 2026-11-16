/**
 * Cubism Core 的按需加载与框架初始化。
 *
 * Core 是一个 228 KB 的 UMD 脚本（`assets/live2d/core/live2dcubismcore.min.js`，
 * Live2D Proprietary Software License 明确把它列为「可再分发文件」），
 * 它把自己挂在 `window.Live2DCubismCore` 上。
 *
 * **框架必须在 Core 之后才 import**：`cubismmodel.ts` 在模块顶层就引用了
 * `Live2DCubismCore`，静态 import 会让它先于 Core 求值，直接
 * `ReferenceError: Live2DCubismCore is not defined`。所以这里只用动态 import。
 *
 * 为什么不写在 index.html 里：静态立绘是默认形态，绝大多数启动用不到 Core。
 */

/** 走 vite 的 publicDir（= assets/），和立绘素材同一个根 */
const CORE_URL = "/live2d/core/live2dcubismcore.min.js";

let booting: Promise<void> | null = null;

function hasCore(): boolean {
  return (
    typeof (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore !==
    "undefined"
  );
}

function injectCore(): Promise<void> {
  if (hasCore()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CORE_URL;
    script.async = true;
    script.onload = () => {
      if (hasCore()) resolve();
      else reject(new Error("Core 脚本已加载，但没挂上 Live2DCubismCore"));
    };
    script.onerror = () => reject(new Error(`加载 ${CORE_URL} 失败`));
    document.head.appendChild(script);
  });
}

/**
 * 加载 Core 并初始化框架。重复调用只会跑一次；失败后清掉缓存，下次还能重试。
 */
export function bootCubism(): Promise<void> {
  if (booting) return booting;
  booting = (async () => {
    await injectCore();
    const { CubismFramework, Option } = await import("./cubism/live2dcubismframework");
    CubismFramework.startUp(new Option());
    CubismFramework.initialize();
  })().catch((err: unknown) => {
    booting = null;
    throw err;
  });
  return booting;
}
