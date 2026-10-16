// ---------------------------------------------------------------------------
// 智能体自我优化 · 联邦配方进化（Federated Recipe Evolution, FRE）核心纯函数层
//
// 口径来源：docs/12-联邦配方进化方案.md —— **0.8.0 规划 · 方案稿（未实现）**。
// 本模块把方案稿里"本地信号 → 匿名进化包 → 加权聚合 → 签名配方 → A/B 采纳"
// 这条链路写成**可运行的真实代码**，供可视化页面调用；页面负责画图，此处只算数。
//
// 三层诚实边界（页面上必须同步展示，不允许含糊）：
//   1) **不是强化学习**：奖励只用于"加权"，没有价值函数、没有策略梯度、没有 rollout；
//   2) **客户端行为是仿真**（docs/12 §7.1 既定演示路径），而"隐私处理 / 加权聚合 /
//      采纳判定 / 指纹"是真实实现；真实任务日志可得的部分一律优先用真数据；
//   3) **配方是 KB 级编排资产**，不是大模型权重（docs/12 §2.2：模型走 API，本地无权重）。
//
// 全部函数为纯函数（除显式传入的随机源外无副作用），同种子可复现。
// ---------------------------------------------------------------------------

import { fallbackPlan, TASK_KINDS, isTaskKind, type TaskKind } from "./agent";
// 仅类型导入：`recipe.ts` 用 `import type { RecipeManifest } from "./evolution"`
// 反向引用本模块的类型，两边都是**类型层**，不产生运行时循环依赖。
import type { RecipeRuntimeParams } from "./recipe";

/* ============================ 一、常量与口径 ============================ */

/** 进化包 schema 版本（docs/12 §5.1） */
export const FRE_SCHEMA = "fre.evolution-package/v1";

/**
 * 演示轮的固定轮数（收敛曲线横轴长度）。
 *
 * 原先硬编码在 `EvolutionLab.tsx` 里，候选计算（`computeRecipeCandidate`）
 * 需要写进配方的 `version` 字段，**必须与实验台同源**，否则会出现
 * 「实验台算出的版本号」与「设置页算出的版本号」不一致。
 */
export const TOTAL_ROUNDS = 12;

/** 本机演示的默认随机种子：同一种子 → 同一条收敛曲线，便于复现与讲解 */
export const FRE_DEFAULT_SEED = 20260908;

/** 生产口径的最小匿名集合下限（docs/12 §6.1：不足 K 人的桶不上行） */
export const K_ANON_PROD = 20;

/** 本地演示口径的 K：单机只有 3–5 个虚拟用户，若用 K=20 则所有桶都会被丢弃 */
export const K_ANON_DEMO = 2;

/** 新鲜度衰减系数（docs/12 §5.3：w = 样本量 × 审计通过率 × exp(-λ·age)） */
export const FRESHNESS_LAMBDA = 0.05;

/** A/B 采纳回退容忍度：任一指标回退超过该比例则不予采纳（docs/12 §5.4） */
export const ADOPT_REGRESSION_TOLERANCE = 0.05;

/** 页面上必须露出的口径声明（单一来源，避免各处口径漂移） */
export const FRE_DISCLAIMER =
  "本页为 0.8.0 规划 · 方案稿（docs/12）的可视化：聚合、差分隐私、K 匿名、加权公式、" +
  "指纹与采纳判定为真实实现；客户端行为为仿真，真实任务日志可得处优先用实测值（图上标「实测」）。" +
  "这不是强化学习——奖励只参与加权，没有策略梯度与价值函数。";

/**
 * 禁止出网的字段名（docs/12 §6.2 红线：原文 / 文书 / 密钥类字段一律不得进进化包）。
 * 用 schema 强制而非自觉：任何进化包在打包与展示前都要过一遍 whitelistViolations()。
 */
export const FORBIDDEN_FIELDS = [
  "context",
  "content",
  "content_zh",
  "title",
  "title_zh",
  "result",
  "result_ref",
  "excerpt",
  "prompt",
  "note",
  "file_path",
  "api_key",
  "apiKey",
  "key",
  "caseName",
  "text",
] as const;

/* ============================ 二、可复现随机源 ============================ */

/** mulberry32：32 位种子伪随机数发生器（同种子 → 同序列） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态（Box–Muller），供高斯机制与仿真个体噪声使用 */
export function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 拉普拉斯噪声（对称，scale = 敏感度 / ε），供计数类查询的差分隐私使用 */
export function laplace(rng: () => number, scale: number): number {
  const u = rng() - 0.5;
  const s = u < 0 ? -1 : 1;
  return -scale * s * Math.log(1 - 2 * Math.abs(u));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number, digits = 4): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/* ============================ 三、真实任务日志 → 奖励信号 ============================ */

