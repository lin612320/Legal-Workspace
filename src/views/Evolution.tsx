import { useEffect, useMemo, useState } from "react";
import { callRust, isTauri } from "../lib/tauri";
import {
  FRE_DISCLAIMER,
  K_ANON_DEMO,
  K_ANON_PROD,
  RL_ANALOGY,
  aggregate,
  buildRealPackages,
  extractRewardSignals,
  kAnonymityFilter,
  kindLabel,
  simulateConvergence,
  whitelistViolations,
  type AbSnapshot,
  type ConvergenceRun,
  type EvolutionPackage,
  type RawTaskRow,
  type RawTaskStep,
  type RoundMetric,
  type TaskLog,
} from "../lib/evolution";
import { adoptRecipe, rollbackRecipe } from "../lib/evolutionStore";
import { refreshRuntimeRecipe } from "../lib/agent";
import { RECIPE_CONSUMPTION, unconsumedFields } from "../lib/recipe";
import "../components/Evolution.css";

/* ============================ 常量 ============================ */

const TOTAL_ROUNDS = 12;

type FlowKey = "signal" | "pack" | "privacy" | "agg" | "manifest" | "ab";

const FLOW: Array<{ key: FlowKey; idx: string; name: string; desc: string }> = [
  { key: "signal", idx: "①", name: "本地信号", desc: "读 tasks / task_steps，零标注奖励（引用自检 + 计划卡偏离 + 闸门）" },
  { key: "pack", idx: "②", name: "匿名进化包", desc: "白名单字段 + 配方向量，KB 级；原文 / 文书 / 密钥零上云" },
  { key: "privacy", idx: "③", name: "隐私处理", desc: "差分隐私加噪（拉普拉斯）→ 不足 K 人的桶整桶丢弃" },
  { key: "agg", idx: "④", name: "加权聚合", desc: "权重 = 样本量 × 审计通过率 × 新鲜度，逐轮更新配方" },
  { key: "manifest", idx: "⑤", name: "配方版本", desc: "聚合产物带指纹与阈值，可 diff、可回滚" },
  { key: "ab", idx: "⑥", name: "A/B 采纳", desc: "Shadow 试运行 → 多数指标改善且无显著回退才采纳" },
];

/* ============================ 折线图 ============================ */

interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
  dash?: boolean;
  measuredFirst?: boolean;
}

interface ChartProps {
  series: Series[];
  height?: number;
  yFmt: (v: number) => string;
  yTitle: string;
  xTitle: string;
  showAxes?: boolean;
}

const CW = 660;
const PAD = { l: 46, r: 16, t: 14, b: 28 };

