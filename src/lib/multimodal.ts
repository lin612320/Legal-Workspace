// 0.7.0·多模态（模型路径）：把 PDF / 图片交给「支持文件/视觉输入的模型」解析。
//
// 依赖：用户需在「数据设置」配置支持视觉 / 文件输入的 OpenAI 兼容模型
//（如 gpt-4o 系、Qwen-VL/Omni 系）；未配置时由调用方给出提示。
//
// 注意：模型的"转录/要点"不是材料原文，调用方必须给文本加免责前缀，
// 避免被误当作原始证据进入引用自检（与"不编造法条"口径一致）。

import { callRust, isTauri } from "./tauri";
import { normalizeEndpoint, type AIConfig, type ApiContentPart } from "./ai";

export interface FileBase64 {
  mime: string;
  size: number;
  base64: string;
}

const DEFAULT_PROMPT =
  "你是法律文书转录助手。请完整提取这份法律材料的可引用内容：正文与条款、章节与编号、" +
  "日期与期限、当事人与金额、签名与落款。只输出材料本身可靠呈现的内容与要点，" +
  "不要评论、不要补全缺失信息；无法可靠辨识的部分明确标注「无法辨识」。";

/** 读取本地文件为 base64（桌面版，大小上限在 Rust 端限制为 20 MB） */
export async function readFileBase64(path: string): Promise<FileBase64 | null> {
  if (!isTauri()) return null;
  return callRust<FileBase64>("read_file_base64", { path });
}

/** 把 PDF / 图片交给模型解析，返回转录文本 */
export async function analyzeMaterialWithModel(
  cfg: AIConfig,
  path: string,
  fileName: string,
): Promise<{ ok: boolean; text: string; err?: string }> {
  const fb = await readFileBase64(path);
  if (!fb) {
    return { ok: false, text: "", err: "读取文件失败（仅桌面版支持）。" };
  }
  const dataUrl = `data:${fb.mime};base64,${fb.base64}`;
  const parts: ApiContentPart[] = [{ type: "text", text: DEFAULT_PROMPT }];
  if (fb.mime.startsWith("image/")) {
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  } else if (fb.mime === "application/pdf") {
    parts.push({ type: "file", file: { filename: fileName, file_data: dataUrl } });
  } else {
    return { ok: false, text: "", err: `暂不支持把 ${fb.mime} 直接交给模型，请先转为文本。` };
  }

  try {
    const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: cfg.model?.trim() || "gpt-4o-mini",
        messages: [{ role: "user", content: parts }],
        stream: false,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(150_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      return {
        ok: false,
        text: "",
        err: `模型解析请求失败（HTTP ${res.status}）${body ? `：${body}` : ""}——当前模型可能不支持文件/图片输入，请在「数据设置」改用支持视觉的模型（如 gpt-4o、Qwen-VL）。`,
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!text) {
      return { ok: false, text: "", err: "模型未返回内容。" };
    }
    return { ok: true, text: text.slice(0, 80_000) };
  } catch (e) {
    return {
      ok: false,
      text: "",
      err: `模型解析失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
