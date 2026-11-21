/**
 * 动态立绘在这个构建里可不可用。
 *
 * 模型本体（`model.moc3` 16 MB + `textures/` 5 张 1024² 贴图）0.8.0 起随仓库入库，
 * 所以官方的开发版和 Actions 产物都带着素材。判据仍然必须是「素材到底在不在」，
 * 而不是「这是不是开发版」——早先用 `import.meta.env.DEV` 判断，本地
 * `pnpm tauri build` 出来的 release 明明带着 `assets/live2d/`（`publicDir` 整个目录
 * 会拷进 `dist`），却照样被挡在门外，桌宠只剩静态图。
 *
 * 现在启动时探一下贴图目录里最小的一张：
 * - 探得到 → 开发版、release 一律当可用，Live2D 走起；
 * - 探不到 → 素材被人为裁掉的构建（比如为了减体积手工删掉 `assets/live2d/`），
 *   整块按静态图处理，别让用户点到一个「点了静默退回静态图」的开关。
 *
 * 探测必须在挂载前跑完（见 `main.tsx`）：`App` 和设置页都同步读
 * `live2dAvailable()`，事后再翻牌会让桌宠先闪一张静态图。
 * 也**别**为了省一次调用把它提到模块顶层求值——`import App from "./App"`
 * 会在 `detectLive2D()` 之前就执行。
 */

/** 贴图里最小的一张（112 KB）。它和模型本体同进同出，探它就够 */
const PROBE_URL = "/live2d/textures/tex_04.png";

/** 探测上限：可选功能不值得卡住整个应用，超时按「没有素材」处理 */
const PROBE_TIMEOUT_MS = 1_200;

let available = false;
let probing: Promise<boolean> | null = null;

/**
 * 同步读探测结果。挂载前已经定下来，组件里读到的都是终值。
 */
export function live2dAvailable(): boolean {
  return available;
}

/**
 * 探一次素材，重复调用只发一次请求。
 *
 * **永远 resolve，不抛错**：调用方是 `main.tsx` 的挂载流程，
 * 一个可选功能不能因为 404 或者协议不认就把整个界面拦住。
 */
export function detectLive2D(): Promise<boolean> {
  if (probing) return probing;
  probing = (async () => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(PROBE_URL, { signal: abort.signal, cache: "no-store" });
      available = response.ok;
    } catch {
      // 404 / 超时 / 自定义协议拒绝，都按「没有素材」处理
      available = false;
    } finally {
      window.clearTimeout(timer);
    }
    if (!available && import.meta.env.DEV) {
      console.warn(`[live2d] 没探到 ${PROBE_URL}，动态立绘按不可用处理`);
    }
    return available;
  })();
  return probing;
}
