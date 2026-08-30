// 翻译引擎：内置免费接口（Google gtx，无需 Key）+ 可配置付费接口（OpenAI 兼容）。

export interface Lang {
  code: string;
  label: string;
}

/** 常用语种；source 侧可选 auto 自动检测 */
export const LANGS: Lang[] = [
  { code: "auto", label: "自动检测" },
  { code: "zh-CN", label: "中文" },
  { code: "zh-TW", label: "繁体中文" },
  { code: "en", label: "英文" },
  { code: "ja", label: "日文" },
  { code: "ko", label: "韩文" },
  { code: "fr", label: "法文" },
  { code: "de", label: "德文" },
  { code: "es", label: "西班牙文" },
  { code: "it", label: "意大利文" },
  { code: "pt", label: "葡萄牙文" },
  { code: "ru", label: "俄文" },
  { code: "ar", label: "阿拉伯文" },
  { code: "th", label: "泰文" },
  { code: "vi", label: "越南文" },
  { code: "nl", label: "荷兰文" },
];

export function langLabel(code: string): string {
  return LANGS.find((l) => l.code === code)?.label ?? code;
}

/** 内置免费接口：Google translate gtx 端点，自动检测由 sl=auto 完成。 */
export async function translateFree(text: string, from: string, to: string): Promise<string> {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx` +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t` +
    `&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`免费翻译请求失败（HTTP ${res.status}）`);
  const data = (await res.json()) as unknown[];
  const segments = (data?.[0] as Array<Array<string>>) ?? [];
  const out = segments.map((seg) => seg[0]).join("");
  if (!out) throw new Error("免费翻译未返回结果，可能语种不受支持或字数过多。");
  return out;
}

export interface PaidConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

/** 付费接口：OpenAI 兼容 /chat/completions，让模型直接输出译文。 */
export async function translatePaid(
  text: string,
  fromLabel: string,
  toLabel: string,
  cfg: PaidConfig,
): Promise<string> {
  let base = cfg.baseUrl.trim().replace(/\/+$/, "");
  if (base && !/\/chat\/completions$/i.test(base)) base += "/chat/completions";
  const endpoint = base || "https://api.openai.com/v1/chat/completions";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: cfg.model?.trim() || "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `你是专业翻译。请把用户文本从「${fromLabel}」翻译成「${toLabel}」，只输出译文本身，不要任何解释或额外内容。`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`付费翻译失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("付费翻译未返回内容，请检查接口地址与 Key。");
  return out;
}