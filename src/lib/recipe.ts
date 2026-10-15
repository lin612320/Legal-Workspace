// 配方 → 运行时参数（EV2：让「自我进化」真正闭环）。
//
// 背景：
//   `lib/evolution.ts` 会产出一版 `RecipeManifest`，`evolutionStore.ts` 会把它
//   持久化到本机 —— 但**没有任何代码读它去改变行为**，进化闭环的最后一环是断的
//   （审计编号 EV2）。
//
// 本模块做两件事，且严格分开：
//   ① **纯函数派生层**（`deriveParams` / `isConsumed`）：把配方折算成具体运行参数，
//      可单测、无副作用、不依赖 Tauri。
//   ② **消费登记表**（`RECIPE_CONSUMPTION`）：逐项声明「这个参数到底有没有被读取」。
//
// ⚠️ 诚实性设计（本文件的核心约束）：
//    消费登记表是**事实清单**，不是愿望清单。
//    凡未真正接入执行链路的字段，必须在表里标 `wired: false`，
//    并由 `unconsumedFields()` 如实报出。
//    `tests/recipe.test.ts` 会**断言表与代码一致**，防止有人只改表不改代码。

import type { RecipeManifest } from "./evolution";

/* ============================ 参数与基线 ============================ */

/** 配方折算出的运行时参数（agent 侧只读这些，不直接读配方） */
export interface RecipeRuntimeParams {
  /** 工具调用循环最大轮数 */
  toolRoundsLimit: number;
  /** 检索类工具返回条数上限 */
  searchLimit: number;
  /** 引用自检通过率下限（低于此值的批次不应被采信） */
  auditPassFloor: number;
  /** 判定所需最小样本量 */
  minSamples: number;
  /** 由配方推荐补充的检索词（去重后） */
  extraKeywords: string[];
  /** 应尽量跳过的计划步骤名（来自 plan_templates_update 的负向建议） */
  deprioritizedSteps: string[];
}

/**
 * 无配方时的基线（= 0.7.2 的现有行为）。
 * 必须与改造前的硬编码值一致，保证「没采纳过配方」时行为不变。
 */
export const BASELINE_PARAMS: RecipeRuntimeParams = {
  toolRoundsLimit: 6, // 原 agent.ts 里的 const MAX_ROUNDS = 6
  searchLimit: 5,
  auditPassFloor: 0.8,
  minSamples: 20, // 对齐 K_ANON_PROD
  extraKeywords: [],
  deprioritizedSteps: [],
};

/** 参数的安全边界（防止配方把系统带进不可用状态） */
export const PARAM_BOUNDS = {
  toolRoundsLimit: { min: 2, max: 12 },
  searchLimit: { min: 1, max: 10 },
  auditPassFloor: { min: 0.5, max: 1 },
  minSamples: { min: 1, max: 100 },
} as const;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/* ============================ 纯函数派生层 ============================ */

/**
 * 把配方折算成运行时参数。**纯函数**：同输入同输出，无副作用。
 *
 * 四个字段各有明确来源：
 *   - `toolRoundsLimit` ← `plan_templates_update["__tool_rounds__"]`
 *       配方值 > 0 表示「本版本建议的工具轮数」；缺省则沿用基线
 *   - `searchLimit`     ← `plan_templates_update["__search_limit__"]`
 *   - `auditPassFloor`  ← `qa_threshold_update.audit_pass_floor`
 *   - `minSamples`      ← `qa_threshold_update.min_samples`
 *   - `extraKeywords`   ← `lexicon_update`
 *   - `deprioritizedSteps` ← `plan_templates_update` 中**值为负数**的步骤名
 *       （语义：该步骤在本版本被建议弱化）
 *
 * @param recipe 当前生效的配方；`null` 表示无配方 → 返回基线
 */
