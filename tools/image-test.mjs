/**
 * 图片处理的纯算术单测（`src/panel/image.ts`）。
 *
 *   node --experimental-strip-types tools/image-test.mjs
 *
 * 像素操作在 canvas 里没法在这儿验，但「裁多大、缩到多少、叫什么名」这些一旦算错，
 * 界面上只是「图有点糊 / 有点变形 / 存出两个同名文件」，肉眼很难发现——所以全压在这层。
 */

import assert from "node:assert/strict";

const {
  extOf,
  formatBytes,
  mimeOf,
  outputStem,
  planSize,
  resolveFormat,
  savingLabel,
  savingPercent,
  stemOf,
  usesQuality,
} = await import("../src/panel/image.ts");

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/* ------------------------------------------------------------ 格式 */

test("保持原格式：按扩展名推，认不出来给 PNG", () => {
  assert.equal(resolveFormat("keep", "IMG_1234.JPG"), "jpeg");
  assert.equal(resolveFormat("keep", "shot.jpeg"), "jpeg");
  assert.equal(resolveFormat("keep", "logo.PNG"), "png");
  assert.equal(resolveFormat("keep", "anim.webp"), "webp");
  assert.equal(resolveFormat("keep", "noext"), "png");
  assert.equal(resolveFormat("keep", "weird.tiff"), "png");
});

test("选了格式就按选的来", () => {
  assert.equal(resolveFormat("webp", "IMG_1234.JPG"), "webp");
  assert.equal(resolveFormat("jpeg", "logo.png"), "jpeg");
});

test("MIME / 扩展名 / 要不要质量", () => {
  assert.equal(mimeOf("jpeg"), "image/jpeg");
  assert.equal(mimeOf("webp"), "image/webp");
  assert.equal(mimeOf("png"), "image/png");

  // 落盘一律写 jpg，和 Rust 侧白名单对齐
  assert.equal(extOf("jpeg"), "jpg");
  assert.equal(extOf("png"), "png");

  // PNG 不吃 quality，界面上要把质量那排藏掉
  assert.equal(usesQuality("png"), false);
  assert.equal(usesQuality("jpeg"), true);
});

/* ------------------------------------------------------------ 尺寸与裁剪 */

const size = (width, height) => ({ width, height });

test("什么都不选：原样", () => {
  assert.deepEqual(planSize(size(4000, 3000), "none", 0), {
    sx: 0,
    sy: 0,
    sw: 4000,
    sh: 3000,
    dw: 4000,
    dh: 3000,
  });
});

test("裁 1:1：横图以高为准，左右各裁一半", () => {
  assert.deepEqual(planSize(size(4000, 3000), "1:1", 0), {
    sx: 500,
    sy: 0,
    sw: 3000,
    sh: 3000,
    dw: 3000,
    dh: 3000,
  });
});

test("裁 16:9：竖着裁，上下各去一块", () => {
  assert.deepEqual(planSize(size(4000, 3000), "16:9", 0), {
    sx: 0,
    sy: 375,
    sw: 4000,
    sh: 2250,
    dw: 4000,
    dh: 2250,
  });
});

test("裁 4:3：竖图以宽为准", () => {
  assert.deepEqual(planSize(size(3000, 4000), "4:3", 0), {
    sx: 0,
    sy: 875,
    sw: 3000,
    sh: 2250,
    dw: 3000,
    dh: 2250,
  });
});

test("长边限制：等比缩，不裁", () => {
  const plan = planSize(size(4000, 3000), "none", 1920);
  assert.equal(plan.dw, 1920);
  assert.equal(plan.dh, 1440);
  assert.equal(plan.sw, 4000);
});

test("长边限制：小图不放大（放大会糊）", () => {
  const plan = planSize(size(640, 480), "none", 1920);
  assert.equal(plan.dw, 640);
  assert.equal(plan.dh, 480);
});

test("先裁后缩：两个一起用时尺寸对得上", () => {
  const plan = planSize(size(4000, 3000), "1:1", 800);
  assert.deepEqual(plan, { sx: 500, sy: 0, sw: 3000, sh: 3000, dw: 800, dh: 800 });
});

test("极端情况也不会算出 0 宽高（canvas 会直接报错）", () => {
  const plan = planSize(size(1, 1), "16:9", 0);
  assert.ok(plan.dw >= 1 && plan.dh >= 1, JSON.stringify(plan));
  assert.ok(plan.sw >= 1 && plan.sh >= 1, JSON.stringify(plan));
});

/* ------------------------------------------------------------ 文件名 */

test("取文件名主干：带目录、带点、没扩展名", () => {
  assert.equal(stemOf("C:\\Users\\me\\IMG_1234.JPG"), "IMG_1234");
  assert.equal(stemOf("D:/pics/a.b.c.png"), "a.b.c");
  assert.equal(stemOf("noext"), "noext");
  // 以点开头的隐藏文件不该被截成空字符串
  assert.equal(stemOf(".gitignore"), ".gitignore");
});

test("输出名带上尺寸，换质量再存一次也不会撞", () => {
  assert.equal(outputStem("IMG_1234.JPG", 1920, 1440), "IMG_1234-1920x1440");
});

/* ------------------------------------------------------------ 体积文案 */

test("字节数给人看", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(2.4 * 1024 * 1024), "2.4 MB");
});

test("压缩率：小了说小了，大了也如实说", () => {
  assert.equal(savingLabel(1000, 270), "小了 73%");
  // 把 JPEG 存成 PNG 会变大，不能显示成「省了 -12%」
  assert.equal(savingLabel(1000, 1120), "大了 12%");
  assert.equal(savingLabel(1000, 998), "大小基本没变");
});

test("压缩率：原图 0 字节时不除零", () => {
  assert.equal(savingPercent(0, 100), 0);
  assert.equal(savingPercent(1000, 0), 100);
});

console.log(`\n${passed} passed`);
