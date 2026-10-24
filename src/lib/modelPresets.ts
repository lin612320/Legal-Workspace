// AI 接口预设：**只收录已查证到的 OpenAI 兼容端点**。
//
// 纪律（工单 P0-1 硬约束 / D1 不得虚报）：
//   1. 每一条的 baseUrl 与 model 都必须有官方文档依据，`source` 写明链接；
//   2. **查不到就不填**，宁可少一个预设，也不许把一个猜的端点写进代码；
//   3. 不预填任何厂商的 Key —— Key 永远由用户自己填。
//
// 关于「通义法睿」（本轮工单点名的法律垂类模型）：
//   它在下拉里**有这一项**，但 baseUrl / model 都是空串、并标记 `guideOnly: true`，
//   选中后只显示一段说明，不做任何预填。
//   原因：阿里云百炼当前公开的模型目录（https://help.aliyun.com/zh/model-studio/models）
//   里没有法睿的 OpenAI 兼容模型名，也查不到可引用的 base_url；法睿的产品页
//   （https://tongyi.aliyun.com/farui）存在，但它不是 API 文档，给不出端点与模型名。
//   所以这里**不替用户编一个地址**，只告诉他去哪里开通、填什么。
//
// 同样**没有**预填的厂商：智谱 GLM / Kimi（月之暗面）—— 本轮未取得可引用的官方
// base_url 原文，需要时用「自定义」手填，或先补依据再加入。

export interface ModelPreset {
  /** 稳定标识，用于下拉选项的 value */
  id: string;
  /** 下拉里显示的名字 */
  label: string;
  /** OpenAI 兼容 base_url（未带 /chat/completions，由 normalizeEndpoint 补全） */
  baseUrl: string;
  /** 建议模型名；空串表示该厂商的模型名由用户自填（如本地 Ollama / 法睿） */
  model: string;
  /** 依据链接：这条预设在官方文档里的出处 */
  source: string;
  /** 给用户的一句补充提示（可选） */
  hint?: string;
  /**
   * true = **指引项**：不对 baseUrl / model 做任何预填，选中后只展示说明。
   * 用于「模型确实存在、但我查证不到可预填的接口」的厂商。
   */
  guideOnly?: boolean;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "farui",
    label: "通义法睿（法律垂类 · 需在百炼开通）",
    // 刻意留空：查不到可预填的官方端点与模型名，就不填（见文件头注释）
    baseUrl: "",
    model: "",
    source: "https://tongyi.aliyun.com/farui",
    hint:
      "法睿需先在阿里云百炼开通。开通后把你控制台给出的 base_url 与模型名填到下面的" +
      "「接口地址」与「模型名」两栏（百炼的 OpenAI 兼容地址形如 " +
      "https://dashscope.aliyuncs.com/compatible-mode/v1 ）。填完点「测试连接」验证。",
    guideOnly: true,
  },
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
