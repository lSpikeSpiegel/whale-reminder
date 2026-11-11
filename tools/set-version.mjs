#!/usr/bin/env node
/**
 * 把版本号同步到所有声明处。
 *
 * Tauri 打包读的是 tauri.conf.json 的 version，Cargo 读的是 Cargo.toml，
 * 前端 `__APP_VERSION__` 走 package.json —— 三处不一致会出现
 * 「安装包装上了但界面还显示旧版本」这种玄学问题，所以统一在这里改。
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

function patchJson(relPath, mutate) {
  const file = join(root, relPath);
  const data = JSON.parse(readFileSync(file, "utf8"));
  mutate(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`  ${relPath} → ${version}`);
}

function patchText(relPath, pattern, replacement) {
  const file = join(root, relPath);
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.warn(`  ${relPath} 未匹配到版本字段，跳过`);
    return;
  }
  writeFileSync(file, after);
  console.log(`  ${relPath} → ${version}`);
}

console.log(`同步版本号到 ${version}`);

patchJson("package.json", (pkg) => {
  pkg.version = version;
});

patchJson("src-tauri/tauri.conf.json", (conf) => {
  conf.version = version;
});

// [package] 段的 version 一定是文件里第一个 version 行
patchText("src-tauri/Cargo.toml", /^version = "[^"]*"/m, `version = "${version}"`);

// 锁文件里的自身条目也要跟着走，否则 CI 上 cargo 会因 --locked 报错
patchText(
  "src-tauri/Cargo.lock",
  /(name = "whale-reminder"\r?\nversion = ")[^"]*(")/,
  `$1${version}$2`,
);

console.log("完成。记得提交后打 tag：git tag v" + version + " && git push origin v" + version);
