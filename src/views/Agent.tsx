import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  TASK_KINDS,
  LS_AGENT_HANDOFF,
  type TaskKind,
  type AgentTask,
  type AgentStep,
  planTask,
  executeStep,
  composeDeliverable,
  deliverTask,
  rememberTask,
  makeRunner,
} from "../lib/agent";
import { useSettings } from "../hooks/useSettings";
import { useDocuments } from "../hooks/useDocuments";
import { isTauri } from "../lib/tauri";
import { callRust } from "../lib/tauri";
import { onBallPush } from "../lib/ball";
import { openPathFile, revealPath } from "../lib/open";
import type { AIConfig } from "../lib/ai";
import type { LawRef } from "../lib/tools";

const SAMPLE_CONTRACT = `甲方（服务方）与乙方（委托方）签订《软件定制开发合同》。约定：合同总价 20 万元，乙方应在合同签订后 5 日内支付 60% 预付款，验收合格后支付 40% 尾款。交付期限为预付款到账后 60 个自然日。甲方逾期交付每日按合同总价 0.5% 支付违约金；乙方逾期付款每日按未付款项 0.3% 支付违约金。双方任何一方不得单方解除合同，违约方需赔偿守约方全部损失（含间接损失与律师费）。知识产权约定：开发成果著作权归乙方，但甲方保留通用组件使用权。争议由甲方所在地法院管辖。`;

const LS_LAST_TASK = "workbench:lastAgentTask";

/** 多智能体接力角色标签（P3 可视化） */
const ROLE_LABELS: Record<string, string> = {
  planner: "规划",
  retriever: "检索员",
  drafter: "起草员",
  qa: "质检员",
};

interface LogLine {
  ts: number;
  level: "tool" | "reason" | "gate" | "error" | "info";
  text: string;
}

interface HistoryItem {
  id?: number;
  kind: string;
  kindLabel: string;
  title: string;
  status: string;
  updated_at: string;
  local?: boolean;
}

/** 浏览器本地最近任务快照 */
function saveLocalLastTask(t: AgentTask) {
  try {
    localStorage.setItem(
      LS_LAST_TASK,
      JSON.stringify({
        kind: t.kind,
        kindLabel: t.kindLabel,
        title: t.title,
        context: t.context,
        mode: t.mode,
        status: t.status,
        created_at: t.created_at,
        steps: t.steps,
      }),
    );
  } catch {
    /* ignore */
  }
}

function loadLocalLastTask(): AgentTask | null {
  try {
    const raw = localStorage.getItem(LS_LAST_TASK);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<AgentTask> & { steps?: AgentStep[] };
    if (!Array.isArray(d.steps) || d.steps.length === 0) return null;
    const steps: AgentStep[] = d.steps.map((s, i) => ({
      seq: s.seq ?? i,
      name: s.name ?? "步骤",
      tool: s.tool,
      role: s.role,
      params: s.params,
      need_confirm: s.need_confirm,
      prompt: s.prompt,
      status: normalizeStepStatus(s.status),
      result_ref: s.result_ref,
      started_at: s.started_at,
      updated_at: s.updated_at,
    }));
    return {
      id: undefined,
      kind: (d.kind as TaskKind) ?? "review",
      kindLabel: d.kindLabel ?? "智能体任务",
      title: d.title ?? "上次任务",
      context: d.context ?? "",
      status: normalizeTaskStatus(d.status),
      mode: d.mode === "agent" ? "agent" : "demo",
      steps,
      artifacts: [],
      refs: [],
      created_at: d.created_at,
    };
  } catch {
    return null;
  }
}

function normalizeStepStatus(s?: string): AgentStep["status"] {
  return s === "done" || s === "failed" || s === "waiting" || s === "running" || s === "pending"
    ? (s as AgentStep["status"])
    : "pending";
}

function normalizeTaskStatus(s?: string): AgentTask["status"] {
  return s === "done" || s === "failed" || s === "running" || s === "paused" ? (s as AgentTask["status"]) : "planned";
}

