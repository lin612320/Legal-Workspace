// AI 接口预设：**只收录已查证到的 OpenAI 兼容端点**。
//
// 纪律（工单 P0-1 硬约束 / D1 不得虚报）：
//   1. 每一条的 baseUrl 与 model 都必须有官方文档依据，`source` 写明链接；
//   2. **查不到就整条不放**，宁可少一个预设，也不许把一个错的端点写进代码；
//   3. 不预填任何厂商的 Key —— Key 永远由用户自己填。
//
// 本轮**没有**收录的厂商及原因（写在这里，免得后来又有人凭印象补上去）：
//   · 通义法睿 —— 阿里云百炼当前的模型目录里没有它的 OpenAI 兼容模型名，
//     也没有可引用的公开 base_url。查不到 → 按纪律**不进代码**。
//     （百炼模型目录：https://help.aliyun.com/zh/model-studio/models）
//   · 智谱 GLM / Kimi（月之暗面）—— 本轮**未取得**可引用的官方 base_url 原文，
//     同样按纪律不写。需要时请用「自定义」手填，或先补依据再加入。

export interface ModelPreset {
  /** 稳定标识，用于下拉选项的 value */
  id: string;
  /** 下拉里显示的名字 */
  label: string;
  /** OpenAI 兼容 base_url（未带 /chat/completions，由 normalizeEndpoint 补全） */
  baseUrl: string;
  /** 建议模型名；空串表示该厂商的模型名由用户自填（如本地 Ollama） */
  model: string;
  /** 依据链接：这条预设在官方文档里的出处 */
  source: string;
  /** 给用户的一句补充提示（可选） */
  hint?: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "dashscope",
    label: "阿里云百炼（千问）",
    // 依据：官方「OpenAI Chat 接口兼容」文档给出
    //   https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
    // 并说明旧域名 https://dashscope.aliyuncs.com 「仍可正常使用」。
    // 这里用**旧域名**，因为新域名要填 {WorkspaceId}，没法预置成一条固定值。
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-plus",
    source: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    hint: "若你的控制台给了专属域名（含业务空间 ID），请改用「自定义」填专属域名。",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    // 依据：官方文档「首次调用 API」
    //   base_url = https://api.deepseek.com，model = deepseek-flash / deepseek-v4-pro
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    source: "https://api-docs.deepseek.com/zh-cn/",
    hint: "模型也可填 deepseek-v4-pro（更贵、更强推理）。",
  },
  {
    id: "ollama",
    label: "Ollama（本机）",
    // 依据：官方「OpenAI compatibility」，本地服务提供 /v1/chat/completions
    baseUrl: "http://localhost:11434/v1",
    // 本地模型名取决于你 `ollama pull` 过什么，无法预置。
    model: "",
    source: "https://docs.ollama.com/api/openai-compatibility",
    hint: "模型名填你本机已有的，例如 `ollama list` 里看到的那个；Key 随便填（本地不校验）。",
  },
];

/** 预设 id 常量，避免各处写裸字符串 */
export const PRESET_CUSTOM = "custom";