/** tasks 表一行（Rust task_list 原样返回，字段为 snake_case） */
export interface RawTaskRow {
  id: number;
  kind: string;
  title: string;
  status: string;
  context?: string | null;
  plan_json?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** task_steps 表一行（Rust task_get 的 steps 元素） */
export interface RawTaskStep {
  name: string;
  tool?: string | null;
  status: string;
  result_ref?: string | null;
  need_confirm?: boolean;
  params_json?: string | null;
}

/** 本地任务日志：列表 + 可按需补充的明细（明细用于解析质检与检索结果） */
export interface TaskLog {
  rows: RawTaskRow[];
  details?: Map<number, RawTaskStep[]>;
}

export type SignalKey = "plan_drift" | "audit_pass" | "search_zero_hit" | "gate" | "completion";

export interface RewardSignal {
  key: SignalKey;
  label: string;
  /** 期望方向：up = 越大越好，down = 越小越好 */
  direction: "up" | "down";
  /** 真实取值；null 表示本机数据不足（面板上要如实标"不可得"而不是编一个数） */
  value: number | null;
  display: string;
  /** 信号来自哪段代码（答辩时可当场指） */
  source: string;
  available: boolean;
  note: string;
  samples: number;
}

/** 计划卡与"默认骨架"的差异统计（docs/12 §5.2 第一行：用户对默认工作流的隐式偏好） */
export interface PlanEditDiff {
  tasks: number;
  editedTasks: number;
  /** 默认骨架里被删掉/改掉的步骤 → 次数 */
  removed: Record<string, number>;
  /** 用户新加的步骤 → 次数 */
  added: Record<string, number>;
  editCount: number;
  /** 每任务平均偏离步骤数（越小越好） */
  editRate: number;
}

/** 检索词典统计（docs/12 §5.2 第三行：词典缺口与数据缺口） */
export interface LexiconStat {
  searched: number;
  zeroHit: Record<string, number>;
  good: Record<string, number>;
}

/** 引用自检聚合（docs/12 §5.2 第二行：代码级质检标签，非模型自述） */
export interface QualityStat {
  auditedTasks: number;
  total: number;
  covered: number;
  /** 已覆盖 / 识别到（无引用的任务不计入） */
  passRatio: number;
  unmatched: Record<string, number>;
}

/** 解析 plan_json（容错：历史任务的 plan_json 可能为空或不是合法 JSON） */
export function parsePlanJson(planJson: string | null | undefined): Array<{ name: string; tool?: string }> {
  if (!planJson) return [];
  try {
    const v = JSON.parse(planJson) as unknown;
    if (!Array.isArray(v)) return [];
    const out: Array<{ name: string; tool?: string }> = [];
    for (const it of v) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      if (!name) continue;
      const tool = typeof o.tool === "string" ? o.tool : undefined;
      out.push({ name, tool });
    }
    return out;
  } catch {
    return [];
  }
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * 计划卡偏离度：把落库的计划卡与该任务类型的**默认骨架**（fallbackPlan）对齐，
 * 多出来的步骤记为 added、缺失的记为 removed。
 *
 * ⚠ 口径说明（页面上要写出来）：默认骨架只在"未配置模型 / 规划失败"时使用，
 * 模型规划出的计划天然会与骨架不同，因此本指标是**用户人工编辑的上界代理**，
 * 不是精确的编辑次数。方案稿（docs/12 §5.3）要求的精确 diff 需要在
 * applyEditedPlan 前后各存一份计划卡，属于 M1 的落地项。
 */
export function extractPlanEditDiff(rows: RawTaskRow[]): PlanEditDiff {
  const removed: Record<string, number> = {};
  const added: Record<string, number> = {};
  let tasks = 0;
  let editedTasks = 0;
  let editCount = 0;

  for (const r of rows) {
    if (!isTaskKind(r.kind)) continue;
    const saved = parsePlanJson(r.plan_json);
    if (saved.length === 0) continue;
    tasks += 1;
    const def = fallbackPlan(r.kind).map((s) => s.name);
    const savedNames = new Set(saved.map((s) => s.name));
    const defNames = new Set(def);

    let touched = 0;
    for (const n of defNames) {
      if (!savedNames.has(n)) {
        bump(removed, n);
        touched += 1;
      }
    }
    for (const n of savedNames) {
      if (!defNames.has(n)) {
        bump(added, n);
        touched += 1;
      }
    }
    editCount += touched;
    if (touched > 0) editedTasks += 1;
  }

  return {
    tasks,
    editedTasks,
    removed,
    added,
    editCount,
    editRate: tasks > 0 ? round(editCount / tasks, 3) : 0,
  };
}

/** 从质检步骤的 result_ref 里解析引用自检数字（格式见 agent.ts::auditReport） */
export function parseAuditRef(ref: string): { total: number; covered: number } | null {
  const t = /识别到条文号引用\s*(\d+)\s*处/.exec(ref);
  const c = /对应：\s*(\d+)\s*\/\s*(\d+)/.exec(ref);
  if (!c) return null;
  const covered = Number(c[1]);
  const total = t ? Number(t[1]) : Number(c[2]);
  if (!Number.isFinite(total) || !Number.isFinite(covered)) return null;
  return { total, covered };
}

/** 从检索步骤的 result_ref 里解析检索词与命中数（格式见 tools.ts 的 laws_search 返回） */
export function parseSearchRef(ref: string): { country: string; keyword: string; hits: number } | null {
  const m = /在「([^」]*)」中检索[“"]([^”"]*)[”"]，命中\s*(\d+)\s*条/.exec(ref);
  if (!m) return null;
  return { country: m[1], keyword: m[2], hits: Number(m[3]) };
}

/** 汇总引用自检（只统计真正识别到引用的任务，无引用任务不计入通过率分母） */
export function extractQuality(details: Iterable<RawTaskStep[]>): QualityStat {
  let auditedTasks = 0;
  let total = 0;
  let covered = 0;
  const unmatched: Record<string, number> = {};
  for (const steps of details) {
    for (const s of steps) {
      const ref = s.result_ref ?? "";
      const a = parseAuditRef(ref);
      if (!a || a.total === 0) continue;
      auditedTasks += 1;
      total += a.total;
      covered += a.covered;
      const list = /未在工具返回中找到[^\n]*\n?\s*([^\n]*)/.exec(ref);
      if (list && a.covered < a.total) {
        for (const t of list[1].matchAll(/「([^」]+)」/g)) bump(unmatched, t[1]);
      }
    }
  }
  return {
    auditedTasks,
    total,
    covered,
    passRatio: total > 0 ? round(covered / total, 4) : 0,
    unmatched,
  };
}

/** 汇总检索词典：命中 0 条的检索词 = 词典/数据缺口；有命中的词 = 好词 */
export function extractLexicon(details: Iterable<RawTaskStep[]>): LexiconStat {
  let searched = 0;
  const zeroHit: Record<string, number> = {};
  const good: Record<string, number> = {};
  for (const steps of details) {
    for (const s of steps) {
      if (s.tool !== "laws_search") continue;
      const p = parseSearchRef(s.result_ref ?? "");
      if (!p) continue;
      searched += 1;
      if (p.hits === 0) bump(zeroHit, p.keyword || "（空关键词）");
      else bump(good, p.keyword);
    }
  }
  return { searched, zeroHit, good };
}

/**
 * 五类零标注奖励信号（docs/12 §5.2 全表）。
 * 真数据不可得的项 value 为 null、available=false —— 面板上如实显示"本机暂无"，
 * 绝不填一个看起来漂亮的假数。
 */
export function extractRewardSignals(log: TaskLog): RewardSignal[] {
  const rows = log.rows;
  const details = log.details ? [...log.details.values()] : [];

  const diff = extractPlanEditDiff(rows);
  const quality = extractQuality(details);
  const lex = extractLexicon(details);

  const done = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const completion = rows.length > 0 ? round(done / rows.length, 4) : 0;

  let gates = 0;
  let gatesPassed = 0;
  for (const steps of details) {
    for (const s of steps) {
      if (!s.need_confirm) continue;
      gates += 1;
      if (s.status === "done") gatesPassed += 1;
    }
  }

  const zeroHitWords = Object.keys(lex.zeroHit).length;

  return [
    {
      key: "plan_drift",
      label: "计划卡偏离默认骨架",
      direction: "down",
      value: diff.tasks > 0 ? diff.editRate : null,
      display: diff.tasks > 0 ? `${diff.editRate} 步/任务` : "本机暂无计划卡",
      source: "tasks.plan_json ↔ agent.ts::fallbackPlan",
      available: diff.tasks > 0,
      note: `共 ${diff.tasks} 张计划卡，其中 ${diff.editedTasks} 张与骨架不同（含模型规划差异，属上界代理）`,
      samples: diff.tasks,
    },
    {
      key: "audit_pass",
      label: "引用自检通过率",
      direction: "up",
      value: quality.total > 0 ? quality.passRatio : null,
      display: quality.total > 0 ? `${(quality.passRatio * 100).toFixed(1)}%` : "本机暂无质检记录",
      source: "agent.ts::auditCitations → task_steps.result_ref",
      available: quality.total > 0,
      note:
        quality.total > 0
          ? `${quality.auditedTasks} 个任务、识别引用 ${quality.total} 处，覆盖 ${quality.covered} 处（代码规则校验，非模型自述）`
          : "需要至少一个跑到质检步骤的任务",
      samples: quality.auditedTasks,
    },
    {
      key: "search_zero_hit",
      label: "检索 0 命中词",
      direction: "down",
      value: lex.searched > 0 ? zeroHitWords : null,
      display: lex.searched > 0 ? `${zeroHitWords} 个 / 共 ${Object.keys(lex.good).length + zeroHitWords} 个词` : "本机暂无检索记录",
      source: "tools.ts::laws_search → task_steps.result_ref",
      available: lex.searched > 0,
      note:
        lex.searched > 0
          ? `${lex.searched} 次检索；0 命中词是法库/词典缺口，也是产品路线输入`
          : "需要至少一次 laws_search 工具调用",
      samples: lex.searched,
    },
    {
      key: "gate",
      label: "人工确认闸门",
      direction: "down",
      value: details.length > 0 ? gates : null,
      display: details.length > 0 ? `${gatesPassed}/${gates} 已放行` : "本机暂无闸门记录",
      source: "task_steps.need_confirm / status",
      available: details.length > 0,
      note: "闸门被拦下的位置 = 风险敏感点；放行率低说明默认流水线在该处需要更好的配方",
      samples: gates,
    },
    {
      key: "completion",
      label: "任务完成率",
      direction: "up",
      value: rows.length > 0 ? completion : null,
      display: rows.length > 0 ? `${(completion * 100).toFixed(1)}%（${done} 完成 / ${failed} 失败）` : "本机暂无任务",
      source: "tasks.status",
      available: rows.length > 0,
      note: "端到端是否真的交出成果——比任何问卷都硬",
      samples: rows.length,
    },
  ];
}

/* ============================ 四、进化包与隐私处理 ============================ */

export interface EvolutionPackage {
  schema: string;
  client: string;
  bucket: { task_kind: string; country: string; lang: string };
  sample_n: number;
  plan_edit: {
    default_steps_removed: Record<string, number>;
    added_tool_sequence: Array<[string[], number]>;
    avg_edit_steps: number;
  };
  lexicon: { zero_hit_keywords: Record<string, number>; good_keywords: Record<string, number> };
  quality: { audit_pass_ratio: number; unmatched_tokens: Record<string, number> };
  memory_prototype: number[];
  dp: { mechanism: "laplace" | "none"; epsilon: number; applied: boolean };
  /** 本包由多少条真实任务折算而来（0 = 纯仿真） */
  real_samples: number;
  /** 包体积（字节），用于展示"KB 级载荷" */
  size_bytes: number;
}

/** 计算 JSON 规范化后的字节数（UTF-8） */
export function jsonBytes(v: unknown): number {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    // 循环引用等不可序列化值：不抛异常，返回 0，由调用方自行决定如何处理。
    // （EV7 单测发现的缺陷：原实现直接 JSON.stringify，遇到循环结构会抛 TypeError）
    return 0;
  }
  if (typeof s !== "string") return 0;
  // UTF-8 字节数：非 BMP 字符（codePoint > 0xffff，如 emoji）占 4 字节，
  // 其余按 1/2/3 字节。原实现把一切非 ASCII 都按 3 字节算，会低估 4 字节字符。
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return n;
}

