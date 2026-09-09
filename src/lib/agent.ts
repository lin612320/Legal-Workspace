// 智能体引擎（P0/P1，含 P2 记忆与 P3 多角色雏形）
//
// 职责：
//   1. 任务规划：模型结构化规划（可用时）→ 兜底预设流水线 → 计划卡（可人工编辑后保存）
//   2. 步骤执行：一步一停（便于人工确认/暂停/日志），工具步骤走 tools.ts，推理步骤走模型
//   3. 多角色：步骤可声明 role（retriever / drafter / qa），模型侧使用对应系统提示词
//   4. 交付：合成 Markdown 交付物；导出 .docx（桌面）/ .md 下载（浏览器）并落"最近文书"
//   5. 记忆：任务完成后写 mem_vectors（embedding 由 embed.ts 计算），新任务先召回（P2）
//
// 环境说明：模型未配置 API 时进入「演示模式」——规划用兜底预设、推理步骤给出占位分析，
// 但工具步骤（法条检索等）仍真实执行，保证无 Key 也能在浏览器里演示 Agent 循环与交付。

import type { AIConfig, FunctionTool } from "./ai";
import { chatStreamOnce, requestStructuredJson, SYSTEM_PROMPTS } from "./ai";
import { buildTools, localDocSave, type LawRef, type ToolResult } from "./tools";
import { callRust, isTauri } from "./tauri";
import { embedTexts, cosine } from "./embed";
import { describeSkeleton, loadSkeleton, type KgSkeleton } from "./kg";
import type { ApiMsg } from "./ai";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** AI 问答 → 文书智能体 交接数据在 localStorage 的键 */
export const LS_AGENT_HANDOFF = "workbench:agentHandoff";

export type TaskKind = "review" | "lawsuit" | "evidence" | "cross_exam" | "argument";

/** 任务类型白名单校验（历史任务 / 交接数据 / 落库值都可能来自旧版本） */
export function isTaskKind(v: unknown): v is TaskKind {
  return TASK_KINDS.some((k) => k.key === v);
}
export type TaskStatus = "planned" | "running" | "paused" | "done" | "failed";
export type StepStatus = "pending" | "running" | "done" | "failed" | "waiting";

export interface AgentStep {
  id?: number; // 落库后的 step id（仅桌面）
  seq: number;
  name: string;
  tool?: string; // 空 = 推理步骤（模型执行）
  role?: "retriever" | "drafter" | "qa" | "planner";
  params?: Record<string, unknown>;
  need_confirm?: boolean;
  /** 人工确认闸门是否已放行（运行期状态；仅当 need_confirm=true 时有意义） */
  confirmed?: boolean;
  prompt?: string; // 推理步骤的指令
  status: StepStatus;
  result_ref?: string;
  started_at?: string;
  updated_at?: string;
}

export interface AgentArtifact {
  id?: number;
  kind: string;
  file_path?: string;
  title?: string;
  content?: string;
  created_at?: string;
}

export interface AgentTask {
  id?: number;
  kind: TaskKind;
  kindLabel: string;
  title: string;
  context: string;
  status: TaskStatus;
  mode: "agent" | "demo"; // demo = 未配置模型
  steps: AgentStep[];
  artifacts: AgentArtifact[];
  refs: LawRef[]; // 累计引用（交付物溯源用）
  /** 命中的知识图谱案由（0.7.0） */
  caseName?: string;
  /** 案由图谱中的请求权基础法名集合（用于适用性校验） */
  kgLawNames?: string[];
  error?: string;
  created_at?: string;
  updated_at?: string;
}

export interface StepEvent {
  taskId?: number;
  step: AgentStep;
  kind: "start" | "tool_result" | "reasoning" | "error" | "gate";
  text?: string;
  refs?: LawRef[];
}

// ---------------------------------------------------------------------------
// 任务类型定义与兜底预设（P0 三条流水线 + 扩展留位）
// ---------------------------------------------------------------------------

export const TASK_KINDS: Array<{ key: TaskKind; label: string; hint: string; goal: string }> = [
  {
    key: "review",
    label: "合同审查",
    hint: "粘贴一份合同/协议文本（或导入 PDF / DOCX），自动生成《审查意见书》",
    goal: "生成《合同审查意见书》（.docx）",
  },
  {
    key: "lawsuit",
    label: "起诉状",
    hint: "描述纠纷事实与诉求，起草《民事起诉状》草稿",
    goal: "生成《民事起诉状》草稿（.docx）",
  },
  {
    key: "evidence",
    label: "证据目录",
    hint: "粘贴案情与证据说明（或导入材料），整理《证据目录》（含表格）",
    goal: "生成《证据目录》（.docx，表格）",
  },
  {
    key: "cross_exam",
    label: "质证意见",
    hint: "描述证据与质证要求，起草质证意见",
    goal: "生成《质证意见》（.docx）",
  },
  {
    key: "argument",
    label: "代理词",
    hint: "描述案情与争议焦点，起草《代理词》",
    goal: "生成《代理词》（.docx）",
  },
];

