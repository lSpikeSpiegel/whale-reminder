/**
 * JSON 解析 / 格式化的单测。
 *
 * 和颜色、编解码一样是纯函数，直接拿 Node 跑：
 *
 *   node --experimental-strip-types tools/json-test.mjs
 *
 * 重点盯三件事：
 * 1. 排版不能改数据——尤其是 19 位以上的整数和 1e400 这种「JS 存不下」的数字；
 * 2. 非法写法要报在**正确的位置**，并且原因说得像人话；
 * 3. 行模型（折叠）的 close / comma / path 得对，不然折起来会少半个括号。
 */

import assert from "node:assert/strict";

const { parseJson, formatJson, buildLines, locate, leafText, indentUnit, formatBytes, INDENTS } = await import(
  "../src/panel/json.ts"
);

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log("ok -", name);
};

/** 断言解析成功并拿到 doc */
const good = (text) => {
  const result = parseJson(text);
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `本该解析成功，却报错：${result.error.message} @${result.error.line}:${result.error.column}`,
  );
  return result.doc;
};

/** 断言解析失败并拿到 error */
const bad = (text) => {
  const result = parseJson(text);
  assert.equal(result.ok, false, "本该报错，却解析成功了");
  return result.error;
};

/* ------------------------------------------------------------ 基本排版 */

test("对象 / 数组：2 空格缩进和压缩结果", () => {
  const doc = good('{"a":1,"b":[true,false,null,"x"]}');
  assert.equal(
    formatJson(doc.root, 2),
    `{
  "a": 1,
  "b": [
    true,
    false,
    null,
    "x"
  ]
}`,
  );
  assert.equal(doc.minified, '{"a":1,"b":[true,false,null,"x"]}');
});

test("4 空格和 Tab 缩进", () => {
  const doc = good('{"a":{"b":1}}');
  assert.equal(formatJson(doc.root, 4), `{\n    "a": {\n        "b": 1\n    }\n}`);
  assert.equal(formatJson(doc.root, "tab"), `{\n\t"a": {\n\t\t"b": 1\n\t}\n}`);
  assert.equal(indentUnit(2), "  ");
  assert.equal(indentUnit(4), "    ");
  assert.equal(indentUnit("tab"), "\t");
});

test("顶层标量也是合法 JSON", () => {
  for (const [text, expected] of [
    ["42", "42"],
    ['"hi"', '"hi"'],
    ["true", "true"],
    ["null", "null"],
    ["  -0.5e+2  ", "-0.5e+2"],
  ]) {
    const doc = good(text);
    assert.equal(formatJson(doc.root, 2), expected);
    assert.equal(doc.minified, expected);
    assert.equal(doc.stats.depth, 0);
  }
});

test("空对象和空数组写成一对括号，不折行", () => {
  const doc = good('{"a":{},"b":[]}');
  assert.equal(formatJson(doc.root, 2), `{\n  "a": {},\n  "b": []\n}`);
  assert.equal(doc.minified, '{"a":{},"b":[]}');

  const lines = buildLines(doc.root);
  assert.equal(lines[1].kind, "leaf");
  assert.equal(lines[1].text, "{}");
  assert.equal(lines[1].type, "object");
  assert.equal(lines[2].text, "[]");
  // 没有内容的容器不该出现三角
  assert.equal(lines.filter((line) => line.kind === "open").length, 1);
});

test("字符串：转义还原后再按标准写法转回去", () => {
  const doc = good('"\\u4e2d\\n\\"x\\"\\\\"');
  assert.equal(doc.root.value, '中\n"x"\\');
  assert.equal(doc.minified, '"中\\n\\"x\\"\\\\"');
  assert.equal(doc.minified.length, '"中\\n\\"x\\"\\\\"'.length);

  // 反斜杠和引号一起，往返不能掉字节
  const again = good(doc.minified);
  assert.equal(again.root.value, doc.root.value);
});

test("数字保留原文：大整数、1.0、1e400、-0 都不许改", () => {
  const source = '{"id":1234567890123456789,"f":1.0,"e":1e400,"z":-0,"neg":-12.50}';
  const doc = good(source);
  assert.equal(doc.minified, source);
  // 走一遍格式化再读回来，数值原文还是同一个
  const formatted = formatJson(doc.root, 2);
  assert.match(formatted, /1234567890123456789/);
  assert.match(formatted, /1\.0/);
  assert.match(formatted, /1e400/);
  assert.match(formatted, /-12\.50/);
  assert.equal(good(formatted).minified, source);
});

