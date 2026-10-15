// EV2 单测：配方派生层 + 消费登记表与代码的一致性。
//
// 两组断言，各有明确目的：
//
//   A. 派生层纯函数（deriveParams / isDeprioritized）
//      证明「配方 → 参数」的折算正确、有边界、可复现。
//
//   B. **消费登记表 ↔ agent.ts 源码的一致性**
//      这是本文件最重要的一组：`recipe.ts` 的 RECIPE_CONSUMPTION 声明了
//      「哪些字段已被执行链路真正读取」。如果只改表不改代码（或反之），
//      这组测试会红 —— 把「声称已接入」变成可验证事实，而不是文档承诺。
//
// 运行：npm test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BASELINE_PARAMS,
  PARAM_BOUNDS,
  RECIPE_CONSUMPTION,
  deriveParams,
  isDeprioritized,
  unconsumedFields,
  isFullyConsumed,
  type RecipeRuntimeParams,
} from "../src/lib/recipe";
import { getRuntimeRecipeParams, setRuntimeRecipeParamsForTest, limitToolText } from "../src/lib/agent";
import type { RecipeManifest } from "../src/lib/evolution";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = readFileSync(resolve(HERE, "../src/lib/agent.ts"), "utf8");

/** 造一版配方；只覆写关心的字段 */
function mkRecipe(over: Partial<RecipeManifest> = {}): RecipeManifest {
  return {
    version: 7,
    created_at: new Date(0).toISOString(),
    signature: "SIG123",
    source: "sim",
    entries: [],
    dropped: [],
    plan_templates_update: {},
    lexicon_update: [],
    qa_threshold_update: { audit_pass_floor: 0.8, min_samples: 20 },
    memory_prototypes: [],
    dp_epsilon: 0,
    notes: [],
    payload_bytes: 0,
    ...over,
  };
}

/* ============================ A. 派生层 ============================ */

describe("deriveParams：无配方 → 基线（行为与改造前一致）", () => {
  it("null / undefined 都返回基线", () => {
    expect(deriveParams(null)).toEqual(BASELINE_PARAMS);
    expect(deriveParams(undefined)).toEqual(BASELINE_PARAMS);
  });

  it("基线必须保持改造前的硬编码值（否则等于偷偷改了默认行为）", () => {
    // 改造前 agent.ts: const MAX_ROUNDS = 6;
    expect(BASELINE_PARAMS.toolRoundsLimit).toBe(6);
  });

  it("返回的是副本，改返回值不会污染基线", () => {
    const p = deriveParams(null);
    p.toolRoundsLimit = 999;
    expect(BASELINE_PARAMS.toolRoundsLimit).toBe(6);
  });
});

describe("deriveParams：配方生效", () => {
  it("__tool_rounds__ 覆盖轮数上限", () => {
    const r = mkRecipe({ plan_templates_update: { __tool_rounds__: 9 } });
    expect(deriveParams(r).toolRoundsLimit).toBe(9);
  });

  it("__search_limit__ 覆盖检索条数", () => {
    const r = mkRecipe({ plan_templates_update: { __search_limit__: 3 } });
    expect(deriveParams(r).searchLimit).toBe(3);
  });

  it("qa_threshold_update 覆盖阈值与样本量", () => {
    const r = mkRecipe({
      qa_threshold_update: { audit_pass_floor: 0.95, min_samples: 50 },
    });
    const p = deriveParams(r);
    expect(p.auditPassFloor).toBe(0.95);
    expect(p.minSamples).toBe(50);
  });

  it("lexicon_update 变为 extraKeywords，去空去重且限量 20", () => {
    const r = mkRecipe({
      lexicon_update: ["契約", "  ", "契約", "遺留分", ...Array.from({ length: 30 }, (_, i) => `k${i}`)],
    });
    const kw = deriveParams(r).extraKeywords;
    expect(kw).toContain("契約");
    expect(kw).toContain("遺留分");
    expect(kw).not.toContain("");           // 空串被过滤
    expect(kw.filter((k) => k === "契約")).toHaveLength(1); // 去重
    expect(kw.length).toBeLessThanOrEqual(20);
  });

  it("plan_templates_update 中**值为负**的步骤 → deprioritizedSteps", () => {
    const r = mkRecipe({
      plan_templates_update: { 载入文书模板: -1, 检索法律依据: 2, __tool_rounds__: 5 },
    });
    const p = deriveParams(r);
    expect(p.deprioritizedSteps).toEqual(["载入文书模板"]);
    expect(p.deprioritizedSteps).not.toContain("__tool_rounds__"); // 内部键不算步骤
  });
});

