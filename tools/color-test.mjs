/**
 * 颜色换算的单测。
 *
 * 这个模块是纯函数、没有 DOM 依赖，所以直接拿 Node 跑，不用引入测试框架：
 *
 *   node --experimental-strip-types tools/color-test.mjs
 *
 * （Node 22.6+ 支持剥类型；不传参数时新版 Node 也默认开。）
 */

import assert from "node:assert/strict";

const { parseColor, toHex, toRgbString, toHslString, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb } =
  await import("../src/panel/color.ts");

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/* ------------------------------------------------------------ 品牌色做基准 */

const BRAND = { r: 53, g: 92, b: 182 };

test("HEX 输出补零且小写", () => {
  assert.equal(toHex(BRAND), "#355cb6");
  assert.equal(toHex({ r: 0, g: 0, b: 0 }), "#000000");
  assert.equal(toHex({ r: 255, g: 255, b: 255 }), "#ffffff");
  assert.equal(toHex({ r: 1, g: 2, b: 3 }), "#010203");
});

test("RGB / HSL 字符串格式", () => {
  assert.equal(toRgbString(BRAND), "rgb(53, 92, 182)");
  assert.equal(toHslString(BRAND), "hsl(222, 55%, 46%)");
});

test("RGB → HSL 与手算一致", () => {
  const hsl = rgbToHsl(BRAND);
  assert.equal(Math.round(hsl.h), 222);
  assert.equal(Math.round(hsl.s), 55);
  assert.equal(Math.round(hsl.l), 46);
});

test("灰阶没有色相和饱和度", () => {
  assert.deepEqual(
    (({ h, s, l }) => ({ h, s, l: Math.round(l) }))(rgbToHsl({ r: 128, g: 128, b: 128 })),
    { h: 0, s: 0, l: 50 },
  );
});

test("HSL → RGB 回到原色", () => {
  const back = hslToRgb(rgbToHsl(BRAND));
  assert.equal(toHex(back), "#355cb6");
});

test("HSV 往返不丢精度", () => {
  const hsv = rgbToHsv(BRAND);
  assert.equal(Math.round(hsv.h), 222);
  assert.equal(toHex(hsvToRgb(hsv)), "#355cb6");
});

test("纯色在各模型里对得上", () => {
  assert.equal(toHex(hslToRgb({ h: 0, s: 100, l: 50 })), "#ff0000");
  assert.equal(toHex(hslToRgb({ h: 120, s: 100, l: 50 })), "#00ff00");
  assert.equal(toHex(hslToRgb({ h: 240, s: 100, l: 50 })), "#0000ff");
  assert.equal(toHex(hsvToRgb({ h: 0, s: 1, v: 1 })), "#ff0000");
  assert.equal(toHex(hsvToRgb({ h: 300, s: 1, v: 1 })), "#ff00ff");
});

test("色相绕圈：360 与 0 同色，负数也认", () => {
  assert.equal(toHex(hslToRgb({ h: 360, s: 100, l: 50 })), "#ff0000");
  assert.equal(toHex(hslToRgb({ h: -120, s: 100, l: 50 })), "#0000ff");
});

/* ------------------------------------------------------------ 文本解析 */

test("解析 HEX：带井号、不带、三位缩写", () => {
  assert.deepEqual(parseColor("#355CB6"), BRAND);
  assert.deepEqual(parseColor("355cb6"), BRAND);
  assert.deepEqual(parseColor("  #355cb6  "), BRAND);
  assert.deepEqual(parseColor("#3CB"), { r: 0x33, g: 0xcc, b: 0xbb });
});

test("解析 rgb() / rgba()", () => {
  assert.deepEqual(parseColor("rgb(53, 92, 182)"), BRAND);
  assert.deepEqual(parseColor("rgba(53,92,182,0.5)"), BRAND);
  assert.deepEqual(parseColor("rgb(53 92 182)"), BRAND);
});

test("解析 hsl()", () => {
  const rgb = parseColor("hsl(222, 55%, 46%)");
  assert.ok(rgb !== null);
  // 222/55/46 是品牌色四舍五入后的写法，转回 RGB 允许每个通道差 1
  assert.ok(Math.abs(rgb.r - BRAND.r) <= 1, `r=${rgb.r}`);
  assert.ok(Math.abs(rgb.g - BRAND.g) <= 1, `g=${rgb.g}`);
  assert.ok(Math.abs(rgb.b - BRAND.b) <= 1, `b=${rgb.b}`);
});

test("解析裸三元组", () => {
  assert.deepEqual(parseColor("53 92 182"), BRAND);
  assert.deepEqual(parseColor("53,92,182"), BRAND);
});

test("越界分量收进 0–255", () => {
  assert.deepEqual(parseColor("rgb(300, -20, 128)"), { r: 255, g: 0, b: 128 });
});

test("认不出来就返回 null，不瞎猜", () => {
  assert.equal(parseColor(""), null);
  assert.equal(parseColor("   "), null);
  assert.equal(parseColor("#12345"), null);
  assert.equal(parseColor("红色"), null);
  assert.equal(parseColor("rgb(1,2)"), null);
  assert.equal(parseColor("hsl(abc)"), null);
});

console.log(`\n${passed} passed`);