export default function Agent() {
  const { s } = useSettings();
  const cfg: AIConfig | null = useMemo(() => {
    if (!s.loaded) return null;
    if (!s.ai.baseUrl.trim() || !s.ai.apiKey.trim()) return null;
    return { baseUrl: s.ai.baseUrl, apiKey: s.ai.apiKey, model: s.ai.model };
  }, [s]);

  const { refresh: refreshDocs, docs } = useDocuments();

  const [kind, setKind] = useState<TaskKind>("review");
  const [context, setContext] = useState("");
  const [mode, setMode] = useState<"idle" | "planned" | "agent" | "demo">("idle");
  const [task, setTask] = useState<AgentTask | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planJSON, setPlanJSON] = useState("");
  const [editPlan, setEditPlan] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [lastDocPath, setLastDocPath] = useState<string | null>(null);

  const taskRef = useRef<AgentTask | null>(null);
  const runToken = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const runner = useMemo(() => makeRunner(), []);

  const pushLog = (line: Omit<LogLine, "ts">) => {
    setLog((prev) => [...prev.slice(-200), { ...line, ts: Date.now() }]);
  };

  const syncState = () => {
    if (!taskRef.current) return;
    setTask({ ...taskRef.current, steps: [...taskRef.current.steps] });
  };

  const selectedKind = TASK_KINDS.find((k) => k.key === kind) ?? TASK_KINDS[0];

  // 切换任务类型时重置
  const changeKind = (k: TaskKind) => {
    if (busy) return;
    setKind(k);
    resetTask();
  };

  const resetTask = () => {
    runToken.current++;
    abortRef.current?.abort();
    taskRef.current = null;
    setTask(null);
    setLog([]);
    setMode("idle");
    setPlanJSON("");
    setMsg(null);
    setLastDocPath(null);
  };

  /** 生成计划卡 */
  const doPlan = async () => {
    const text = context.trim();
    if (!text) {
      setMsg({ type: "err", text: "请先粘贴/输入要处理的材料。" });
      return;
    }
    setPlanning(true);
    setMsg(null);
    try {
      const plan = await planTask(cfg, kind, text);
      const meta = TASK_KINDS.find((k) => k.key === kind)!;
      const t: AgentTask = {
        kind,
        kindLabel: meta.label,
        title: plan.kindLabel,
        context: text,
        status: "planned",
        mode: plan.mode,
        steps: plan.steps,
        artifacts: [],
        refs: [],
        created_at: new Date().toISOString(),
      };
      taskRef.current = t;
      setPlanJSON(JSON.stringify(serializePlan(t.steps), null, 2));
      setMode(plan.mode === "demo" ? "demo" : "planned");
      pushLog({
        level: "info",
        text:
          plan.mode === "demo"
            ? "未配置模型 → 演示模式：使用预设流水线，工具步骤真实执行"
            : "模型已规划任务步骤",
      });
      setTask({ ...t, steps: [...t.steps] });
      // 桌面端落库（P1 状态机）
      await persistTask(t);
      saveLocalLastTask(t);
      void loadHistory();
    } catch (e) {
      setMsg({ type: "err", text: `规划失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setPlanning(false);
    }
  };

  /** 使用编辑后的计划 JSON */
  const applyEditedPlan = () => {
    if (!taskRef.current) return;
    try {
      const parsed = JSON.parse(planJSON);
      const arr = Array.isArray(parsed) ? parsed : parsed?.steps;
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("计划为空");
      taskRef.current.steps = arr.map(
        (s: any, i: number): AgentStep => ({
          seq: i,
          name: String(s?.name ?? "步骤"),
          tool: s?.tool || undefined,
          role: s?.role || undefined,
          params: s?.params ?? undefined,
          need_confirm: !!s?.need_confirm,
          prompt: s?.prompt || undefined,
          status: "pending",
        }),
      );
      void persistTask(taskRef.current);
      syncState();
      pushLog({ level: "info", text: "已按编辑后的计划更新步骤" });
    } catch (e) {
      setMsg({ type: "err", text: `计划 JSON 解析失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const serializePlan = (steps: AgentStep[]) =>
    steps.map((s) => ({
      name: s.name,
      tool: s.tool,
      role: s.role,
      params: s.params,
      need_confirm: s.need_confirm,
      prompt: s.prompt,
    }));

  const persistTask = async (t: AgentTask) => {
    if (!isTauri()) return;
    try {
      if (t.id == null) {
        const id = await callRust<number>("task_create", {
          kind: t.kind,
          title: t.title,
          context: t.context,
          planJson: JSON.stringify(serializePlan(t.steps)),
        });
        t.id = id ?? undefined;
      }
      if (t.id != null) {
        const ids = (await callRust<number[]>("task_steps_save", {
          taskId: t.id,
          steps: serializePlan(t.steps),
        })) ?? [];
        t.steps.forEach((st, i) => {
          if (ids[i] != null) st.id = ids[i];
        });
      }
      await setStatus(t, "planned");
    } catch (e) {
      console.warn("[agent] 任务落库失败（浏览器/桌面异常，不影响执行）:", e);
    }
  };

  const setStatus = async (t: AgentTask, status: AgentTask["status"]) => {
    t.status = status;
    if (isTauri() && t.id != null) {
      await callRust<void>("task_set_status", { id: t.id, status });
    }
  };

  const syncStepStatus = async (st: AgentStep) => {
    if (isTauri() && st.id != null) {
      await callRust<void>("task_step_update", {
        stepId: st.id,
        status: st.status,
        resultRef: st.result_ref ?? null,
      });
    }
  };

  /** 顺序执行全部步骤（每步一停，支持人工放行/失败即停） */
  const runAll = async () => {
    const t = taskRef.current;
    if (!t || busy) return;
    const token = ++runToken.current;
    abortRef.current = new AbortController();
    setBusy(true);
    await setStatus(t, "running");
    pushLog({ level: "info", text: "任务开始执行…" });

    for (const st of t.steps) {
      if (token !== runToken.current) break;
      if (st.status === "done" || st.status === "failed") continue;
      if (st.status === "waiting") {
        // 人工确认闸门：暂停，等用户点「继续」
        setBusy(false);
        await setStatus(t, "paused");
        pushLog({ level: "gate", text: `等待人工确认：${st.name}` });
        syncState();
        return;
      }
      if (st.status === "pending") {
        pushLog({ level: "info", text: `▶ ${st.name}${st.tool ? `（工具：${st.tool}）` : ""}` });
        syncState();
        await executeStep(
          cfg,
          t,
          st,
          runner,
          (e) => {
            if (e.kind === "tool_result") {
              pushLog({
                level: "tool",
                text: `工具返回：${(e.text ?? "").slice(0, 600)}${(e.text ?? "").length > 600 ? "…" : ""}`,
              });
            } else if (e.kind === "reasoning") {
              pushLog({
                level: "reason",
                text: `${st.name} 结论：${(e.text ?? "").slice(0, 500)}${(e.text ?? "").length > 500 ? "…" : ""}`,
              });
            } else if (e.kind === "error") {
              pushLog({ level: "error", text: e.text ?? "步骤失败" });
            } else if (e.kind === "gate") {
              pushLog({ level: "gate", text: `等待人工确认：${st.name}` });
            }
            syncState();
          },
          abortRef.current!.signal,
        );
        await syncStepStatus(st);
        syncState();
      }
      // executeStep 通过 Object.assign 原地变更 st.status，类型系统无法追踪，需重新收窄
      const st2 = st as AgentStep;
      if (st2.status === "failed") {
        pushLog({ level: "error", text: `步骤失败：${st.name}` });
        await setStatus(t, "failed");
        setBusy(false);
        return;
      }
      if (st2.status === "waiting") {
        setBusy(false);
        await setStatus(t, "paused");
        syncState();
        return;
      }
    }

    const hasPending = t.steps.some((s) => s.status === "pending");
    if (!hasPending) {
      const hasFail = t.steps.some((s) => s.status === "failed");
      await setStatus(t, hasFail ? "failed" : "done");
      if (!hasFail) {
        pushLog({ level: "info", text: "任务完成，已生成交付物草稿（下方预览可编辑导出）" });
        void rememberTask(cfg, t);
      }
    }
    setBusy(false);
    syncState();
  };

  /** 从人工确认闸门继续 */
  const resumeFromGate = async () => {
    const t = taskRef.current;
    if (!t || busy) return;
    const st = t.steps.find((x) => x.status === "waiting");
    if (st) {
      st.status = "pending";
      await syncStepStatus(st);
    }
    await runAll();
  };

  const stopRun = async () => {
    runToken.current++;
    abortRef.current?.abort();
    setBusy(false);
    const t = taskRef.current;
    if (t) await setStatus(t, "paused");
  };

  /** 交付：导出 .docx（桌面）/ .md 下载（浏览器），并落"最近文书" */
  const doDeliver = async () => {
    const t = taskRef.current;
    if (!t) return;
    setDelivering(true);
    try {
      const r = await deliverTask(t);
      setMsg({ type: r.ok ? "ok" : "err", text: r.msg });
      if (r.path) setLastDocPath(r.path);
      if (r.ok) {
        pushLog({ level: "info", text: r.msg });
        await refreshDocs();
      }
    } finally {
      setDelivering(false);
    }
  };

  const handleOpenDoc = async () => {
    if (!lastDocPath) return;
    const err = await openPathFile(lastDocPath);
    if (err) setMsg({ type: "err", text: `打开失败：${err}` });
  };
  const handleRevealDoc = async () => {
    if (!lastDocPath) return;
    const err = await revealPath(lastDocPath);
    if (err) setMsg({ type: "err", text: `定位失败：${err}` });
  };

  const setEditableStepParam = (idx: number, key: string, value: string) => {
    const t = taskRef.current;
    if (!t) return;
    const st = t.steps[idx];
    if (!st) return;
    st.params = { ...(st.params ?? {}), [key]: value };
    syncState();
  };

  /** 刷新任务历史（桌面：tasks 表；浏览器：最近任务快照） */
  const loadHistory = async () => {
    try {
      if (isTauri()) {
        const rows =
          (await callRust<
            Array<{ id: number; kind: string; title: string; status: string; updated_at: string }>
          >("task_list")) ?? [];
        const meta = (k: string) => TASK_KINDS.find((x) => x.key === k)?.label ?? k;
        setHistory(
          rows.slice(0, 10).map((r) => ({
            id: r.id,
            kind: r.kind,
            kindLabel: meta(r.kind),
            title: r.title,
            status: r.status,
            updated_at: r.updated_at,
          })),
        );
      } else {
        const last = loadLocalLastTask();
        setHistory(
          last
            ? [
                {
                  kind: last.kind,
                  kindLabel: last.kindLabel,
                  title: last.title,
                  status: last.status,
                  updated_at: last.created_at ?? "",
                  local: true,
                },
              ]
            : [],
        );
      }
    } catch (e) {
      console.warn("[agent] 读取任务历史失败:", e);
    }
  };

  /** 载入历史任务（可续跑 / 查看结果） */
  const openHistoryItem = async (hi: HistoryItem) => {
    if (busy || planning) return;
    try {
      let t: AgentTask | null = null;
      if (hi.local || !isTauri()) {
        t = loadLocalLastTask();
      } else if (hi.id != null) {
        const d = await callRust<{
          task?: {
            id: number;
            kind: string;
            title: string;
            status: string;
            context?: string | null;
            created_at?: string | null;
          };
          steps?: Array<{
            id: number;
            seq: number;
            name: string;
            tool?: string | null;
            params_json?: string | null;
            status: string;
            result_ref?: string | null;
            need_confirm: boolean;
            started_at?: string | null;
            updated_at?: string | null;
          }>;
          artifacts?: Array<{ id: number; kind: string; file_path?: string | null; title?: string | null; content?: string | null; created_at?: string | null }>;
        }>("task_get", { id: hi.id });
        if (d?.task) {
          const meta = TASK_KINDS.find((x) => x.key === d.task!.kind) ?? TASK_KINDS[0];
          const kindV = (["review", "lawsuit", "cross_exam"].includes(d.task.kind)
            ? d.task.kind
            : "review") as TaskKind;
          t = {
            id: d.task.id,
            kind: kindV,
            kindLabel: meta.label,
            title: d.task.title || meta.label,
            context: d.task.context ?? "",
            status: normalizeTaskStatus(d.task.status),
            mode: cfg ? "agent" : "demo",
            steps: (d.steps ?? []).map((s, i) => {
              let params: Record<string, unknown> | undefined;
              if (s.params_json) {
                try {
                  params = JSON.parse(s.params_json) as Record<string, unknown>;
                } catch {
                  params = undefined;
                }
              }
              return {
                id: s.id,
                seq: s.seq ?? i,
                name: s.name,
                tool: s.tool ?? undefined,
                params,
                need_confirm: !!s.need_confirm,
                status: normalizeStepStatus(s.status),
                result_ref: s.result_ref ?? undefined,
                started_at: s.started_at ?? undefined,
                updated_at: s.updated_at ?? undefined,
              };
            }),
            artifacts: (d.artifacts ?? []).map((a) => ({
              id: a.id,
              kind: a.kind,
              file_path: a.file_path ?? undefined,
              title: a.title ?? undefined,
              content: a.content ?? undefined,
              created_at: a.created_at ?? undefined,
            })),
            refs: [],
            created_at: d.task.created_at ?? undefined,
          };
        }
      }
      if (!t) {
        setMsg({ type: "err", text: "无法载入该任务。" });
        return;
      }
      runToken.current++;
      abortRef.current?.abort();
      taskRef.current = t;
      setKind(t.kind);
      setContext(t.context);
      setPlanJSON(JSON.stringify(serializePlan(t.steps), null, 2));
      setLog([]);
      setMode(t.mode === "demo" ? "demo" : "planned");
      pushLog({
        level: "info",
        text: `已载入历史任务：${t.title}（${t.steps.filter((s) => s.status === "done").length}/${t.steps.length} 步已完成，可续跑）`,
      });
      setMsg(null);
      syncState();
    } catch (e) {
      setMsg({ type: "err", text: `载入失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  /** 删除历史任务 */
  const removeHistoryItem = async (hi: HistoryItem) => {
    try {
      if (hi.local || !isTauri()) {
        localStorage.removeItem(LS_LAST_TASK);
      } else if (hi.id != null) {
        await callRust<void>("task_delete", { id: hi.id });
      }
      setHistory((prev) => prev.filter((x) => x.id !== hi.id));
      if (taskRef.current?.id === hi.id) resetTask();
    } catch (e) {
      setMsg({ type: "err", text: `删除失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const deliverPreview = task ? composeDeliverable(task) : "";
  const refs = useMemo(() => {
    const map = new Map<number, LawRef>();
    for (const r of task?.refs ?? []) map.set(r.id, r);
    return [...map.values()];
  }, [task]);

  // 首页最近文书与智能体文档联动提示 + 任务历史
  useEffect(() => {
    void refreshDocs();
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 悬浮球划词 → 任务材料入口（桌面端）：把推送文字预填到任务输入
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await onBallPush((p) => {
        const q = p.text?.trim();
        if (!q) return;
        setContext((prev) => (prev ? prev + "\n" + q : q));
        setMsg({ type: "ok", text: "已从悬浮球接收选中文字到任务材料（可点击「制定计划」）" });
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // AI 问答 → 文书智能体 交接：读取转交数据并预填任务材料
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_AGENT_HANDOFF);
      if (!raw) return;
      const d = JSON.parse(raw) as { kind?: string; text?: string; ts?: number };
      localStorage.removeItem(LS_AGENT_HANDOFF);
      if (!d.text || !d.text.trim()) return;
      if (d.kind === "review" || d.kind === "lawsuit" || d.kind === "cross_exam") {
        setKind(d.kind);
      }
      setContext(d.text.trim());
      setMsg({
        type: "ok",
        text: "已从「AI 问答」接收转交内容（可增补材料后点击「制定计划」生成交付文书）",
      });
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="agent-page">
      {/* 顶部：任务类型 + 计划/执行按钮 */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>文书智能体 · 法律任务交付</h3>
        <p className="muted hint" style={{ marginTop: 0 }}>
          定位：<b>端到端任务交付</b>（委托 → 计划卡 → 调用本地法库工具 → 交付 .docx）。
          与「AI 问答」互补：问答给即时分析与建议，这里把委托做成可溯源、可验收的文书成果。模型配置见「数据设置」；未配置时为演示模式（工具仍真实执行）。
        </p>
        <div className="mode-chips">
          {TASK_KINDS.map((k) => (
            <button
              key={k.key}
              className={`chip ${kind === k.key ? "chip-active" : ""}`}
              onClick={() => changeKind(k.key)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <label className="wide">
            <span>任务材料（粘贴合同 / 案情 / 证据说明）</span>
            <textarea
              className="form-textarea"
              rows={5}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={selectedKind.hint}
            />
          </label>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="ghost-btn" onClick={() => setContext(SAMPLE_CONTRACT)} disabled={busy}>
            填入示例合同
          </button>
          {!task || task.steps.length === 0 ? (
            <button className="primary" onClick={() => void doPlan()} disabled={planning || busy || !context.trim()}>
              {planning ? "规划中…" : "① 制定计划"}
            </button>
          ) : (
            <>
              <button className="primary" onClick={() => void runAll()} disabled={busy || planning}>
                {busy ? "执行中…" : "② 开始执行"}
              </button>
              {task?.status === "paused" && task.steps.some((s) => s.status === "waiting") && (
                <button className="primary" onClick={() => void resumeFromGate()}>
                  继续（人工确认通过）
                </button>
              )}
              <button className="ghost-btn" onClick={() => void stopRun()} disabled={!busy}>
                暂停
              </button>
              <button className="ghost-btn" onClick={() => resetTask()} disabled={busy}>
                重置
              </button>
            </>
          )}
        </div>
        {mode !== "idle" && (
          <p className="muted hint" style={{ marginBottom: 0 }}>
            当前任务：{task?.kindLabel ?? ""} ｜ 模式：
            {task?.mode === "demo" ? "演示模式（未配置模型）" : "模型驱动"} ｜ 状态：
            {statusLabel(task?.status ?? "planned")}
            {cfg && <span> ｜ 已接入模型接口</span>}
          </p>
        )}
      </div>

      {/* 任务历史（P1：可载入续跑 / 查看结果） */}
      {history.length > 0 && (
        <div className="card">
          <div className="panel-head">
            <h3 style={{ margin: 0 }}>任务历史（{history.length}）</h3>
            <span className="muted hint">
              {isTauri() ? "已落 SQLite · 重启后可恢复续跑" : "浏览器仅保留最近一次任务"}
            </span>
          </div>
          <div className="agent-history">
            {history.map((hi, i) => (
              <div key={hi.id ?? `local-${i}`} className="agent-history-row">
                <button
                  className="ghost-btn"
                  disabled={busy || planning}
                  onClick={() => void openHistoryItem(hi)}
                  title={`${hi.kindLabel} · 更新于 ${fmtDateTime(hi.updated_at)}`}
                >
                  {statusEmoji(hi.status)} {hi.kindLabel}：{hi.title}（{statusLabel(hi.status)}）
                </button>
                <button
                  className="danger-btn"
                  disabled={busy}
                  title="删除该任务记录"
                  onClick={() => void removeHistoryItem(hi)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 计划卡 */}
      {task && task.steps.length > 0 && (
        <div className="card">
          <div className="panel-head">
            <h3 style={{ margin: 0 }}>计划卡（{task.steps.length} 步）</h3>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="ghost-btn"
                onClick={() => setEditPlan((v) => !v)}
                disabled={busy || task.status === "running"}
              >
                {editPlan ? "收起编辑" : "编辑计划"}
              </button>
            </div>
          </div>

          {/* 多智能体/工具接力链可视化（P3） */}
          <div className="agent-relay" title="按执行顺序展示各角色/工具的接力过程">
            {task.steps.map((st, i) => (
              <span key={`${st.seq}-${i}`} className="relay-node">
                {i > 0 && <span className="relay-arrow">→</span>}
                <span className={`relay-chip ${st.status}`}>
                  {stepActor(st)} {statusEmoji(st.status)}
                </span>
              </span>
            ))}
          </div>

          {editPlan && (
            <div style={{ margin: "10px 0" }}>
              <textarea
                className="form-textarea"
                rows={10}
                value={planJSON}
                onChange={(e) => setPlanJSON(e.target.value)}
                style={{ fontFamily: "Consolas,monospace", fontSize: 12 }}
              />
              <button className="ghost-btn" onClick={applyEditedPlan} disabled={busy}>
                应用修改后的计划
              </button>
            </div>
          )}

          <ol className="agent-steps">
            {task.steps.map((st, i) => (
              <li key={`${st.seq}-${i}`} className={`agent-step ${st.status}`}>
                <div className="agent-step-head">
                  <span className="agent-step-name">
                    {st.status === "done" ? "✅" : st.status === "failed" ? "❌" : st.status === "running" ? "⏳" : st.status === "waiting" ? "✋" : "○"}{" "}
                    {st.name}
                  </span>
                  {st.tool && <span className="tag tag-warn">{st.tool}</span>}
                  {st.role && ROLE_LABELS[st.role] && (
                    <span className="tag tag-role">{ROLE_LABELS[st.role]}</span>
                  )}
                  {st.need_confirm && <span className="tag">需人工确认</span>}
                  <span className={`chip ${st.status}`}>{st.status}</span>
                </div>
                {st.tool === "laws_search" && st.status !== "running" && task.status !== "done" && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                    <input
                      className="search-input"
                      style={{ flex: 1, minWidth: 0 }}
                      value={String((st.params?.keyword as string) ?? "")}
                      onChange={(e) => setEditableStepParam(i, "keyword", e.target.value)}
                      placeholder="检索关键词（如：第五百零二条 / 遺留分 / trademark）"
                    />
                    <select
                      value={String((st.params?.country as string) ?? "中国")}
                      onChange={(e) => setEditableStepParam(i, "country", e.target.value)}
                      style={{ minWidth: 96 }}
                    >
                      <option value="中国">🇨🇳 中国</option>
                      <option value="日本">🇯🇵 日本</option>
                      <option value="美国">🇺🇸 美国</option>
                      <option value="全部国家">🌐 全部</option>
                    </select>
                  </div>
                )}
                {st.result_ref && (
                  <pre className="agent-step-ref">{st.result_ref.slice(0, 900)}</pre>
                )}
              </li>
            ))}
          </ol>

          {refs.length > 0 && (
            <div className="muted hint" style={{ marginTop: 8 }}>
              📚 本次引用法条（{refs.length} 条，可溯源）：{" "}
              {refs.map((r) => `${r.title}${r.article_no ? " " + r.article_no : ""}`).join("；")}
            </div>
          )}
        </div>
      )}

      {/* 执行日志 */}
      {log.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>执行日志</h3>
          <div className="agent-log">
            {log.map((l, i) => (
              <div key={i} className={`agent-log-line ${l.level}`}>
                <span className="muted">{fmtTime(l.ts)}</span> {l.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 交付物预览与导出 */}
      {deliverPreview && (
        <div className="card">
          <div className="panel-head">
            <h3 style={{ margin: 0 }}>交付物预览</h3>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="primary small"
                onClick={() => void doDeliver()}
                disabled={delivering || task?.status !== "done"}
                title={task?.status !== "done" ? "任务完成后可导出" : "导出 .docx 并存入最近文书"}
              >
                {delivering ? "导出中…" : isTauri() ? "导出 .docx" : "下载 .md"}
              </button>
              <button className="ghost-btn" onClick={() => void refreshDocs()}>
                刷新最近文书（{docs.length}）
              </button>
              {lastDocPath && (
                <>
                  <button className="ghost-btn" onClick={() => void handleOpenDoc()}>
                    打开文件
                  </button>
                  <button className="ghost-btn" onClick={() => void handleRevealDoc()}>
                    在文件夹中显示
                  </button>
                </>
              )}
            </div>
          </div>
          <p className="muted hint">桌面版导出为可打开的 .docx 并记入首页「最近文书」；浏览器预览下载 .md。</p>
          <pre className="agent-deliverable">{deliverPreview}</pre>
        </div>
      )}

      {msg && (
        <div className={`settings-msg ${msg.type}`} onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}

      {!cfg && mode !== "demo" && (
        <p className="muted hint">
          尚未配置 AI 接口：将进入演示模式。前往 <Link to="/settings">数据设置</Link> 填写 base_url 与 Key 后可获得自主规划/推理能力。
        </p>
      )}
    </div>
  );
}

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    planned: "已计划",
    running: "执行中",
    paused: "已暂停",
    done: "已完成",
    failed: "失败",
  };
  return map[s] ?? s;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusEmoji(s: string): string {
  const map: Record<string, string> = {
    planned: "○",
    running: "⏳",
    paused: "⏸",
    done: "✅",
    failed: "❌",
  };
  return map[s] ?? "○";
}

/** 步骤的"执行者"标签：有角色显示角色名（规划/检索员/起草员/质检员），否则显示工具或"推理" */
function stepActor(st: AgentStep): string {
  if (st.role && ROLE_LABELS[st.role]) return ROLE_LABELS[st.role];
  if (st.tool) return st.tool;
  return "推理";
}
