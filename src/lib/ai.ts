// AI 助手：OpenAI 兼容 /chat/completions 流式对话。

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

/** 把接口地址规整为 /chat/completions 端点。 */
export function normalizeEndpoint(baseUrl: string): string {
  let b = baseUrl.trim().replace(/\/+$/, "");
  if (b && !/\/chat\/completions$/i.test(b)) b += "/chat/completions";
  return b || "https://api.openai.com/v1/chat/completions";
}

export const SYSTEM_PROMPTS: Record<string, string> = {
  通用: "你是「律政工作台」的 AI 法律助手，请专业、简练地回答用户问题。",
  审合同:
    "你是资深合规律师。请审查用户提供的合同条款，逐一指出：风险条款、责任失衡、约定不明确或可能无效的地方，并给出可直接采用的修改建议。用要点分条输出，先风险后建议。",
  审质证:
    "你是执业多年的出庭律师。请围绕证据的合法性、真实性、关联性，帮用户分析质证要点、质疑证据效力，或起草质证意见。结论要有依据、表述严谨。",
};

/** 流式对话：边返回边把增量交给 onDelta，结束后返回完整文本。
 *  传入 opts.signal 可随时中止（AbortController）。 */
export async function chatStream(
  cfg: AIConfig,
  messages: ChatMsg[],
  opts: { onDelta: (delta: string) => void; signal?: AbortSignal },
): Promise<string> {
  const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: cfg.model?.trim() || "gpt-4o-mini",
      messages,
      stream: true,
      temperature: 0.7,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("当前环境不支持流式读取，请换用桌面版。");

  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    // 主动检查中止，避免等下一次 read 才返回
    if (opts.signal?.aborted) {
      throw new DOMException("已停止生成", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          full += d;
          opts.onDelta(d);
        }
      } catch {
        /* 跳过无法解析的片段 */
      }
    }
  }
  return full;
}