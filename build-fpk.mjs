#!/usr/bin/env node
/**
 * N_m3u8DL-RE → fnOS .fpk 跨平台构建脚本
 *
 * fnOS .fpk 实际格式（依据真实社区安装包与安装器行为）：
 *   .fpk = gzip 压缩的 tar 归档，顶层包含：
 *     - app.tgz       应用负载 tar.gz（bin/ui/www 等内容，解压后即 target/）
 *     - manifest      INI 键值，必须含 checksum = app.tgz 的 MD5
 *     - config/       privilege + resource
 *     - cmd/          生命周期脚本
 *     - wizard/       向导目录
 *     - ICON.PNG / ICON_256.PNG
 *     - *.sc          端口转发配置（可选，纯 CLI 应用不需要）
 *
 * 本脚本：
 *   1. 从 GitHub Releases 获取（或指定）N_m3u8DL-RE 版本
 *   2. 下载 linux-x64 / linux-arm64 官方发布包并提取自包含二进制
 *   3. 组装 app.tgz（显式 Unix 权限位，保证 fnOS 上可执行）
 *   4. 计算 app.tgz 的 MD5 写入 manifest.checksum
 *   5. 生成 .fpk
 *
 * 用法：
 *   node build-fpk.mjs
 *   node build-fpk.mjs --version v0.6.0-beta
 *   node build-fpk.mjs --out ./dist
 *
 * 依赖：仅 Node.js 18+（内置 fetch/zlib/crypto），无需安装任何包。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = "nilaoda/N_m3u8DL-RE";
const PKG_DIR = path.join(__dirname, "m3u8_down");
const CACHE_DIR = path.join(__dirname, ".cache");

// 需要可执行权限位的文件（相对包根的路径）
const EXEC_FILES = new Set([
  "cmd/main",
  "cmd/install_init",
  "cmd/install_callback",
  "cmd/upgrade_init",
  "cmd/upgrade_callback",
  "cmd/uninstall_init",
  "cmd/uninstall_callback",
  "cmd/config_init",
  "cmd/config_callback",
  "app/bin/N_m3u8DL-RE",
  "app/bin/task-run.sh",
  "app/bin/x64/N_m3u8DL-RE",
  "app/bin/arm64/N_m3u8DL-RE",
  "app/ui/index.cgi",
]);

function parseArgs(argv) {
  const args = { version: "latest", out: path.join(__dirname, "dist"), build: null, note: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") args.version = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--build") args.build = parseInt(argv[++i], 10);
    else if (argv[i] === "--note") args.note = argv[++i];
    else if (argv[i] === "--help") {
      console.log(
        "Usage: node build-fpk.mjs [--version <tag|latest>] [--build <N>] [--note <text>] [--out <dir>]\n" +
        "  --build N   手动指定构建号；省略时自动递增（.cache/build-count.json 记录）\n" +
        "  --note TEXT 附加到 changelog 的说明"
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * 生成/递增构建号。
 * 每次构建生成形如 <上游版本>.<N> 的完整版本（如 0.6.0-beta.1），
 * 保证 fnOS 可识别为"新版本"并允许直接覆盖更新安装。
 * 上游版本变化时构建号重置为 1。
 */
const COUNTER_FILE = path.join(CACHE_DIR, "build-count.json");

function nextBuildNumber(ver, explicit) {
  let state = { ver: "", count: 0 };
  try { state = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8")); } catch (_) { /* 首次构建 */ }
  if (state.ver !== ver) state = { ver, count: 0 }; // 上游版本变化 → 重置
  state.count = explicit && explicit > 0 ? explicit : state.count + 1;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(state));
  return state.count;
}

async function getRelease(version) {
  const url =
    version === "latest"
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(version)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "fnOS-fpk-builder", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

function pickAsset(assets, arch) {
  const suffix = `_linux-${arch}_`;
  const asset = (assets || []).find(
    (a) => a.name.startsWith("N_m3u8DL-RE_") && a.name.includes(suffix) && a.name.endsWith(".tar.gz")
  );
  if (!asset) throw new Error(`未找到 linux-${arch} 发布包`);
  return asset;
}

async function downloadCached(url, name, size) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, name);
  if (fs.existsSync(cacheFile) && (!size || fs.statSync(cacheFile).size === size)) {
    console.log(`[cache] 使用缓存 ${name}`);
    return cacheFile;
  }
  console.log(`[下载] ${name} (${size} bytes)`);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cacheFile, buf);
  console.log(`[完成] ${name}`);
  return cacheFile;
}

