// 0.7.0·知识图谱数据层：桌面走 Rust 命令（SQLite kg_node / kg_edge）；
// 浏览器预览无本地库，返回 null，由页面给出提示（与整法浏览同策略）。

import { callRust, isTauri } from "./tauri";
import type { KgEdge, KgNode, KgNodeType } from "./kgTypes";

// 节点 / 边 / 类型契约与可视化组件共用同一份定义（kgTypes.ts 为单一来源）
export type { KgEdge, KgNode, KgNodeType } from "./kgTypes";

export interface KgGraph {
  nodes: KgNode[];
  edges: KgEdge[];
}

export interface KgSubGraph extends KgGraph {
  case: string;
  root: number;
}

/** 图谱节点类型的中文名（UI 图例 / 标签用） */
export const KG_TYPE_LABEL: Record<KgNodeType, string> = {
  case: "案由",
  element: "构成要件",
  law: "法条",
  evidence: "证据种类",
  doc: "文书结构",
  issue: "争议焦点",
};

/** 全量图谱（可视化面板） */
export async function loadKg(): Promise<KgGraph | null> {
  if (!isTauri()) return null;
  return callRust<KgGraph>("kg_list");
}

/** 某案由的子图（2 跳内），用于任务规划与高亮 */
export async function queryKg(caseName: string): Promise<KgSubGraph | null> {
  if (!isTauri()) return null;
  return callRust<KgSubGraph>("kg_query", { caseName });
}

/** 按任务材料文本匹配案由（返回案由名） */
export async function findCase(text: string): Promise<string | null> {
  if (!isTauri()) return null;
  return callRust<string | null>("kg_find_case", { text });
}

/** 人工确认 / 拒绝一条候选边（拒绝即删除该边） */
export async function confirmEdge(edgeId: number, confirmed: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  const r = await callRust<void>("kg_confirm_edge", { id: edgeId, confirmed });
  return r !== null;
}

/** 运行期候选边：任务实际检索命中的法条挂到案由下（待人工确认） */
export async function addCandidateEdge(
  caseName: string,
  lawTitle: string,
  taskId?: number,
): Promise<number | null> {
  if (!isTauri()) return null;
  return callRust<number | null>("kg_add_candidate", {
    caseName,
    lawTitle,
    taskId: taskId ?? null,
  });
}

/** 图谱骨架：从子图里抽出「要件 → 法条 / 证据」结构，供规划与起草使用 */
export interface KgElement {
  name: string;
  laws: string[];
  evidences: string[];
}

export interface KgSkeleton {
  case: string;
  elements: KgElement[];
  issues: string[];
  docs: string[];
  /** 图谱里的法条名集合（供引用适用性校验） */
  lawNames: string[];
}

export function skeletonOf(sub: KgSubGraph): KgSkeleton {
  const byId = new Map(sub.nodes.map((n) => [n.id, n]));
  const elements = new Map<number, KgElement>();
  const issues: string[] = [];
  const docs: string[] = [];

  for (const e of sub.edges) {
    const src = byId.get(e.src);
    const dst = byId.get(e.dst);
    if (!src || !dst) continue;
    if (e.rel === "构成要件是" && dst.type === "element") {
      if (!elements.has(dst.id)) {
        elements.set(dst.id, { name: dst.name, laws: [], evidences: [] });
      }
    } else if (e.rel === "请求权基础是" && src.type === "element" && dst.type === "law") {
      elements.get(src.id)?.laws.push(dst.name);
    } else if (e.rel === "证明对象是" && src.type === "element" && dst.type === "evidence") {
      elements.get(src.id)?.evidences.push(dst.name);
    } else if (e.rel === "常见争点是" && dst.type === "issue") {
      issues.push(dst.name);
    } else if (e.rel === "文书载体是" && dst.type === "doc") {
      docs.push(dst.name);
    }
  }

  const lawNames = sub.nodes.filter((n) => n.type === "law").map((n) => n.name);
  return {
    case: sub.case,
    elements: [...elements.values()],
    issues: [...new Set(issues)],
    docs: [...new Set(docs)],
    lawNames: [...new Set(lawNames)],
  };
}

/** 按材料文本加载图谱骨架（桌面版；无命中返回 null） */
export async function loadSkeleton(text: string): Promise<KgSkeleton | null> {
  if (!isTauri()) return null;
  const caseName = await findCase(text);
  if (!caseName) return null;
  const sub = await queryKg(caseName);
  return sub ? skeletonOf(sub) : null;
}

/** 把骨架渲染成注入规划提示的一段文本 */
export function describeSkeleton(sk: KgSkeleton): string {
  const lines: string[] = [`案由：${sk.case}`];
  lines.push("构成要件（须逐一覆盖）：");
  for (const el of sk.elements) {
    const laws = el.laws.length ? `｜请求权基础：${el.laws.join("、")}` : "";
    const evs = el.evidences.length ? `｜证据：${el.evidences.join("、")}` : "";
    lines.push(`- ${el.name}${laws}${evs}`);
  }
  if (sk.issues.length) lines.push(`争议焦点：${sk.issues.join("、")}`);
  if (sk.docs.length) lines.push(`相关文书：${sk.docs.join("、")}`);
  return lines.join("\n");
}