describe("deriveParams：边界夹紧（配方不能把系统带坏）", () => {
  it("轮数上限被夹到 [min,max]", () => {
    const lo = deriveParams(mkRecipe({ plan_templates_update: { __tool_rounds__: 0.5 } }));
    const hi = deriveParams(mkRecipe({ plan_templates_update: { __tool_rounds__: 999 } }));
    expect(lo.toolRoundsLimit).toBe(PARAM_BOUNDS.toolRoundsLimit.min);
    expect(hi.toolRoundsLimit).toBe(PARAM_BOUNDS.toolRoundsLimit.max);
  });

  it("检索条数被夹到 [min,max]", () => {
    expect(deriveParams(mkRecipe({ plan_templates_update: { __search_limit__: 999 } })).searchLimit)
      .toBe(PARAM_BOUNDS.searchLimit.max);
  });

  it("非有限值（NaN / Infinity）退回基线而非产生 NaN", () => {
    const p = deriveParams(mkRecipe({ plan_templates_update: { __tool_rounds__: Number.NaN } }));
    expect(p.toolRoundsLimit).toBe(BASELINE_PARAMS.toolRoundsLimit);
    expect(Number.isFinite(p.toolRoundsLimit)).toBe(true);
  });

  it("负值视为「未建议」，退回基线", () => {
    const p = deriveParams(mkRecipe({ plan_templates_update: { __tool_rounds__: -5 } }));
    expect(p.toolRoundsLimit).toBe(BASELINE_PARAMS.toolRoundsLimit);
  });

  it("阈值下限被夹到 0.5（不允许把门槛设到 0 而失去意义）", () => {
    const p = deriveParams(mkRecipe({ qa_threshold_update: { audit_pass_floor: 0, min_samples: 20 } }));
    expect(p.auditPassFloor).toBe(PARAM_BOUNDS.auditPassFloor.min);
  });

  it("派生结果是纯函数：同输入同输出", () => {
    const r = mkRecipe({ plan_templates_update: { __tool_rounds__: 8 } });
    expect(deriveParams(r)).toEqual(deriveParams(r));
  });

  it("输出恒为整数轮数 / 条数（避免把小数传给循环）", () => {
    const p = deriveParams(mkRecipe({ plan_templates_update: { __tool_rounds__: 7.6, __search_limit__: 4.4 } }));
    expect(Number.isInteger(p.toolRoundsLimit)).toBe(true);
    expect(Number.isInteger(p.searchLimit)).toBe(true);
  });
});

describe("isDeprioritized", () => {
  const params: RecipeRuntimeParams = { ...BASELINE_PARAMS, deprioritizedSteps: ["载入文书模板"] };

  it("名称包含即命中", () => {
    expect(isDeprioritized("载入文书模板", params)).toBe(true);
  });

  it("大小写无关", () => {
    const p = { ...params, deprioritizedSteps: ["Template"] };
    expect(isDeprioritized("load template step", p)).toBe(true);
  });

  it("未命中返回 false", () => {
    expect(isDeprioritized("起草正文", params)).toBe(false);
  });

  it("空步骤名 / 空清单 → false（不误伤）", () => {
    expect(isDeprioritized("", params)).toBe(false);
    expect(isDeprioritized("载入文书模板", BASELINE_PARAMS)).toBe(false);
  });
});

/* ============================ B. 消费登记表 ↔ 源码一致性 ============================ */