/** 各任务类型的交付物正文骨架（注入起草员系统提示，约束输出结构） */
export const KIND_GUIDES: Record<TaskKind, string> = {
  review:
    "输出结构：一、合同基本情况；二、逐条风险与修改建议（风险等级 / 原文条款 / 问题 / 修改建议）；三、重点条款专项意见（违约责任、知识产权、争议解决、保密）；四、总体结论与谈判策略。",
  lawsuit:
    "输出结构：《民事起诉状》——当事人信息；诉讼请求（分项列明）；事实与理由（时间线 + 法律关系）；证据清单；此致法院；具状人；日期。",
  evidence:
    "输出结构：先用 Markdown 表格输出《证据目录》，表头固定为「序号 | 证据名称 | 证据种类 | 证明对象 | 来源/页码 | 备注」；再逐条说明该证据与待证事实（构成要件）的对应关系；最后列出待补充的证据。",
  cross_exam:
    "输出结构：一、证据逐项质证（证据名称 + 合法性/真实性/关联性分别评述 + 质证意见）；二、综合质证意见；三、建议申请法院调取或鉴定的证据。",
  argument:
    "输出结构：一、案件基本情况与争议焦点；二、事实认定意见（结合在案证据）；三、法律适用意见（逐条引用真实法条）；四、代理意见与请求；五、结语。",
};

export function kindMeta(kind: string) {
  return (
    TASK_KINDS.find((k) => k.key === kind) ?? {
      key: kind,
      label: kind,
      hint: "",
      goal: "生成交付物",
    }
  );
}

/** 兜底预设步骤（模型不可用时 / 结构化规划失败时） */
export function fallbackPlan(kind: TaskKind): AgentStep[] {
  const base = (
    list: Array<Omit<AgentStep, "seq" | "status">>,
  ): AgentStep[] => list.map((s, i) => ({ ...s, seq: i, status: "pending" as const }));
  switch (kind) {
    case "review":
      return base([
        { name: "合同分段与要点梳理", role: "planner", need_confirm: false },
        { name: "检索相关法条", tool: "laws_search", params: { keyword: "", country: "中国" }, role: "retriever" },
        { name: "逐条风险与修改建议分析", role: "drafter" },
        { name: "质检：核对引用与风险遗漏", role: "qa" },
      ]);
    case "lawsuit":
      return base([
        { name: "事实与诉求要点梳理", role: "planner" },
        { name: "检索法律依据", tool: "laws_search", params: { keyword: "", country: "中国" }, role: "retriever" },
        { name: "载入起诉状模板", tool: "template_load", params: { category: "诉讼文书", title: "民事起诉状" }, role: "retriever" },
        { name: "起草起诉状正文", role: "drafter" },
      ]);
    case "evidence":
      return base([
        { name: "案情与证据要点梳理", role: "planner" },
        { name: "检索证据规则法条", tool: "laws_search", params: { keyword: "", country: "中国" }, role: "retriever" },
        { name: "载入证据目录模板", tool: "template_load", params: { category: "诉讼文书", title: "证据目录" }, role: "retriever" },
        { name: "整理证据目录与证明目的", role: "drafter" },
        { name: "质检：三性与要件覆盖检查", role: "qa" },
      ]);
    case "cross_exam":
      return base([
        { name: "证据清单与质证目标梳理", role: "planner" },
        { name: "检索证据相关法条", tool: "laws_search", params: { keyword: "", country: "中国" }, role: "retriever" },
        { name: "起草质证意见", role: "drafter" },
        { name: "质检：三性覆盖检查", role: "qa" },
      ]);
    case "argument":
      return base([
        { name: "争议焦点与事实梳理", role: "planner" },
        { name: "检索法律依据", tool: "laws_search", params: { keyword: "", country: "中国" }, role: "retriever" },
        { name: "载入代理词模板", tool: "template_load", params: { category: "诉讼文书", title: "代理词" }, role: "retriever" },
        { name: "起草代理词正文", role: "drafter" },
        { name: "质检：争点与引用覆盖检查", role: "qa" },
      ]);
  }
}

// ---------------------------------------------------------------------------
// 规划（模型 → JSON；失败 → 兜底预设）
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM = `你是法律工作流规划器。根据用户的模糊需求，把任务拆成 3~6 个可执行步骤。
必须返回合法 JSON（不要任何额外文字），结构：
{
  "title": "简短任务标题",
  "steps": [
    {"name":"步骤名","tool":"laws_search|law_by_id|laws_country_preview|template_load|translate_text（无工具则省略）",
     "params":{"keyword":"建议检索词"}, "need_confirm":false,
     "prompt":"若是推理步骤，写明要模型做什么（面向工具结果引用，禁止编造法条）"}
  ]
}
检索类步骤请给出能命中真实法条的关键词（如条文号或日本法用词），中文场景默认 country="中国"。`;

