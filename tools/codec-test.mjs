/**
 * 编解码的单测。
 *
 * 这个模块是纯函数、没有 DOM 依赖，和颜色换算一样直接拿 Node 跑：
 *
 *   node --experimental-strip-types tools/codec-test.mjs
 */

import assert from "node:assert/strict";

const {
  encodeBase64,
  decodeBase64,
  encodeUrl,
  decodeUrl,
  encodeHtml,
  decodeHtml,
  encodeUnicode,
  decodeUnicode,
  toTimestamp,
  fromTimestamp,
  runCodec,
  FORMATS,
  FORMAT_MAP,
} = await import("../src/panel/codec.ts");

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/** 断言成功并拿到结果，失败时把 error 打进断言消息 */
const good = (result) => {
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return result;
};

/** 断言失败并拿到错误文案 */
const bad = (result) => {
  assert.equal(result.ok, false, "本该报错，却解成功了");
  return result.error;
};

/* ------------------------------------------------------------ Base64 */

test("Base64 编码：ASCII / 中文 / emoji", () => {
  assert.equal(good(encodeBase64("hello")).text, "aGVsbG8=");
  assert.equal(good(encodeBase64("中文")).text, "5Lit5paH");
  assert.equal(good(encodeBase64("🐳")).text, "8J+Qsw==");
  assert.equal(good(encodeBase64("")).text, "");
});

test("Base64 往返：多行和 emoji 都不掉字节", () => {
  const source = "第一行\n第二行 🐳 tab\tend";
  assert.equal(good(decodeBase64(good(encodeBase64(source)).text)).text, source);
});

test("Base64 解码容忍换行、省略的 = 和 URL 安全字符", () => {
  assert.equal(good(decodeBase64("aGVsbG8=")).text, "hello");
  assert.equal(good(decodeBase64("aGVsbG8")).text, "hello");
  assert.equal(good(decodeBase64("aGVs\nbG8=")).text, "hello");
  assert.equal(good(decodeBase64(" 5Lit5paH ")).text, "中文");

  // 取一段含 + / 的 Base64，换成 URL 安全写法再去解，结果应当一致
  const source = "ÿÿ??>>~~";
  const standard = good(encodeBase64(source)).text;
  const urlsafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(good(decodeBase64(urlsafe)).text, source);
});

test("Base64 解码容忍 data URL 前缀", () => {
  assert.equal(good(decodeBase64("data:image/png;base64,aGVsbG8=")).text, "hello");
});

test("Base64 解不开要说清楚原因", () => {
  bad(decodeBase64("!!!!"));
  bad(decodeBase64("a"));
  bad(decodeBase64(""));
  // 0xFF 不是合法的 UTF-8 起始字节——多半是图片，别硬塞一堆 � 装作解开了
  assert.match(bad(decodeBase64("/w==")), /UTF-8/);
});

/* ------------------------------------------------------------ URL */

test("URL 编解码", () => {
  const source = "a b&c=d 中文?";
  const encoded = good(encodeUrl(source)).text;
  assert.equal(encoded, "a%20b%26c%3Dd%20%E4%B8%AD%E6%96%87%3F");
  assert.equal(good(decodeUrl(encoded)).text, source);
});

test("URL 解码不把 + 当空格", () => {
  // encodeURIComponent 从不产出 +，把它读成空格会改坏路径和搜索词
  assert.equal(good(decodeUrl("a+b")).text, "a+b");
});

test("URL 残缺的 % 转义要报错", () => {
  assert.match(bad(decodeUrl("100%")), /% 转义/);
  assert.match(bad(decodeUrl("%ZZ")), /% 转义/);
});

/* ------------------------------------------------------------ HTML 实体 */

test("HTML 实体编码只转五个结构字符", () => {
  assert.equal(
    good(encodeHtml(`<p class="x">a & b 'c'</p>`)).text,
    "&lt;p class=&quot;x&quot;&gt;a &amp; b &#39;c&#39;&lt;/p&gt;",
  );
  // 中文、引号外的标点都不动
  assert.equal(good(encodeHtml("中文，不动")).text, "中文，不动");
});

test("HTML 实体解码：命名实体 + 十进制 + 十六进制", () => {
  assert.equal(good(decodeHtml("&lt;p&gt;&amp;&quot;&#39;")).text, `<p>&"'`);
  assert.equal(good(decodeHtml("&nbsp;")).text, "\u00a0");
  assert.equal(good(decodeHtml("&#38;&#x26;")).text, "&&");
  assert.equal(good(decodeHtml("&#x1F433;")).text, "🐳");
});

test("HTML 实体往返，且不会二次解码", () => {
  const source = `<a href="/x?a=1&b=2">点 & 走</a>`;
  const encoded = good(encodeHtml(source)).text;
  assert.equal(good(decodeHtml(encoded)).text, source);
  // &amp;lt; 只解一层，得到 &lt; 而不是 <
  assert.equal(good(decodeHtml("&amp;lt;")).text, "&lt;");
});

test("认不出的实体原样留着，别把文本改坏", () => {
  assert.equal(good(decodeHtml("&foo; 和 &amp 还有 &#xZZ;")).text, "&foo; 和 &amp 还有 &#xZZ;");
});

/* ------------------------------------------------------------ Unicode 转义 */