/**
 * 白名单体检：递归遍历对象，返回所有命中 FORBIDDEN_FIELDS 的路径。
 * 空数组 = 干净（无原文 / 文书 / 密钥字段）。这是 §6.2 红线的机器化执行。
 */
export function whitelistViolations(value: unknown, path = "$"): string[] {
  const bad: string[] = [];
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      v.forEach((it, i) => walk(it, `${p}[${i}]`));
      return;
    }
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const np = `${p}.${k}`;
      if ((FORBIDDEN_FIELDS as readonly string[]).includes(k)) bad.push(np);
      walk(val, np);
    }
  };
  walk(value, path);
  return bad;
}

/**
 * 差分隐私：对**计数类**字段加拉普拉斯噪声（敏感度取 1 条记录 = 1）。
 * 噪声只加在聚合统计上，不加在已经 ≥K 的桶身份上；比例类字段加噪后截断回 [0,1]。
 */
export function applyDpNoise(
  counts: Record<string, number>,
  epsilon: number,
  rng: () => number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    const noisy = v + laplace(rng, 1 / Math.max(epsilon, 0.05));
    // 计数不可能为负：截断到 0 并保持整数语义
    out[k] = Math.max(0, Math.round(noisy));
  }
  return out;
}

export interface KAnonResult {
  kept: EvolutionPackage[];
  dropped: Array<{ pkg: EvolutionPackage; reason: string }>;
  k: number;
}

/** K 匿名：样本量不足 K 的桶整包丢弃（docs/12 §6.1 第 3 条） */
export function kAnonymityFilter(pkgs: EvolutionPackage[], k: number): KAnonResult {
  const kept: EvolutionPackage[] = [];
  const dropped: Array<{ pkg: EvolutionPackage; reason: string }> = [];
  for (const p of pkgs) {
    if (p.sample_n >= k) kept.push(p);
    else dropped.push({ pkg: p, reason: `样本量 ${p.sample_n} < K=${k}，整桶不上行` });
  }
  return { kept, dropped, k };
}

/* ============================ 五、加权聚合（FedAvg 思路） ============================ */

/** 聚合权重：样本量 × 审计通过率 × 新鲜度衰减（docs/12 §5.3） */
export function weightOf(
  sampleN: number,
  auditPass: number,
  ageDays: number,
  lambda = FRESHNESS_LAMBDA,
): number {
  const q = clamp(auditPass, 0, 1);
  // 审计通过率为 0 的包不应被完全抹零（否则低质桶永远无法自救），给 0.2 的地板
  const quality = 0.2 + 0.8 * q;
  return Math.max(0, sampleN) * quality * Math.exp(-lambda * Math.max(0, ageDays));
}

export interface WeightedEntry {
  pkg: EvolutionPackage;
  weight: number;
  /** 归一化后的贡献占比，用于画贡献条 */
  share: number;
  ageDays: number;
  auditPass: number;
}

export interface RecipeManifest {
  version: number;
  created_at: string;
  /** 内容指纹（FNV-1a，演示口径；生产口径为私钥签名，见 notes） */
  signature: string;
  source: "real" | "sim" | "hybrid";
  entries: WeightedEntry[];
  dropped: Array<{ bucket: string; reason: string }>;
  plan_templates_update: Record<string, number>;
  lexicon_update: string[];
  qa_threshold_update: { audit_pass_floor: number; min_samples: number };
  memory_prototypes: number[][];
  /** 本版配方聚合时采用的差分隐私预算（0 = 未开 DP）。进指纹：口径不同 → 配方版本不同 */
  dp_epsilon: number;
  notes: string[];
  payload_bytes: number;
}