describe("★ 消费登记表必须与 agent.ts 源码一致（防止只改表不改代码）", () => {
  it("每个 wired:true 的字段都能在 agent.ts 找到真实消费点", () => {
    // 字段 → 期望在源码中出现的证据
    const evidence: Record<string, string[]> = {
      // 轮数上限：替换了原硬编码 MAX_ROUNDS
      toolRoundsLimit: ["MAX_ROUNDS = rp.toolRoundsLimit"],
      // 回填条数：调用 limitToolText 时传 rp.searchLimit
      searchLimit: ["limitToolText(res.text, rp.searchLimit)"],
      // 检索词补充：注入 system 提示
      extraKeywords: ["rp.extraKeywords"],
      // 弱化步骤：planFromSkeleton 里调用 isDeprioritized
      deprioritizedSteps: ["isDeprioritized(s.name, params)"],
    };

    const missing: string[] = [];
    for (const [field, needles] of Object.entries(evidence)) {
      if (!RECIPE_CONSUMPTION[field as keyof RecipeRuntimeParams].wired) continue;
      for (const n of needles) {
        if (!AGENT_SRC.includes(n)) missing.push(`${field}: 源码中找不到「${n}」`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("wired:false 的字段**不得**在 agent.ts 中被消费（否则表已过期）", () => {
    const overclaims: string[] = [];
    for (const f of unconsumedFields()) {
      // 这些字段若真被消费，源码里应出现 rp.<字段>
      if (AGENT_SRC.includes(`rp.${f}`)) {
        overclaims.push(`${f} 标注为未接入，但 agent.ts 中出现了 rp.${f}`);
      }
    }
    expect(overclaims).toEqual([]);
  });

  it("硬编码的 MAX_ROUNDS = 6 已被移除（改由配方提供）", () => {
    expect(AGENT_SRC).not.toContain("const MAX_ROUNDS = 6");
  });

  it("消费登记表覆盖全部派生字段（不能漏登记）", () => {
    const derived = Object.keys(BASELINE_PARAMS) as Array<keyof RecipeRuntimeParams>;
    const registered = Object.keys(RECIPE_CONSUMPTION);
    expect(new Set(registered)).toEqual(new Set(derived));
  });

  it("unconsumedFields / isFullyConsumed 与表一致（R3-P1-6 后应全部接入）", () => {
    const un = unconsumedFields();
    // R3-P1-6 已把 auditPassFloor 与 minSamples 接入执行链路，
    // 因此未接入集合应为空 —— 这正是「进化闭环完整」的判据。
    expect(un).toEqual([]);
    expect(isFullyConsumed()).toBe(true);
  });

  it("每个 wired:true 条目都写明了 where（可人工复核）", () => {
    for (const [k, v] of Object.entries(RECIPE_CONSUMPTION)) {
      if (v.wired) {
        // where 指向真实消费点；允许落在 agent.ts 或 evolution-lab/evolution.ts
        expect(
          v.where.includes("agent.ts") || v.where.includes("evolution.ts") || v.where.includes("EvolutionLab.tsx"),
          `${k} 的 where 未指向可复核的消费点：${v.where}`,
        ).toBe(true);
        expect(v.where).not.toContain("未接入");
      }
    }
  });

  it("★ R3-P1-6：两个新接入的字段在源码里确有消费点", () => {
    // 这条是「登记表 ↔ 源码一致性」的延伸：新标 wired:true 的字段必须真有消费证据
    const LAB_SRC = readFileSync(resolve(HERE, "../src/evolution-lab/EvolutionLab.tsx"), "utf8");
    const EVO_SRC = readFileSync(resolve(HERE, "../src/lib/evolution.ts"), "utf8");
    expect(LAB_SRC).toContain("recipeMinSamples");
    expect(LAB_SRC).toContain("recipeAuditFloor");
    expect(EVO_SRC).toContain("opts.minSamples");
    expect(EVO_SRC).toContain("opts.auditPassFloor");
  });
});

/* ============================ C. 运行时快照与文本截断 ============================ */

describe("运行时参数快照", () => {
  it("默认是基线（未采纳配方时行为不变）", () => {
    setRuntimeRecipeParamsForTest(null);
    expect(getRuntimeRecipeParams()).toEqual(BASELINE_PARAMS);
  });

  it("注入后 getter 能读到", () => {
    setRuntimeRecipeParamsForTest({ ...BASELINE_PARAMS, toolRoundsLimit: 11 });
    expect(getRuntimeRecipeParams().toolRoundsLimit).toBe(11);
    setRuntimeRecipeParamsForTest(null); // 复原，避免影响其它用例
  });

  it("注入的是副本，外部改对象不影响快照", () => {
    const p = { ...BASELINE_PARAMS, searchLimit: 2 };
    setRuntimeRecipeParamsForTest(p);
    p.searchLimit = 99;
    expect(getRuntimeRecipeParams().searchLimit).toBe(2);
    setRuntimeRecipeParamsForTest(null);
  });
});

describe("limitToolText：只影响给模型看的内容", () => {
  it("行数不超限时原样返回", () => {
    const t = "第1条\n第2条";
    expect(limitToolText(t, 5)).toBe(t);
  });

  it("超限时保留前 N 个非空行并折叠其余", () => {
    const t = ["a", "b", "c", "d", "e", "f"].join("\n");
    const out = limitToolText(t, 3);
    expect(out).toContain("a");
    expect(out).toContain("c");
    expect(out).not.toContain("\nd\n"); // d 之后被折叠
    expect(out).toContain("另有 3 条");
  });

  it("空行不计入条数", () => {
    const t = ["a", "", "b", "", "c", "d"].join("\n");
    const out = limitToolText(t, 3);
    expect(out).toContain("c");
    expect(out).toContain("另有 1 条");
  });

  it("空文本安全返回", () => {
    expect(limitToolText("", 3)).toBe("");
  });

  it("limit=1 只留第一行", () => {
    const out = limitToolText("a\nb\nc", 1);
    expect(out.startsWith("a")).toBe(true);
    expect(out).toContain("另有 2 条");
  });
});
