#!/usr/bin/env node
/**
 * 把版本号同步到所有声明处。
 *
 * Tauri 打包读的是 tauri.conf.json 的 version，Cargo 读的是 Cargo.toml，
 * 前端读 package.json —— 三处不一致会出现「安装包装上了但界面还显示旧版本」
 * 这种玄学问题，所以统一在这里改。
 *
 * 全部走文本替换而不是 JSON 解析重写，避免把原有排版搅乱（diff 里只剩版本号那一行）。
 *
 * 用法：node tools/set-version.mjs 0.2.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] ?? "").replace(/^v/, "").trim();

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`版本号不合法：${process.argv[2] ?? "(空)"}，应为 1.2.3 或 1.2.3-beta.1`);
  process.exit(1);
}

let failed = 0;

function patch(relPath, pattern, replacement) {
  const file = join(root, relPath);
  const before = readFileSync(file, "utf8");

  if (!pattern.test(before)) {
    console.error(`  ✗ ${relPath} 找不到版本字段，请手动检查`);
    failed += 1;
    return;
  }

  writeFileSync(file, before.replace(pattern, replacement));
  console.log(`  ✓ ${relPath} → ${version}`);
}

// JSON 里只认顶层那个 "version"（两空格缩进），不碰依赖里的版本号
const JSON_VERSION = /(\n {2}"version": ")[^"]*(")/;

console.log(`同步版本号到 ${version}`);

patch("package.json", JSON_VERSION, `$1${version}$2`);
patch("src-tauri/tauri.conf.json", JSON_VERSION, `$1${version}$2`);

// [package] 段的 version 是文件里第一个 version 行
patch("src-tauri/Cargo.toml", /^version = "[^"]*"/m, `version = "${version}"`);

// 锁文件里的自身条目也要跟着走，否则 CI 上 cargo 会因 --locked 报错
patch(
  "src-tauri/Cargo.lock",
  /(name = "whale-reminder"\r?\nversion = ")[^"]*(")/,
  `$1${version}$2`,
);

if (failed > 0) {
  console.error("有文件没改成功，已中止。");
  process.exit(1);
}

console.log(`完成。提交后打 tag：git tag v${version} && git push origin v${version}`);