test("Unicode 转义：中文、emoji、控制字符", () => {
  assert.equal(good(encodeUnicode("中文")).text, "\\u4e2d\\u6587");
  assert.equal(good(encodeUnicode("🐳")).text, "\\u{1f433}");
  assert.equal(good(encodeUnicode("a\nb\tc")).text, "a\\nb\\tc");
});

test("Unicode 往返：反斜杠和 emoji 都不丢", () => {
  for (const source of ["中文 🐳", "C:\\tmp\\new", "换行\n制表\t", "plain ascii"]) {
    assert.equal(good(decodeUnicode(good(encodeUnicode(source)).text)).text, source);
  }
});

test("Unicode 解码认 \\uXXXX / \\u{...} / \\xXX", () => {
  assert.equal(good(decodeUnicode("\\u4e2d\\u6587")).text, "中文");
  assert.equal(good(decodeUnicode("\\u{1f433}")).text, "🐳");
  assert.equal(good(decodeUnicode("\\x41\\x42")).text, "AB");
  assert.equal(good(decodeUnicode("\\u0041")).text, "A");
});

test("Unicode 解码不认识的转义原样保留", () => {
  assert.equal(good(decodeUnicode("C:\\dir")).text, "C:\\dir");
  assert.equal(good(decodeUnicode("\\q")).text, "\\q");
});

/* ------------------------------------------------------------ 时间戳 */

test("日期 → 时间戳：带时区和不带时区", () => {
  assert.equal(good(toTimestamp("2023-11-14T22:13:20Z")).text, "1700000000");
  assert.equal(good(toTimestamp("2023-11-14T22:13:20+08:00")).text, "1699971200");
  assert.equal(good(toTimestamp("2023-11-14T22:13:20-05:00")).text, String(1700000000 + 5 * 3600));
});

test("日期 → 时间戳：认这些写法", () => {
  assert.equal(good(toTimestamp("2023-11-14 22:13:20")).text, good(toTimestamp("2023-11-14T22:13:20")).text);
  assert.equal(good(toTimestamp("2023/11/14 22:13:20")).text, good(toTimestamp("2023-11-14 22:13:20")).text);
  assert.equal(good(toTimestamp("2023年11月14日 22:13:20")).text, good(toTimestamp("2023-11-14 22:13:20")).text);
  // 只写日期就是当天零点
  assert.equal(good(toTimestamp("2023-11-14")).text, good(toTimestamp("2023-11-14 00:00:00")).text);
});

test("时间戳 → 日期：秒和毫秒都认", () => {
  const seconds = good(fromTimestamp("1700000000"));
  assert.deepEqual(seconds.rows.map((row) => row.key), ["秒", "毫秒", "UTC"]);
  assert.equal(seconds.rows[0].value, "1700000000");
  assert.equal(seconds.rows[1].value, "1700000000000");
  assert.equal(seconds.rows[2].value, "2023-11-14 22:13:20");

  const millis = good(fromTimestamp("1700000000123"));
  assert.equal(millis.rows[1].value, "1700000000123");
  assert.equal(millis.rows[0].value, "1700000000");
  assert.ok(millis.text.endsWith(".123"), millis.text);
  assert.ok(millis.rows[2].value.endsWith(".123"), millis.rows[2].value);
});

test("时间戳往返：本地时间写法能原样转回去", () => {
  // 不管跑测试的机器在哪个时区，输出再吃回去都得回到同一个毫秒数
  for (const value of ["1700000000", "1700000000123", "1762994225"]) {
    const decoded = good(fromTimestamp(value));
    const back = good(toTimestamp(decoded.text));
    const millis = decoded.rows[1].value;
    assert.equal(back.rows[0].value, millis, `往返失败：${value} → ${decoded.text} → ${back.rows[0].value}`);
    // 秒那一行是取整后的值，和喂进去的秒对得上
    assert.equal(decoded.rows[0].value, String(Math.floor(Number(millis) / 1000)));
  }
});

test("时间戳认不出就报错，别猜", () => {
  assert.match(bad(toTimestamp("2023-02-31")), /认不出/);
  assert.match(bad(toTimestamp("2023-13-01")), /认不出/);
  assert.match(bad(toTimestamp("明天")), /认不出/);
  assert.match(bad(fromTimestamp("abc")), /数字/);
  assert.match(bad(fromTimestamp("1e12")), /数字/);
  assert.match(bad(fromTimestamp("")), /数字/);
});

/* ------------------------------------------------------------ 入口 */

test("runCodec 按格式和方向分发", () => {
  assert.equal(good(runCodec("base64", "encode", "hi")).text, "aGk=");
  assert.equal(good(runCodec("base64", "decode", "aGk=")).text, "hi");
  assert.equal(good(runCodec("time", "decode", "1700000000")).rows[0].value, "1700000000");
  // 空输入给空结果，让界面自己显示空状态
  const blank = good(runCodec("html", "encode", "   "));
  assert.equal(blank.text, "");
  assert.deepEqual(blank.rows, []);
});

test("格式清单齐全：每个 key 都有名字、方向、提示", () => {
  assert.equal(FORMATS.length, 5);
  for (const item of FORMATS) {
    assert.ok(item.label.length > 0, item.key);
    assert.ok(item.encode.length > 0, item.key);
    assert.ok(item.decode.length > 0, item.key);
    assert.ok(item.placeholder.length > 0, item.key);
    assert.ok(item.hint.length > 0, item.key);
    assert.equal(FORMAT_MAP[item.key].label, item.label);
  }
});

console.log(`\n${passed} passed`);