test("键里的引号、中文、emoji 都能原样转义", () => {
  const source = '{"a\\"b":1,"中文":2,"🐳":3}';
  const doc = good(source);
  assert.equal(doc.minified, source);
  const lines = buildLines(doc.root);
  assert.equal(lines[1].key, 'a"b');
  assert.equal(lines[1].path, '$["a\\"b"]');
  assert.equal(lines[2].path, '$["中文"]');
});

/* ------------------------------------------------------------ 行模型（折叠） */

test("行模型的深度、路径、逗号、闭合行都对得上", () => {
  const doc = good('{"a":{"b":1},"c":2}');
  const lines = buildLines(doc.root);

  assert.equal(lines.length, 6);
  assert.deepEqual(
    lines.map((line) => [line.kind, line.depth, line.path, line.comma]),
    [
      ["open", 0, "$", false],
      ["open", 1, '$["a"]', true],
      ["leaf", 2, '$["a"]["b"]', false],
      ["close", 1, '$["a"]', true],
      ["leaf", 1, '$["c"]', false],
      ["close", 0, "$", false],
    ],
  );
  assert.equal(lines[0].close, 5);
  assert.equal(lines[0].size, 2);
  assert.equal(lines[1].close, 3);
  assert.equal(lines[1].size, 1);
  assert.equal(lines[4].text, "2");
});

test("数组用下标拼路径，顺序和逗号正确", () => {
  const doc = good('[[1,2],[]]');
  const lines = buildLines(doc.root);
  assert.deepEqual(
    lines.map((line) => line.path),
    ["$", "$[0]", "$[0][0]", "$[0][1]", "$[0]", "$[1]", "$"],
  );
  assert.equal(lines[0].close, 6);
  assert.equal(lines[0].size, 2);
  assert.equal(lines[1].comma, true);
  assert.equal(lines[5].text, "[]");
  assert.equal(lines[5].comma, false);
});

test("格式化 → 再解析 → 再格式化，结果稳定", () => {
  const source = '{"a":[1,2,{"b":"x"}],"c":{},"d":[[],{}]}';
  const once = formatJson(good(source).root, 2);
  const twice = formatJson(good(once).root, 2);
  assert.equal(twice, once);
  assert.equal(good(once).minified, source);
});

/* ------------------------------------------------------------ 统计与提醒 */

test("统计：键数、层数、字节数", () => {
  const doc = good('{"a":1,"b":{"c":[1,2,{"d":3}]}}');
  assert.equal(doc.stats.keys, 4);
  assert.equal(doc.stats.depth, 4);
  assert.equal(doc.stats.bytes, 31);
  assert.equal(formatBytes(31), "31 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.00 MB");
});

test("重复键给提醒，但两条都留着", () => {
  const doc = good('{"a":1,\n"a":2}');
  assert.equal(doc.warnings.length, 1);
  assert.match(doc.warnings[0], /"a"/);
  assert.match(doc.warnings[0], /第 1 行和第 2 行/);
  assert.match(doc.minified, /"a":1,"a":2/);
});

test("缩进清单的三档都在，标签不空", () => {
  assert.equal(INDENTS.length, 3);
  for (const item of INDENTS) {
    assert.ok(item.label.length > 0);
    assert.ok(item.aria.length > 0);
    assert.ok(indentUnit(item.key).length > 0);
  }
});

/* ------------------------------------------------------------ 报错 */

test("结尾逗号：对象和数组都要拦下来", () => {
  assert.match(bad('{"a":1,}').message, /多了一个逗号/);
  assert.match(bad("[1,2,]").message, /多了一个逗号/);
  assert.match(bad('{"a":1, }').message, /多了一个逗号/);

  // 位置要指在那个逗号上，而不是后面的括号
  const error = bad('{\n  "a": 1,\n}');
  assert.equal(error.line, 2);
  assert.equal(error.column, 9);
  assert.equal(error.snippet[error.caret], ",");
});

test("少逗号 / 少冒号 / 键没引号", () => {
  assert.match(bad("[1 2]").message, /少了逗号/);
  assert.match(bad('{"a":1 "b":2}').message, /少了逗号/);
  assert.match(bad('{"a" 1}').message, /少了冒号/);
  assert.match(bad("{a:1}").message, /双引号/);
  assert.match(bad("{'a':1}").message, /双引号/);
});

test("字符串没闭合 / 里有裸换行 / 转义不认识", () => {
  assert.match(bad('{"a":"x}').message, /没有闭合/);
  assert.match(bad('"abc\nx"').message, /不能直接换行/);
  assert.match(bad('"a\\qb"').message, /不认识的转义/);
  assert.match(bad('"\\u12"').message, /4 位十六进制/);
});

