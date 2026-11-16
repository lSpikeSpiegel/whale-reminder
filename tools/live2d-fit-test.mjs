/**
 * Live2D 落位换算的单测。
 *
 * 这段数学唯一的作用是把模型「等比、贴底、居中」塞进窗口，但算错了在画面上只表现为
 * 「看着怪」（拉扁、缩在角落），靠肉眼盯窗口很难判断到底错在哪。抽成纯函数之后
 * 就能直接断言几何关系，不用起 WebView：
 *
 *   node --experimental-strip-types tools/live2d-fit-test.mjs
 */

import assert from "node:assert/strict";

const { fitToViewport, fittedSize, fixFromMeasured, unionBox } = await import(
  "../src/live2d/fit.ts"
);

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/**
 * 把变换套到包围盒四角，换算成「像素矩形」，模拟屏幕上会落在哪。
 * NDC → 像素：x 占 [-1,1] 映射到 [0, W]，y 向上所以要从底边翻。
 */
function project(bounds, fit, width, height) {
  const xs = [bounds.left, bounds.right].map((x) => (x * fit.scaleX + fit.translateX + 1) / 2 * width);
  const ys = [bounds.bottom, bounds.top].map((y) => (1 - (y * fit.scaleY + fit.translateY + 1) / 2) * height);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

/** 这套 moc3 的真实数字：画布 1 × 2.053，角色只占底部一条 */
const SLIVER = { left: 0.18, right: 0.82, bottom: 0.01, top: 0.39 };
/** 竖构图模型（写实立绘那种 9 头身） */
const TALL = { left: -0.5, right: 0.5, bottom: -1.95, top: 1.95 };

test("宽扁模型：铺满宽度、贴底、水平居中", () => {
  const fit = fitToViewport(SLIVER, 172, 340);
  const rect = project(SLIVER, fit, 172, 340);
  const size = fittedSize(SLIVER, fit);

  assert.ok(Math.abs(rect.bottom - 340) < 0.01, `底边该贴窗口下沿，实际 ${rect.bottom}`);
  assert.ok(Math.abs(rect.left + rect.right - 172) < 0.01, "该水平居中");
  // 宽扁模型受宽度限制，所以宽度先满
  assert.ok(Math.abs(size.width - 172 * 0.98) < 0.01, `宽度该接近满窗（留 2% 余量），实际 ${size.width}`);
  assert.ok(size.height < 340, "高度不该撑满——宽扁模型撑满就超出窗口了");
});

test("竖构图模型：铺满高度，不会被裁到", () => {
  const fit = fitToViewport(TALL, 172, 340);
  const size = fittedSize(TALL, fit);
  const rect = project(TALL, fit, 172, 340);

  assert.ok(Math.abs(size.height - 340 * 0.98) < 0.01, `高度该接近满窗，实际 ${size.height}`);
  assert.ok(rect.left >= -0.01 && rect.right <= 172.01, "不该横向越界");
  assert.ok(Math.abs(rect.bottom - 340) < 0.01, "该贴底");
});

test("等比：两个方向的像素比例一致（拉扁的根源就在这）", () => {
  for (const bounds of [SLIVER, TALL]) {
    const fit = fitToViewport(bounds, 344, 680);
    const pxPerUnitX = fit.scaleX * (344 / 2);
    const pxPerUnitY = fit.scaleY * (680 / 2);
    assert.ok(
      Math.abs(pxPerUnitX - pxPerUnitY) < 1e-9,
      `x 方向 ${pxPerUnitX} 与 y 方向 ${pxPerUnitY} 不一致，人会被拉扁`,
    );
    assert.ok(Math.abs(fit.scale - pxPerUnitX) < 1e-9, "scale 要等于实际每单位像素数");
  }
});

test("落位后的宽高比等于模型自身的宽高比", () => {
  const fit = fitToViewport(SLIVER, 344, 680);
  const size = fittedSize(SLIVER, fit);
  const modelAspect = (SLIVER.right - SLIVER.left) / (SLIVER.top - SLIVER.bottom);
  assert.ok(
    Math.abs(size.width / size.height - modelAspect) < 1e-9,
    `落位宽高比 ${size.width / size.height} 应等于模型 ${modelAspect}`,
  );
});

test("窗口尺寸翻倍：落位尺寸同步翻倍", () => {
  const small = fittedSize(SLIVER, fitToViewport(SLIVER, 172, 340));
  const large = fittedSize(SLIVER, fitToViewport(SLIVER, 344, 680));
  assert.ok(Math.abs(large.width - small.width * 2) < 1e-9);
  assert.ok(Math.abs(large.height - small.height * 2) < 1e-9);
});

test("退化输入不产生 Infinity / NaN", () => {
  const flat = { left: 0, right: 0, bottom: 0, top: 0 };
  for (const fit of [fitToViewport(flat, 172, 340), fitToViewport(SLIVER, 0, 0)]) {
    for (const value of Object.values(fit)) {
      assert.ok(Number.isFinite(value), `换算出非有限值：${value}`);
    }
  }
});

/* ------------------------------------------------ 按实际像素做的落位校正 */

/** 把像素坐标换成 NDC，套上校正量，再换回像素——模拟叠在 MVP 后面的效果 */
function applyFix(box, fix, width, height) {
  const map = (px, py) => {
    const x = (px / width) * 2 - 1;
    const y = 1 - (py / height) * 2;
    return {
      x: x * fix.scale + fix.translateX,
      y: y * fix.scale + fix.translateY,
    };
  };
  const topLeft = map(box.left, box.top);
  const bottomRight = map(box.right, box.bottom);
  return {
    top: ((1 - topLeft.y) / 2) * height,
    bottom: ((1 - bottomRight.y) / 2) * height,
    left: ((topLeft.x + 1) / 2) * width,
    right: ((bottomRight.x + 1) / 2) * width,
  };
}

test("校正量把实测框搬成「居中 + 贴底 + 98% 高」", () => {
  const W = 344;
  const H = 680;
  // 这是真机量到的一组数：顶点算出来的落位只有 89% 高，且偏左 5px
  const box = { left: 36, right: 298, top: 72, bottom: 679 };
  const fix = fixFromMeasured(box, W, H);
  const rect = applyFix(box, fix, W, H);

  assert.ok(Math.abs(rect.bottom - H) < 0.5, `底边该贴到 ${H}，实际 ${rect.bottom}`);
  assert.ok(Math.abs(rect.top - (H - H * 0.98)) < 1, `高度该是 98% 窗口高，实际顶边 ${rect.top}`);
  assert.ok(Math.abs((rect.left + rect.right) / 2 - W / 2) < 0.5, "该水平居中");
  assert.ok(rect.left > 0 && rect.right < W, "不该横向溢出");
});

test("校正量是等比的（不会把立绘拉扁）", () => {
  const W = 344;
  const H = 680;
  const box = { left: 10, right: 320, top: 40, bottom: 600 };
  const fix = fixFromMeasured(box, W, H);
  const rect = applyFix(box, fix, W, H);
  const sourceAspect = (box.right - box.left) / (box.bottom - box.top);
  const resultAspect = (rect.right - rect.left) / (rect.bottom - rect.top);
  assert.ok(
    Math.abs(sourceAspect - resultAspect) < 1e-9,
    `宽高比变了：${sourceAspect} → ${resultAspect}`,
  );
});

test("校正量对退化输入不产生 NaN", () => {
  const fix = fixFromMeasured({ left: 0, right: 0, top: 0, bottom: 0 }, 344, 680);
  for (const value of Object.values(fix)) {
    assert.ok(Number.isFinite(value), `换算出非有限值：${value}`);
  }
});

test("并集框只增不减", () => {
  const a = { left: 10, right: 100, top: 20, bottom: 200 };
  const b = { left: 40, right: 160, top: 5, bottom: 150 };
  assert.deepEqual(unionBox(a, b), { left: 10, right: 160, top: 5, bottom: 200 });
  // 第一次（还没有累计值）直接取新的
  assert.deepEqual(unionBox(null, b), b);
});

console.log(`\n${passed} passed`);
