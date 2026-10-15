// evolution.ts 纯函数层单测（EV7）
//
// 覆盖审计点名的五组：差分隐私 / K 匿名 / 白名单 / 指纹 / 采纳判定。
//
// 为什么先测这五组：审计指出 `lib/evolution.ts` 是「47KB 纯函数层却零单测」，
// 而它**恰好是最容易测、最能证明严谨性的部分**——不依赖 DOM、不依赖 Rust、不依赖模型。
//
// 运行：npm test

import { describe, expect, it } from "vitest";

import {
  ADOPT_REGRESSION_TOLERANCE,
  FRE_DEFAULT_SEED,
  FRE_SCHEMA,
  K_ANON_DEMO,
  K_ANON_PROD,
  applyDpNoise,
  evaluateAdoption,
  fingerprint,
  gaussian,
  jsonBytes,
  kAnonymityFilter,
  laplace,
  mulberry32,
  weightOf,
  whitelistViolations,
  type AbSnapshot,
  type EvolutionPackage,
} from "../src/lib/evolution";

/* ============================ 夹具（严格照真实接口） ============================ */

/** 构造一个合法的 EvolutionPackage；sample_n 可控（K 匿名按包粒度判定） */
function mkPkg(client: string, sampleN: number, auditPass = 0.9): EvolutionPackage {
  return {
    schema: FRE_SCHEMA,
    client,
    bucket: { task_kind: "review", country: "JP", lang: "ja" },
    sample_n: sampleN,
    plan_edit: {
      default_steps_removed: {},
      added_tool_sequence: [],
      avg_edit_steps: 0.2,
    },
    lexicon: { zero_hit_keywords: {}, good_keywords: {} },
    quality: { audit_pass_ratio: auditPass, unmatched_tokens: {} },
    memory_prototype: [],
    dp: { mechanism: "none", epsilon: 0, applied: false },
    real_samples: sampleN,
    size_bytes: 128,
  };
}

function snap(o: Partial<AbSnapshot> = {}): AbSnapshot {
  return {
    label: "run",
    editRate: 0.2,
    auditPass: 0.9,
    lexiconUnknown: 0.1,
    toolRounds: 3,
    ...o,
  };
}

/* ============================ 1. 伪随机与噪声 ============================ */

