/**
 * 鲸鱼娘的 Live2D 模型：加载、每帧驱动、绘制。
 *
 * 全部基于 Live2D 官方的 Cubism Web Framework（`src/live2d/cubism/`，原样拷贝，
 * 只加了 `@ts-nocheck`）。这里只写「把它跑起来」的那一层：
 *
 *   load()   —— 拉 model3.json / moc3 / 贴图 / 物理，建 WebGL 渲染器
 *   update() —— 注视、呼吸、眨眼、物理，最后 model.update()
 *   draw()   —— 按窗口宽高比算投影矩阵
 *
 * 不做的事：动作（motion）、表情文件（exp3）。这套模型的 13 个表情就是
 * `key1`…`key13` 十三个 0/1 参数，直接设参数比加载 exp3 简单得多，见 `params.ts`。
 */

import { CubismModelSettingJson } from "./cubism/cubismmodelsettingjson";
import { CubismUserModel } from "./cubism/model/cubismusermodel";
import { CubismMatrix44 } from "./cubism/math/cubismmatrix44";
import { CubismEyeBlink } from "./cubism/effect/cubismeyeblink";
import { CubismBreath, BreathParameterData } from "./cubism/effect/cubismbreath";
import { CubismFramework } from "./cubism/live2dcubismframework";
import { CubismDefaultParameterId } from "./cubism/cubismdefaultparameterid";
import { CubismIdHandle } from "./cubism/id/cubismid";
import { CubismWebGLOffscreenManager } from "./cubism/rendering/cubismoffscreenmanager";
import { CubismLogError } from "./cubism/utils/cubismdebug";
import { fixFromMeasured, fitToViewport, type Bounds, type Fit, type PixelBox } from "./fit";

/** 贴图目录、模型文件都在这个前缀下 */
export const MODEL_BASE = "/live2d/";
const SHADER_PATH = "/live2d/shaders/";

/** 呼吸的三个参数：参数 id、偏移、幅度、周期（秒）、权重 */
const BREATH = [
  [CubismDefaultParameterId.ParamAngleX, 0, 6, 3.2, 1],
  [CubismDefaultParameterId.ParamAngleY, 0, 4, 3.2, 1],
  [CubismDefaultParameterId.ParamBodyAngleX, 0, 2, 4.5, 1],
] as const;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`贴图加载失败：${url}`));
    image.src = url;
  });
}

export class WhaleModel extends CubismUserModel {
  private gl: WebGLRenderingContext | null = null;
  private shaderPath = SHADER_PATH;
  /** 参数 id 句柄缓存：每帧要设十几个参数，重复解析字符串太浪费 */
  private _ids = new Map<string, CubismIdHandle>();
  /** 角色包围盒，首帧量出来后缓存（顶点不随呼吸剧变，没必要每帧重算） */
  private _bounds: Bounds | null = null;
  /** 用实际像素校出来的落位修正，叠在 MVP 后面；null 表示还没校 */
  private _fitFix: Float32Array | null = null;

  /**
   * 加载模型并建好渲染器。
   *
   * 贴图必须**预乘 alpha**：透明窗口上如果按非预乘合成，头发边缘会出现一圈黑边。
   */
  async load(canvas: HTMLCanvasElement, gl: WebGLRenderingContext): Promise<void> {
    const settingBuffer = await (await fetch(`${MODEL_BASE}model.model3.json`)).arrayBuffer();
    const setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);
    this.gl = gl;

    const mocBuffer = await (await fetch(`${MODEL_BASE}${setting.getModelFileName()}`)).arrayBuffer();
    if (mocBuffer.byteLength === 0) throw new Error("moc3 是空的");
    this.loadModel(mocBuffer);

    this.createRenderer(canvas.width, canvas.height, 9);
    const renderer = this.getRenderer();
    renderer.startUp(gl);
    renderer.loadShaders(this.shaderPath);
    renderer.setIsPremultipliedAlpha(true);

    const count = setting.getTextureCount();
    for (let index = 0; index < count; index += 1) {
      const name = setting.getTextureFileName(index);
      if (!name) continue;
      const image = await loadImage(`${MODEL_BASE}${name}`);
      const texture = gl.createTexture();
      if (!texture) throw new Error("创建 WebGL 贴图失败");
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      // 贴图集不能重复采样，边缘必须夹住，否则描边会渗色
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      renderer.bindTexture(index, texture);
    }

    // 物理：头发、裙摆、尾巴的摆动全靠它，没有这个模型就是一张僵图
    const physicsFile = setting.getPhysicsFileName();
    if (physicsFile) {
      const buffer = await (await fetch(`${MODEL_BASE}${physicsFile}`)).arrayBuffer();
      this.loadPhysics(buffer, buffer.byteLength);
    }

    this._eyeBlink = CubismEyeBlink.create(setting);
    this._breath = CubismBreath.create();
    this._breath.setParameters(
      BREATH.map(
        ([id, offset, peak, cycle, weight]) =>
          new BreathParameterData(
            CubismFramework.getIdManager().getId(id),
            offset,
            peak,
            cycle,
            weight,
          ),
      ),
    );