test("数字的非法写法各有各的说法", () => {
  assert.match(bad('{"a":01}').message, /前导零/);
  assert.match(bad('{"a":+1}').message, /不能写 \+/);
  assert.match(bad('{"a":.5}').message, /小数点前面/);
  assert.match(bad('{"a":1.}').message, /小数点后面/);
  assert.match(bad('{"a":1e}').message, /指数/);
  assert.match(bad('{"a":1-2}').message, /数字后面/);
  assert.match(bad('{"a":NaN}').message, /应该是一个值/);
  assert.match(bad('{"a":Infinity}').message, /应该是一个值/);
});

test("括号对不上、没闭合、后面还有内容", () => {
  assert.match(bad("[1}").message, /括号对不上/);
  assert.match(bad('{"a":1]').message, /括号对不上/);
  assert.match(bad('{"a":1').message, /对象没有闭合/);
  assert.match(bad("[1,2").message, /数组没有闭合/);
  assert.match(bad('{"a":1} x').message, /已经结束了/);
  assert.match(bad('{"a":1}{}').message, /已经结束了/);
});

test("注释和不认识的字符说清楚原因", () => {
  assert.match(bad('{"a":1 // x\n}').message, /不支持注释/);
  assert.match(bad("?{}").message, /意外的字符/);
  assert.match(bad('{"a":@}').message, /意外的字符/);
});

test("空输入 / 只有空白：提示先粘内容", () => {
  assert.match(bad("").message, /还没有内容/);
  assert.match(bad("  \n\t").message, /还没有内容/);
  assert.equal(bad("").line, 1);
  assert.equal(bad("").column, 1);
});

test("报错行列号和出错行原文都对", () => {
  const error = bad('{\n  "a": 1,\n  "b": ,\n}');
  assert.equal(error.line, 3);
  assert.equal(error.column, 8);
  assert.equal(error.snippet, '  "b": ,');
  assert.equal(error.caret, 7);
  assert.equal(error.snippet[error.caret], ",");

  const missing = bad('{\n  "a": 1\n  "b": 2\n}');
  assert.equal(missing.line, 3);
  assert.match(missing.message, /少了逗号/);
});

test("长行截断后 ^ 还能指到出错处", () => {
  const key = "k".repeat(120);
  const error = bad(`{"${key}":@}`);
  assert.ok(error.snippet.length <= 78, `snippet 太长：${error.snippet.length}`);
  assert.equal(error.snippet[error.caret], "@");
  assert.ok(error.snippet.startsWith("…"));
  // 出错点贴着行尾时不需要右省略号，能看清 @ 就够了
});

test("CRLF 换行也能算对行号", () => {
  const error = bad('{\r\n  "a": 1,\r\n  "b": ,\r\n}');
  assert.equal(error.line, 3);
  assert.equal(error.snippet, '  "b": ,');
});

test("locate 的边界：0、末尾、越界都不炸", () => {
  assert.deepEqual(locate("ab\ncd", 0), { line: 1, column: 1 });
  assert.deepEqual(locate("ab\ncd", 4), { line: 2, column: 2 });
  assert.deepEqual(locate("ab\ncd", 999), { line: 2, column: 3 });
  assert.deepEqual(locate("ab\ncd", -3), { line: 1, column: 1 });
});

/* ------------------------------------------------------------ 边界情况 */

test("文件头的 UTF-8 BOM 放行，报错位置仍然对得上原文", () => {
  const doc = good('\ufeff{"a":1}');
  assert.equal(doc.minified, '{"a":1}');

  const error = bad('\ufeff{"a":}');
  assert.equal(error.snippet, '{"a":}');
  assert.equal(error.snippet[error.caret], "}");
});

test("嵌套超过 400 层直接说清楚，别把栈跑爆", () => {
  const error = bad("[".repeat(401));
  assert.match(error.message, /嵌套太深/);
});

test("超过 2 MB 不解析", () => {
  const error = bad(" ".repeat(2_000_001));
  assert.match(error.message, /太大/);
});

test("leafText 覆盖每种类型", () => {
  assert.equal(leafText({ type: "string", value: "a" }), '"a"');
  assert.equal(leafText({ type: "number", raw: "1e400" }), "1e400");
  assert.equal(leafText({ type: "boolean", value: false }), "false");
  assert.equal(leafText({ type: "null" }), "null");
  assert.equal(leafText({ type: "object", entries: [] }), "{}");
  assert.equal(leafText({ type: "array", items: [] }), "[]");
});

console.log(`\n${passed} passed`);
