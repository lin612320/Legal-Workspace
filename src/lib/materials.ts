// 0.7.0·任务材料（多模态导入）数据层
//
// 桌面版：Rust `extract_material` 提取文本（DOCX / PPTX / XLSX / TXT / MD / CSV 本地提取；
//        PDF 与图片需配置支持文件/视觉输入的模型），再经 `attachment_add` 落库。
// 浏览器预览：不提供材料提取（与 Excel 导入同策略），页面给出提示。

import { callRust, isTauri } from "./tauri";

export interface Material {
  id: number;
  task_id: number;
  file_name: string;
  file_path: string;
  kind?: string | null;
  size_bytes?: number | null;
  blocks?: number | null;
  truncated?: boolean;
  note?: string | null;
  text_len?: number;
  created_at: string;
}

export interface ExtractResult {
  kind: string;
  text: string;
  blocks: number;
  truncated: boolean;
  note?: string | null;
}

/** 支持的扩展名（与 src-tauri/src/office.rs 的分派保持一致） */
export const MATERIAL_EXTS = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "txt",
  "md",
  "csv",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
];

export const MATERIAL_ACCEPT = MATERIAL_EXTS.map((e) => `.${e}`).join(",");

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

export function baseNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? path : path.slice(i + 1);
}

/** 该扩展名是否走"需模型解析"的通道（PDF / 图片） */
export function needsModel(path: string): boolean {
  const e = extOf(path);
  return e === "pdf" || ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(e);
}

/** 提取材料文本（桌面版） */
export async function extractMaterial(path: string): Promise<ExtractResult | null> {
  if (!isTauri()) return null;
  return callRust<ExtractResult>("extract_material", { path });
}

export async function addAttachment(
  taskId: number,
  filePath: string,
  ex: ExtractResult,
  sizeBytes?: number,
): Promise<number | null> {
  if (!isTauri()) return null;
  return callRust<number>("attachment_add", {
    taskId,
    fileName: baseNameOf(filePath),
    filePath,
    kind: ex.kind,
    sizeBytes: sizeBytes ?? null,
    text: ex.text,
    blocks: ex.blocks,
    truncated: ex.truncated,
    note: ex.note ?? null,
  });
}

export async function listAttachments(taskId: number): Promise<Material[]> {
  if (!isTauri()) return [];
  return (await callRust<Material[]>("attachments_list", { taskId })) ?? [];
}

export async function deleteAttachment(id: number): Promise<void> {
  if (!isTauri()) return;
  await callRust<void>("attachment_delete", { id });
}

/** 把材料文本拼进任务材料（带来源标注，便于智能体区分原文与材料） */
export function mergeMaterialIntoContext(context: string, fileName: string, text: string): string {
  const body = text.trim();
  if (!body) return context;
  const block = `【材料：${fileName}】\n${body}`;
  return context.trim() ? `${context.trim()}\n\n${block}` : block;
}