export function deriveParams(recipe: RecipeManifest | null | undefined): RecipeRuntimeParams {
  if (!recipe) return { ...BASELINE_PARAMS };

  const pt = recipe.plan_templates_update ?? {};
  const qa = recipe.qa_threshold_update;
  const lex = recipe.lexicon_update ?? [];

  const roundsRaw = Number(pt["__tool_rounds__"]);
  const limitRaw = Number(pt["__search_limit__"]);

  // 负值/非有限值视为「未建议」，沿用基线
  const toolRoundsLimit = clamp(
    Number.isFinite(roundsRaw) && roundsRaw > 0 ? roundsRaw : BASELINE_PARAMS.toolRoundsLimit,
    PARAM_BOUNDS.toolRoundsLimit.min,
    PARAM_BOUNDS.toolRoundsLimit.max,
  );
  const searchLimit = clamp(
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : BASELINE_PARAMS.searchLimit,
    PARAM_BOUNDS.searchLimit.min,
    PARAM_BOUNDS.searchLimit.max,
  );
  const auditPassFloor = clamp(
    qa && Number.isFinite(qa.audit_pass_floor) ? qa.audit_pass_floor : BASELINE_PARAMS.auditPassFloor,
    PARAM_BOUNDS.auditPassFloor.min,
    PARAM_BOUNDS.auditPassFloor.max,
  );
  const minSamples = clamp(
    qa && Number.isFinite(qa.min_samples) ? qa.min_samples : BASELINE_PARAMS.minSamples,
    PARAM_BOUNDS.minSamples.min,
    PARAM_BOUNDS.minSamples.max,
  );

  // 关键词：去空、去重、限量（防止配方把提示词撑爆）
  const extraKeywords = [...new Set(
    lex.map((k) => String(k).trim()).filter((k) => k.length > 0),
  )].slice(0, 20);

  // 值为负的条目 = 建议弱化该步骤
  const deprioritizedSteps = Object.entries(pt)
    .filter(([k, v]) => !k.startsWith("__") && Number(v) < 0)
    .map(([k]) => k)
    .slice(0, 20);

  return {
    toolRoundsLimit: Math.round(toolRoundsLimit),
    searchLimit: Math.round(searchLimit),
    auditPassFloor,
    minSamples: Math.round(minSamples),
    extraKeywords,
    deprioritizedSteps,
  };
}

/** 该步骤是否被配方建议弱化（按名称包含匹配，大小写无关） */
export function isDeprioritized(stepName: string, params: RecipeRuntimeParams): boolean {
  if (!stepName || params.deprioritizedSteps.length === 0) return false;
  const n = stepName.toLowerCase();
  return params.deprioritizedSteps.some((d) => n.includes(d.toLowerCase()));
}

/* ============================ 消费登记表（事实清单） ============================ */

/**
 * 逐字段声明「是否已被执行链路真正读取」。
 *
 * ⚠️ 这不是文档，而是**被测试断言的事实清单**：
 *   `tests/recipe.test.ts` 会断言 `wired: true` 的字段在 agent.ts 中确实被引用。
 *   改了代码就要改这张表，否则测试红。
 *
 * `where` 指向真正的消费点，便于人工复核。
 */
export const RECIPE_CONSUMPTION: Record<
  keyof RecipeRuntimeParams,
  { wired: boolean; where: string; note?: string }
> = {
  toolRoundsLimit: {
    wired: true,
    where: "src/lib/agent.ts · runAgenticToolStep",
    note: "取代原硬编码 const MAX_ROUNDS = 6",
  },
  searchLimit: {
    wired: true,
    where: "src/lib/agent.ts · runAgenticToolStep（回填工具结果时截断）",
    note: "限制单次检索回填给模型的条数",
  },
  extraKeywords: {
    wired: true,
    where: "src/lib/agent.ts · runAgenticToolStep（注入 system 提示）",
    note: "配方推荐补充的检索词",
  },
  deprioritizedSteps: {
    wired: true,
    where: "src/lib/agent.ts · planFromSkeleton",
    note: "被建议弱化的步骤在计划中降级为可选",
  },
  auditPassFloor: {
    wired: true,
    where: "src/evolution-lab/EvolutionLab.tsx（→ src/lib/evolution.ts · simulateConvergence）",
    note: "作为采纳判定的质量闸门：引用自检通过率低于该底线时不得采纳",
  },
  minSamples: {
    wired: true,
    where: "src/evolution-lab/EvolutionLab.tsx（→ src/lib/evolution.ts · simulateConvergence）",
    note: "作为 K 匿名门槛注入，取 max(配方值, K_ANON_DEMO)；演示下限不被降低",
  },
};

/** 列出**已派生但未被消费**的字段（供 UI / 文档如实展示） */
export function unconsumedFields(): string[] {
  return (Object.keys(RECIPE_CONSUMPTION) as Array<keyof RecipeRuntimeParams>)
    .filter((k) => !RECIPE_CONSUMPTION[k].wired);
}

/** 是否所有派生字段都已被消费（EV2 完成的判据） */
export function isFullyConsumed(): boolean {
  return unconsumedFields().length === 0;
}
