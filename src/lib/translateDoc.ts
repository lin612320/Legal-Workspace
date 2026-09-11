// 文档翻译的「导入 / 导出」数据层：把用户的文档变成可翻译全文，再把译文写回文档。
//
// 导入路径（桌面优先、浏览器降级）：
//   txt / md / csv / log / json  → 前端直接解码（UTF-8，失败回退 GB18030）
//   docx / pptx / xlsx / xls     → Rust extract_material_b64（自解析 OOXML，零额外依赖）
//   pdf / 图片                    → 支持文件 / 视觉输入的模型转录（明确标注「模型转录，非原文」）
//
// 导出路径：
//   桌面   → docx_export 生成 .docx，并 document_save 落「最近文书」（首页可见、可一键打开）
//   浏览器 → 下载 .md（与文书智能体同一策略）

import { callRust, invokeStrict, isTauri } from "./tauri";
import { analyzeFileWithModel, mimeOfName, IMAGE_EXTS } from "./multimodal";
import { isConfigured, configHint } from "./translate";
import type { ExtractResult } from "./materials";
import type { AIConfig } from "./ai";

/** 前端可直接解码的纯文本类 */
export const TEXT_EXTS = ["txt", "md", "markdown", "csv", "log", "json"];

/** 由 Rust 本地解析的办公文档（OOXML / Excel） */
export const OFFICE_EXTS = ["docx", "pptx", "xlsx", "xlsm", "xls"];

/** 需要模型转录的（PDF / 图片） */
export const MODEL_EXTS = ["pdf", ...IMAGE_EXTS];

/** 可导入的全部扩展名 */
export const DOC_EXTS = [...TEXT_EXTS, ...OFFICE_EXTS, ...MODEL_EXTS];

export const DOC_ACCEPT = DOC_EXTS.map((e) => `.${e}`).join(",");

/** 单文件上限（Rust 侧还有 60 MB 兜底；PDF / 图片另有 20 MB 限制） */
export const MAX_DOC_BYTES = 40 * 1024 * 1024;

export interface DocImportResult {
  fileName: string;
  /** docx / pptx / xlsx / txt / md / csv / pdf / image */
  kind: string;
  text: string;
  blocks: number;
  truncated: boolean;
  /** 文本是否由模型转录（非原文，需提示用户） */
  fromModel: boolean;
  note?: string | null;
}

export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i < 0 ? "" : fileName.slice(i + 1).toLowerCase();
}

/** pdf / 图片需要模型转录 */
export function needsModelExt(fileName: string): boolean {
  return MODEL_EXTS.includes(extOf(fileName));
}

/** 用模型转录文档全文（供翻译使用：要求完整、按版面顺序，不做摘要） */
const TRANSCRIBE_FOR_TRANSLATION_PROMPT =
  "你是文档转录助手。请把这份材料**完整**转录为纯文本，用于后续全文翻译：" +
  "按版面顺序输出正文，保留段落换行、标题层级、条款与章节编号、表格内容（按行用 | 分隔）、" +
  "名单与页码；只输出转录文本本身，不要总结、不要评论、不要翻译、不要补全缺失内容；" +
  "无法可靠辨识的部分用「〔无法辨识〕」标注。";

/** ArrayBuffer → base64（分块拼接，避免超长参数导致栈溢出） */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 纯文本解码：先按 UTF-8 严格解码，失败回退 GB18030（老 Windows 上的中文文本） */
function decodeBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function countBlocks(text: string): number {
  return text.split(/\n{2,}/).filter((s) => s.trim()).length;
}

/**
 * 导入文档并取出全文（供翻译）。
 * @param file 用户选择的文件
 * @param cfg  当前 AI 接口配置（PDF / 图片转录需要）
 */
