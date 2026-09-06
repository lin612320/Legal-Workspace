// 智能体工具注册表（P0/P1）
//
// 每个工具 = { defs 里声明（OpenAI tools 协议）, run(args) 执行 }。
// 双环境：
//   - Tauri 桌面 → callRust 走 Rust 命令（SQLite / 文件系统）
//   - 浏览器预览 → 本地示例数据 + localStorage + .md 下载（便于无后端演示）
// 执行结果统一 ToolResult，含 refs（引用法条，供模型引用与溯源展示）。

import { Law, SAMPLE_LAWS } from "../data/laws";
import { readLocalTemplates } from "../data/templates";
import { callRust, isTauri } from "./tauri";
import type { FunctionTool } from "./ai";
import { translateFree } from "./translate";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一次引用（真法条：可反查） */
export interface LawRef {
  id: number;
  title: string;
  article_no: string | null;
  source: string | null;
  excerpt: string;
}

/** 工具执行结果 */
export interface ToolResult {
  ok: boolean;
  text: string; // 给模型回填的自然语言结果（含要点 + 引用）
  refs?: LawRef[];
  /** 若工具本身产出交付物（如 docx/md），随结果带出 */
  artifact?: { kind: string; title: string; content: string; file_path?: string };
}

/** 本地（浏览器预览）文书 */
export interface LocalDoc {
  id: number;
  title: string;
  content: string;
  kind: string;
  file_path?: string;
  updated_at: string;
}

const LS_DOCS = "workbench:documents";

function readLocalDocs(): LocalDoc[] {
  try {
    const raw = localStorage.getItem(LS_DOCS);
    if (raw) return JSON.parse(raw) as LocalDoc[];
  } catch {
    /* ignore */
  }
  return [];
}