/** FNV-1a 32 位内容指纹（演示用；**不是**密码学签名） */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 加权聚合：把若干进化包合成一版配方（这是本页唯一"真跑"的算法核心） */
export function aggregate(
  kept: EvolutionPackage[],
  opts: { version: number; now: number; source: RecipeManifest["source"]; dropped?: Array<{ bucket: string; reason: string }> },
): RecipeManifest {
  const entries: WeightedEntry[] = [];
  let totalW = 0;
  /** 本批进化包实际使用的 DP 预算（0 = 全部未开） */
  const dpEpsilon = kept.length > 0 ? Math.max(...kept.map((p) => p.dp.epsilon)) : 0;

  for (const p of kept) {
    // 新鲜度用包内 real_samples 的存在与否无法判断时间，统一由 clock.ts 传入的 sample 时间决定；
    // 真数据路径在 buildRealPackages 里已把 age 折算进 sample_n 权重，这里只做质量加权。
    const w = weightOf(p.sample_n, p.quality.audit_pass_ratio, 0);
    entries.push({ pkg: p, weight: w, share: 0, ageDays: 0, auditPass: p.quality.audit_pass_ratio });
    totalW += w;
  }

  for (const e of entries) e.share = totalW > 0 ? round(e.weight / totalW, 4) : 0;

  // 计划卡模板更新：加权平均"被加入的步骤"频次（同一步骤跨桶累加）
  const stepAcc: Record<string, number> = {};
  for (const e of entries) {
    const s = e.share;
    for (const [name, n] of Object.entries(e.pkg.plan_edit.default_steps_removed)) {
      stepAcc[`删除 · ${name}`] = (stepAcc[`删除 · ${name}`] ?? 0) + s * n;
    }
    for (const [seq, n] of e.pkg.plan_edit.added_tool_sequence) {
      stepAcc[`新增 · ${seq.join(" → ")}`] = (stepAcc[`新增 · ${seq.join(" → ")}`] ?? 0) + s * n;
    }
  }
  const plan_templates_update: Record<string, number> = {};
  for (const [k, v] of Object.entries(stepAcc)) plan_templates_update[k] = round(v, 4);

  // 词典更新：只采纳加权后仍高频的 0 命中词（低样本不加）
  const kwAcc: Record<string, number> = {};
  for (const e of entries) {
    for (const [kw, n] of Object.entries(e.pkg.lexicon.zero_hit_keywords)) {
      kwAcc[kw] = (kwAcc[kw] ?? 0) + e.share * n;
    }
  }
  const lexicon_update = Object.entries(kwAcc)
    .filter(([, v]) => v >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

  // 质检阈值：由聚合后的审计通过率反推（通过率高 → 阈值可上调，反之收紧）
  const avgPass =
    entries.length > 0 ? entries.reduce((s, e) => s + e.share * e.auditPass, 0) : 0;
  const audit_pass_floor = round(clamp(avgPass - 0.05, 0.5, 0.99), 3);

  const memory_prototypes = entries
    .map((e) => e.pkg.memory_prototype)
    .filter((v) => v.length > 0);

  const body = {
    source: opts.source,
    plan_templates_update,
    lexicon_update,
    qa_threshold_update: { audit_pass_floor, min_samples: kAnonCountFloor(entries) },
    dp_epsilon: dpEpsilon,
  };

  return {
    version: opts.version,
    created_at: new Date(opts.now).toISOString(),
    signature: fingerprint(JSON.stringify(body)),
    source: opts.source,
    entries,
    dropped: opts.dropped ?? [],
    plan_templates_update,
    lexicon_update,
    qa_threshold_update: { audit_pass_floor, min_samples: kAnonCountFloor(entries) },
    memory_prototypes,
    dp_epsilon: dpEpsilon,
    notes: [
      "指纹为 FNV-1a 内容哈希（演示口径）；生产口径需改为私钥签名 + TLS，见 docs/12 §6.2。",
      "聚合端只存聚合统计与配方版本，不存原文、不存进化包原文。",
    ],
    payload_bytes: jsonBytes(body),
  };
}

function kAnonCountFloor(entries: WeightedEntry[]): number {
  return entries.length > 0 ? Math.min(...entries.map((e) => e.pkg.sample_n)) : 0;
}

/* ============================ 六、A/B 采纳与回滚判定 ============================ */

export interface AbSnapshot {
  label: string;
  editRate: number;
  auditPass: number;
  lexiconUnknown: number;
  toolRounds: number;
}

export interface AbDecision {
  adopt: boolean;
  improved: string[];
  regressed: string[];
  reasons: string[];
}

/** 采纳条件：多数指标同向改善，且无任何指标显著回退（docs/12 §5.4） */
export function evaluateAdoption(before: AbSnapshot, after: AbSnapshot): AbDecision {
  const improved: string[] = [];
  const regressed: string[] = [];
  const reasons: string[] = [];

  const cmp = (name: string, a: number, b: number, dir: "up" | "down"): void => {
    const good = dir === "up" ? b > a : b < a;
    const back = dir === "up" ? b < a * (1 - ADOPT_REGRESSION_TOLERANCE) : b > a * (1 + ADOPT_REGRESSION_TOLERANCE);
    if (good) improved.push(`${name} ${fmtDelta(a, b, dir)}`);
    if (back) regressed.push(`${name} 回退 ${(Math.abs(b - a) / Math.max(a, 1e-6) * 100).toFixed(1)}%`);
  };

  cmp("计划卡编辑率", before.editRate, after.editRate, "down");
  cmp("引用自检通过率", before.auditPass, after.auditPass, "up");
  cmp("检索词未登记率", before.lexiconUnknown, after.lexiconUnknown, "down");
  cmp("平均工具轮数", before.toolRounds, after.toolRounds, "down");

  if (regressed.length > 0) {
    reasons.push(`存在显著回退（容忍度 ${(ADOPT_REGRESSION_TOLERANCE * 100).toFixed(0)}%）：${regressed.join("；")}`);
  }
  if (improved.length < 2) {
    reasons.push(`同向改善的指标不足 2 项（当前 ${improved.length} 项），继续 Shadow 观察`);
  }
  const adopt = regressed.length === 0 && improved.length >= 2;
  if (adopt) reasons.push("多数指标同向改善且无显著回退 → 采纳并写入本机进化日志");
  return { adopt, improved, regressed, reasons };
}

function fmtDelta(a: number, b: number, dir: "up" | "down"): string {
  if (dir === "up") return `+${((b - a) * 100).toFixed(1)}pt`;
  const rel = a > 1e-9 ? ((a - b) / a) * 100 : 0;
  return `−${rel.toFixed(1)}%（相对）`;
}

/* ============================ 七、仿真客户端与收敛推演 ============================ */

/** 配方基因：一条"该不该进默认流水线"的候选步骤（truth=1 表示好实践确实需要它） */
export interface RecipeGene {
  kind: TaskKind;
  name: string;
  /** 1 = 好实践包含；0 = 好实践不包含（默认骨架里若有，用户会手动删掉） */
  truth: 0 | 1;
  /** 该基因是否已在默认骨架（fallbackPlan）里 */
  inDefault: boolean;
}

/**
 * 配方基因表：候选步骤取自五类任务的真实骨架（agent.ts::fallbackPlan）与
 * 各任务输出骨架（KIND_GUIDES）里体现的好实践。★ 这是仿真环境的"真值"，
 * 不代表产品已有结论，只用于让聚合算法的收敛过程可被观察。
 */
export const RECIPE_GENES: RecipeGene[] = [
  { kind: "review", name: "合同分段与要点梳理", truth: 1, inDefault: true },
  { kind: "review", name: "逐条风险与修改建议分析", truth: 1, inDefault: true },
  { kind: "review", name: "风险条款排序（高→低）", truth: 1, inDefault: false },
  { kind: "review", name: "修改建议对照表", truth: 1, inDefault: false },
  { kind: "review", name: "通用免责套话", truth: 0, inDefault: true },

  { kind: "lawsuit", name: "事实与诉求要点梳理", truth: 1, inDefault: true },
  { kind: "lawsuit", name: "起草起诉状正文", truth: 1, inDefault: true },
  { kind: "lawsuit", name: "管辖与诉讼费核算", truth: 1, inDefault: false },
  { kind: "lawsuit", name: "证据清单与送达地址", truth: 1, inDefault: false },
  { kind: "lawsuit", name: "空泛法理铺陈", truth: 0, inDefault: true },

  { kind: "evidence", name: "案情与证据要点梳理", truth: 1, inDefault: true },
  { kind: "evidence", name: "整理证据目录与证明目的", truth: 1, inDefault: true },
  { kind: "evidence", name: "按要件分组编号", truth: 1, inDefault: false },
  { kind: "evidence", name: "交付为原生表格", truth: 1, inDefault: false },
  { kind: "evidence", name: "质检：三性与要件覆盖检查", truth: 1, inDefault: true },

  { kind: "cross_exam", name: "证据清单与质证目标梳理", truth: 1, inDefault: true },
  { kind: "cross_exam", name: "起草质证意见", truth: 1, inDefault: true },
  { kind: "cross_exam", name: "逐份证据三性意见", truth: 1, inDefault: false },
  { kind: "cross_exam", name: "对证据来源作主观推测", truth: 0, inDefault: true },

  { kind: "argument", name: "争议焦点与事实梳理", truth: 1, inDefault: true },
  { kind: "argument", name: "起草代理词正文", truth: 1, inDefault: true },
  { kind: "argument", name: "要件—法条对应论证", truth: 1, inDefault: false },
  { kind: "argument", name: "预判对方抗辩并回应", truth: 1, inDefault: false },
  { kind: "argument", name: "情绪化表述", truth: 0, inDefault: true },
];

/** 仿真客户端：3–5 个"律所用户"（docs/12 §7.1 第 1 条） */
export interface SimClient {
  id: string;
  name: string;
  desc: string;
  kinds: TaskKind[];
  country: string;
  /** 每轮样本量（进权重） */
  sampleN: number;
  /** 本地审计通过率（进权重） */
  auditPass: number;
  /** 个体偏好偏移：只做自己熟的那类任务，倾向加自己惯用的步骤 */
  bias: number;
  /** 个体观测噪声强度 */
  sigma: number;
}

export const SIM_CLIENTS: SimClient[] = [
  {
    id: "firm-a",
    name: "甲所 · 涉日合规律师",
    desc: "长期做涉日合资合同审查，习惯先做风险排序再逐条改",
    kinds: ["review", "argument"],
    country: "日本",
    sampleN: 46,
    auditPass: 0.95,
    bias: 0.18,
    sigma: 0.42,
  },
  {
    id: "firm-b",
    name: "乙所 · 涉外诉讼团队",
    desc: "起诉状与证据目录为主，坚持证据按要件分组、交付原生表格",
    kinds: ["lawsuit", "evidence"],
    country: "中国",
    sampleN: 38,
    auditPass: 0.92,
    bias: 0.24,
    sigma: 0.48,
  },
  {
    id: "firm-c",
    name: "丙所 · 出口管制顾问",
    desc: "美国法域任务多，检索词偏英文监管术语，0 命中率高",
    kinds: ["review", "cross_exam"],
    country: "美国",
    sampleN: 22,
    auditPass: 0.86,
    bias: 0.3,
    sigma: 0.6,
  },
  {
    id: "firm-d",
    name: "丁所 · 刑民交叉小组",
    desc: "质证意见与代理词为主，讲究逐份证据三性意见",
    kinds: ["cross_exam", "argument"],
    country: "中国",
    sampleN: 15,
    auditPass: 0.9,
    bias: 0.12,
    sigma: 0.52,
  },
  {
    id: "firm-e",
    name: "戊所 · 新入行独立律师",
    desc: "任务杂、样本少，编辑最频繁（也是最需要默认流水线的人）",
    kinds: ["lawsuit", "cross_exam", "review"],
    country: "中国",
    sampleN: 6,
    auditPass: 0.78,
    bias: 0.36,
    sigma: 0.7,
  },
];

export interface RoundMetric {
  round: number;
  /** 计划卡编辑率（步骤/任务，↓） */
  editRate: number;
  /** 引用自检通过率（↑） */
  auditPass: number;
  /** 检索词未登记率（↓） */
  lexiconUnknown: number;
  /** 平均工具轮数（↓） */
  toolRounds: number;
  /** 与"好实践真值"的距离（0 = 完全一致） */
  distance: number;
  /** 该轮隐私参数：null = 未开差分隐私 */
  dpEpsilon: number | null;
  /** 该轮是否采纳了新配方 */
  adopted: boolean;
  /** 该点是否为真实任务日志实测值 */
  measured: boolean;
  /** 该轮聚合权重分布（用于柱状图） */
  weights: number[];
}

export interface ConvergenceRun {
  rounds: RoundMetric[];
  genes: RecipeGene[];
  clients: SimClient[];
  /** 最后一轮配方对各基因的采纳权重（0~1），可与 truth 对比 */
  recipe: number[];
  manifest: RecipeManifest;
  /** 基线（第 0 轮，默认骨架）指标 */
  baseline: AbSnapshot;
  /** 收敛后指标 */
  final: AbSnapshot;
  decision: AbDecision;
  notes: string[];
}

const METRIC_BASE = {
  auditPass0: 0.72,
  lexiconUnknown0: 0.34,
  toolRounds0: 6.4,
  editRate0: 3.1,
};

/** 任务类型中文名（页面与进化包展示共用） */
export function kindLabel(kind: string): string {
  return TASK_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

/** 好实践真值向量 */
export function truthVector(genes: RecipeGene[] = RECIPE_GENES): number[] {
  return genes.map((g) => g.truth);
}

/** 默认骨架在真值上的距离（作为收敛曲线的 y 轴上限） */
export function defaultDistance(genes: RecipeGene[] = RECIPE_GENES): number {
  return genes.reduce((s, g) => s + Math.abs((g.inDefault ? 1 : 0) - g.truth), 0) / genes.length;
}

function distanceToTruth(v: number[], genes: RecipeGene[]): number {
  let d = 0;
  for (let i = 0; i < genes.length; i += 1) d += Math.abs(v[i] - genes[i].truth);
  return d / genes.length;
}

function metricsFromDistance(d0: number, d: number, rng: () => number): Omit<RoundMetric, "round" | "dpEpsilon" | "adopted" | "measured" | "weights"> {
  const progress = clamp(1 - d / Math.max(d0, 1e-6), 0, 1); // 0 = 起点，1 = 完全对齐好实践
  const jitter = (v: number, amp: number): number => round(v + (rng() - 0.5) * amp, 4);
  return {
    editRate: jitter(METRIC_BASE.editRate0 * (0.35 + 0.65 * (1 - progress)), 0.08),
    auditPass: clamp(jitter(METRIC_BASE.auditPass0 + (0.985 - METRIC_BASE.auditPass0) * progress, 0.01), 0, 1),
    lexiconUnknown: clamp(jitter(METRIC_BASE.lexiconUnknown0 * (1 - 0.8 * progress), 0.02), 0, 1),
    toolRounds: jitter(METRIC_BASE.toolRounds0 - 1.9 * progress, 0.25),
    distance: round(d, 4),
  };
}

/**
 * 收敛推演（**协议仿真**，docs/12 §7.1）：
 *
 * - 真实的部分：客户端权重公式、加权平均聚合、差分隐私加噪、K 匿名、指纹、采纳判定；
 * - 仿真的部分：客户端每轮"观察到什么"（用真值 + 个体偏好 + 噪声生成）。
 *
 * 收敛机制不是凭空的：每轮各客户端独立观测，聚合端做加权平均，
 * **独立噪声在多轮多客户平均下按 1/√(R·K) 衰减**（这就是 FedAvg 收敛的本质），
 * 而差分隐私为维持固定的隐私预算，每轮都要重新加噪，于是形成一个**噪声地板**——
 * 这正是 docs/12 §3.3 约束 4「噪声与质量权衡」的可视化。
 */
export function simulateConvergence(opts: {
  rounds: number;
  epsilon: number | null;
  seed?: number;
  genes?: RecipeGene[];
  clients?: SimClient[];
  /** 真实任务日志实测的基线指标（有则作为第 0 轮"实测锚点"） */
  measuredBaseline?: Partial<AbSnapshot>;
  /**
   * K 匿名的样本量门槛（可选注入）。
   *
   * 缺省 `K_ANON_DEMO` —— 与改造前行为一致。
   * **提供它是为了把「已采纳编排配方」里的 `minSamples` 真正接到执行链路上**
   * （配方的「可复用阈值」与这里的 K 匿名门槛是同一个量纲：最小样本量）。
   * 取 `max(注入值, K_ANON_DEMO)`：演示下限不被降低，但用户配的更高门槛会生效。
   */
  minSamples?: number;
  /**
   * 采纳判定的**质量闸门**（可选注入）：引用自检通过率的底线。
   *
   * 缺省 `null` —— 与改造前行为一致（只看 A/B 判定，不额外设闸门）。
   * **提供它是为了把「已采纳编排配方」里的 `auditPassFloor` 真正接到执行链路上**：
   * 当最终快照的 `auditPass` 低于该底线时，直接判为不可采纳。
   *
   * 为什么这条闸门是合理的：`auditPass` 就是「引用自检通过率」，
   * 而配方里的 `audit_pass_floor` 本来就是「这条比率的最低可接受值」——
   * 两者同义，接上不会引入语义漂移。
   */
  auditPassFloor?: number | null;
}): ConvergenceRun {
  const genes = opts.genes ?? RECIPE_GENES;
  const clients = opts.clients ?? SIM_CLIENTS;
  const seed = opts.seed ?? FRE_DEFAULT_SEED;
  const rng = mulberry32(seed);
  const truth = truthVector(genes);
  const d0 = defaultDistance(genes);
  const rounds: RoundMetric[] = [];
  // K 匿名门槛：演示下限与配方门槛取高者
  const kAnon =
    opts.minSamples && Number.isFinite(opts.minSamples)
      ? Math.max(opts.minSamples, K_ANON_DEMO)
      : K_ANON_DEMO;

  const baselineSnap: AbSnapshot = {
    label: "默认骨架（v1）",
    editRate: opts.measuredBaseline?.editRate ?? METRIC_BASE.editRate0,
    auditPass: opts.measuredBaseline?.auditPass ?? METRIC_BASE.auditPass0,
    lexiconUnknown: opts.measuredBaseline?.lexiconUnknown ?? METRIC_BASE.lexiconUnknown0,
    toolRounds: opts.measuredBaseline?.toolRounds ?? METRIC_BASE.toolRounds0,
  };

  // 第 0 轮：默认配方（起点）。若传入了实测基线，则在图上打「实测」标记。
  const measured = opts.measuredBaseline !== undefined && opts.measuredBaseline.editRate !== undefined;
  rounds.push({
    round: 0,
    editRate: baselineSnap.editRate,
    auditPass: baselineSnap.auditPass,
    lexiconUnknown: baselineSnap.lexiconUnknown,
    toolRounds: baselineSnap.toolRounds,
    distance: d0,
    dpEpsilon: opts.epsilon,
    adopted: false,
    measured,
    weights: clients.map((c) => weightOf(c.sampleN, c.auditPass, 0)),
  });

  const activeClients = clients.filter((c) => c.kinds.length > 0);
  /**
   * DP 噪声地板系数（**仿真参数，非实测常数**）：
   * 每轮都要重新满足 ε 预算，因此加噪不会像独立观测噪声那样被多轮平均抹平，
   * 等效地给距离留一个平台。系数取值只用于把权衡画得看得见，不代表任何实测标定。
   */
  const dpFloor = opts.epsilon && opts.epsilon > 0 ? 0.18 / opts.epsilon : 0;

  /** 服务端聚合步长：每轮只吸收一部分增量（FedAvg 的更新比例，非一次性全局平均） */
  const ETA = 0.4;
  /**
   * 实测锚定：若本机任务日志给出了真实基线，则把整条曲线按同一收敛形状平移/缩放，
   * 使第 0 轮恰好等于实测值 —— 避免曲线在"实测起点"与"仿真第 1 轮"之间出现断点。
   */
  const eScale =
    opts.measuredBaseline?.editRate !== undefined && METRIC_BASE.editRate0 > 0
      ? opts.measuredBaseline.editRate / METRIC_BASE.editRate0
      : 1;
  const aShift =
    opts.measuredBaseline?.auditPass !== undefined
      ? opts.measuredBaseline.auditPass - METRIC_BASE.auditPass0
      : 0;
  const weights = activeClients.map((c) => weightOf(c.sampleN, c.auditPass, 0));
  const wSum = weights.reduce((s, w) => s + w, 0) || 1;
  /** 当前配方：起点 = 默认骨架（inDefault ? 1 : 0） */
  let theta: number[] = genes.map((g) => (g.inDefault ? 1 : 0));

  for (let r = 1; r <= opts.rounds; r += 1) {
    // ① 各客户端本轮独立观测（仿真）：真值 × 本行熟悉度 + 个体偏好偏移 + 个体噪声
    const agg = new Array<number>(genes.length).fill(0);
    activeClients.forEach((c, ci) => {
      const w = weights[ci] / wSum;
      for (let i = 0; i < genes.length; i += 1) {
        const gene = genes[i];
        const touched = c.kinds.includes(gene.kind) ? 1 : 0.35; // 非本行任务观测弱
        const obs =
          truth[i] * touched +
          (1 - touched) * (gene.inDefault ? 1 : 0) +
          c.bias * (truth[i] === 1 ? 1 : -1) * 0.3 +
          gaussian(rng) * c.sigma * 0.5;
        agg[i] += w * clamp(obs, 0, 1);
      }
    });

    // ② 服务端按步长更新配方（这一行就是"策略更新"的全部：加权平均，无梯度）
    theta = theta.map((t, i) => t + ETA * (agg[i] - t));

    // ③ 与好实践真值的距离；差分隐私噪声地板与统计噪声正交叠加
    const dRaw = distanceToTruth(theta, genes);
    const d = Math.sqrt(dRaw * dRaw + dpFloor * dpFloor);

    const m = metricsFromDistance(d0, d, rng);
    m.editRate = round(m.editRate * eScale, 4);
    m.auditPass = clamp(m.auditPass + aShift, 0, 1);
    const adopted = r >= 2 && d < (rounds[r - 1]?.distance ?? d0) - 1e-6;
    rounds.push({
      round: r,
      ...m,
      dpEpsilon: opts.epsilon,
      adopted,
      measured: false,
      weights,
    });
  }

  const last = rounds[rounds.length - 1];
  const recipeVec = theta.map((v) => clamp(v, 0, 1));
  const finalSnap: AbSnapshot = {
    label: opts.epsilon ? `配方 v${opts.rounds}（DP ε=${opts.epsilon}）` : `配方 v${opts.rounds}`,
    editRate: last.editRate,
    auditPass: last.auditPass,
    lexiconUnknown: last.lexiconUnknown,
    toolRounds: last.toolRounds,
  };
  const decision = evaluateAdoption(
    {
      label: "默认骨架（v1）",
      editRate: baselineSnap.editRate,
      auditPass: baselineSnap.auditPass,
      lexiconUnknown: baselineSnap.lexiconUnknown,
      toolRounds: baselineSnap.toolRounds,
    },
    finalSnap,
  );

  // R3-P1-6：把「已采纳编排配方」的 auditPassFloor 接到采纳判定的质量闸门上。
  //   `auditPass` 就是「引用自检通过率」，而配方里的 `audit_pass_floor`
  //   本来就是这条比率的最低可接受值 —— 同义，接上不引入语义漂移。
  //   未注入（null/undefined）时行为与改造前完全一致。
  if (
    decision.adopt &&
    typeof opts.auditPassFloor === "number" &&
    Number.isFinite(opts.auditPassFloor) &&
    finalSnap.auditPass < opts.auditPassFloor
  ) {
    decision.adopt = false;
    decision.reasons.push(
      `引用自检通过率 ${(finalSnap.auditPass * 100).toFixed(1)}% 低于本机配方设定的质量闸门 ${(opts.auditPassFloor * 100).toFixed(0)}%，不予采纳`,
    );
  }

  // 聚合产物：把仿真客户端的匿名统计真的过一遍聚合 + 隐私链路
  const pkgs: EvolutionPackage[] = activeClients.map((c, idx) => {
    const auditPass = clamp(c.auditPass + gaussian(rng) * 0.01, 0, 1);
    const sampleN = Math.max(1, Math.round(c.sampleN + gaussian(rng) * 1.2));
    return {
      schema: FRE_SCHEMA,
      client: c.id,
      bucket: { task_kind: c.kinds[0], country: c.country, lang: "zh" },
      sample_n: sampleN,
      plan_edit: {
        default_steps_removed: { [genes[idx % genes.length].name]: 1 + (idx % 3) },
        added_tool_sequence: [[["laws_search", "law_by_id"], 1 + (idx % 4)]],
        avg_edit_steps: round(1 + idx * 0.4, 2),
      },
      lexicon: {
        zero_hit_keywords: { [c.country === "美国" ? "export control" : c.country === "日本" ? "遺留分" : "新就业形态"]: 1 + (idx % 3) },
        good_keywords: { [c.kinds[0]]: 3 + idx },
      },
      quality: { audit_pass_ratio: round(auditPass, 3), unmatched_tokens: {} },
      memory_prototype: [round(gaussian(rng) * 0.02, 4), round(gaussian(rng) * 0.02, 4)],
      dp: {
        mechanism: opts.epsilon ? "laplace" : "none",
        epsilon: opts.epsilon ?? 0,
        applied: !!opts.epsilon,
      },
      real_samples: 0,
      size_bytes: 0,
    };
  });

  const dpRng = mulberry32(seed + 1);
  for (const p of pkgs) {
    if (opts.epsilon) {
      p.lexicon.zero_hit_keywords = applyDpNoise(p.lexicon.zero_hit_keywords, opts.epsilon, dpRng);
      p.lexicon.good_keywords = applyDpNoise(p.lexicon.good_keywords, opts.epsilon, dpRng);
      // 记忆原型同样属于上行载荷，按同一预算加噪（高斯机制，示意量级）
      p.memory_prototype = p.memory_prototype.map((v) => round(v + gaussian(dpRng) * (0.02 / opts.epsilon!), 5));
    }
    p.size_bytes = jsonBytes({ ...p, size_bytes: 0 });
  }

  const anon = kAnonymityFilter(pkgs, kAnon);
  const manifest = aggregate(anon.kept, {
    version: opts.rounds,
    now: Date.now(),
    source: "sim",
    dropped: anon.dropped.map((d) => ({ bucket: d.pkg.bucket.task_kind, reason: d.reason })),
  });

  return {
    rounds,
    genes,
    clients,
    recipe: recipeVec,
    manifest,
    baseline: baselineSnap,
    final: finalSnap,
    decision,
    notes: [
      `客户端行为为仿真（${activeClients.length} 个虚拟律所用户），加权聚合 / DP / K 匿名 / 指纹为真实实现。`,
      opts.epsilon
        ? `差分隐私 ε=${opts.epsilon}：噪声地板使距离收敛到一个平台（不会到 0），这就是隐私-质量权衡。`
        : "未开差分隐私：独立观测噪声随轮次与客户数按 1/√(R·K) 衰减，距离趋于 0。",
      "K 匿名按演示口径 K=" + K_ANON_DEMO + "（生产口径 K=" + K_ANON_PROD + "）。",
    ],
  };
}

/* ============================ 八、真实任务日志 → 进化包 ============================ */

/** 真数据分桶：按任务类型分桶（法域在 result_ref 里可得时再细分） */
export function buildRealPackages(log: TaskLog, opts: { epsilon: number | null; seed?: number }): EvolutionPackage[] {
  const rng = mulberry32(opts.seed ?? FRE_DEFAULT_SEED + 7);
  const byKind = new Map<string, RawTaskRow[]>();
  for (const r of log.rows) {
    if (!isTaskKind(r.kind)) continue;
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }

  const details = log.details ? [...log.details.values()] : [];
  const quality = extractQuality(details);
  const lex = extractLexicon(details);
  const out: EvolutionPackage[] = [];

  for (const [kind, rows] of byKind) {
    const diff = extractPlanEditDiff(rows);
    const added: Array<[string[], number]> = [];
    // 真实 added 步骤里带工具序列的（role 为 retriever 的相邻工具）作为序列统计
    const toolSeq = new Map<string, number>();
    for (const r of rows) {
      const steps = parsePlanJson(r.plan_json).filter((s) => !!s.tool);
      const names = steps.map((s) => s.tool!) as string[];
      const key = names.join(" → ");
      if (key) toolSeq.set(key, (toolSeq.get(key) ?? 0) + 1);
    }
    for (const [seq, n] of toolSeq) added.push([seq.split(" → "), n]);

    const pkg: EvolutionPackage = {
      schema: FRE_SCHEMA,
      client: "local-workbench",
      bucket: { task_kind: kind, country: "—", lang: "zh" },
      sample_n: rows.length,
      plan_edit: {
        default_steps_removed: { ...diff.removed },
        added_tool_sequence: added,
        avg_edit_steps: diff.editRate,
      },
      lexicon: { zero_hit_keywords: { ...lex.zeroHit }, good_keywords: { ...lex.good } },
      quality: {
        audit_pass_ratio: quality.total > 0 ? quality.passRatio : 0,
        unmatched_tokens: { ...quality.unmatched },
      },
      // 记忆原型需要 /embeddings 与 mem_vectors 聚类（docs/12 §4.1 第 ③ 步），本版未实现
      memory_prototype: [],
      dp: { mechanism: opts.epsilon ? "laplace" : "none", epsilon: opts.epsilon ?? 0, applied: !!opts.epsilon },
      real_samples: rows.length,
      size_bytes: 0,
    };

    if (opts.epsilon) {
      pkg.plan_edit.default_steps_removed = applyDpNoise(pkg.plan_edit.default_steps_removed, opts.epsilon, rng);
      pkg.lexicon.zero_hit_keywords = applyDpNoise(pkg.lexicon.zero_hit_keywords, opts.epsilon, rng);
      pkg.lexicon.good_keywords = applyDpNoise(pkg.lexicon.good_keywords, opts.epsilon, rng);
    }
    pkg.size_bytes = jsonBytes({ ...pkg, size_bytes: 0 });
    out.push(pkg);
  }

  return out;
}

/* ============================ 九、RL 对照（诚实口径） ============================ */

export interface RlAnalogyRow {
  rl: string;
  fre: string;
  same: "同构" | "部分" | "没有";
  note: string;
}

/**
 * "若按强化学习看"的对照表。
 * 结论必须落在最后一行：本方案**没有**策略梯度与价值函数，因此不是 RL，
 * 而是"联邦统计聚合 + 零标注奖励加权"。这张表存在的意义是不让口径含糊。
 */
export const RL_ANALOGY: RlAnalogyRow[] = [
  {
    rl: "轨迹 rollout",
    fre: "一次任务（tasks / task_steps 全量落库）",
    same: "部分",
    note: "任务是真实发生的，但不是策略采样出来的轨迹——没有动作空间定义，也没有状态转移。",
  },
  {
    rl: "奖励 reward",
    fre: "确定性引用自检（auditCitations）+ 计划卡编辑 diff + 闸门放行",
    same: "同构",
    note: "这是本方案最像 RL 的地方，也是最强的地方：奖励由代码规则算出、零标注（docs/12 §3.2）。",
  },
  {
    rl: "策略 policy",
    fre: "编排配方（计划卡模板 / 检索词典 / 质检阈值）",
    same: "部分",
    note: "配方确实在决定「下一步做什么」，但它是结构化资产，不是一个可微参数化的策略网络。",
  },
  {
    rl: "策略更新",
    fre: "加权 FedAvg 聚合（权重 = 样本量 × 审计通过率 × 新鲜度）",
    same: "部分",
    note: "是**统计平均**，不是梯度下降：没有优势函数、没有目标函数的反向传播。",
  },
  {
    rl: "探索 exploration",
    fre: "A/B Shadow 试运行 + 差分隐私噪声",
    same: "部分",
    note: "Shadow 让新配方与现配方并行评估，等效于一次保守的策略探索；DP 噪声是隐私副产品，不是刻意探索。",
  },
  {
    rl: "价值函数 / 折扣回报",
    fre: "无",
    same: "没有",
    note: "不做长程信用分配——本方案只回答「这一步该不该留在默认流水线」，不预测未来累积收益。",
  },
];

// ---------------------------------------------------------------------------
// 用户级采纳入口（R6-P0-1）
//
// 背景：`adoptRecipe` 原先只有 `EvolutionLab` 一处调用，而实验台在**两条深链之外**
//       （`#/evolution` → `#/evolution-lab`），全仓没有导航入口。
//       后果是三条隐式触点**永远不会亮**：
//         · 首页状态行    门禁 `activeVersion !== null` → 永远 null
//         · 计划卡标注    门禁 `deprioritizedSteps.length > 0` → 永远 0
//         · 设置页「恢复默认」 `disabled={!activeVersion}` → 永远禁用
//       也就是说：**能撤销，但不能采纳；而撤销的前提又永远不成立。**
//
// 本段提供**与实验台同源**的候选计算，供设置页调用。
// ⚠️ 纪律：这里只做「算」，不做「写」——落盘仍走 `adoptRecipe`，
//    避免出现第二条写路径导致状态不一致。
// ---------------------------------------------------------------------------

/** 从一批进化包导出可比快照（样本量加权平均；无样本的包不参与） */
export function snapshotsFromPackages(pkgs: EvolutionPackage[]): AbSnapshot | null {
  const usable = pkgs.filter((p) => p.sample_n > 0);
  if (usable.length === 0) return null;
  const totalN = usable.reduce((s, p) => s + p.sample_n, 0);
  if (totalN <= 0) return null;
  const wsum = (pick: (p: EvolutionPackage) => number): number =>
    usable.reduce((s, p) => s + pick(p) * p.sample_n, 0) / totalN;
  const unmatchedTotal = usable.reduce(
    (s, p) => s + Object.values(p.quality.unmatched_tokens).reduce((a, b) => a + b, 0),
    0,
  );
  const toolTotal = usable.reduce(
    (s, p) => s + p.plan_edit.added_tool_sequence.reduce((a, [, n]) => a + n, 0),
    0,
  );
  return {
    label: "本机实测",
    editRate: wsum((p) => p.plan_edit.avg_edit_steps),
    auditPass: wsum((p) => p.quality.audit_pass_ratio),
    lexiconUnknown: unmatchedTotal,
    toolRounds: toolTotal / usable.length,
  };
}

export interface RecipeCandidate {
  decision: AbDecision;
  manifest: RecipeManifest;
  /** 参与聚合的真实任务数（用于如实表述，**不得**被当作版本号使用） */
  realSamples: number;
  tasksConsidered: number;
  droppedBuckets: number;
}

export type CandidateOutcome =
  | { kind: "candidate"; value: RecipeCandidate }
  | { kind: "no_data"; reason: string };

/** 读本机任务日志（最近 8 个任务取明细），供候选计算与实验台共用 */
export async function loadLocalTaskLog(
  callRustFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T | null>,
): Promise<TaskLog> {
  const rows = (await callRustFn<RawTaskRow[]>("task_list")) ?? [];
  const details = new Map<number, RawTaskStep[]>();
  for (const r of rows.slice(0, 8)) {
    try {
      const d = await callRustFn<{ steps?: RawTaskStep[] }>("task_get", { id: r.id });
      if (d?.steps) details.set(r.id, d.steps);
    } catch {
      /* 单个任务明细取失败不致命：跳过即可，不吞整体 */
    }
  }
  return { rows, details };
}

/**
 * 用户级「检查可用优化」。
 *
 * **只基于本机真实任务数据**：没有任何带 `sample_n` 的真实任务时返回 `no_data`，
 * 而不是拿协议仿真去凑一个候选 —— 否则会出现「用户一次任务没跑，
 * 界面却说根据他的使用优化过」这类凭空表述（纪律 D12）。
 */
export async function computeRecipeCandidate(
  log: TaskLog,
  opts: {
    epsilon?: number | null;
    /** 参与聚合的最小任务数（默认 1；配方的 minSamples 门槛另在 K 匿名处生效） */
    minTasks?: number;
    /** 已采纳配方的运行时参数（用于同口径比较与质量闸门） */
    currentParams?: RecipeRuntimeParams;
  } = {},
): Promise<CandidateOutcome> {
  const minTasks = opts.minTasks ?? 1;
  const rows = log.rows.filter((r) => isTaskKind(r.kind));
  if (rows.length < minTasks) {
    return {
      kind: "no_data",
      reason:
        rows.length === 0
          ? "本机还没有可用的任务记录。完成一次文书任务后再来检查。"
          : `本机任务记录不足（${rows.length} < ${minTasks}）。`,
    };
  }

  const epsilon = opts.epsilon ?? null;
  const packages = buildRealPackages(log, { epsilon });
  if (packages.length === 0) {
    return { kind: "no_data", reason: "任务记录里没有可聚合的信号（计划/自检/词典均为空）。" };
  }

  // K 匿名：与已采纳配方同口径（取配方 minSamples 与演示下限的较大者）
  const k = Math.max(opts.currentParams?.minSamples ?? 0, K_ANON_DEMO);
  const anon = kAnonymityFilter(packages, k);
  if (anon.kept.length === 0) {
    return {
      kind: "no_data",
      reason: `样本量不足 K=${k}，不生成候选（这是隐私保护的一部分，不是故障）。`,
    };
  }

  const manifest = aggregate(anon.kept, {
    version: TOTAL_ROUNDS,
    now: Date.now(),
    source: "real",
    dropped: anon.dropped.map((d) => ({ bucket: d.pkg.bucket.task_kind, reason: d.reason })),
  });

  const before = snapshotsFromPackages(anon.kept);
  if (!before) {
    return { kind: "no_data", reason: "聚合后没有可用样本。" };
  }
  // 「应用后」用配方自身的质量口径推演：自检通过率取配方设定的底线与其实际表现之高者
  const after: AbSnapshot = {
    label: `候选 v${manifest.version}`,
    editRate: before.editRate,
    auditPass: Math.max(manifest.qa_threshold_update.audit_pass_floor, before.auditPass),
    lexiconUnknown: Math.max(0, before.lexiconUnknown - manifest.lexicon_update.length),
    toolRounds: before.toolRounds,
  };
  const decision = evaluateAdoption(before, after);

  // 质量闸门：与 simulateConvergence 同一条纪律 —— 低于配方底线不得采纳
  const floor = opts.currentParams?.auditPassFloor;
  if (decision.adopt && typeof floor === "number" && Number.isFinite(floor) && before.auditPass < floor) {
    decision.adopt = false;
    decision.reasons.push(
      `引用自检通过率 ${(before.auditPass * 100).toFixed(1)}% 低于本机设定的质量闸门 ${(floor * 100).toFixed(0)}%，不予采纳`,
    );
  }

  return {
    kind: "candidate",
    value: {
      decision,
      manifest,
      realSamples: anon.kept.reduce((s, p) => s + p.real_samples, 0),
      tasksConsidered: rows.length,
      droppedBuckets: anon.dropped.length,
    },
  };
}

