/**
 * 知识图谱数据契约（前后端共用）
 *
 * 仅描述结构，不做任何请求 / 副作用，保证 <KnowledgeGraph /> 是纯展示组件。
 */

/** 节点类型：案由 / 构成要件 / 争点 / 法条 / 证据种类 / 文书结构 */
export type KgNodeType = "case" | "element" | "law" | "evidence" | "doc" | "issue";

export interface KgNode {
  id: number;
  type: KgNodeType;
  name: string;
  /** 原文名 / 别名 */
  name_alt?: string | null;
  /** 来源（如 e-Gov / govinfo / 人工策展） */
  source?: string | null;
  /** 0~1 */
  confidence: number;
  note?: string | null;
}

export interface KgEdge {
  id: number;
  /** 源节点 id */
  src: number;
  /** 关系名：构成要件是 / 请求权基础是 / 证明对象是 / 常见争点是 / 文书载体是 */
  rel: string;
  /** 目标节点 id */
  dst: number;
  weight: number;
  source?: string | null;
  /** 0~1，<0.8 视为「候选边」 */
  confidence: number;
  /** 是否已人工确认 */
  confirmed: boolean;
}

export interface KnowledgeGraphProps {
  nodes: KgNode[];
  edges: KgEdge[];
  /** 当前任务命中的案由节点，高亮 */
  focusId?: number | null;
  /** 人工确认候选边 */
  onConfirmEdge?: (edgeId: number) => void;
  /** 拒绝候选边 */
  onRejectEdge?: (edgeId: number) => void;
  /** 画布高度，默认 420 */
  height?: number;
  title?: string;
}

/** 候选边阈值：置信度低于此值的关系需要人工复核 */
export const KG_CANDIDATE_CONFIDENCE = 0.8;