export async function importDocument(file: File, cfg: AIConfig | null): Promise<DocImportResult> {
  const fileName = file.name || "未命名文件";
  const ext = extOf(fileName);
  const buf = await file.arrayBuffer();

  if (buf.byteLength === 0) throw new Error("文件内容为空。");
  if (buf.byteLength > MAX_DOC_BYTES) {
    throw new Error(`文件超过 ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB 上限，请拆分后再试。`);
  }

  if (TEXT_EXTS.includes(ext)) {
    const text = decodeBytes(buf);
    const kind = ext === "markdown" ? "md" : ext;
    return {
      fileName,
      kind,
      text,
      blocks: countBlocks(text),
      truncated: false,
      fromModel: false,
      note: null,
    };
  }

  if (MODEL_EXTS.includes(ext)) {
    if (!isConfigured(cfg)) {
      throw new Error(`PDF / 图片需要由模型转录全文。${configHint()}`);
    }
    const mime = mimeOfName(fileName);
    const r = await analyzeFileWithModel(cfg!, fileName, toBase64(buf), mime, TRANSCRIBE_FOR_TRANSLATION_PROMPT);
    if (!r.ok || !r.text.trim()) {
      throw new Error(r.err ?? "模型未返回内容，请确认所选模型支持文件 / 图片输入。");
    }
    return {
      fileName,
      kind: mime === "application/pdf" ? "pdf" : "image",
      text: r.text,
      blocks: countBlocks(r.text),
      truncated: false,
      fromModel: true,
      note: "本全文由模型转录（非原文），译文请与原件核对后再使用。",
    };
  }

  if (OFFICE_EXTS.includes(ext)) {
    if (!isTauri()) {
      throw new Error("docx / pptx / xlsx 的文本提取仅桌面版支持；浏览器预览请改用 txt / md 文本文件。");
    }
    const ex = await invokeStrict<ExtractResult>("extract_material_b64", {
      fileName,
      dataB64: toBase64(buf),
    });
    if (!ex || !ex.text.trim()) {
      throw new Error(ex?.note ?? "未能从该文档中提取到文本内容（可能是扫描件或空文档）。");
    }
    return {
      fileName,
      kind: ex.kind,
      text: ex.text,
      blocks: ex.blocks,
      truncated: ex.truncated,
      fromModel: false,
      note: ex.note ?? null,
    };
  }

  throw new Error(
    `暂不支持 .${ext || "?"} 格式：可导入 txt / md / csv / docx / pptx / xlsx / pdf 及图片（png、jpg、webp、bmp）。`,
  );
}

export interface ExportResult {
  ok: boolean;
  /** 桌面版导出成功时的文件路径 */
  path?: string;
  msg: string;
}

/**
 * 导出译文文档：
 * 桌面 → .docx（同时记入「最近文书」，首页可一键打开）；
 * 浏览器 → 下载 .md。
 */
export async function exportTranslatedDoc(
  title: string,
  body: string,
  meta: Record<string, unknown> = {},
): Promise<ExportResult> {
  const md = body.trim();
  if (!md) return { ok: false, msg: "译文为空，无法导出。" };

  if (isTauri()) {
    const r = await invokeStrict<{ path: string; dir: string }>("docx_export", { title, markdown: md });
    if (!r?.path) return { ok: false, msg: "导出失败：未返回文件路径（请检查数据目录权限）。" };
    // 落「最近文书」，首页与文档列表可追溯、可打开
    await callRust<number>("document_save", {
      title,
      content: md,
      filePath: r.path,
      kind: "docx",
      meta: JSON.stringify({ source: "translate", ...meta }),
    });
    return { ok: true, path: r.path, msg: `已导出 Word：${r.path}（已记入首页「最近处理的文书」）` };
  }

  downloadMarkdown(title, md);
  return { ok: false, msg: "浏览器预览模式：已下载 .md 译文；桌面版会导出 .docx。" };
}

/** 下载 Markdown 文本（浏览器 / 桌面均可） */
export function downloadMarkdown(title: string, body: string): void {
  try {
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    console.error("[translate] 下载失败：", e);
  }
}
