/**
 * 把模型放进窗口的那点换算。
 *
 * 单独抽成纯函数，是因为这里**全是数学、没有一句 DOM**，而算错的症状
 * （立绘被拉扁、缩在角落里）只能靠肉眼盯窗口才看得出来。放在这里就能用
 * `tools/live2d-fit-test.mjs` 断言「等比、贴底、居中、不越界」，不用起 WebView。
 *
 * ## 为什么按「模型包围盒」而不是「模型画布」算
 *
 * Cubism 的画布尺寸是导出时定的，和内容不一定贴合——这套 moc3 的画布是
 * 1 × 2.053，而角色实际只占底部一条（不到画布高度的两成）。按画布铺满的话，
 * 桌宠就是一粒贴在窗口底边的像素；按包围盒算，角色才真的填满窗口。
 *
 * 包围盒由 `WhaleModel` 在加载后从 drawable 顶点实测得到，不写死任何数字。
 */

/** 模型在自身坐标系里的包围盒（Cubism 的 y 轴向上） */
export interface Bounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * 顶点 → 裁剪空间的仿射变换：`ndc = vertex * scale + translate`。
 *
 * 只用到对角两项和平移，所以四个数就够，不用交出整个 4×4。
 */
export interface Fit {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  /** 每个模型单位占多少像素。等比缩放的唯一比例，日志和自检都用它 */
  scale: number;
}

/**
 * 留一点余量。
 *
 * 包围盒是在初始姿势下量的，而呼吸会整体放大 1.5%、转头会让头发甩出轮廓，
 * 贴着边就会被窗口裁掉一小条。2% 的余量用户看不出来，但足以吃掉这些溢出。
 */
export const MARGIN = 0.98;

/** 退化包围盒（空模型、全透明）的下限，避免除零算出 Infinity 把整帧画飞 */
const EPSILON = 1e-6;

/**
 * 等比缩放 + 底部对齐 + 水平居中地放进视口。
 *
 * 「等比」是指两个方向用同一个像素比例——这正是之前出问题的地方：
 * 分别按 x / y 归一化会丢掉长宽比，人就被拉扁了。
 */
export function fitToViewport(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
): Fit {
  const width = Math.max(bounds.right - bounds.left, EPSILON);
  const height = Math.max(bounds.top - bounds.bottom, EPSILON);

  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    return { scaleX: 0, scaleY: 0, translateX: 0, translateY: 0, scale: 0 };
  }

  // 两个方向各算一次「铺满需要多大」，取小的那个：保证整个模型都在窗口里
  const scale = Math.min(viewportWidth / width, viewportHeight / height) * MARGIN;

  // 像素 → 裁剪空间：一个像素在 NDC 里是 2 / 边长
  const scaleX = (2 * scale) / viewportWidth;
  const scaleY = (2 * scale) / viewportHeight;

  const centerX = (bounds.left + bounds.right) / 2;

  return {
    scaleX,
    scaleY,
    // 水平居中：把包围盒中点挪到 x = 0
    translateX: -centerX * scaleX,
    // 底部对齐：包围盒底边落在裁剪空间的 -1（窗口下沿）
    translateY: -bounds.bottom * scaleY - 1,
    scale,
  };
}

/** 换算之后角色在窗口里占多少像素。日志和「画歪了」的自检都看这个 */
export function fittedSize(
  bounds: Bounds,
  fit: Fit,
): { width: number; height: number } {
  const width = Math.max(bounds.right - bounds.left, 0);
  const height = Math.max(bounds.top - bounds.bottom, 0);
  return { width: width * fit.scale, height: height * fit.scale };
}

/** 屏幕上的矩形（像素，图像坐标：y 向下） */
export interface PixelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 量完一帧之后算的**落位修正**，叠在原来的 MVP 后面。
 *
 * 为什么要这一步：顶点包围盒不等于着色范围——模型里有些 drawable 的顶点摊得比
 * 实际着色宽（遮罩用、或被整块涂透明），按顶点算会把角色算胖，等比缩放后就偏小。
 * 而画出来的像素是不会骗人的，量一次就能把误差一次消掉。
 *
 * 返回的是 NDC 空间的等比缩放 + 平移：把「当前内容框的底边中点」搬到 (0, -1)，
 * 并让内容等比铺满视口的一个方向。
 */
export function fixFromMeasured(
  box: PixelBox,
  viewportWidth: number,
  viewportHeight: number,
): { scale: number; translateX: number; translateY: number } {
  const width = Math.max(box.right - box.left, EPSILON);
  const height = Math.max(box.bottom - box.top, EPSILON);
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    return { scale: 1, translateX: 0, translateY: 0 };
  }

  const scale = Math.min(
    (viewportWidth * MARGIN) / width,
    (viewportHeight * MARGIN) / height,
  );

  // 当前内容框的底边中点，换到 NDC
  const centerX = (((box.left + box.right) / 2) / viewportWidth) * 2 - 1;
  const bottomY = 1 - (box.bottom / viewportHeight) * 2;

  // 目标：中点 → x = 0，底边 → y = -1
  return {
    scale,
    translateX: -centerX * scale,
    translateY: -bottomY * scale - 1,
  };
}

/**
 * 两个框的并集。
 *
 * 量落位要多帧取并集：呼吸、眨眼、头发物理都在动，单帧量到的是某个瞬间的轮廓，
 * 拿它当基准会让最终尺寸随「恰好量到哪一帧」漂几像素。
 */
export function unionBox(a: PixelBox | null, b: PixelBox): PixelBox {
  if (!a) return b;
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}
