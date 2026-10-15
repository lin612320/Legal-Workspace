// 前端 UI 文案与隐式化的**精确验收脚本**（供 CI / 人工一键复核）。
//
// 为什么不用简单 grep：
//   1. 「裸星号」的原始 bug 是 **JSX 文本节点**里写 `**加粗**` ——
//      它在浏览器里会显示成字面的 `**加粗**`。
//      而**代码注释**（`// …` 与 `{/* … */}`）中的 `**` 根本不会渲染，
//      简单 grep `\*\*[^*]+\*\*` 会产生误报，逼人去改无害注释。
//   2. 「planned」这个词在本仓库有**两个语义**：
//      导航项的弱化标记（已随隐式化删除）与**任务状态** `"planned"`（仍在用，无关）。
//      简单 grep `planned` 会把后者全部误伤。
//
// 用法：node scripts/check-ui-copy.mjs
// 退出码：0 = 全部通过；1 = 有未通过项

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** 递归收集指定扩展名的文件 */
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** 去掉整行注释与块注释后的「有效代码行」 */
function effectiveLines(text) {
  const out = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((line, i) => {
    let s = line;
    if (inBlock) {
      const end = s.indexOf("*/");
      if (end === -1) return;
      s = s.slice(end + 2);
      inBlock = false;
    }
    // 去掉所有完整块注释
    for (;;) {
      const start = s.indexOf("/*");
      if (start === -1) break;
      const end = s.indexOf("*/", start + 2);
      if (end === -1) {
        s = s.slice(0, start);
        inBlock = true;
        break;
      }
      s = s.slice(0, start) + s.slice(end + 2);
    }
    const t = s.trim();
    if (t.startsWith("//")) return;
    if (!s.trim()) return;
    out.push({ line: i + 1, text: s });
  });
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

/* ---------- 1) JSX 文本节点里的裸 markdown 星号 ---------- */
{
  const files = walk(join(SRC, "views"), [".tsx"]).concat(
    walk(join(SRC, "components"), [".tsx"]),
  );
  const hits = [];
  for (const f of files) {
    for (const { line, text } of effectiveLines(readFileSync(f, "utf8"))) {
      if (/\*\*[^*\n]+\*\*/.test(text)) {
        hits.push(`${relative(ROOT, f)}:${line}  ${text.trim()}`);
      }
    }
  }
  check(
    "JSX 文本节点无裸 markdown 星号（排除注释）",
    hits.length === 0,
    hits.join("\n") || "0 命中",
  );
}

/* ---------- 2) 导航项 planned 死代码已清 ---------- */
{
  const targets = [
    join(SRC, "nav.ts"),
    join(SRC, "components", "Sidebar.tsx"),
    join(SRC, "styles.css"),
  ];
  const hits = [];
  for (const f of targets) {
    effectiveLines(readFileSync(f, "utf8")).forEach(({ line, text }) => {
      // 只查「导航项弱化标记」语义，不误伤任务状态 "planned"
      if (/\bitem\.planned\b/.test(text) || /\.nav-item\.planned\b/.test(text) || /\bnav-flag\b/.test(text)) {
        hits.push(`${relative(ROOT, f)}:${line}  ${text.trim()}`);
      }
    });
  }
  check("导航 planned 死代码已清（item.planned / .nav-item.planned / .nav-flag）",
    hits.length === 0, hits.join("\n") || "0 命中");
}

/* ---------- 3) nav.ts 不再出现「自我进化」 ---------- */
{
  const hits = [];
  const f = join(SRC, "nav.ts");
  readFileSync(f, "utf8").split(/\r?\n/).forEach((l, i) => {
    if (l.includes("自我进化")) hits.push(`${relative(ROOT, f)}:${i + 1}  ${l.trim()}`);
  });
  check("nav.ts 不含「自我进化」（已从一级导航撤下）", hits.length === 0, hits.join("\n") || "0 命中");
}

/* ---------- 4) views/components 下机制词清零 ---------- */
{
  const MECH = /方案稿|docs\/12|未实现|纯仿真|差分隐私|K 匿名|加权平均|棱镜口径/;
  const files = walk(join(SRC, "views"), [".tsx", ".ts"]).concat(
    walk(join(SRC, "components"), [".tsx", ".ts"]),
  );
  const hits = [];
  for (const f of files) {
    effectiveLines(readFileSync(f, "utf8")).forEach(({ line, text }) => {
      if (MECH.test(text)) hits.push(`${relative(ROOT, f)}:${line}  ${text.trim()}`);
    });
  }
  check("views/components 下机制词清零（隐式化）", hits.length === 0, hits.join("\n") || "0 命中");
}

/* ---------- 5) 深链路由保留 ---------- */
{
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  check('深链 /evolution 路由保留', app.includes('path="/evolution"'),
    app.includes('path="/evolution"') ? "已保留" : "缺失");
}

/* ---------- 6) 隐私开关默认不参与（三态） ---------- */
{
  const store = readFileSync(join(SRC, "lib", "evolutionStore.ts"), "utf8");
  const hasKey = store.includes('"evolution.participation"');
  const hasUnset = store.includes('"unset"') && store.includes("isParticipating");
  check("参与意愿用三态（unset/on/off，默认不参与）", hasKey && hasUnset,
    `key=${hasKey} 三态逻辑=${hasUnset}`);
}

/* ---------- 输出 ---------- */
let failed = 0;
console.log("=".repeat(74));
console.log("前端 UI 文案与隐式化验收（精确口径）");
console.log("=".repeat(74));
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`\n${r.ok ? "✅" : "❌"} ${r.name}`);
  if (!r.ok) console.log(r.detail.split("\n").map((l) => "    " + l).join("\n"));
  else if (r.detail !== "0 命中") console.log(`    ${r.detail}`);
}
console.log("\n" + "=".repeat(74));
console.log(`结果：${results.length - failed} 通过 / ${failed} 未通过 / 共 ${results.length}`);
console.log("=".repeat(74));
process.exit(failed ? 1 : 0);