describe("随机源：必须可复现（同 seed 同序列）", () => {
  it("mulberry32 同 seed 产出同序列", () => {
    const a = mulberry32(FRE_DEFAULT_SEED);
    const b = mulberry32(FRE_DEFAULT_SEED);
    expect(Array.from({ length: 8 }, () => a())).toEqual(
      Array.from({ length: 8 }, () => b()),
    );
  });

  it("mulberry32 不同 seed 产出不同序列", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it("mulberry32 值域落在 [0,1)", () => {
    const rng = mulberry32(FRE_DEFAULT_SEED);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gaussian 同 seed 可复现", () => {
    expect(gaussian(mulberry32(7))).toBe(gaussian(mulberry32(7)));
  });

  it("laplace 同 seed 可复现；scale 越大波动越大", () => {
    expect(laplace(mulberry32(3), 1)).toBe(laplace(mulberry32(3), 1));
    const small = Math.abs(laplace(mulberry32(9), 0.5));
    const big = Math.abs(laplace(mulberry32(9), 5));
    expect(big).toBeGreaterThan(small);
  });
});

/* ============================ 2. 差分隐私 ============================ */

describe("差分隐私 applyDpNoise", () => {
  // ⚠️ 真实签名：applyDpNoise(counts: Record<string, number>, epsilon, rng)
  //    输入是**计数字典**（不是向量），输出为「加噪后取整、夹到 >= 0」的计数字典。
  const counts = { a: 10, b: 10, c: 10, d: 10 };

  it("输出保留全部键，且计数被夹到非负整数", () => {
    const out = applyDpNoise(counts, 1, mulberry32(FRE_DEFAULT_SEED));
    expect(Object.keys(out).sort()).toEqual(["a", "b", "c", "d"]);
    for (const v of Object.values(out)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("同 rng 序列 + 同 epsilon 可复现", () => {
    const a = applyDpNoise(counts, 1, mulberry32(123));
    const b = applyDpNoise(counts, 1, mulberry32(123));
    expect(a).toEqual(b);
  });

  it("加噪会改变计数（噪声确实生效）", () => {
    const out = applyDpNoise(counts, 0.1, mulberry32(FRE_DEFAULT_SEED));
    expect(out).not.toEqual(counts);
  });

  it("epsilon 越小，噪声越大（隐私预算与可用性的取舍方向）", () => {
    const dev = (eps: number) => {
      const out = applyDpNoise(counts, eps, mulberry32(FRE_DEFAULT_SEED));
      return Object.keys(counts).reduce((s, k) => s + Math.abs(out[k] - counts[k]), 0);
    };
    expect(dev(0.1)).toBeGreaterThan(dev(10));
  });

  it("epsilon 为 0 或负数时按下限 0.05 处理（仍加噪，不静默关闭 DP）", () => {
    // 实现里 laplace scale = 1 / max(epsilon, 0.05)，故 ε<=0 等价于 ε=0.05
    const zero = applyDpNoise(counts, 0, mulberry32(FRE_DEFAULT_SEED));
    const floor = applyDpNoise(counts, 0.05, mulberry32(FRE_DEFAULT_SEED));
    expect(zero).toEqual(floor);
  });

  it("计数为 0 时加噪后被夹回 0（不产生负数）", () => {
    const out = applyDpNoise({ z: 0 }, 0.05, mulberry32(FRE_DEFAULT_SEED));
    expect(out.z).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(out.z)).toBe(true);
  });

  it("不修改入参（无副作用）", () => {
    const input = { a: 5 };
    const before = { ...input };
    applyDpNoise(input, 1, mulberry32(5));
    expect(input).toEqual(before);
  });
});

/* ============================ 3. K 匿名 ============================ */

describe("K 匿名 kAnonymityFilter", () => {
  it("样本量不足 K 的包被丢弃（宁可不聚合）", () => {
    const r = kAnonymityFilter([mkPkg("a", 1)], K_ANON_DEMO);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toContain("K=");
  });

  it("样本量达标即保留（按包粒度判定）", () => {
    const pkgs = Array.from({ length: 3 }, (_, i) => mkPkg(`c${i}`, K_ANON_DEMO));
    const r = kAnonymityFilter(pkgs, K_ANON_DEMO);
    expect(r.kept).toHaveLength(3);
    expect(r.dropped).toHaveLength(0);
  });

  it("生产口径 K=20 比演示口径 K=2 更严格", () => {
    expect(K_ANON_PROD).toBeGreaterThan(K_ANON_DEMO);
    const pkgs = [mkPkg("d", 5)];
    expect(kAnonymityFilter(pkgs, K_ANON_PROD).kept).toHaveLength(0);
    expect(kAnonymityFilter(pkgs, K_ANON_DEMO).kept).toHaveLength(1);
  });

  it("边界：sample_n 恰等于 K 时保留（>= 语义）", () => {
    expect(kAnonymityFilter([mkPkg("e", K_ANON_DEMO)], K_ANON_DEMO).kept).toHaveLength(1);
  });

  it("回显 K，便于日志记录", () => {
    expect(kAnonymityFilter([], 7).k).toBe(7);
  });
});

/* ============================ 4. 白名单 ============================ */

describe("白名单 whitelistViolations（防原文外泄）", () => {
  it("干净对象无违规", () => {
    expect(whitelistViolations({ a: 1, b: "x", c: [1, 2] })).toEqual([]);
  });

  it("命中禁用字段名时报告违规（带路径）", () => {
    const bad = whitelistViolations({ nested: { content: "合同原文" } });
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.join(" ")).toContain("content");
  });

  it("路径以 $ 开头，便于定位", () => {
    const bad = whitelistViolations({ content: "x" });
    expect(bad[0].startsWith("$")).toBe(true);
  });

  it("数组元素也会被检查", () => {
    expect(whitelistViolations({ list: [{ content: "x" }] }).length).toBeGreaterThan(0);
  });
});

/* ============================ 5. 指纹 ============================ */

describe("指纹 fingerprint", () => {
  it("同输入同指纹（确定性）", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
  });

  it("不同输入不同指纹", () => {
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
  });

  it("空串也有稳定指纹", () => {
    expect(fingerprint("")).toBe(fingerprint(""));
  });

  it("对中文稳定（UTF-8 路径一致）", () => {
    expect(fingerprint("法元")).toBe(fingerprint("法元"));
    expect(fingerprint("法元")).not.toBe(fingerprint("法原"));
  });
});

/* ============================ 6. 采纳判定 ============================ */

describe("采纳判定 evaluateAdoption（回归保护）", () => {
  // ⚠️ 真实采纳条件（evolution.ts:685）：
  //      adopt = (无任何指标显著回归) AND (同向改善的指标数 >= 2)
  //    即「至少两项变好、且没有一项显著变差」。同理只改一项**不足以采纳**。

  it("四项全部同向改善 → 采纳", () => {
    const d = evaluateAdoption(
      snap({ editRate: 0.3, auditPass: 0.7, lexiconUnknown: 0.3, toolRounds: 5 }),
      snap({ editRate: 0.1, auditPass: 0.95, lexiconUnknown: 0.05, toolRounds: 2 }),
    );
    expect(d.regressed).toHaveLength(0);
    expect(d.improved.length).toBeGreaterThanOrEqual(2);
    expect(d.adopt).toBe(true);
  });

  it("仅 1 项改善 → **不采纳**（要求至少 2 项同向）", () => {
    const d = evaluateAdoption(snap({ auditPass: 0.8 }), snap({ auditPass: 0.95 }));
    expect(d.improved).toHaveLength(1);
    expect(d.adopt).toBe(false);
    expect(d.reasons.join(" ")).toContain("不足 2 项");
  });

  it("明显变差 → 必须拒绝（adopt=false）且列出 regressed", () => {
    const d = evaluateAdoption(snap({ auditPass: 0.9 }), snap({ auditPass: 0.5 }));
    expect(d.adopt).toBe(false);
    expect(d.regressed.length).toBeGreaterThan(0);
  });

  it("容忍度内的极小波动不构成回归", () => {
    const before = snap({ auditPass: 0.9, editRate: 0.2, lexiconUnknown: 0.1, toolRounds: 3 });
    const after = snap({
      auditPass: 0.9 * (1 - ADOPT_REGRESSION_TOLERANCE * 0.5),
      editRate: 0.2,
      lexiconUnknown: 0.1,
      toolRounds: 3,
    });
    expect(evaluateAdoption(before, after).regressed).toHaveLength(0);
  });

  it("超出容忍度的下降即拒绝（阈值方向正确）", () => {
    const before = snap({ auditPass: 0.9 });
    const after = snap({ auditPass: 0.9 * (1 - ADOPT_REGRESSION_TOLERANCE * 3) });
    expect(evaluateAdoption(before, after).adopt).toBe(false);
  });

  it("判定是纯函数：同输入同结论", () => {
    expect(evaluateAdoption(snap(), snap())).toEqual(evaluateAdoption(snap(), snap()));
  });

  it("★ 任一指标显著回归即整体拒绝（不因其它指标大幅变好而放行）", () => {
    const before = snap({ editRate: 0.3, auditPass: 0.9, lexiconUnknown: 0.3, toolRounds: 5 });
    // 编辑率、检索词未登录率、工具轮数都大幅改善，但**自检通过率崩了**
    const after = snap({ editRate: 0.05, auditPass: 0.4, lexiconUnknown: 0.02, toolRounds: 1 });
    const d = evaluateAdoption(before, after);
    expect(d.improved.length).toBeGreaterThanOrEqual(2); // 确实变好了三项
    expect(d.regressed.length).toBeGreaterThan(0);       // 但有一项崩了
    expect(d.adopt).toBe(false);                          // 仍必须拒绝
  });

  it("四项全不变 → 不采纳（没有改善证据）", () => {
    expect(evaluateAdoption(snap(), snap()).adopt).toBe(false);
  });
});

/* ============================ 7. 加权聚合权重 ============================ */

describe("聚合权重 weightOf", () => {
  it("样本量越大权重越大（线性）", () => {
    expect(weightOf(10, 0.9, 0)).toBeGreaterThan(weightOf(5, 0.9, 0));
  });

  it("审计通过率越高权重越大", () => {
    expect(weightOf(5, 1.0, 0)).toBeGreaterThan(weightOf(5, 0.5, 0));
  });

  it("越陈旧权重越小（新鲜度衰减）", () => {
    expect(weightOf(5, 0.9, 30)).toBeLessThan(weightOf(5, 0.9, 0));
  });

  it("审计通过率为 0 也保留 0.2 地板（低质桶可自救）", () => {
    expect(weightOf(5, 0, 0)).toBeGreaterThan(0);
    // 地板恰好是 0.2 倍样本量
    expect(weightOf(5, 0, 0)).toBeCloseTo(5 * 0.2, 6);
  });

  it("负样本量被夹到 0（不产生负权重）", () => {
    expect(weightOf(-3, 0.9, 0)).toBe(0);
  });

  it("负 ageDays 被夹到 0（不产生放大效应）", () => {
    expect(weightOf(5, 0.9, -10)).toBeCloseTo(weightOf(5, 0.9, 0), 9);
  });
});

/* ============================ 8. 其它纯函数 ============================ */

describe("辅助纯函数", () => {
  it("jsonBytes 按 UTF-8 字节计（中文 3 字节）", () => {
    expect(jsonBytes("a")).toBe(new TextEncoder().encode('"a"').length);
    expect(jsonBytes("法元")).toBe(new TextEncoder().encode('"法元"').length);
  });

  it("jsonBytes 对不可序列化值不抛异常", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => jsonBytes(circular)).not.toThrow();
  });
});