    this.setInitialized(true);
  }

  /** 模型自带的画布尺寸，只在量不到包围盒时兜底 */
  canvasSize(): { width: number; height: number } {
    const model = this.getModel();
    return { width: model.getCanvasWidth(), height: model.getCanvasHeight() };
  }

  /**
   * 角色实际占多大（模型坐标下的包围盒）。
   *
   * 第一帧 `update()` 之后顶点才算出来，所以懒算一次并缓存。
   * **不按画布算**：这套 moc3 的画布是 1 × 2.053，角色只占底部一条，
   * 按画布铺满会让桌宠变成窗口底边的一粒像素。
   */
  bounds(): Bounds {
    if (this._bounds) return this._bounds;

    const measured = this.measureBounds();
    if (measured) {
      this._bounds = measured;
      return measured;
    }

    // 一个 drawable 都读不到（模型坏了）：退回画布，至少别让这一帧算飞。
    // 不缓存——下一帧顶点可能就有了
    const canvas = this.canvasSize();
    return {
      left: 0,
      right: canvas.width > 0 ? canvas.width : 1,
      bottom: 0,
      top: canvas.height > 0 ? canvas.height : 1,
    };
  }

  /**
   * 遍历所有**可见** drawable 的顶点取极值。只在首帧跑一次。
   *
   * 必须过滤可见性：模型里有些部件（备用表情、物理用的占位网格）默认是不可见的，
   * 顶点却摊在旁边很远的地方。不过滤的话包围盒会比角色宽出一大截，等比缩放之后
   * 人就缩水了——实测差 28%。
   *
   * 过滤之后要留意的是「首帧不可见、后面某个姿势才露出来」的部件。这套模型的表情
   * 是整组切换（`key1`…`key13` 互斥），备选部件都落在同一处，所以不会越界。
   */
  private measureBounds(): Bounds | null {
    const model = this.getModel();
    if (!model) return null;

    let left = Infinity;
    let right = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;

    const count = model.getDrawableCount();
    for (let index = 0; index < count; index += 1) {
      if (!model.getDrawableDynamicFlagIsVisible(index)) continue;
      if (model.getDrawableOpacity(index) <= 0.001) continue;
      const vertices = model.getDrawableVertexPositions(index);
      if (!vertices || vertices.length < 2) continue;
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        const x = vertices[i];
        const y = vertices[i + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < bottom) bottom = y;
        if (y > top) top = y;
      }
    }

    return left === Infinity ? null : { left, right, bottom, top };
  }

  /** 当前视口下的换算式（还没校正过的初值）。日志和自检都要看，所以单独暴露 */
  fit(viewportWidth: number, viewportHeight: number): Fit {
    return fitToViewport(this.bounds(), viewportWidth, viewportHeight);
  }

  /**
   * 按**实际画出来的像素**校正落位，只接受第一次调用。
   *
   * 为什么不能只靠顶点包围盒：模型里有些 drawable 的顶点摊得比着色范围宽
   * （遮罩用、或者整块被涂透明），按顶点算会把角色算胖，等比缩放后就偏小
   * （实测宽度虚高 25%，落位只有该有的 89%）。
   *
   * 顶点包围盒仍然有用——它是「先用它画一帧，才知道像素长什么样」的前提。
   * 校正量见 `fit.ts` 的 `fixFromMeasured`（等比 + 贴底居中，有单测）。
   *
   * @param box 实际内容的包围盒（设备像素，图像坐标，y 向下）
   */
  calibrate(box: PixelBox, viewportWidth: number, viewportHeight: number): boolean {
    if (this._fitFix) return false;
    if (box.right - box.left < 1 || box.bottom - box.top < 1) return false;
    if (!(viewportWidth > 0) || !(viewportHeight > 0)) return false;

    const fix = fixFromMeasured(box, viewportWidth, viewportHeight);

    const matrix = new Float32Array(16);
    matrix[0] = fix.scale;
    matrix[5] = fix.scale;
    matrix[10] = 1;
    matrix[12] = fix.translateX;
    matrix[13] = fix.translateY;
    matrix[15] = 1;

    this._fitFix = matrix;
    return true;
  }

  /** 按参数 id 设值。id 句柄查一次就缓存，别每帧去解析字符串 */
  setParam(id: string, value: number): void {
    if (!this.isInitialized()) return;
    let handle = this._ids.get(id);
    if (!handle) {
      handle = CubismFramework.getIdManager().getId(id);
      this._ids.set(id, handle);
    }
    this.getModel().setParameterValueById(handle, value, 1);
  }

  /**
   * 每帧驱动。
   *
   * 顺序有讲究：**呼吸先跑，注视后加，物理最后算**。
   * 呼吸是「设值」，会把同参数的注视偏移盖掉；物理要读最终角度，
   * 放前面就会慢一帧。
   *
   * @param dt 秒
   * @param gaze 光标相对窗口中心的归一化坐标，范围 -1..1
   */
  update(dt: number, gaze: { x: number; y: number }, blink: boolean): void {
    if (!this.isInitialized()) return;
    const model = this.getModel();
    const ids = CubismDefaultParameterId;

    this._breath?.updateParameters(model, dt);
    // 睡觉时不眨眼：眼睛由 params.ts 按动作直接按到 0
    if (blink) this._eyeBlink?.updateParameters(model, dt);

    // 注视：眼球 + 头部 + 胸腔分三级跟，全给满会像拨浪鼓
    model.addParameterValueById(ids.ParamAngleX, gaze.x * 22);
    model.addParameterValueById(ids.ParamAngleY, gaze.y * 18);
    model.addParameterValueById(ids.ParamAngleZ, gaze.x * gaze.y * -18);
    model.addParameterValueById(ids.ParamBodyAngleX, gaze.x * 8);
    model.addParameterValueById(ids.ParamEyeBallX, gaze.x, 1);
    model.addParameterValueById(ids.ParamEyeBallY, gaze.y, 1);

    this._physics?.evaluate(model, dt);
    model.update();
  }

  /**
   * 绘制。
   *
   * @param viewportWidth  **设备像素**（= canvas.width），不是 CSS 像素。
   *   gl 的视口和裁剪空间都以绘图缓冲为准，混用 CSS 尺寸会让整幅缩小一半
   *   （缩放比例正好是 devicePixelRatio 时最难发现——看着"就是有点小"）。
   *
   * 两件事都不能省：
   *
   * 1. **先 `setRenderState` 设视口**。框架自己不会设——遮罩流程会把视口改成
   *    离屏缓冲尺寸再"恢复"，而那个"上一次的视口"是上下文创建时的旧值。不显式设，
   *    绘制就一直落在画布左下角的一小块里。
   * 2. 矩阵由 `fit.ts` 算出：按角色包围盒**等比**缩放、贴底、居中。
   *    不能按模型画布算——画布比角色大一大截，按画布铺满就成了一粒像素。
   */
  draw(viewportWidth: number, viewportHeight: number): void {
    if (!this.isInitialized()) return;
    const gl = this.gl;
    if (!gl) return;

    const renderer = this.getRenderer();
    // fbo = null 表示默认帧缓冲（直接画到 canvas 上）
    renderer.setRenderState(null as unknown as WebGLFramebuffer, [
      0,
      0,
      viewportWidth,
      viewportHeight,
    ]);

    // Cubism 5 会把模型先画进离屏缓冲做剪切蒙版，最后再合成到屏幕上。
    // 这一对必须包住 drawModel，否则屏幕上（和 readPixels 里）都只有半成品。
    const offscreen = CubismWebGLOffscreenManager.getInstance();
    offscreen.beginFrameProcess(gl);

    const fit = this.fit(viewportWidth, viewportHeight);
    const matrix = new CubismMatrix44();
    // 列主序的 4×4：0 / 5 是对角缩放，12 / 13 是平移，其余保持单位阵
    const tr = new Float32Array(16);
    tr[0] = fit.scaleX;
    tr[5] = fit.scaleY;
    tr[10] = 1;
    tr[12] = fit.translateX;
    tr[13] = fit.translateY;
    tr[15] = 1;
    matrix.setMatrix(tr);

    // 已经按实际像素校过的话，修正矩阵叠在前面：结果 = fix × fit
    if (this._fitFix) {
      const fix = new CubismMatrix44();
      fix.setMatrix(this._fitFix);
      matrix.multiplyByMatrix(fix);
    }

    renderer.setMvpMatrix(matrix);
    renderer.drawModel(this.shaderPath);

    offscreen.endFrameProcess(gl);
  }

  /** 窗口尺寸变了（DPI 缩放、换屏）之后要同步渲染目标 */
  resize(width: number, height: number): void {
    if (!this.isInitialized()) return;
    this.getRenderer().setRenderTargetSize(width, height);
  }

  /** 读回整块画布（readPixels 是自下而上的，调用方自己翻） */
  readRaw(): { width: number; height: number; pixels: Uint8Array } | null {
    const gl = this.gl;
    if (!gl) return null;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { width, height, pixels };
  }

  /**
   * 读回整块画布，量出不透明像素的包围盒。
   *
   * 只用来回答「到底画出来没有、画得对不对」：全透明说明没画上，
   * 包围盒铺满整块画布说明投影矩阵算错了（模型被撑爆）。
   * 一次性的，跑完就不要再调。
   */
  measure(): {
    width: number;
    height: number;
    ratio: number;
    box: { left: number; top: number; right: number; bottom: number } | null;
  } {
    const gl = this.gl;
    if (!gl) return { width: 0, height: 0, ratio: 0, box: null };
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let opaque = 0;
    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (pixels[(y * width + x) * 4 + 3] <= 8) continue;
        opaque += 1;
        if (x < left) left = x;
        if (x > right) right = x;
        // readPixels 的原点在左下角，翻回「从上往下」的行号
        const row = height - 1 - y;
        if (row < top) top = row;
        if (row > bottom) bottom = row;
      }
    }
    return {
      width,
      height,
      ratio: opaque / (width * height),
      box: right >= 0 ? { left, top, right, bottom } : null,
    };
  }

  override release(): void {
    super.release();
    this.gl = null;
    CubismLogError("WhaleModel released");
  }
}