export interface PlanResult {
  kindLabel: string;
  mode: "agent" | "demo";
  steps: AgentStep[];
  /** 命中的知识图谱案由 */
  caseName?: string;
  /** 案由图谱的请求权基础法名 */
  kgLawNames?: string[];
}

/** 由法名推断法域（用于检索时限定国家） */
const COUNTRY_BY_LAW: Array<[RegExp, string]> = [
  [/民法|商法|会社法|民事訴訟法|日本国憲法|労働基準法|著作権法/, "日本"],
  [/美国法典|美利坚合众国宪法/, "美国"],
  [/中华人民共和国/, "中国"],
];

function countryOfLaws(laws: string[]): string | undefined {
  const hits = new Set<string>();
  for (const l of laws) {
    for (const [re, c] of COUNTRY_BY_LAW) {
      if (re.test(l)) hits.add(c);
    }
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/**
 * 由知识图谱骨架生成计划步骤（0.7.0 核心）：
 * 图谱给出「案由 → 构成要件 → 请求权基础 / 证据」结构，规划在其上填充，
 * 保证要件不漏、检索有明确法域、起草有要件清单约束。
 */
export function planFromSkeleton(kind: TaskKind, sk: KgSkeleton): AgentStep[] {
  const meta = kindMeta(kind);
  const elNames = sk.elements.map((e) => e.name);
  const lawNames = [...new Set(sk.elements.flatMap((e) => e.laws))];
  const evNames = [...new Set(sk.elements.flatMap((e) => e.evidences))];
  const country = countryOfLaws(lawNames);
  const steps: Array<Omit<AgentStep, "seq" | "status">> = [
    {
      name: `按案由要件梳理材料（${elNames.join("、") || "构成要件"}）`,
      role: "planner",
      prompt: `本案由：${sk.case}。请逐项梳理材料事实与待证事实：${elNames.join("、")}。${
        sk.issues.length ? `争议焦点：${sk.issues.join("、")}。` : ""
      }`,
    },
    {
      name: "检索法律依据",
      tool: "laws_search",
      params: { keyword: lawNames[0] ?? "", country: country ?? "全部国家" },
      role: "retriever",
    },
  ];
  if (kind === "lawsuit" || kind === "evidence" || kind === "argument") {
    const titleByKind: Partial<Record<TaskKind, string>> = {
      lawsuit: "民事起诉状",
      evidence: "证据目录",
      argument: "代理词",
    };
    steps.push({
      name: "载入文书模板",
      tool: "template_load",
      params: { category: "诉讼文书", title: titleByKind[kind] },
      role: "retriever",
    });
  }
  steps.push({
    name: `起草${meta.label}正文`,
    role: "drafter",
    prompt: `${evNames.length ? `证据要点：${evNames.join("、")}。` : ""}按构成要件逐项展开，只引用工具真实返回的法条。`,
  });
  steps.push({ name: "质检：要件覆盖与引用核对", role: "qa" });
  return steps.map((s, i) => ({ ...s, seq: i, status: "pending" as const }));
}

export async function planTask(
  cfg: AIConfig | null,
  kind: TaskKind,
  context: string,
  signal?: AbortSignal,
): Promise<PlanResult> {
  const meta = kindMeta(kind);
  // 0.7.0：先检索本地知识图谱，命中案由则用图谱骨架作为规划底座（无命中回退预设流水线）
  const skeleton = await loadSkeleton(context);
  const fallback: PlanResult = {
    kindLabel: meta.label,
    mode: "demo",
    steps: skeleton ? planFromSkeleton(kind, skeleton) : fallbackPlan(kind),
    caseName: skeleton?.case,
    kgLawNames: skeleton?.lawNames,
  };
  if (!cfg || !cfg.baseUrl.trim() || !cfg.apiKey.trim()) return fallback;

  const recalled = await recallMemory(cfg, kind, context);
  const userText = `任务类型：${meta.label}。\n用户输入：\n${context.slice(0, 6000)}\n\n${
    skeleton
      ? `【知识图谱骨架（来自本地图谱，规划必须覆盖下列构成要件）】\n${describeSkeleton(skeleton)}\n`
      : ""
  }${recalled ? `历史相关经验：\n${recalled}\n（可参考但勿照搬）\n` : ""}`;
  const plan = await requestStructuredJson<{
    title?: string;
    steps?: Array<{
      name?: string;
      tool?: string;
      params?: Record<string, unknown>;
      need_confirm?: boolean;
      prompt?: string;
    }>;
  }>(cfg, PLANNER_SYSTEM, userText, signal);

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return fallback;
  const steps: AgentStep[] = plan.steps
    .filter((s) => s && typeof s.name === "string" && s.name.trim())
    .map((s, i) => ({
      seq: i,
      name: String(s.name).trim(),
      tool: s.tool || undefined,
      params: s.params ?? undefined,
      need_confirm: !!s.need_confirm,
      prompt: s.prompt || undefined,
      status: "pending" as const,
    }));
  if (steps.length === 0) return fallback;
  return {
    kindLabel: meta.label,
    mode: "agent",
    steps: steps.length > 8 ? steps.slice(0, 8) : steps,
    caseName: skeleton?.case,
    kgLawNames: skeleton?.lawNames,
  };
}

// ---------------------------------------------------------------------------
// 步骤执行
// ---------------------------------------------------------------------------

const ROLE_SYSTEMS: Record<string, string> = {
  planner: "你是本次法律任务的分析员：先梳理要点与问题清单，输出结论要点。",
  retriever:
    "你是法律检索员：基于上一步要点，选择恰当工具检索真实法条；只汇报工具真实返回的条文，禁止编造条文号与内容。",
  drafter: "你是资深法律文书起草人：结合检索结果起草高质量文书/意见，引用处标注法条篇名与条文号。",
  qa: "你是文书质检员：核对引用是否真实存在、风险/三性是否覆盖、口径是否一致、有无明显遗漏；有则指出并给修改说明。",
};

const DEMO_REASON_PREFIX = "【演示模式】未配置模型，本步输出为示例推理：";

function roleSystem(role?: string): string {
  return ROLE_SYSTEMS[role ?? "planner"] ?? ROLE_SYSTEMS.planner;
}

/** 单步执行：返回是否推进到下一步（false = 停在 waiting，等人工放行） */
export async function executeStep(
  cfg: AIConfig | null,
  task: AgentTask,
  step: AgentStep,
  tools: { defs: FunctionTool[]; run: (name: string, args: any) => Promise<ToolResult> },
  emit: (e: StepEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const set = (patch: Partial<AgentStep>) => Object.assign(step, patch);
  set({ status: "running", started_at: new Date().toISOString() });

  // 需要人工确认的步骤：先停住（已放行过的步骤不再拦截，否则「继续」会无限回到 waiting）
  if (step.need_confirm && !step.confirmed) {
    set({ status: "waiting" });
    emit({ step, kind: "gate" });
    return;
  }

  try {
    if (step.tool) {
      const configured = !!(cfg && cfg.baseUrl.trim() && cfg.apiKey.trim());
      let summary: string;
      if (configured) {
        // 模型驱动：让模型在多个工具间自主决策，直到给出结论
        summary = await runAgenticToolStep(cfg!, task, step, tools, emit, signal);
      } else {
        // 演示/兜底：按计划执行一次确定性工具调用（浏览器也能演示）
        summary = await runSimpleToolStep(task, step, tools, emit);
      }
      set({ result_ref: summary });
      set({ status: "done" });
    } else {
      // —— 推理/起草/质检步骤 ——
      const reasoning = await runReasoningStep(cfg, task, step, signal);
      set({ result_ref: reasoning });
      emit({ step, kind: "reasoning", text: reasoning });
      set({ status: "done" });
    }
  } catch (e) {
    set({
      status: "failed",
      result_ref: `执行异常：${e instanceof Error ? e.message : String(e)}`,
    });
    emit({ step, kind: "error", text: step.result_ref });
  }
}

/**
 * 模型驱动工具循环（agentic tool-calling）：
 *   model 发 tool_calls → 执行工具 → 结果回填 → 模型继续，
 *   直到模型不再调用工具（输出最终结论）或达到轮数上限。
 */
async function runAgenticToolStep(
  cfg: AIConfig,
  task: AgentTask,
  step: AgentStep,
  tools: { defs: FunctionTool[]; run: (name: string, args: any) => Promise<ToolResult> },
  emit: (e: StepEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const params = step.params ?? {};
  const sys =
    roleSystem("retriever") +
    `\n本步目标：${step.name}\n` +
    `计划建议的检索参数：${JSON.stringify(params)}\n` +
    `可用工具会访问本地真实法库（内置 15 万条日美法条文等）。必要时连续调用多个工具；` +
    `引用任何条文都必须来自工具真实返回。检索完成后，用一两句话汇报要点与命中数量，不要编造。`;
  const msgs: ApiMsg[] = [
    { role: "system", content: sys },
    {
      role: "user",
      content: `任务：${task.kindLabel}\n任务输入：${task.context.slice(0, 4000)}`,
    },
  ];

  let finalText = "";
  const MAX_ROUNDS = 6;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { content, tool_calls } = await chatStreamOnce(cfg, msgs, {
      tools: tools.defs,
      signal,
      temperature: 0.3,
    });
    if (!tool_calls || tool_calls.length === 0) {
      finalText = (content ?? "").trim() || finalText;
      break;
    }
    // 记录 assistant 的 tool_calls 消息
    msgs.push({
      role: "assistant",
      content: content || null,
      tool_calls: tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });
    // 逐个执行并回填
    for (const tc of tool_calls) {
      let args: any = {};
      try {
        args = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        args = {};
      }
      const res = await tools.run(tc.name, args);
      if (res.refs && res.refs.length > 0) {
        task.refs.push(...res.refs);
        emit({ step, kind: "tool_result", text: res.text, refs: res.refs });
      } else {
        emit({ step, kind: "tool_result", text: res.text });
      }
      finalText = res.text;
      msgs.push({ role: "tool", tool_call_id: tc.id, content: res.text });
    }
    if (round === MAX_ROUNDS - 1) {
      finalText += "\n（已达最大工具轮数，由执行器截断）";
    }
  }
  return truncateText(finalText, 6000);
}

/** 演示/兜底：按计划执行一次确定性工具调用 */
async function runSimpleToolStep(
  task: AgentTask,
  step: AgentStep,
  tools: { defs: FunctionTool[]; run: (name: string, args: any) => Promise<ToolResult> },
  emit: (e: StepEvent) => void,
): Promise<string> {
  let params: any = { ...(step.params ?? {}) };
  if (
    (step.tool === "laws_search" || step.tool === "laws_country_preview") &&
    !params.country
  ) {
    params.country = "中国";
  }
  if (
    step.tool === "laws_search" &&
    !String(params.keyword ?? "").trim() &&
    task.context.trim()
  ) {
    params.keyword = task.context.replace(/\s+/g, " ").slice(0, 40);
  }
  const res = await tools.run(step.tool as string, params);
  if (res.refs && res.refs.length > 0) {
    task.refs.push(...res.refs);
    emit({ step, kind: "tool_result", text: res.text, refs: res.refs });
  } else {
    emit({ step, kind: "tool_result", text: res.text });
  }
  return res.text;
}

function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 推理步骤：模型可用 → 调用（system=角色提示 + 任务上下文 + 检索结果）；否则演示占位 */
async function runReasoningStep(
  cfg: AIConfig | null,
  task: AgentTask,
  step: AgentStep,
  signal?: AbortSignal,
): Promise<string> {
  const evidence = task.steps
    .filter((s) => s.seq < step.seq && s.result_ref)
    .map((s) => `【第 ${s.seq + 1} 步：${s.name}】\n${s.result_ref}`)
    .join("\n\n");
  if (cfg && cfg.baseUrl.trim() && cfg.apiKey.trim()) {
    const sys =
      roleSystem(step.role) +
      (step.prompt ? `\n本步指令：${step.prompt}` : "") +
      (step.role === "drafter" ? `\n交付物结构要求：${KIND_GUIDES[task.kind]}` : "") +
      `\n任务：${task.kindLabel}。禁止编造法条；引用必须来自工具真实返回（含来源）。`;
    const msgs: ApiMsg[] = [
      { role: "system", content: sys },
      { role: "user", content: `任务输入：\n${task.context.slice(0, 6000)}\n\n检索/前序结果：\n${evidence || "（无）"}` },
    ];
    const { content } = await chatStreamOnce(cfg, msgs, { signal, temperature: 0.4 });
    let out = content.trim() || "（模型未返回内容）";
    // 质检角色：无论模型说了什么，都追加一段“代码必然执行”的确定性引用自检结论
    if (step.role === "qa") out += appendQaAudit(task, evidence);
    return out;
  }
  const hint = DEMO_REASON_PREFIX + (step.prompt || step.name);
  let out = hint + "\n" + demoReasoning(task, step);
  if (step.role === "qa") out += appendQaAudit(task, evidence);
  return out;
}

/** 质检步骤收尾：对“已执行步骤产出”追加确定性引用自检结论（规则执行，非模型自述） */
function appendQaAudit(task: AgentTask, evidence: string): string {
  const audit = auditCitations(evidence, task.refs);
  let out: string;
  if (audit.ok) {
    out = `\n\n【引用自检 · 确定性规则】通过：产出中共识别 ${audit.total} 处条文号引用，全部可回溯到本次工具真实返回的本地法条（${audit.covered}/${audit.total}）。`;
  } else {
    const listed = audit.unmatched
      .slice(0, 8)
      .map((t) => `「${t}」`)
      .join("、");
    out = `\n\n【引用自检 · 确定性规则】需人工核实：产出中共识别 ${audit.total} 处条文号引用，其中 ${audit.unmatched.length} 处未在工具真实返回中找到对应条文（${listed}${audit.unmatched.length > 8 ? "…" : ""}）——可能来自用户材料原文或模型笔误，已提示人工核实后再采用。`;
  }
  if (task.kgLawNames && task.kgLawNames.length > 0) {
    out += `\n\n【适用性校验 · 知识图谱】\n${applicabilityReport(
      auditApplicability(task.refs, task.kgLawNames),
    )}`;
  }
  return out;
}

/** 演示模式：根据已检索到的引用给出可读的分析占位 */
function demoReasoning(task: AgentTask, step: AgentStep): string {
  const refs = task.refs;
  const lines: string[] = [];
  lines.push(`- 输入要点：${task.context.replace(/\s+/g, " ").slice(0, 120)}${task.context.length > 120 ? "…" : ""}`);
  if (refs.length > 0) {
    lines.push(`- 已检索到 ${refs.length} 条真实法条引用（可溯源）：`);
    for (const r of refs.slice(0, 5)) {
      lines.push(`  · ${r.title}${r.article_no ? ` ${r.article_no}` : ""}（来源：${r.source ?? "未知"}）`);
    }
  } else {
    lines.push("- 未命中真实法条（本地示例库仅 6 条，真机内置库含 15 万条日美法条文）");
  }
  if (step.role === "qa") {
    lines.push("- 质检要点：引用均来自工具返回、未编造；风险/三性覆盖在演示数据下有限，需真实法库全量核对");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 确定性引用自检（反幻觉硬校验：规则执行，非模型自查）
// ---------------------------------------------------------------------------

/** 自检方法脚注（写进交付物，说明识别范围与判据） */
export const CITE_PATTERNS_NOTE =
  "自检为确定性规则校验：按中文/日文「第X条(之Y/のY)」、美国法典「§NN」等条文号格式识别正文引用，" +
  "并判定每条引用是否能在「本次工具真实返回」的法条中找到对应条文号；未覆盖项仅提示人工核实，不视为有效引用。";

/** 从文本中抽取去重后的条文号引用 token */
export function extractCitationTokens(text: string): string[] {
  const re =
    /第[0-9〇零一二三四五六七八九十百千万]+条(?:(?:之|の|ノ)[0-9〇零一二三四五六七八九十百千万]+)?|§\s*\d+(?:[.\-]\d+)?(?:\(\d+\))?/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const t = m[0].replace(/\s+/g, "");
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 规范化条文号（去空白与括号），用于对照 */
function normArticleNo(s: string | null): string {
  return (s ?? "").replace(/\s+/g, "").replace(/[（）()]/g, "");
}

/** 条文号是否“覆盖”引用：完全相等，或条文号以该引用为前缀（如「第一百四十三条」覆盖「第一百四十三条第一款」） */
function articleCovers(articleNo: string | null, token: string): boolean {
  const a = normArticleNo(articleNo);
  const t = normArticleNo(token);
  if (!a || !t) return false;
  return a === t || (t.length < a.length && a.startsWith(t));
}

export interface CitationAudit {
  ok: boolean;
  total: number; // 识别到的条文号引用数（去重）
  covered: number; // 能在工具返回法条中找到的引用数
  unmatched: string[]; // 未找到的引用清单
}

/**
 * 对“正文（模型产出）”做确定性引用自检：
 * 正文中每一条条文号引用都必须能对应到本次工具真实返回的法条（task.refs）。
 * 这是代码层面的硬校验——不依赖模型“说自己检查过”，而是规则必然执行。
 */
export function auditCitations(bodyText: string, refs: LawRef[]): CitationAudit {
  const tokens = extractCitationTokens(bodyText);
  const covered = tokens.filter((t) => refs.some((r) => articleCovers(r.article_no, t)));
  const unmatched = tokens.filter((t) => !refs.some((r) => articleCovers(r.article_no, t)));
  return { ok: unmatched.length === 0, total: tokens.length, covered: covered.length, unmatched };
}

/** 把自检结果渲染成 Markdown（写进交付物 / QA 步骤日志） */
export function auditReport(a: CitationAudit): string {
  const lines: string[] = [];
  lines.push(`- 识别到条文号引用 ${a.total} 处（去重）`);
  lines.push(`- 与「本次工具真实返回」法条对应：${a.covered}/${a.total}`);
  if (a.ok) {
    lines.push("- ✅ 自检通过：正文引用均可回溯到本次检索/工具返回的本地法条（未发现编造引用）");
  } else {
    lines.push(
      "- ⚠ 以下引用未在工具返回中找到对应条文（可能来自用户材料原文或模型笔误，请人工核实后再采用）：\n  " +
        a.unmatched.map((t) => `「${t}」`).join("、"),
    );
  }
  lines.push(`- ${CITE_PATTERNS_NOTE}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 0.7.0：法条适用性校验（知识图谱第二段自检）
// 第一段 auditCitations 校验「引用是否真实存在（工具返回）」；
// 第二段校验「引用是否落在本案由图谱的请求权基础范围内」。
// ---------------------------------------------------------------------------

export interface ApplicabilityAudit {
  checked: number;
  inScope: string[];
  outOfScope: string[];
  lawNames: string[];
}

/** 名称互含即视为同一部法（图谱存法名，法条返回 title 可能带后缀） */
function sameLaw(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  return x === y || x.includes(y) || y.includes(x);
}

export function auditApplicability(refs: LawRef[], lawNames: string[]): ApplicabilityAudit {
  const titles = [...new Set(refs.map((r) => r.title))];
  const inScope = titles.filter((t) => lawNames.some((l) => sameLaw(t, l)));
  const outOfScope = titles.filter((t) => !inScope.includes(t));
  return { checked: titles.length, inScope, outOfScope, lawNames };
}

export function applicabilityReport(a: ApplicabilityAudit): string {
  if (a.lawNames.length === 0) {
    return "- 未命中知识图谱案由，跳过适用性校验。";
  }
  const lines: string[] = [];
  lines.push(`- 本案由图谱请求权基础：${a.lawNames.join("、")}`);
  lines.push(`- 本次引用法条 ${a.checked} 部，落在案由范围内的 ${a.inScope.length} 部`);
  if (a.outOfScope.length > 0) {
    lines.push(
      `- ⚠ 以下引用不在本案由图谱范围内（可能仍然相关，请人工判断）：${a.outOfScope
        .map((t) => `「${t}」`)
        .join("、")}`,
    );
  } else if (a.checked > 0) {
    lines.push("- ✅ 全部引用均落在本案由图谱的请求权基础范围内");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 交付物合成 + 导出
// ---------------------------------------------------------------------------

export function composeDeliverable(task: AgentTask): string {
  const meta = kindMeta(task.kind);
  const title = task.title || `${meta.label} · ${new Date().toLocaleDateString()}`;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> 由「法元 · 小元（${meta.label}智能体）」生成${task.mode === "demo" ? "（演示模式，未配置模型）" : ""}`);
  lines.push("");
  lines.push("## 一、任务输入");
  lines.push("");
  lines.push(task.context.replace(/\s+/g, " ").slice(0, 2000));
  lines.push("");
  lines.push("## 二、执行过程与分步结果");
  lines.push("");
  const stepTexts: string[] = [];
  for (const s of task.steps) {
    lines.push(`### ${s.seq + 1}. ${s.name}`);
    lines.push("");
    if (s.tool) lines.push(`- 工具：${s.tool}`);
    const ref = (s.result_ref ?? "（未产出）").slice(0, 3000);
    lines.push(ref);
    lines.push("");
    stepTexts.push(ref);
  }
  lines.push("## 三、引用的法规条文（可溯源）");
  lines.push("");
  if (task.refs.length === 0) {
    lines.push("本次执行未命中本地法条。");
  } else {
    const seen = new Set<number>();
    for (const r of task.refs) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      lines.push(
        `- ${r.title}${r.article_no ? ` ${r.article_no}` : ""}（来源：${r.source ?? "未知"}）：${r.excerpt}`,
      );
    }
  }
  lines.push("");
  lines.push("## 四、引用自检（确定性规则校验）");
  lines.push("");
  // 只审计“模型/步骤产出”（二）里的引用——不审计输入原文与自检段自身
  const audit = auditCitations(stepTexts.join("\n"), task.refs);
  lines.push(auditReport(audit));
  if (task.kgLawNames && task.kgLawNames.length > 0) {
    lines.push("");
    lines.push(`### 四之二、法条适用性校验（知识图谱 · 案由「${task.caseName ?? "未命名"}」）`);
    lines.push("");
    lines.push(applicabilityReport(auditApplicability(task.refs, task.kgLawNames)));
  }
  lines.push("");
  lines.push("## 五、结论");
  lines.push("");
  lines.push("本交付物由智能体自动生成，供人工复核；引用法条以工具返回的本地库原文为准。");
  return lines.join("\n");
}

/** 交付动作：桌面导出 .docx 并落 documents / task_artifacts；浏览器下载 .md + 本地文书 */
export async function deliverTask(task: AgentTask): Promise<{ path?: string; ok: boolean; msg: string }> {
  const title = task.title || kindMeta(task.kind).label;
  const md = composeDeliverable(task);
  try {
    if (isTauri()) {
      const r = await callRust<{ path: string; dir: string }>("docx_export", { title, markdown: md });
      if (!r) return { ok: false, msg: "docx_export 未返回结果（检查数据目录权限）" };
      const docId = await callRust<number>("document_save", {
        title,
        content: md,
        file_path: r.path,
        kind: "docx",
        meta: JSON.stringify({ taskId: task.id ?? null, kind: task.kind }),
      });
      if (task.id != null) {
        await callRust<void>("task_artifact_add", {
          taskId: task.id,
          kind: "docx",
          file_path: r.path,
          title,
          content: md,
        });
      }
      return { path: r.path, ok: true, msg: `已导出：${r.path}${docId != null ? "（已记入最近文书）" : ""}` };
    }
    // 浏览器：下载 .md + 本地文书
    downloadText(md, `${title}.md`);
    localDocSave(title, md, "md");
    return { ok: true, msg: "浏览器预览模式：已下载 .md 并记入本地（演示）最近文书（桌面版会导出 .docx）" };
  } catch (e) {
    return { ok: false, msg: `交付失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

function downloadText(text: string, fileName: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// 记忆（P2）：embedding 回存 mem_vectors；新任务先做向量召回
// ---------------------------------------------------------------------------

const LS_MEM = "workbench:mem";

function readLocalMem(): Array<{ id: number; kind: string; title: string; content: string; vector: number[]; created_at: string }> {
  try {
    const raw = localStorage.getItem(LS_MEM);
    return raw ? (JSON.parse(raw) as Array<{ id: number; kind: string; title: string; content: string; vector: number[]; created_at: string }>) : [];
  } catch {
    return [];
  }
}

/** 任务完成后沉淀一条记忆（失败静默，不打断主流程） */
export async function rememberTask(cfg: AIConfig | null, task: AgentTask): Promise<void> {
  try {
    const digest =
      `${task.kindLabel}任务：${task.title}\n输入：${task.context.slice(0, 300)}\n引用法条：` +
      task.refs
        .map((r) => `${r.title}${r.article_no ?? ""}`)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 10)
        .join("、") +
      `\n结论要点：${task.steps
        .filter((s) => s.status === "done" && s.result_ref)
        .slice(-2)
        .map((s) => s.result_ref!.slice(0, 200))
        .join("\n")}`;
    if (isTauri()) {
      if (cfg && cfg.baseUrl && cfg.apiKey && task.id != null) {
        const vec = (await embedTexts(cfg, [digest]))[0];
        await callRust<void>("mem_save", {
          kind: "task",
          refId: task.id,
          title: task.title || kindMeta(task.kind).label,
          content: digest,
          vectorJson: JSON.stringify(vec),
        });
      } else {
        // 桌面但未配置模型：先存文本摘要，向量留空
        await callRust<void>("mem_save", {
          kind: "task",
          refId: task.id,
          title: task.title || kindMeta(task.kind).label,
          content: digest,
          vectorJson: "",
        });
      }
    } else {
      const vec =
        cfg && cfg.baseUrl && cfg.apiKey ? ((await embedTexts(cfg, [digest]))[0] ?? []) : [];
      writeLocalMem([...readLocalMem(), { id: Date.now(), kind: "task", title: task.title || "", content: digest, vector: vec, created_at: new Date().toISOString() }]);
    }
  } catch (e) {
    console.warn("[mem] 记忆写入失败（不影响主流程）:", e);
  }
}

function writeLocalMem(list: any[]) {
  try {
    localStorage.setItem(LS_MEM, JSON.stringify(list.slice(-200)));
  } catch {
    /* ignore */
  }
}

/** 新任务召回：返回最近相关记忆文本（最多 1 条），用于注入规划上下文 */
export async function recallMemory(
  cfg: AIConfig | null,
  kind: TaskKind,
  context: string,
): Promise<string | null> {
  try {
    const meta = kindMeta(kind);
    const probe = `${meta.label} ${context.slice(0, 200)}`;
    if (isTauri()) {
      const rows =
        (await callRust<
          Array<{ id: number; kind: string; ref_id?: number; title: string; content: string; vector_json?: string | null; created_at: string }>
        >("mem_list", { kind: "task" })) ?? [];
      if (rows.length === 0) return null;
      if (cfg && cfg.baseUrl && cfg.apiKey && rows.some((r) => r.vector_json)) {
        const vec = (await embedTexts(cfg, [probe]))[0];
        let best: (typeof rows)[0] | null = null;
        let bestScore = 0.45; // 相似度阈值
        for (const r of rows) {
          if (!r.vector_json) continue;
          try {
            const v = JSON.parse(r.vector_json) as number[];
            if (!Array.isArray(v) || v.length === 0) continue;
            const sc = cosine(vec, v);
            if (sc > bestScore) {
              bestScore = sc;
              best = r;
            }
          } catch {
            /* ignore */
          }
        }
        return best ? `《${best.title}》：${best.content.slice(0, 400)}` : null;
      }
      // 未配置模型时按关键词粗召回
      const kw = (context.match(/[\u4e00-\u9fa5A-Za-z]{2,}/g) ?? []).slice(0, 6);
      const hit = rows.find((r) => kw.some((k) => r.content.includes(k)) && r.content.includes(meta.label));
      return hit ? `《${hit.title}》：${hit.content.slice(0, 400)}` : null;
    }
    const rows = readLocalMem().filter((r) => r.kind === "task");
    if (rows.length === 0) return null;
    if (cfg && cfg.baseUrl && cfg.apiKey && rows.some((r) => r.vector && r.vector.length > 0)) {
      const vec = (await embedTexts(cfg, [probe]))[0];
      let best: (typeof rows)[0] | null = null;
      let bestScore = 0.45;
      for (const r of rows) {
        if (!r.vector || r.vector.length === 0) continue;
        const sc = cosine(vec, r.vector);
        if (sc > bestScore) {
          bestScore = sc;
          best = r;
        }
      }
      return best ? `《${best.title}》：${best.content.slice(0, 400)}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 供外部工具调用循环使用的句柄（含 tools 声明） */
export function makeRunner() {
  const tools = buildTools();
  return {
    defs: tools.defs as FunctionTool[],
    run: tools.run,
    SYSTEM_PROMPTS,
  };
}
