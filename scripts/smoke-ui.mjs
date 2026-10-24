// UI 冒烟：用无头 Chrome 真渲染一遍首页，断言 DOM 里该有的东西都在。
//
// 为什么要这个脚本（工单 P0-3 的原话）：
//   `npm test`（75 个）与 `npm run build` 在首屏大改 329 行之后**全绿** ——
//   因为它们根本不渲染页面。真正发现问题的是黑盒截图。
//   这个脚本把那一步自动化，让"测试全绿但页面是坏的"这种事故不再靠人肉发现。
//
// 用法：
//   npm run smoke                        # 自己起静态服务（要求先 npm run build）
//   node scripts/smoke-ui.mjs http://localhost:1420     # 指向已在跑的 dev server
//   node scripts/smoke-ui.mjs --serve    # 显式走 dist/ 静态服务
//
// 三个坑（前两个工单里点过名，第三个是写这个脚本时自己踩的）：
//   1. 路由是 **HashRouter** —— 必须访问 `#/home`；`/home` 会被 `*` 兜底重定向。
//   2. 无头浏览器要**等渲染**（`--virtual-time-budget`），否则拿到的是空壳。
//   3. ⚠️ 不能用 `spawnSync`：它会**阻塞事件循环**，而同进程里的静态服务器
//      正等着响应 Chrome 的请求 —— 于是自己把自己锁死，表现为 ETIMEDOUT。
//      必须用异步 `spawn`。
//
// 不引入任何第三方依赖：用系统里的 Chrome / Edge，以 `--dump-dom` 输出渲染后的 DOM。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const DONE = /<\/html>\s*$/i;

/* ---------------------------------------------------------------- 浏览器 */

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function findBrowser() {
  return BROWSER_CANDIDATES.filter(Boolean).find((p) => existsSync(p)) || null;
}

/** 用 --dump-dom 拿到「渲染后」的 DOM 文本（异步，别阻塞事件循环） */
function dumpDom(browser, url, timeoutMs = 60_000) {
  const profile = mkdtempSync(join(tmpdir(), "faron-smoke-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    // 关键：给它时间把 React 挂载完、入场动画跑完，否则 dump 到的是空壳
    "--virtual-time-budget=6000",
    "--dump-dom",
    url,
  ];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`无头浏览器 ${timeoutMs / 1000}s 未返回（地址 ${url}）`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // Chrome 的 stderr 里有一堆 libpng/gpu 噪声，只有拿不到 DOM 时才用它
      if (!out.trim()) {
        reject(new Error(`浏览器没有输出 DOM。stderr 摘要：${err.trim().slice(-300) || "（空）"}`));
        return;
      }
      resolvePromise(out);
    });
  }).finally(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响判定 */
    }
  });
}

/* ------------------------------------------------------------ 静态服务器 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/** 起一个只读的静态服务（端口随机），返回 { url, close } */
function serveDist() {
  const index = join(DIST, "index.html");
  if (!existsSync(index)) {
    throw new Error("dist/ 里没有 index.html —— 先跑 `npm run build`，或直接指向已在跑的 dev server。");
  }
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path === "/" ? index : join(DIST, path);
    try {
      const buf = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      // SPA 兜底
      const buf = await readFile(index);
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(buf);
    }
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      ok({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/* ---------------------------------------------------------------- 断言 */

/** 去掉脚本/样式/标签后取纯文本，用于"页面不是空白"的判定 */
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const explicit = argv.find((a) => /^https?:\/\//.test(a));
  const wantServe = argv.includes("--serve") || !explicit;

  const browser = findBrowser();
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  if (!browser) {
    add("找到 Chrome / Edge", false, "装了 Chrome/Edge，或用环境变量 CHROME_PATH 指定路径");
    return report(browser, explicit || "—", checks);
  }
  add("找到 Chrome / Edge", true);

  let base = explicit;
  let closer = null;
  if (wantServe && !explicit) {
    const s = await serveDist();
    base = s.url;
    closer = s.close;
  }

  const url = `${(base || "http://localhost:1420").replace(/\/+$/, "")}/#/home`;
  add("访问 HashRouter 路由 #/home", true, url);

  let dom = "";
  try {
    dom = await dumpDom(browser, url);
  } catch (e) {
    add("无头浏览器渲染成功", false, e instanceof Error ? e.message : String(e));
    if (closer) closer();
    return report(browser, url, checks);
  }
  if (closer) closer();
  add("无头浏览器渲染成功", true);

  const text = textOf(dom);
  add("页面不是空白（文本长度 > 200）", text.length > 200, `实际 ${text.length} 字`);

  for (const kw of ["面向律师", "开始审查一份合同", "确定性引用自检"]) {
    const hit = text.includes(kw);
    add(`首页含「${kw}」`, hit, hit ? "" : "DOM 里没找到 —— 可能被兜底重定向、或渲染没跑完");
  }

  // 反向断言：抓到的是真首页，不是被 `*` 兜底后仍然渲染的别的页面
  add("确实是首页（含「最近打开」）", text.includes("最近打开"));

  return report(browser, url, checks);
}

function report(browser, url, checks) {
  let failed = 0;
  console.log("=".repeat(74));
  console.log("UI 冒烟（无头浏览器真渲染 #/home）");
  console.log("=".repeat(74));
  console.log(`  浏览器：${browser || "未找到"}`);
  console.log(`  地址　：${url}`);
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`\n${c.ok ? "✅" : "❌"} ${c.name}`);
    if (!c.ok && c.detail) console.log(`    ${c.detail}`);
  }
  console.log("\n" + "=".repeat(74));
  console.log(`结果：${checks.length - failed} 通过 / ${failed} 未通过 / 共 ${checks.length}`);
  console.log("=".repeat(74));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("冒烟脚本自身出错：", e);
  process.exit(1);
});
