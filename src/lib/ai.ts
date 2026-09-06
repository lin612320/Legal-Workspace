// AI 助手：OpenAI 兼容 /chat/completions 流式对话 + 工具调用（function calling）。
//
// 演进说明（智能体赛道 P0）：
// 旧版只支持纯文本 messages；本版向下兼容 chatStream 的同时，新增：
//   - ApiMsg：支持 role = "tool"（工具返回消息）
//   - FunctionTool：tools 声明
//   - chatStreamOnce：一次请求 = 流式增量 + 累积 assistant 消息（content / tool_calls）
// 上层（agent.ts）负责「发起请求 → 若有 tool_calls 则执行工具 → 回填 → 再请求」的循环。

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 支持 tool 角色的消息类型（用于 agent 循环） */
export interface ApiMsg {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

/** function calling 工具声明（OpenAI 兼容 tools 协议子集） */
export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 一次模型回复中要求调用的工具 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string; // JSON 字符串，需由调用方解析
}

/** 把接口地址规整为 /chat/completions 端点。 */
export function normalizeEndpoint(baseUrl: string): string {
  let b = baseUrl.trim().replace(/\/+$/, "");
  if (b && !/\/chat\/completions$/i.test(b)) b += "/chat/completions";
  return b || "https://api.openai.com/v1/chat/completions";
}

export const SYSTEM_PROMPTS: Record<string, string> = {
  通用: "你是「律衡」的 AI 法律助手，请专业、简练地回答用户问题。",
  审合同:
    "你是资深合规律师。请审查用户提供的合同条款，逐一指出：风险条款、责任失衡、约定不明确或可能无效的地方，并给出可直接采用的修改建议。用要点分条输出，先风险后建议。",
  审质证:
    "你是执业多年的出庭律师。请围绕证据的合法性、真实性、关联性，帮用户分析质证要点、质疑证据效力，或起草质证意见。结论要有依据、表述严谨。",
};

interface ParsedToolCallAcc {
  id?: string;
  name?: string;
  argsBuf: string;
}

/**
 * 发起一次 /chat/completions 请求并流式消费。
 * - content 增量实时回调 onDelta；
 * - 若模型返回 tool_calls，累积完成后回调 onTool（参数 JSON 字符串由上层解析）。
 * 返回 { content, tool_calls }：本次 assistant 消息的完整内容与工具调用。
 */
export async function chatStreamOnce(
  cfg: AIConfig,
  messages: ApiMsg[],
  opts: {
    tools?: FunctionTool[];
    onDelta?: (delta: string) => void;
    onTool?: (tc: ToolCallRequest) => void;
    signal?: AbortSignal;
    temperature?: number;
  },
): Promise<{ content: string; tool_calls: ToolCallRequest[] }> {
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
      temperature: opts.temperature ?? 0.7,
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
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
  const accTool = new Map<number, ParsedToolCallAcc>();

  for (;;) {
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
        const j = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
        };
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          full += delta.content;
          opts.onDelta?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const prev = accTool.get(tc.index) ?? { argsBuf: "" };
            if (tc.id) prev.id = tc.id;
            if (tc.function?.name) prev.name = tc.function.name;
            if (tc.function?.arguments) prev.argsBuf += tc.function.arguments;
            accTool.set(tc.index, prev);
          }
        }
      } catch {
        /* 跳过无法解析的片段 */
      }
    }
  }

  // 流结束后统一回调工具调用（防止中断导致半截参数）
  const tool_calls: ToolCallRequest[] = [];
  for (const idx of [...accTool.keys()].sort((a, b) => a - b)) {
    const tc = accTool.get(idx)!;
    if (tc.id && tc.name) {
      const req: ToolCallRequest = { id: tc.id, name: tc.name, arguments: tc.argsBuf };
      tool_calls.push(req);
      opts.onTool?.(req);
    }
  }
  return { content: full, tool_calls };
}

/** 旧接口：一次性纯文本流式对话（无工具），向上兼容 Assistant.tsx。 */
export async function chatStream(
  cfg: AIConfig,
  messages: ChatMsg[],
  opts: { onDelta: (delta: string) => void; signal?: AbortSignal },
): Promise<string> {
  const { content } = await chatStreamOnce(
    cfg,
    messages as ApiMsg[],
    {
      onDelta: opts.onDelta,
      signal: opts.signal,
    },
  );
  return content;
}

/** 请求结构化输出（非流式）：用于计划卡等 JSON 场景；失败返回 null。 */
export async function requestStructuredJson<T>(
  cfg: AIConfig,
  system: string,
  userText: string,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: cfg.model?.trim() || "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userText },
        ],
        stream: false,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
