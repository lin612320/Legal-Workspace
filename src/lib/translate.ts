// 翻译引擎：统一走「数据设置 → AI 接口」（OpenAI 兼容 /chat/completions）。
//
// 设计取舍（v0.7.1）：
//   1) 彻底移除内置免费接口（Google gtx）——国内网络不可达、译文不可控，
//      全部译文一律由用户配置的模型（DeepSeek / OpenAI / 通义 / 智谱 等）产出，
//      与「文书智能体」共用同一份接口配置（s.ai），不再单独配置翻译通道。
//   2) 长文档按段落分块、顺序翻译、逐块流式回显，保证「导入文档全文翻译」可控可中断、
//      不会因为一次塞进超长文本而超上下文或静默丢段。

import { chatStreamOnce, type AIConfig } from "./ai";

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

/** 翻译配置 = AI 接口配置（翻译不再有独立通道） */
export type TranslateConfig = AIConfig;

/** 单次请求的建议最大字符数：长文档按此分块 */
export const CHUNK_CHARS = 2400;

/** 接口是否已配置（未配置时页面给出引导而不是静默失败） */
export function isConfigured(cfg: TranslateConfig | null | undefined): boolean {
  return !!cfg && !!cfg.baseUrl.trim() && !!cfg.apiKey.trim();
}

/** 未配置接口时的统一提示文案 */
export function configHint(): string {
  return (
    "翻译统一使用「数据设置 → AI 接口」的配置，当前尚未填写。" +
    "请在「数据设置」里填写 base_url 与 API Key（如 DeepSeek：https://api.deepseek.com/v1，模型 deepseek-chat）。"
  );
}

/** 构造翻译系统提示词；segment 用于长文档分块时的一致性约束 */
function buildSystem(fromLabel: string, toLabel: string, segment?: { index: number; total: number }): string {
  let s =
    `你是专业翻译。请把用户文本从「${fromLabel}」翻译成「${toLabel}」。` +
    "只输出译文本身，不要任何解释、注释、标题或原文对照；保留原有的段落换行与条款/章节编号。" +
    "专有名词、法条名称、机构与人名按目标语言的通行译法处理，同一术语前后保持一致。";
  if (fromLabel.includes("自动")) {
    s += "若无法判断原文语种，按最可能的语种处理。";
  }
  if (segment && segment.total > 1) {
    s += `这是同一份长文档的第 ${segment.index}/${segment.total} 段，只需翻译本段，翻译风格与术语须与其余各段保持一致。`;
  }
  return s;
}

export interface TranslateOptions {
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  /** 长文档分块信息（由 translateLongText 传入） */
  segment?: { index: number; total: number };
}

/** 翻译单块文本（流式；返回完整译文） */
export async function translateText(
  cfg: TranslateConfig,
  text: string,
  fromLabel: string,
  toLabel: string,
  opts: TranslateOptions = {},
): Promise<string> {
  if (!isConfigured(cfg)) throw new Error(configHint());
  const src = text.trim();
  if (!src) return "";

  const { content } = await chatStreamOnce(
    cfg,
    [
      { role: "system", content: buildSystem(fromLabel, toLabel, opts.segment) },
      { role: "user", content: src },
    ],
    { onDelta: opts.onDelta, signal: opts.signal, temperature: 0.2 },
  );

  const out = content.trim();
  if (!out) {
    throw new Error("模型未返回译文，请检查「数据设置」中的接口地址、API Key 与模型名是否正确。");
  }
  return out;
}

/** 极长单段（无空行）：优先在句末标点处断开，其次按字符边界硬切 */
function hardSplit(paragraph: string, max: number): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    const cands = [
      win.lastIndexOf("。"),
      win.lastIndexOf("！"),
      win.lastIndexOf("？"),
      win.lastIndexOf("\n"),
      win.lastIndexOf("；"),
      win.lastIndexOf(". "),
      win.lastIndexOf("; "),
    ];
    const cut = Math.max(...cands);
    const at = cut > max * 0.5 ? cut + 1 : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** 按空行分段聚合成不超过 maxChars 的块；不在段落中间随意截断 */
export function splitForTranslation(text: string, maxChars: number = CHUNK_CHARS): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };

  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) continue;
    if (p.length > maxChars) {
      flush();
      for (const piece of hardSplit(p, maxChars)) chunks.push(piece);
      continue;
    }
    if (buf && buf.length + p.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();

  if (chunks.length === 0 && text.trim()) return [text.trim()];
  return chunks;
}

export interface LongTranslateOptions {
  /** 每块增量（chunkIndex 从 0 开始），便于按块渲染进度 */
  onDelta?: (delta: string, chunkIndex: number) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  maxChars?: number;
}

/** 长文翻译：分块顺序翻译，逐块流式回显 + 进度回调 */
export async function translateLongText(
  cfg: TranslateConfig,
  text: string,
  fromLabel: string,
  toLabel: string,
  opts: LongTranslateOptions = {},
): Promise<string> {
  const chunks = splitForTranslation(text, opts.maxChars ?? CHUNK_CHARS);
  if (chunks.length === 0) return "";

  const done: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("已停止翻译", "AbortError");
    const out = await translateText(cfg, chunks[i], fromLabel, toLabel, {
      signal: opts.signal,
      onDelta: opts.onDelta ? (d) => opts.onDelta!(d, i) : undefined,
      segment: { index: i + 1, total: chunks.length },
    });
    done.push(out);
    opts.onProgress?.(i + 1, chunks.length);
  }
  return done.join("\n\n");
}

/**
 * 文档翻译标题：{原名} · {目标语言}译文
 */
export function translatedDocTitle(fileName: string, toLabel: string): string {
  const base = fileName.replace(/\.[^.\\/]+$/, "") || fileName;
  return `${base} · ${toLabel}译文`;
}