function LineChart({ series, height = 200, yFmt, yTitle, xTitle, showAxes = true }: ChartProps) {
  const visible = series.filter((s) => s.values.length > 1);
  if (visible.length === 0) return <div className="evo-empty">无可绘制数据</div>;

  const all = visible.flatMap((s) => s.values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-9) {
    hi += Math.abs(hi) * 0.1 + 0.5;
    lo -= Math.abs(lo) * 0.1 + 0.5;
  } else {
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
  }
  const maxRound = Math.max(...visible.map((s) => s.values.length - 1));
  const plotW = CW - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;

  const X = (i: number) => PAD.l + (maxRound > 0 ? (i / maxRound) * plotW : 0);
  const Y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * plotH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
  const xTicks = [...new Set([0, Math.round(maxRound / 2), maxRound])];

  return (
    <svg className="evo-chart" viewBox={`0 0 ${CW} ${height}`} height={height} role="img" aria-label={yTitle}>
      {showAxes &&
        ticks.map((t) => (
          <g key={t}>
            <line className="evo-axis" x1={PAD.l} x2={CW - PAD.r} y1={Y(t)} y2={Y(t)} />
            <text className="evo-tick" x={PAD.l - 6} y={Y(t) + 3} textAnchor="end">
              {yFmt(t)}
            </text>
          </g>
        ))}
      {showAxes &&
        xTicks.map((t) => (
          <text key={t} className="evo-tick" x={X(t)} y={height - 9} textAnchor="middle">
            {t === 0 ? "基线" : `第 ${t} 轮`}
          </text>
        ))}
      {showAxes && (
        <>
          <text className="evo-axis-title" x={PAD.l} y={9}>
            {yTitle}
          </text>
          <text className="evo-axis-title" x={CW - PAD.r} y={height - 9} textAnchor="end">
            {xTitle}
          </text>
        </>
      )}

      {visible.map((s) => {
        const d = s.values
          .map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(2)},${Y(v).toFixed(2)}`)
          .join(" ");
        const lastI = s.values.length - 1;
        return (
          <g key={s.key}>
            <path className={"evo-line" + (s.dash ? " evo-line-dash" : "")} d={d} stroke={s.color} />
            <circle className="evo-point" cx={X(lastI)} cy={Y(s.values[lastI])} r={3} fill={s.color} />
            {s.measuredFirst && (
              <circle className="evo-measure-ring" cx={X(0)} cy={Y(s.values[0])} r={5.5} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ============================ 小组件 ============================ */

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

/** 指标名 → 期望方向（向下/向上） */
const METRIC_META: Record<string, { label: string; dir: "up" | "down"; digits: number; unit: string }> = {
  editRate: { label: "计划卡编辑率", dir: "down", digits: 2, unit: "步/任务" },
  auditPass: { label: "引用自检通过率", dir: "up", digits: 3, unit: "" },
  lexiconUnknown: { label: "检索词未登记率", dir: "down", digits: 3, unit: "" },
  toolRounds: { label: "平均工具轮数", dir: "down", digits: 2, unit: "轮" },
};

function Spark({ metric, rounds }: { metric: string; rounds: RoundMetric[] }) {
  const meta = METRIC_META[metric];
  const values = rounds.map((r) => r[metric as keyof RoundMetric] as number);
  const first = values[0];
  const last = values[values.length - 1];
  const better = meta.dir === "up" ? last > first : last < first;
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  return (
    <div className="evo-spark">
      <div className="evo-spark-name">
        <span>{meta.label}</span>
        <span>{meta.dir === "up" ? "↑ 越好" : "↓ 越好"}</span>
      </div>
      <div className="evo-spark-val">
        {meta.digits === 3 ? `${(last * 100).toFixed(1)}%` : `${fmt(last, meta.digits)}${meta.unit ? " " + meta.unit : ""}`}
      </div>
      <div className={"evo-spark-delta " + (better ? "evo-up" : "evo-down")}>
        {better ? "▼" : "▲"} {Math.abs(pct).toFixed(1)}% vs 基线
      </div>
      <LineChart
        series={[{ key: metric, label: meta.label, color: "var(--brand)", values }]}
        height={54}
        yFmt={(v) => fmt(v, 2)}
        yTitle=""
        xTitle=""
        showAxes={false}
      />
    </div>
  );
}

function SignalRow({ s }: { s: ReturnType<typeof extractRewardSignals>[number] }) {
  return (
    <div className={"evo-signal" + (s.available ? "" : " off")}>
      <span className="evo-signal-key">{s.direction === "up" ? "↑" : "↓"}</span>
      <span className="evo-signal-label">{s.label}</span>
      <span className="evo-signal-val">{s.display}</span>
      <span className="evo-signal-note">
        {s.note}
        <br />
        <span className="evo-signal-src">{s.source}</span>
      </span>
    </div>
  );
}

/* ============================ 主页面 ============================ */

export default function Evolution({ initialStep = "agg" }: { initialStep?: FlowKey } = {}) {
  const [log, setLog] = useState<TaskLog>({ rows: [] });
  const [loading, setLoading] = useState(true);
  const [epsilon, setEpsilon] = useState<number | null>(3);
  const [k, setK] = useState<number>(K_ANON_DEMO);
  const [visible, setVisible] = useState(TOTAL_ROUNDS);
  const [step, setStep] = useState<FlowKey>(initialStep);
  const [pkgIdx, setPkgIdx] = useState(0);
  const [abState, setAbState] = useState<"pending" | "adopted" | "rolled">("pending");
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const [journal, setJournal] = useState<string[]>([]);
  /** 采纳/回滚写入中（用于禁用按钮，避免重复提交） */
  const [busy, setBusy] = useState(false);
  /** 采纳/回滚的失败原因（真实错误文本，不吞错） */
  const [decideError, setDecideError] = useState<string | null>(null);

  /* ---------- 读本机任务日志（有真数据用真数据，否则退回示例数据） ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!isTauri()) {
        setLoading(false);
        return;
      }
      try {
        const rows = (await callRust<RawTaskRow[]>("task_list")) ?? [];
        const details = new Map<number, RawTaskStep[]>();
        // 明细按需取：只取最近 8 个任务，避免一次拉全量
        for (const r of rows.slice(0, 8)) {
          const d = await callRust<{ steps?: RawTaskStep[] }>("task_get", { id: r.id });
          if (d?.steps) details.set(r.id, d.steps);
        }
        if (alive) setLog({ rows, details });
      } catch (e) {
        console.warn("[evolution] 读取任务日志失败，降级为仿真：", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ---------- 派生数据 ---------- */
  const signals = useMemo(() => extractRewardSignals(log), [log]);

  /** 实测基线：有真数据时锚定曲线起点（只在真数据可用时给出，否则退回示例数据） */
  const measured = useMemo<Partial<AbSnapshot> | undefined>(() => {
    const e = signals.find((s) => s.key === "plan_drift");
    const a = signals.find((s) => s.key === "audit_pass");
    const m: Partial<AbSnapshot> = {};
    if (e && e.value !== null) m.editRate = e.value;
    if (a && a.value !== null) m.auditPass = a.value;
    return Object.keys(m).length > 0 ? m : undefined;
  }, [signals]);

  const runs = useMemo(
    () => ({
      none: simulateConvergence({ rounds: TOTAL_ROUNDS, epsilon: null, measuredBaseline: measured }),
      dp3: simulateConvergence({ rounds: TOTAL_ROUNDS, epsilon: 3, measuredBaseline: measured }),
      dp1: simulateConvergence({ rounds: TOTAL_ROUNDS, epsilon: 1, measuredBaseline: measured }),
    }),
    [measured],
  );

  const activeRun: ConvergenceRun = epsilon === 3 ? runs.dp3 : epsilon === 1 ? runs.dp1 : runs.none;
  const shownRounds = activeRun.rounds.slice(0, Math.min(visible, TOTAL_ROUNDS) + 1);

  const realPackages = useMemo(() => buildRealPackages(log, { epsilon }), [log, epsilon]);
  const simPackages = useMemo(() => activeRun.manifest.entries.map((e) => e.pkg), [activeRun]);
  const packages: EvolutionPackage[] = realPackages.length > 0 ? realPackages : simPackages;
  const dataSource: "sim" | "hybrid" = realPackages.length > 0 ? "hybrid" : "sim";

  const anon = useMemo(() => kAnonymityFilter(packages, k), [packages, k]);
  const violations = useMemo(
    () => packages.flatMap((p, i) => whitelistViolations(p).map((v) => `包 #${i + 1} ${v}`)),
    [packages],
  );
  const manifest = useMemo(
    () =>
      aggregate(anon.kept, {
        version: TOTAL_ROUNDS,
        now: Date.now(),
        source: dataSource,
        dropped: anon.dropped.map((d) => ({ bucket: d.pkg.bucket.task_kind, reason: d.reason })),
      }),
    [anon, dataSource],
  );

  const curPkg = packages[Math.min(pkgIdx, Math.max(0, packages.length - 1))];
  const lastRound = shownRounds[shownRounds.length - 1];
  const firstRound = shownRounds[0];

  const chartSeries: Series[] = [
    { key: "none", label: "未开差分隐私", color: "var(--evo-s1)", values: runs.none.rounds.slice(0, visible + 1).map((r) => r.distance), measuredFirst: !!measured },
    { key: "dp3", label: "DP ε=3", color: "var(--evo-s2)", values: runs.dp3.rounds.slice(0, visible + 1).map((r) => r.distance), dash: true },
    { key: "dp1", label: "DP ε=1", color: "var(--evo-s3)", values: runs.dp1.rounds.slice(0, visible + 1).map((r) => r.distance), dash: true },
  ].filter((s) => !hiddenSeries.includes(s.key));

  const decide = async (ok: boolean) => {
    setBusy(true);
    try {
      if (ok) {
        // 真正持久化到本机 SQLite（settings 表，key = evolution.recipe_state）
        await adoptRecipe(manifest.version, manifest.signature, manifest);
        // EV2：立刻刷新执行链路用的运行时参数，使下一个任务就用上新配方
        await refreshRuntimeRecipe();
        setAbState("adopted");
        setJournal((j) => [
          `采纳 配方 v${manifest.version}（指纹 ${manifest.signature}，${new Date().toLocaleTimeString()}）`,
          ...j,
        ]);
      } else {
        await rollbackRecipe();
        await refreshRuntimeRecipe();
        setAbState("rolled");
        setJournal((j) => [
          `回滚到 配方 v${manifest.version - 1}（保留上一版，${new Date().toLocaleTimeString()}）`,
          ...j,
        ]);
      }
      setDecideError(null);
    } catch (e) {
      // 不吞错：写入失败必须如实显示，不得假装成功
      const msg = e instanceof Error ? e.message : String(e);
      setDecideError(msg);
      setJournal((j) => [`${ok ? "采纳" : "回滚"}失败：${msg}`, ...j]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="evo">
      <div className="evo-head">
        <div>
          <h2>自我进化实验室 · 联邦配方进化</h2>
          <p className="evo-sub">
            本机零标注奖励 → 匿名进化包 → 差分隐私与 K 匿名 → 加权聚合 → 签名配方 → A/B 采纳。
          </p>
        </div>
        <div className="evo-badges">
          <span className="evo-badge evo-badge-plan">配方进化（编排参数调优）</span>
          <span className={"evo-badge" + (dataSource === "hybrid" ? " evo-badge-real" : "")}>
            {loading ? "读取任务日志…" : dataSource === "hybrid" ? `数据源：本机任务日志（${log.rows.length} 条）` : "数据源：示例数据"}
          </span>
          <span className="evo-badge">棱镜口径 K={k === K_ANON_DEMO ? `${K_ANON_DEMO}（演示）` : k}</span>
        </div>
      </div>

      <p className="evo-disclaimer">{FRE_DISCLAIMER}</p>

      {/* ---------- 闭环流程（点击切换下方详情） ---------- */}
      <div className="evo-flow">
        {FLOW.map((f) => (
          <button
            key={f.key}
            type="button"
            className={"evo-flow-step" + (step === f.key ? " on" : "")}
            onClick={() => setStep(f.key)}
          >
            <span className="evo-flow-idx">{f.idx}</span>
            <span className="evo-flow-name">{f.name}</span>
            <span className="evo-flow-desc">{f.desc}</span>
          </button>
        ))}
      </div>

      {/* ---------- 控制条 ---------- */}
      <div className="evo-controls" style={{ marginTop: 14 }}>
        <label>
          差分隐私 ε
          <select value={epsilon === null ? "off" : String(epsilon)} onChange={(e) => setEpsilon(e.target.value === "off" ? null : Number(e.target.value))}>
            <option value="off">关闭</option>
            <option value="3">3（较松）</option>
            <option value="1">1（较严）</option>
          </select>
        </label>
        <label>
          K 匿名下限
          <input type="range" min={1} max={K_ANON_PROD} value={k} onChange={(e) => setK(Number(e.target.value))} />
          <span>{k}</span>
        </label>
        <label>
          轮次
          <input type="range" min={1} max={TOTAL_ROUNDS} value={visible} onChange={(e) => setVisible(Number(e.target.value))} />
          <span>{visible} / {TOTAL_ROUNDS}</span>
        </label>
        <button type="button" onClick={() => setVisible((v) => Math.min(TOTAL_ROUNDS, v + 1))} disabled={visible >= TOTAL_ROUNDS}>
          ▶ 推进一轮
        </button>
        <button type="button" onClick={() => { setVisible(TOTAL_ROUNDS); setAbState("pending"); }}>
          ↺ 重置
        </button>
      </div>

      {/* ---------- ① 本地信号 ---------- */}
      {step === "signal" && (
        <div className="evo-grid evo-grid-2">
          <div className="evo-card">
            <h3>
              零标注奖励信号
              <span className="evo-hint">来自既有任务日志，不需要任何用户填写</span>
            </h3>
            <div className="evo-signals">
              {signals.map((s) => (
                <SignalRow key={s.key} s={s} />
              ))}
            </div>
          </div>
          <div className="evo-card">
            <h3>这些信号为什么可信</h3>
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.85, margin: 0 }}>
              通用联邦学习最缺的是标签：用户不会为"这次计划卡改得好不好"填问卷。
              法元的标签是<strong>代码规则算出来的</strong>——引用自检逐条比对本次工具真实返回的法条，
              计划卡偏离度直接来自落库的计划卡与默认骨架的差异，闸门放行位置来自状态机。
              <br />
              <br />
              这也意味着：<strong>没有真数据就没有信号</strong>。本机任务量为 0 时，上面每一项都会如实显示
              "本机暂无"，而不是编一个看起来漂亮的数字。
            </p>
            <dl className="evo-kv">
              <dt>任务总数</dt>
              <dd>{log.rows.length} 条</dd>
              <dt>取到明细</dt>
              <dd>{log.details ? log.details.size : 0} 条（用于解析质检与检索结果）</dd>
              <dt>任务类型分布</dt>
              <dd>
                {log.rows.length === 0
                  ? "—"
                  : Object.entries(
                      log.rows.reduce<Record<string, number>>((acc, r) => {
                        acc[kindLabel(r.kind)] = (acc[kindLabel(r.kind)] ?? 0) + 1;
                        return acc;
                      }, {}),
                    )
                      .map(([kk, v]) => `${kk}×${v}`)
                      .join("、")}
              </dd>
            </dl>
          </div>
        </div>
      )}

      {/* ---------- ② 匿名进化包 ---------- */}
      {step === "pack" && (
        <div className="evo-grid evo-grid-2">
          <div className="evo-card">
            <h3>
              进化包内容
              <span className="evo-hint">上云的唯一载荷 · 白名单字段</span>
            </h3>
            <div className="evo-pkg-tabs">
              {packages.map((p, i) => (
                <button
                  key={`${p.client}-${p.bucket.task_kind}-${i}`}
                  type="button"
                  className={"evo-pkg-tab" + (i === pkgIdx ? " on" : "")}
                  onClick={() => setPkgIdx(i)}
                >
                  {kindLabel(p.bucket.task_kind)} · {p.client}
                </button>
              ))}
            </div>
            {curPkg ? (
              <pre className="evo-json">{JSON.stringify(curPkg, null, 2)}</pre>
            ) : (
              <div className="evo-empty">暂无进化包</div>
            )}
          </div>
          <div className="evo-card">
            <h3>
              合规体检
              <span className="evo-hint">schema 强制，而非自觉</span>
            </h3>
            <div className="evo-checks">
              <div className="evo-check">
                <span className="evo-check-ico">{violations.length === 0 ? "✅" : "⛔"}</span>
                <span>
                  {violations.length === 0
                    ? "敏感字段体检通过：无 context / content / title / result / api_key 等字段"
                    : `命中 ${violations.length} 个禁止字段：${violations.slice(0, 5).join("、")}`}
                </span>
              </div>
              <div className="evo-check">
                <span className="evo-check-ico">📦</span>
                <span>
                  包体积 {packages.map((p) => p.size_bytes).join(" / ") || "—"} 字节（
                  {realPackages.length > 0 ? "真实日志折算" : "仿真"}，KB 级载荷）
                </span>
              </div>
              <div className="evo-check">
                <span className="evo-check-ico">{curPkg?.dp.applied ? "🔒" : "🔓"}</span>
                <span>
                  差分隐私：{curPkg?.dp.applied ? `已加噪（拉普拉斯，ε=${curPkg.dp.epsilon}）` : "未开启（上行为明文统计）"}
                </span>
              </div>
              <div className="evo-check">
                <span className="evo-check-ico">🧠</span>
                <span>
                  记忆原型：
                  {curPkg && curPkg.memory_prototype.length > 0
                    ? `示意向量 [${curPkg.memory_prototype.map((v) => v.toFixed(3)).join(", ")}]`
                    : "暂无可用向量（本机任务日志不足）"}
                </span>
              </div>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.75 }}>
              注意 `plan_edit.default_steps_removed` 里只有<strong>步骤名与次数</strong>，
              `lexicon.zero_hit_keywords` 里只有<strong>检索词与命中次数</strong>——
              案情原文、文书正文、文件路径都不会离开本机。
            </p>
          </div>
        </div>
      )}

      {/* ---------- ③ 隐私处理 ---------- */}
      {step === "privacy" && (
        <div className="evo-grid evo-grid-2">
          <div className="evo-card">
            <h3>
              差分隐私与 K 匿名
              <span className="evo-hint">三层机制的第二、三层</span>
            </h3>
            <div className="evo-checks">
              <div className="evo-check">
                <span className="evo-check-ico">1️⃣</span>
                <span>
                  <strong>数据最小化</strong>：上云仅白名单统计与配方向量；现场可抓包验证载荷里没有案情文本。
                </span>
              </div>
              <div className="evo-check">
                <span className="evo-check-ico">2️⃣</span>
                <span>
                  <strong>差分隐私</strong>：计数类字段加拉普拉斯噪声（scale = 敏感度/ε）。
                  当前 ε = {epsilon ?? "关闭"}；{epsilon ? "单条记录不可还原。" : "校验用：关掉就能看清噪声前后差别。"}
                </span>
              </div>
              <div className="evo-check">
                <span className="evo-check-ico">3️⃣</span>
                <span>
                  <strong>K 匿名</strong>：样本量 &lt; K 的桶整桶丢弃。当前 K = {k}
                  {k === K_ANON_DEMO ? "（演示口径）" : k === K_ANON_PROD ? "（生产口径）" : ""}。
                </span>
              </div>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.75 }}>
              把 K 拉到 {K_ANON_PROD}（生产口径），样本量不足的桶会被整桶丢弃——这不是 bug，
              正是「小样本宁可不聚合」的直接后果，也是为什么单机演示用 K={K_ANON_DEMO}（样本量本来就少）。
            </p>
          </div>
          <div className="evo-card">
            <h3>K 匿名判定结果</h3>
            <table className="evo-table">
              <thead>
                <tr>
                  <th>桶（任务类型）</th>
                  <th>样本量</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((p, i) => {
                  const dropped = p.sample_n < k;
                  return (
                    <tr key={`${p.client}-${i}`}>
                      <td>{kindLabel(p.bucket.task_kind)}</td>
                      <td>{p.sample_n}</td>
                      <td>
                        <span className={"evo-tag " + (dropped ? "evo-tag-none" : "evo-tag-same")}>
                          {dropped ? "丢弃（< K）" : "保留"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {packages.length === 0 && (
                  <tr>
                    <td colSpan={3}>暂无进化包</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
              保留 {anon.kept.length} 桶 / 丢弃 {anon.dropped.length} 桶。
              {anon.kept.length === 0 && " → 本轮没有可用统计，聚合产物为空，正是 K 匿名的代价。"}
            </p>
          </div>
        </div>
      )}

      {/* ---------- ④ 加权聚合 ---------- */}
      {step === "agg" && (
        <div className="evo-grid">
          <div className="evo-card">
            <h3>
              配方向"好实践"收敛
              <span className="evo-hint">纵轴 = 与好实践的距离（0 = 完全一致），越低越好</span>
            </h3>
            <LineChart series={chartSeries} yFmt={(v) => v.toFixed(2)} yTitle="与好实践的距离" xTitle="聚合轮次" />
            <div className="evo-legend">
              {[
                { key: "none", label: "未开差分隐私", color: "var(--evo-s1)" },
                { key: "dp3", label: "DP ε=3", color: "var(--evo-s2)" },
                { key: "dp1", label: "DP ε=1", color: "var(--evo-s3)" },
              ].map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={hiddenSeries.includes(s.key) ? "off" : ""}
                  onClick={() =>
                    setHiddenSeries((h) => (h.includes(s.key) ? h.filter((x) => x !== s.key) : [...h, s.key]))
                  }
                >
                  <i style={{ background: s.color }} />
                  {s.label}
                </button>
              ))}
              {measured && (
                <span>
                  <span style={{ color: "var(--evo-measure)" }}>◎</span> 本机实测基线（{fmt(measured.editRate ?? 0, 2)} 步/任务
                  {measured.auditPass !== undefined ? ` · 自检 ${(measured.auditPass * 100).toFixed(1)}%` : ""}）
                </span>
              )}
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.75 }}>
              收敛机制：每轮各客户端独立观测，服务端按步长做<strong>加权平均</strong>（θ ← θ + η·(聚合观测 − θ)），
              独立噪声在"多客户多轮"下被平均掉；差分隐私为维持固定预算每轮都要重新加噪，于是留出一个<strong>噪声地板</strong>——
              这就是 ε 越小、平台越高的原因。
            </p>
            <div className="evo-sparks">
              {Object.keys(METRIC_META).map((mk) => (
                <Spark key={mk} metric={mk} rounds={shownRounds} />
              ))}
            </div>
          </div>

          <div className="evo-grid evo-grid-2">
            <div className="evo-card">
              <h3>
                客户端权重
                <span className="evo-hint">样本量 × 审计通过率 × 新鲜度</span>
              </h3>
              <div className="evo-weights">
                {activeRun.clients.map((c, i) => {
                  const w = lastRound.weights[i] ?? 0;
                  const total = lastRound.weights.reduce((s, x) => s + x, 0) || 1;
                  return (
                    <div className="evo-weight" key={c.id}>
                      <span className="evo-weight-name" title={c.desc}>
                        {c.name}
                      </span>
                      <span className="evo-weight-bar">
                        <i style={{ width: `${(w / total) * 100}%` }} />
                      </span>
                      <span className="evo-weight-share">{((w / total) * 100).toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.7 }}>
                质量加权而非纯数量加权：审计通过率低、数据陈旧的客户端说话更轻，防止"低质高频"桶主导配方。
                最后一个虚拟用户样本最少、编辑最频繁——它也是最需要好默认配方的人。
              </p>
            </div>

            <div className="evo-card">
              <h3>配方基因对齐情况（末轮）</h3>
              <table className="evo-table">
                <thead>
                  <tr>
                    <th>候选步骤</th>
                    <th>好实践</th>
                    <th>配方采纳度</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRun.genes.map((g, i) => (
                    <tr key={`${g.kind}-${g.name}`}>
                      <td>
                        <span style={{ color: "var(--text-muted)" }}>{kindLabel(g.kind)}</span> {g.name}
                      </td>
                      <td>{g.truth === 1 ? "应包含" : "不应包含"}</td>
                      <td>
                        {fmt(activeRun.recipe[i], 2)}
                        <span
                          className={"evo-tag " + ((activeRun.recipe[i] >= 0.5 ? 1 : 0) === g.truth ? "evo-tag-same" : "evo-tag-none")}
                          style={{ marginLeft: 6 }}
                        >
                          {(activeRun.recipe[i] >= 0.5 ? 1 : 0) === g.truth ? "对齐" : "偏离"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ⑤ 配方版本 ---------- */}
      {step === "manifest" && (
        <div className="evo-grid evo-grid-2">
          <div className="evo-card">
            <h3>
              配方版本 manifest
              <span className="evo-hint">聚合端只存这个，不存原文</span>
            </h3>
            <dl className="evo-kv">
              <dt>版本</dt>
              <dd>v{manifest.version}</dd>
              <dt>生成时间</dt>
              <dd>{new Date(manifest.created_at).toLocaleString()}</dd>
              <dt>指纹</dt>
              <dd className="evo-mono">{manifest.signature}</dd>
              <dt>载荷体积</dt>
              <dd>{manifest.payload_bytes} 字节</dd>
              <dt>参与聚合</dt>
              <dd>{manifest.entries.length} 个匿名桶（丢弃 {manifest.dropped.length} 个）</dd>
              <dt>数据来源</dt>
              <dd>{manifest.source === "hybrid" ? "本机真实日志（实测锚定）" : "协议仿真"}</dd>
              <dt>质检阈值</dt>
              <dd>审计通过率下限 {manifest.qa_threshold_update.audit_pass_floor}；最小样本 {manifest.qa_threshold_update.min_samples}</dd>
            </dl>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.75 }}>
              {manifest.notes.join(" ")}
            </p>
          </div>
          <div className="evo-card">
            <h3>配方更新内容</h3>
            {Object.keys(manifest.plan_templates_update).length === 0 ? (
              <div className="evo-empty">
                {anon.kept.length === 0 ? "没有通过 K 匿名的桶，本轮无法产出配方更新" : "本轮暂无计划卡更新"}
              </div>
            ) : (
              <table className="evo-table">
                <thead>
                  <tr>
                    <th>步骤变更</th>
                    <th>加权后强度</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(manifest.plan_templates_update)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([kk, v]) => (
                      <tr key={kk}>
                        <td>{kk}</td>
                        <td>{v.toFixed(3)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
            <h3 style={{ marginTop: 14 }}>检索词典增量</h3>
            {manifest.lexicon_update.length === 0 ? (
              <div className="evo-empty">暂无高频 0 命中词（这类词同时是产品路线输入）</div>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {manifest.lexicon_update.map((w) => (
                  <span className="evo-badge" key={w}>
                    {w}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------- ⑥ A/B 采纳 ---------- */}
      {step === "ab" && (
        <div className="evo-grid evo-grid-2">
          <div className="evo-card">
            <h3>
              Shadow 试运行结论
              <span className="evo-hint">采纳前必须过这道门</span>
            </h3>
            <div className={"evo-decision " + (activeRun.decision.adopt ? "adopt" : "hold")}>
              <strong>{activeRun.decision.adopt ? "✅ 建议采纳" : "⏸ 暂不采纳"}</strong>
              <ul>
                {activeRun.decision.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
            <table className="evo-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>指标</th>
                  <th>基线（默认骨架）</th>
                  <th>第 {visible} 轮配方</th>
                </tr>
              </thead>
              <tbody>
                {(["editRate", "auditPass", "lexiconUnknown", "toolRounds"] as const).map((mk) => (
                  <tr key={mk}>
                    <td>
                      {METRIC_META[mk].label} {METRIC_META[mk].dir === "up" ? "↑" : "↓"}
                    </td>
                    <td>{mk === "auditPass" || mk === "lexiconUnknown" ? `${(firstRound[mk] * 100).toFixed(1)}%` : fmt(firstRound[mk], 2)}</td>
                    <td>{mk === "auditPass" || mk === "lexiconUnknown" ? `${(lastRound[mk] * 100).toFixed(1)}%` : fmt(lastRound[mk], 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="evo-actions">
              <button type="button" onClick={() => decide(true)} disabled={busy || !activeRun.decision.adopt || abState === "adopted"}>
                ✓ 采纳配方 v{TOTAL_ROUNDS}
              </button>
              <button type="button" onClick={() => decide(false)} disabled={busy || abState === "rolled"}>
                ↺ 回滚到 v{TOTAL_ROUNDS - 1}
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.7 }}>
              当前状态：
              {busy
                ? "正在写入本机…"
                : abState === "pending"
                  ? "待人工决策（新配方已下载但未生效）"
                  : abState === "adopted"
                    ? "已采纳并保存到本机（编排参数将在下一个任务生效）"
                    : "已回滚（保留最近 2 个版本）"}
              {decideError && (
                <span style={{ color: "var(--danger, #c00)", display: "block", marginTop: 4 }}>
                  ⚠ 写入失败：{decideError}
                </span>
              )}
            </p>
            {/* 配方消费明细：如实列出「哪些参数已接入执行链路、哪些还没有」。
                这张表来自 lib/recipe.ts 的 RECIPE_CONSUMPTION，
                并由 tests/recipe.test.ts 断言与 agent.ts 源码一致。 */}
            <details style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
              <summary style={{ cursor: "pointer" }}>
                配方参数接入情况（已接入 {Object.values(RECIPE_CONSUMPTION).filter((c) => c.wired).length}
                /{Object.keys(RECIPE_CONSUMPTION).length}）
              </summary>
              <ul style={{ margin: "6px 0 0 18px", padding: 0, lineHeight: 1.7 }}>
                {Object.entries(RECIPE_CONSUMPTION).map(([field, info]) => (
                  <li key={field}>
                    <code>{field}</code>
                    {" — "}
                    {info.wired ? "✓ 已接入执行链路" : "○ 尚未接入"}
                    {info.note ? `：${info.note}` : ""}
                  </li>
                ))}
                {unconsumedFields().length > 0 && (
                  <li style={{ marginTop: 4 }}>
                    未接入的 {unconsumedFields().length} 项仅为派生值，当前**不会**改变文书生成行为。
                  </li>
                )}
              </ul>
            </details>
          </div>
          <div className="evo-card">
            <h3>本机进化日志（本地留存、可删）</h3>
            {journal.length === 0 ? (
              <div className="evo-empty">还没有采纳 / 回滚记录，点左侧按钮试试</div>
            ) : (
              <div className="evo-signals">
                {journal.map((j) => (
                  <div className="evo-signal" key={j}>
                    <span className="evo-signal-key">·</span>
                    <span className="evo-signal-label" style={{ fontWeight: 400, fontSize: 12.5 }}>
                      {j}
                    </span>
                    <span />
                  </div>
                ))}
              </div>
            )}
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.7 }}>
              这张日志就是"进化了什么"的账本：版本、时间、指标变化，全部留在本机。
              它可删除、可停用——关掉进化开关后核心链路离线照常，不受影响。
            </p>
          </div>
        </div>
      )}

      {/* ---------- RL 对照（始终可见，口径兜底） ---------- */}
      <div className="evo-card" style={{ marginTop: 16 }}>
        <h3>
          如果按强化学习看：逐项对照
          <span className="evo-hint">结论在最后一行——本方案不是 RL</span>
        </h3>
        <table className="evo-table">
          <thead>
            <tr>
              <th>RL 概念</th>
              <th>法元 · 联邦配方进化</th>
              <th>是否同构</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {RL_ANALOGY.map((r) => (
              <tr key={r.rl}>
                <td>{r.rl}</td>
                <td>{r.fre}</td>
                <td>
                  <span
                    className={
                      "evo-tag " +
                      (r.same === "同构" ? "evo-tag-same" : r.same === "部分" ? "evo-tag-part" : "evo-tag-none")
                    }
                  >
                    {r.same}
                  </span>
                </td>
                <td style={{ color: "var(--text-muted)" }}>{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.8 }}>
          一句话结论：法元的自我优化是<strong>联邦统计聚合 + 零标注奖励加权</strong>，
          奖励信号确实与 RL 同构（而且比问券标注更硬），但没有策略梯度、没有价值函数、不做长程信用分配。
          对外一律说"编排配方进化"，不说"强化学习"，也不说"联邦大模型权重"。
        </p>
      </div>
    </div>
  );
}