/** 从 tar.gz 中提取第一个普通文件的内容 */
function extractFirstFile(tarGzPath) {
  const buf = zlib.gunzipSync(fs.readFileSync(tarGzPath));
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const name = readCString(header.subarray(0, 100));
    const size = parseInt(readCString(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    offset += 512;
    if (name === "" && size === 0) break; // 结束块
    if (type === "0" || type === "\0" || type === "") {
      const content = buf.subarray(offset, offset + size);
      return { name, content };
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error(`无法从 ${path.basename(tarGzPath)} 中解析出文件`);
}

function readCString(b) {
  const end = b.indexOf(0);
  return b.subarray(0, end < 0 ? b.length : end).toString("utf8");
}

/** 写入 ustar 头部（显式 mode），name 使用相对路径 */
function ustarHeader(name, size, mode, type) {
  const buf = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, "utf8");
  const writeOctal = (off, len, val) => {
    const s = val.toString(8).padStart(len - 1, "0");
    buf.write(s, off, len - 1, "ascii");
    buf[off + len - 1] = 0;
  };
  // 超长路径使用 prefix 字段（ustar）
  let prefix = "";
  let base = name;
  if (nameBuf.length > 100) {
    // 尽量在目录边界处拆分
    const idx = name.lastIndexOf("/");
    if (idx > 0 && idx <= 155) {
      prefix = name.slice(0, idx);
      base = name.slice(idx + 1);
    } else {
      throw new Error(`路径过长且无法拆分: ${name}`);
    }
  }
  buf.write(base, 0, 100, "utf8");
  buf.write(prefix, 345, 155, "utf8");
  writeOctal(100, 8, mode);
  writeOctal(108, 8, 0); // uid
  writeOctal(116, 8, 0); // gid
  writeOctal(124, 12, size);
  writeOctal(136, 12, Math.floor(Date.now() / 1000)); // mtime
  buf.write("        ", 148, 8, "ascii"); // checksum 占位（空格）
  buf[156] = type.charCodeAt(0);
  buf.write("ustar", 257, 5, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write("root", 265, 32, "ascii");
  buf.write("root", 297, 32, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

/**
 * 收集目录下的所有条目。
 * @param {string} root 要打包的根目录
 * @param {string} namePrefix 归档条目名前缀（如把 app/ 打成 app.tgz 时不需要前缀）
 * @param {string} execPrefix 用于匹配 EXEC_FILES 的路径前缀（app.tgz 场景传 "app"）
 */
function collectEntries(root, namePrefix = "", execPrefix = "") {
  const entries = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    const relPosix = rel.split(path.sep).join("/");
    const entryName = (namePrefix ? namePrefix + "/" : "") + relPosix;
    if (st.isDirectory()) {
      entries.push({ name: entryName + "/", dir: true, mode: 0o755 });
      for (const child of fs.readdirSync(abs).sort()) walk(path.join(rel, child));
    } else {
      const execKey = (execPrefix ? execPrefix + "/" : "") + relPosix;
      const mode = EXEC_FILES.has(execKey) ? 0o755 : 0o644;
      entries.push({ name: entryName, dir: false, mode, data: fs.readFileSync(abs) });
    }
  };
  walk(".");
  return entries;
}

function buildTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const size = e.dir ? 0 : e.data.length;
    chunks.push(ustarHeader(e.name, size, e.mode, e.dir ? "5" : "0"));
    if (!e.dir) {
      chunks.push(e.data);
      const pad = (512 - (size % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024)); // 两个结束块
  return Buffer.concat(chunks);
}

function writeTarGz(entries, outPath, level = 9) {
  const tar = buildTar(entries);
  const gz = zlib.gzipSync(tar, { level });
  fs.writeFileSync(outPath, gz);
  return gz.length;
}

function md5File(p) {
  return crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(PKG_DIR)) throw new Error(`应用包目录不存在: ${PKG_DIR}`);
  fs.mkdirSync(args.out, { recursive: true });

  console.log(`[版本] 获取 Release: ${args.version}`);
  const release = await getRelease(args.version);
  const tag = release.tag_name;
  const ver = tag.replace(/^v/i, "");
  console.log(`[版本] tag=${tag} published=${release.published_at}`);

  // 构建号：形如 0.6.0-beta.<N>，保证每次构建版本递增，可直接覆盖更新安装
  const buildNo = nextBuildNumber(ver, args.build);
  const fullVer = `${ver}.${buildNo}`;
  console.log(`[版本] 本次构建号 ${buildNo} → 完整版本 ${fullVer}`);

  // 1. 下载并提取双架构二进制到 m3u8_down/app/bin/<arch>/
  const binDir = path.join(PKG_DIR, "app", "bin");
  for (const arch of ["x64", "arm64"]) {
    const asset = pickAsset(release.assets, arch);
    const local = await downloadCached(asset.browser_download_url, asset.name, asset.size);
    const { name: innerName, content } = extractFirstFile(local);
    const dest = path.join(binDir, arch, "N_m3u8DL-RE");
    fs.writeFileSync(dest, content);
    fs.chmodSync(dest, 0o755);
    console.log(`[提取] ${arch} ← ${innerName} (${content.length} bytes)`);
  }

  // 2. 同步 manifest 版本
  const manifestPath = path.join(PKG_DIR, "manifest");
  let manifest = fs.readFileSync(manifestPath, "utf8");
  const note = args.note ? ` ${args.note}` : "";
  manifest = manifest
    .replace(/^version\s*=.*$/m, `version=${fullVer}`)
    .replace(/^fpk_version\s*=.*$/m, `fpk_version=${fullVer}`)
    .replace(/^changelog\s*=.*$/m, `changelog=构建 ${fullVer}：基于 N_m3u8DL-RE ${tag} 官方 Release 打包；内置 linux-x64 / linux-arm64 双架构二进制。${note}`);

  // 2b. 生成版本信息文件（供 Web 界面"应用与引擎更新"读取，随包分发）
  const verFile = path.join(PKG_DIR, "app", "www", "version");
  fs.writeFileSync(verFile, `appVersion=${fullVer}\nengineVersion=${ver}\nengineTag=${tag}\n`);
  console.log(`[版本] 写入 ${verFile} (app=${fullVer} engine=${ver})`);

  // 3. 生成 app.tgz（app/ 目录内容，去掉 app/ 前缀）
  const tmpDir = fs.mkdtempSync(path.join(args.out, ".tmp-"));
  const appTgzPath = path.join(tmpDir, "app.tgz");
  const appEntries = collectEntries(path.join(PKG_DIR, "app"), "", "app");
  writeTarGz(appEntries, appTgzPath);
  console.log(`[app.tgz] ${appEntries.length} 个条目，${(fs.statSync(appTgzPath).size / 1024 / 1024).toFixed(2)} MB`);

  // 4. manifest 写入 checksum（app.tgz 的 MD5）
  const checksum = md5File(appTgzPath);
  if (/^checksum\s*=/m.test(manifest)) {
    manifest = manifest.replace(/^checksum\s*=.*$/m, `checksum=${checksum}`);
  } else {
    manifest += `\nchecksum=${checksum}\n`;
  }
  fs.writeFileSync(manifestPath, manifest);
  console.log(`[manifest] version=${fullVer} checksum=${checksum}`);

  // 5. 打包 .fpk：顶层 = manifest + app.tgz + config/ + cmd/ + wizard/ + 图标 + 文档
  // 清理旧版本产物，避免混淆
  for (const old of fs.readdirSync(args.out)) {
    if (/^m3u8_down_.*_all\.fpk$/.test(old)) {
      fs.rmSync(path.join(args.out, old), { force: true });
      console.log(`[清理] 移除旧产物 ${old}`);
    }
  }
  const fpkName = `m3u8_down_${fullVer}_all.fpk`;
  const fpkPath = path.join(args.out, fpkName);
  const fpkEntries = collectEntries(PKG_DIR)
    .filter((e) => !e.name.startsWith("app/")) // app/ 已打进 app.tgz
    .concat([{ name: "app.tgz", dir: false, mode: 0o644, data: fs.readFileSync(appTgzPath) }])
    .sort((a, b) => a.name.localeCompare(b.name));
  const fpkSize = writeTarGz(fpkEntries, fpkPath);
  console.log(`[打包] ${fpkPath} (${(fpkSize / 1024 / 1024).toFixed(2)} MB)`);

  // 6. 校验输出
  console.log("[校验] fpk 顶层内容：");
  for (const e of fpkEntries) {
    console.log(`   ${(e.mode & 0o111 ? "-rwxr-xr-x" : "-rw-r--r--")}  ${e.name}`);
  }
  console.log("[校验] app.tgz 内容：");
  for (const e of appEntries) {
    console.log(`   ${(e.mode & 0o111 ? "-rwxr-xr-x" : "-rw-r--r--")}  ${e.name}`);
  }
  console.log(`[完成] sha256 = ${crypto.createHash("sha256").update(fs.readFileSync(fpkPath)).digest("hex")}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(`[错误] ${e.message}`);
  process.exit(1);
});
