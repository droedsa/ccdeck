#!/usr/bin/env node
// Выпуск новой версии:  npm run release -- [patch|minor|major|1.2.3]
//
// 1. Поднимает версию в package.json, src-tauri/tauri.conf.json, Cargo.toml, Cargo.lock.
// 2. Коммитит и ставит тег vX.Y.Z.
// 3. Пушит ветку и тег во все remote (сейчас это GitHub).
//    GitHub Actions по тегу собирает Windows + macOS и выкладывает релиз с автообновлением.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

if (sh("git status --porcelain")) {
  console.error("Есть незакоммиченные изменения — сначала закоммитьте их.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const arg = process.argv[2] || "patch";
const next =
  arg === "major" ? `${maj + 1}.0.0`
  : arg === "minor" ? `${maj}.${min + 1}.0`
  : arg === "patch" ? `${maj}.${min}.${pat + 1}`
  : /^\d+\.\d+\.\d+$/.test(arg) ? arg
  : null;
if (!next) {
  console.error(`Непонятная версия «${arg}». Используйте patch, minor, major или X.Y.Z`);
  process.exit(1);
}

pkg.version = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

const cargoPath = "src-tauri/Cargo.toml";
writeFileSync(cargoPath, readFileSync(cargoPath, "utf8").replace(/^version = "[^"]+"/m, `version = "${next}"`));

const lockPath = "src-tauri/Cargo.lock";
writeFileSync(lockPath, readFileSync(lockPath, "utf8").replace(/(name = "ccdeck"\r?\nversion = )"[^"]+"/, `$1"${next}"`));

const lockPkg = "package-lock.json";
try {
  const lock = JSON.parse(readFileSync(lockPkg, "utf8"));
  lock.version = next;
  if (lock.packages?.[""]) lock.packages[""].version = next;
  writeFileSync(lockPkg, JSON.stringify(lock, null, 2) + "\n");
} catch {}

const tag = `v${next}`;
run(`git add -A`);
run(`git commit -m "Release ${tag}"`);
run(`git tag -a ${tag} -m "CC Deck ${tag}"`);

const branch = sh("git rev-parse --abbrev-ref HEAD");
const remotes = sh("git remote").split(/\s+/).filter(Boolean);
for (const r of remotes) {
  console.log(`\n→ ${r}`);
  run(`git push ${r} ${branch}`);
  run(`git push ${r} ${tag}`);
}
console.log(`\nГотово: ${tag}. Сборка идёт в GitHub Actions — через ~15 минут релиз появится, а установленные копии предложат обновиться.`);