function writeLocalDocs(list: LocalDoc[]) {
  try {
    localStorage.setItem(LS_DOCS, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function localDocList(): LocalDoc[] {
  return readLocalDocs();
}

export function localDocSave(title: string, content: string, kind = "doc", file_path?: string): LocalDoc {
  const d: LocalDoc = {
    id: Date.now(),
    title,
    content,
    kind,
    file_path,
    updated_at: new Date().toISOString(),
  };
  writeLocalDocs([d, ...readLocalDocs()]);
  return d;
}

export function localDocDelete(id: number) {
  writeLocalDocs(readLocalDocs().filter((d) => d.id !== id));
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function lawToRef(l: Law): LawRef {
  return {
    id: l.id,
    title: l.title,
    article_no: l.article_no ?? null,
    source: l.source ?? null,
    excerpt: truncate(l.content, 420),
  };
}

function sampleById(id: number): Law | undefined {
  return SAMPLE_LAWS.find((l) => l.id === id);
}

function refsText(refs: LawRef[]): string {
  if (refs.length === 0) return "（未命中）";
  return refs
    .map(
      (r) =>
        `- ${r.title}${r.article_no ? ` ${r.article_no}` : ""}（来源：${r.source ?? "未知"}）：${r.excerpt}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

async function runLawsSearch(args: any): Promise<ToolResult> {
  const keyword = String(args?.keyword ?? "").trim();
  const country = args?.country ? String(args.country) : undefined;
  if (!keyword) return { ok: false, text: "关键词为空，请提供 keyword。" };

  let list: Law[] = [];
  if (isTauri()) {
    const r = await callRust<Law[]>("laws_search", {
      keyword,
      country: country && country !== "全部国家" ? country : undefined,
    });
    list = r ?? [];
  } else {
    const all = SAMPLE_LAWS;
    const k = keyword.toLowerCase();
    list = all.filter(
      (l) =>
        l.title.toLowerCase().includes(k) ||
        (l.article_no ?? "").toLowerCase().includes(k) ||
        (l.chapter ?? "").toLowerCase().includes(k) ||
        l.content.toLowerCase().includes(k),
    );
  }
  const top = list.slice(0, 8);
  const refs = top.map(lawToRef);
  return {
    ok: true,
    text:
      `在「${country ?? "全部国家"}」中检索“${keyword}”，命中 ${list.length} 条` +
      (list.length >= 500 ? "（仅前 500，已截断）" : "") +
      `，取前 ${top.length} 条：\n` +
      refsText(refs),
    refs,
  };
}

async function runLawById(args: any): Promise<ToolResult> {
  const id = Number(args?.id);
  if (!Number.isFinite(id)) return { ok: false, text: "缺少合法 id。" };
  let law: Law | undefined;
  if (isTauri()) {
    const r = await callRust<Law | null>("law_by_id", { id });
    law = r ?? undefined;
  } else {
    law = sampleById(id);
  }
  if (!law) return { ok: false, text: `库中不存在 id=${id} 的条文（本地示例仅 6 条，勿编造）。` };
  const ref = lawToRef(law);
  return {
    ok: true,
    text: `已取得条文全文：${law.title}${law.article_no ? ` ${law.article_no}` : ""}（来源：${law.source ?? "未知"}）：\n${law.content}`,
    refs: [ref],
  };
}

async function runCountryPreview(args: any): Promise<ToolResult> {
  const country = args?.country ? String(args.country) : undefined;
  let rows: Array<{ title: string; articles: number }> = [];
  if (isTauri()) {
    const r = await callRust<Array<{ title: string; articles: number }>>(
      "laws_country_preview",
      { country: country && country !== "全部国家" ? country : undefined },
    );
    rows = r ?? [];
  } else {
    const stat = new Map<string, number>();
    for (const l of SAMPLE_LAWS) {
      if (country && country !== "全部国家" && !l.title.includes(country)) continue;
      stat.set(l.title, (stat.get(l.title) ?? 0) + 1);
    }
    rows = [...stat.entries()]
      .map(([title, articles]) => ({ title, articles }))
      .sort((a, b) => b.articles - a.articles)
      .slice(0, 8);
  }
  if (rows.length === 0) return { ok: true, text: "该范围暂无重点法规。" };
  return {
    ok: true,
    text:
      `「${country ?? "全部"}」条文最多的法规：\n` +
      rows.map((r) => `- ${r.title}（${r.articles} 条）`).join("\n"),
  };
}

async function runTemplateLoad(args: any): Promise<ToolResult> {
  const category = args?.category ? String(args.category) : undefined;
  let list: Array<{ id: number; title: string; category?: string | null; content: string }> = [];
  if (isTauri()) {
    const r = await callRust<Array<{ id: number; title: string; category?: string | null; content: string }>>(
      "templates_list",
    );
    list = r ?? [];
  } else {
    // 浏览器示例模板
    list = readLocalTemplates();
  }
  const filtered = category ? list.filter((t) => t.category === category) : list;
  const t = filtered[0];
  if (!t) return { ok: true, text: `没有可用模板${category ? `（分类：${category}）` : ""}。` };
  return {
    ok: true,
    text: `已载入模板「${t.title}」（${filtered.length} 份候选中的第 1 份）：\n${truncate(t.content, 1200)}`,
    refs: [],
  };
}

async function runTranslate(args: any): Promise<ToolResult> {
  const text = String(args?.text ?? "").trim();
  const target = String(args?.target ?? "中文").trim();
  if (!text) return { ok: false, text: "没有待翻译文本。" };
  try {
    const out = await translateFree(text, "auto", langCodeOf(target));
    return { ok: true, text: `翻译（目标：${target}）：\n${out}` };
  } catch (e) {
    return { ok: false, text: `翻译失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

function langCodeOf(target: string): string {
  if (/中文|简体/.test(target)) return "zh-CN";
  if (/繁/.test(target)) return "zh-TW";
  if (/日/.test(target)) return "ja";
  if (/英/.test(target)) return "en";
  if (/韩/.test(target)) return "ko";
  if (/法/.test(target)) return "fr";
  if (/德/.test(target)) return "de";
  if (/俄/.test(target)) return "ru";
  if (/西/.test(target)) return "es";
  return target.toLowerCase();
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

interface ToolImpl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any) => Promise<ToolResult>;
}

const IMPLS: ToolImpl[] = [
  {
    name: "laws_search",
    description:
      "在本地法规库（内置日美法 15 万条等）按关键词检索法条。关键词可为条文号、法名或正文词。返回命中条文与来源。country 可选：全部国家 / 日本 / 美国 / 中国。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "检索关键词，如：第五百零二条 / 遺留分 / trademark" },
        country: { type: "string", description: "限定国家：日本 / 美国 / 中国，缺省为全部" },
      },
      required: ["keyword"],
    },
    run: runLawsSearch,
  },
  {
    name: "law_by_id",
    description: "按 id 取回某条法规的完整原文。仅在 laws_search 已返回 id 后使用；id 必须是工具返回的真实 id，禁止编造。",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", description: "法规条文 id" } },
      required: ["id"],
    },
    run: runLawById,
  },
  {
    name: "laws_country_preview",
    description: "查看某国家条文最多的前 8 部法规（用于选择要检索的法名）。",
    parameters: {
      type: "object",
      properties: { country: { type: "string", description: "日本 / 美国 / 中国，缺省为全部" } },
    },
    run: runCountryPreview,
  },
  {
    name: "template_load",
    description: "载入内置法律文书模板（如起诉状、律师函、合同），供起草时参考结构与格式。",
    parameters: {
      type: "object",
      properties: { category: { type: "string", description: "模板分类：诉讼文书 / 函件 / 合同 等" } },
    },
    run: runTemplateLoad,
  },
  {
    name: "translate_text",
    description: "翻译一小段文字（内置免费接口，无需 Key）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "待翻译文本" },
        target: { type: "string", description: "目标语言，如 中文 / 英文 / 日文" },
      },
      required: ["text"],
    },
    run: runTranslate,
  },
];

export function buildTools(): { defs: FunctionTool[]; run: (name: string, args: any) => Promise<ToolResult> } {
  const defs: FunctionTool[] = IMPLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const byName = new Map(IMPLS.map((t) => [t.name, t]));
  return {
    defs,
    run: async (name: string, args: any) => {
      const impl = byName.get(name);
      if (!impl) return { ok: false, text: `未知工具：${name}` };
      try {
        return await impl.run(args);
      } catch (e) {
        return { ok: false, text: `工具 ${name} 执行异常：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
