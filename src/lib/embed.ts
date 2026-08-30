// 向量检索：OpenAI 兼容 /embeddings + 余弦相似度。

import type { AIConfig } from "./ai";

/** 调 /embeddings 把文本批量向量化 */
export async function embedTexts(cfg: AIConfig, texts: string[]): Promise<number[][]> {
  let base = cfg.baseUrl.trim().replace(/\/+$/, "");
  if (base) {
    // 从 /chat/completions 或裸地址规整为 /embeddings
    base = base.replace(/\/chat\/completions$/i, "");
    base += "/embeddings";
  } else {
    base = "https://api.openai.com/v1/embeddings";
  }
  const res = await fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: cfg.model?.trim() || "text-embedding-3-small",
      input: texts,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`向量化请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const out = (data.data ?? []).map((d) => d.embedding);
  if (out.length !== texts.length) throw new Error("向量化返回数量与输入不匹配");
  return out;
}

/** 余弦相似度（0~1） */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
