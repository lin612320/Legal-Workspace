import { useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import {
  KG_CANDIDATE_CONFIDENCE,
  type KgEdge,
  type KgNode,
  type KgNodeType,
  type KnowledgeGraphProps,
} from "../lib/kgTypes";
import "./KnowledgeGraph.css";

/* ============================ 常量与查表 ============================ */

/** 分层顺序：案由 → 构成要件 → 争点 → 法条 / 证据 → 文书结构 */
const LAYER_COUNT = 5;
const LAYER_TITLE = ["案由", "构成要件", "争点", "法条 / 证据", "文书结构"];

const LAYER_OF: Record<KgNodeType, number> = {
  case: 0,
  element: 1,
  issue: 2,
  law: 3,
  evidence: 3,
  doc: 4,
};

const TYPE_LABEL: Record<KgNodeType, string> = {
  case: "案由",
  element: "构成要件",
  issue: "争点",
  law: "法条",
  evidence: "证据种类",
  doc: "文书结构",
};

/** 类型色统一走 KnowledgeGraph.css 里的 --kg-* 变量，深浅主题各自可读 */
const TYPE_COLOR: Record<KgNodeType, string> = {
  case: "var(--kg-case)",
  element: "var(--kg-element)",
  issue: "var(--kg-issue)",
  law: "var(--kg-law)",
  evidence: "var(--kg-evidence)",
  doc: "var(--kg-doc)",
};

const LEGEND_ORDER: KgNodeType[] = ["case", "element", "issue", "law", "evidence", "doc"];

const PAD_X = 16;
const PAD_TOP = 42;
const PAD_BOTTOM = 18;
const NODE_RX = 8;
const MAX_NODE_W = 200;
const MIN_NODE_W = 48;
const MAX_NODE_H = 36;
const MIN_NODE_H = 18;
/** 边起点离开节点边框的间距 */
const EDGE_GAP_START = 2;
/** 边终点相对节点边框的内缩量，给箭头留出落点 */
const EDGE_GAP_END = 5;
/** 置信度低于该值时进一步降低透明度 */
const LOW_CONF = 0.5;
/** 尚未量到容器宽度时的回退画布宽度（浏览器首帧不绘制，仅 SSR / 隐藏容器时兜底） */
const FALLBACK_WIDTH = 720;

/** 非浏览器环境退化为 useEffect，避免 SSR 警告 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/* ============================ 小工具 ============================ */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function layerOf(t: KgNodeType): number {
  const v = LAYER_OF[t];
  return typeof v === "number" ? v : LAYER_COUNT - 1;
}

function typeLabel(t: KgNodeType): string {
  const v = TYPE_LABEL[t];
  return typeof v === "string" ? v : String(t);
}

function typeColor(t: KgNodeType): string {
  const v = TYPE_COLOR[t];
  return typeof v === "string" ? v : "var(--kg-doc)";
}

function confText(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "—";
}

/** 线宽随 weight 变化，统一落在 1~3px */
function edgeWidth(weight: number): number {
  if (!Number.isFinite(weight)) return 1.4;
  return weight > 1 ? clamp(weight, 1, 3) : 1 + 2 * clamp(weight, 0, 1);
}

/** 中日韩字符按 1 个字宽估算，其余按 0.55 */
function charWidth(ch: string, fontSize: number): number {
  return /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fontSize : fontSize * 0.55;
}

function textWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch, fontSize);
  return w;
}

/** SVG 没有 text-overflow，按估算宽度截断并补省略号（全称交给 <title>） */
function fitText(s: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return "";
  if (textWidth(s, fontSize) <= maxWidth) return s;
  const ellipsisW = fontSize * 0.8;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch, fontSize);
    if (w + cw > maxWidth - ellipsisW) break;
    out += ch;
    w += cw;
  }
  return out ? `${out}…` : "…";
}

/** 三次贝塞尔 t=0.5 处的点，用于候选边操作按钮落点 */
function bezierMid(
  p0x: number,
  p0y: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  p3x: number,
  p3y: number,
): { x: number; y: number } {
  const a = 0.125;
  const b = 0.375;
  return {
    x: a * p0x + b * c1x + b * c2x + a * p3x,
    y: a * p0y + b * c1y + b * c2y + a * p3y,
  };
}

/* ============================ 布局结果类型 ============================ */

interface PlacedNode {
  node: KgNode;
  x: number;
  y: number;
}

interface PlacedEdge {
  edge: KgEdge;
  d: string;
  mid: { x: number; y: number };
}

interface Layout {
  items: PlacedNode[];
  links: PlacedEdge[];
  /** 非空层的标题（x 为该层中心横坐标） */
  titles: Array<{ x: number; label: string }>;
  nodeW: number;
  nodeH: number;
}

/* ============================ 组件 ============================ */

export default function KnowledgeGraph({
  nodes,
  edges,
  focusId = null,
  onConfirmEdge,
  onRejectEdge,
  height = 420,
  title = "知识图谱",
}: KnowledgeGraphProps) {
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");

  /* ---------- 容器宽度：首次在绘制前量取，之后交给 ResizeObserver ---------- */
  useIsomorphicLayoutEffect(() => {
    if (canvasEl) setWidth(canvasEl.clientWidth);
  }, [canvasEl]);

  useEffect(() => {
    if (!canvasEl) return;
    const apply = () => setWidth(canvasEl.clientWidth);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(apply);
      ro.observe(canvasEl);
    }
    window.addEventListener("resize", apply);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [canvasEl]);

  /* ---------- 数据变更时丢弃失效的选中态 ---------- */
  useEffect(() => {
    if (selectedId != null && !nodes.some((n) => n.id === selectedId)) setSelectedId(null);
    if (hoverId != null && !nodes.some((n) => n.id === hoverId)) setHoverId(null);
  }, [nodes, selectedId, hoverId]);

  /* ---------- 邻接表（hover 高亮用） ---------- */
  const neighbors = useMemo(() => {
    const map = new Map<number, Set<number>>();
    const add = (a: number, b: number) => {
      let set = map.get(a);
      if (!set) {
        set = new Set<number>();
        map.set(a, set);
      }
      set.add(b);
    };
    for (const e of edges) {
      add(e.src, e.dst);
      add(e.dst, e.src);
    }
    return map;
  }, [edges]);

  /* ---------- 分层布局：x 由容器宽度算出，同层按 id 升序纵向均分 ---------- */
  const drawWidth = width > 0 ? width : FALLBACK_WIDTH;

  const layout = useMemo<Layout>(() => {
    const avail = Math.max(160, drawWidth - PAD_X * 2);
    // 解 nodeW ≈ 0.78 * 层间步长，保证节点宽度随容器宽度自适应且互不重叠
    const nodeW = clamp((0.78 * avail) / (LAYER_COUNT - 1 + 0.78), MIN_NODE_W, MAX_NODE_W);
    const left = PAD_X + nodeW / 2;
    const right = Math.max(left, drawWidth - PAD_X - nodeW / 2);
    const colStep = (right - left) / (LAYER_COUNT - 1);
    const usableH = Math.max(80, height - PAD_TOP - PAD_BOTTOM);

    const byLayer: KgNode[][] = Array.from({ length: LAYER_COUNT }, () => []);
    for (const n of nodes) byLayer[layerOf(n.type)].push(n);
    for (const arr of byLayer) arr.sort((a, b) => a.id - b.id);

    // 节点高度取所有层里最挤的一层，保持全局一致
    let nodeH = MAX_NODE_H;
    for (const arr of byLayer) {
      if (arr.length === 0) continue;
      nodeH = Math.min(nodeH, clamp(usableH / arr.length - 10, MIN_NODE_H, MAX_NODE_H));
    }

    const items: PlacedNode[] = [];
    const titles: Array<{ x: number; label: string }> = [];
    const pos = new Map<number, { x: number; y: number }>();

    for (let li = 0; li < LAYER_COUNT; li++) {
      const arr = byLayer[li];
      if (arr.length === 0) continue;
      const x = left + li * colStep;
      const step = usableH / arr.length;
      titles.push({ x, label: LAYER_TITLE[li] });
      arr.forEach((node, i) => {
        const y = PAD_TOP + step * (i + 0.5);
        items.push({ node, x, y });
        pos.set(node.id, { x, y });
      });
    }

    // 丢弃悬空边（src/dst 不在节点集合里）；候选边后画，压在上层
    const links: PlacedEdge[] = [];
    for (const edge of edges) {
      const a = pos.get(edge.src);
      const b = pos.get(edge.dst);
      if (!a || !b) continue;
      const sx = a.x + nodeW / 2 + EDGE_GAP_START;
      const sy = a.y;
      const tx = b.x - nodeW / 2 - EDGE_GAP_END;
      const ty = b.y;
      const dx = tx - sx;
      // 前进边走平缓 S 形；回退/同层边向外弓出，避免穿过节点
      const bow = dx > 0 ? dx * 0.42 : Math.max(46, Math.abs(dx) * 0.3 + 46);
      const c1x = sx + bow;
      const c2x = tx - bow;
      links.push({
        edge,
        d: `M ${sx} ${sy} C ${c1x} ${sy} ${c2x} ${ty} ${tx} ${ty}`,
        mid: bezierMid(sx, sy, c1x, sy, c2x, ty, tx, ty),
      });
    }
    links.sort((p, q) => Number(q.edge.confirmed) - Number(p.edge.confirmed));

    return { items, links, titles, nodeW, nodeH };
  }, [nodes, edges, drawWidth, height]);

  /* ---------- 详情条数据 ---------- */
  const nodeIndex = useMemo(() => {
    const m = new Map<number, KgNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const selected = selectedId != null ? nodeIndex.get(selectedId) ?? null : null;
  const outEdges = useMemo(
    () => (selectedId == null ? [] : edges.filter((e) => e.src === selectedId)),
    [edges, selectedId],
  );
  const inEdges = useMemo(
    () => (selectedId == null ? [] : edges.filter((e) => e.dst === selectedId)),
    [edges, selectedId],
  );

  const pendingCount = useMemo(() => edges.filter((e) => !e.confirmed).length, [edges]);
  const focusNode = focusId != null ? nodeIndex.get(focusId) ?? null : null;

  const isDimNode = (id: number): boolean =>
    hoverId !== null && hoverId !== id && !neighbors.get(hoverId)?.has(id);

  const nodeFontSize = layout.nodeH >= 28 ? 11.5 : 10.5;
  const twoLine = layout.nodeH >= 28;
  const nameMaxW = twoLine
    ? Math.max(20, layout.nodeW - 30)
    : Math.max(20, layout.nodeW - 56);

  const hasActs = !!(onConfirmEdge || onRejectEdge);

  /* ---------- 空状态 ---------- */
  if (nodes.length === 0) {
    return (
      <section className="card kg">
        <div className="kg-head">
          <h3 className="kg-title">{title}</h3>
          <span className="kg-meta muted">暂无数据</span>
        </div>
        <div className="kg-empty" style={{ height }}>
          <div className="kg-empty-title">暂无知识图谱数据</div>
          <div className="kg-empty-hint">执行任务或选择案由后自动加载</div>
        </div>
      </section>
    );
  }

  return (
    <section className="card kg">
      <div className="kg-head">
        <h3 className="kg-title">{title}</h3>
        <span className="kg-meta muted">
          节点 {nodes.length} · 关系 {edges.length} · 待确认 {pendingCount}
          {focusNode ? ` · 命中案由：${focusNode.name}` : ""}
        </span>
      </div>

      <div className="kg-canvas" ref={setCanvasEl} style={{ height }}>
        <svg
          className="kg-svg"
          width={drawWidth}
          height={height}
          role="group"
          aria-label={`${title}：共 ${nodes.length} 个节点、${edges.length} 条关系，其中 ${pendingCount} 条待人工确认`}
          onClick={() => setSelectedId(null)}
        >
          <defs>
            <marker
              id={`${uid}-edge`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path className="kg-arrow kg-arrow-edge" d="M 0 0 L 10 5 L 0 10 Z" />
            </marker>
            <marker
              id={`${uid}-cand`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path className="kg-arrow kg-arrow-cand" d="M 0 0 L 10 5 L 0 10 Z" />
            </marker>
            <marker
              id={`${uid}-hl`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path className="kg-arrow kg-arrow-hl" d="M 0 0 L 10 5 L 0 10 Z" />
            </marker>
            <marker
              id={`${uid}-dim`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path className="kg-arrow kg-arrow-dim" d="M 0 0 L 10 5 L 0 10 Z" />
            </marker>
          </defs>

          {/* 分层标题 */}
          {layout.titles.map((t) => (
            <text
              key={t.label}
              className="kg-layer-title"
              x={t.x}
              y={PAD_TOP - 18}
              textAnchor="middle"
            >
              {t.label}
            </text>
          ))}

          {/* 边 */}
          {layout.links.map(({ edge, d, mid }, i) => {
            const cand = !edge.confirmed;
            const dim = hoverId !== null && edge.src !== hoverId && edge.dst !== hoverId;
            const active = hoverId !== null && !dim;
            const low = clamp(edge.confidence, 0, 1) < LOW_CONF;
            const baseOp = (cand ? 0.62 : 0.82) * (low ? 0.55 : 1);
            const opacity = dim ? 0.1 : active ? Math.min(1, baseOp + 0.25) : baseOp;
            const marker = dim
              ? `url(#${uid}-dim)`
              : active
                ? `url(#${uid}-hl)`
                : cand
                  ? `url(#${uid}-cand)`
                  : `url(#${uid}-edge)`;
            const showRel =
              active || selectedId === edge.src || selectedId === edge.dst;
            const relY = cand && hasActs ? mid.y - 20 : mid.y - 2;
            return (
              <g
                key={`${edge.id}-${i}`}
                className={`kg-edge${cand ? " kg-edge-cand" : ""}`}
                style={{ opacity }}
              >
                <path
                  className="kg-edge-line"
                  d={d}
                  strokeWidth={edgeWidth(edge.weight)}
                  strokeDasharray={cand ? "6 4" : undefined}
                  markerEnd={marker}
                />
                {showRel && (
                  <text className="kg-edge-rel" x={mid.x} y={relY} textAnchor="middle">
                    {edge.rel}
                  </text>
                )}
                {cand && hasActs && (
                  <g className="kg-edge-acts" transform={`translate(${mid.x} ${mid.y})`}>
                    {onConfirmEdge && (
                      <g
                        className="kg-act"
                        role="button"
                        tabIndex={0}
                        aria-label={`确认候选关系：${edge.rel}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onConfirmEdge(edge.id);
                        }}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            onConfirmEdge(edge.id);
                          }
                        }}
                      >
                        <title>确认该候选关系（人工复核通过）</title>
                        <circle className="kg-act-ok" cx={-12} cy={0} r={9} />
                        <text className="kg-act-text kg-act-ok-text" x={-12} y={0}>
                          ✓
                        </text>
                      </g>
                    )}
                    {onRejectEdge && (
                      <g
                        className="kg-act"
                        role="button"
                        tabIndex={0}
                        aria-label={`拒绝候选关系：${edge.rel}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onRejectEdge(edge.id);
                        }}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            onRejectEdge(edge.id);
                          }
                        }}
                      >
                        <title>拒绝该候选关系（不成立 / 存疑）</title>
                        <circle className="kg-act-no" cx={12} cy={0} r={9} />
                        <text className="kg-act-text kg-act-no-text" x={12} y={0}>
                          ✕
                        </text>
                      </g>
                    )}
                  </g>
                )}
              </g>
            );
          })}

          {/* 节点 */}
          {layout.items.map(({ node, x, y }) => {
            const dim = isDimNode(node.id);
            const isFocus = focusId === node.id;
            const isSel = selectedId === node.id;
            const cls = [
              "kg-node",
              dim ? "kg-node-dim" : "",
              isFocus ? "kg-node-focus" : "",
              isSel ? "kg-node-sel" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const fullTitle = [
              typeLabel(node.type),
              node.name,
              node.name_alt ? `（${node.name_alt}）` : "",
              `置信度 ${confText(node.confidence)}`,
              node.source ? `来源 ${node.source}` : "",
            ]
              .filter(Boolean)
              .join("｜");
            return (
              <g
                key={node.id}
                className={cls}
                transform={`translate(${x} ${y})`}
                tabIndex={0}
                role="button"
                aria-label={`${typeLabel(node.type)}节点：${node.name}，置信度 ${confText(node.confidence)}`}
                onMouseEnter={() => setHoverId(node.id)}
                onMouseLeave={() => setHoverId((h) => (h === node.id ? null : h))}
                onFocus={() => setHoverId(node.id)}
                onBlur={() => setHoverId((h) => (h === node.id ? null : h))}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setSelectedId((s) => (s === node.id ? null : node.id));
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelectedId((s) => (s === node.id ? null : node.id));
                  }
                }}
              >
                <title>{fullTitle}</title>
                <rect
                  className="kg-node-box"
                  x={-layout.nodeW / 2}
                  y={-layout.nodeH / 2}
                  width={layout.nodeW}
                  height={layout.nodeH}
                  rx={NODE_RX}
                  ry={NODE_RX}
                />
                <circle
                  className="kg-node-dot"
                  cx={-layout.nodeW / 2 + 12}
                  cy={0}
                  r={3.5}
                  style={{ fill: typeColor(node.type) }}
                />
                <text
                  className="kg-node-name"
                  x={-layout.nodeW / 2 + 21}
                  y={twoLine ? -6 : 0}
                  textAnchor="start"
                  style={{ fontSize: nodeFontSize }}
                >
                  {fitText(node.name, nameMaxW, nodeFontSize)}
                </text>
                <text
                  className="kg-node-conf"
                  x={layout.nodeW / 2 - 9}
                  y={twoLine ? 9 : 0}
                  textAnchor="end"
                >
                  {confText(node.confidence)}
                </text>
              </g>
            );
          })}
        </svg>

        {/* 右上角图例 */}
        <div className="kg-legend">
          <span className="kg-legend-title">图例</span>
          <div className="kg-legend-grid">
            {LEGEND_ORDER.map((t) => (
              <span key={t} className="kg-legend-item">
                <span className="kg-legend-dot" style={{ background: typeColor(t) }} />
                {typeLabel(t)}
              </span>
            ))}
          </div>
          <span className="kg-legend-item">
            <span className="kg-legend-dash" />
            虚线 = 待人工确认
          </span>
        </div>
      </div>

      {/* 下方信息条 */}
      <div className="kg-detail">
        {!selected ? (
          <p className="kg-detail-hint muted">
            点击节点查看详情；虚线关系为待人工确认的候选边，可直接在图上点 ✓ / ✕ 处理。
          </p>
        ) : (
          <>
            <div className="kg-detail-head">
              <span
                className="kg-legend-dot"
                style={{ background: typeColor(selected.type) }}
                aria-hidden="true"
              />
              <span className="kg-detail-name">{selected.name}</span>
              {selected.name_alt && <span className="kg-detail-alt">（{selected.name_alt}）</span>}
              <span className="tag">{typeLabel(selected.type)}</span>
              <span className="tag">置信度 {confText(selected.confidence)}</span>
              <span className="tag">{selected.source ?? "来源未标注"}</span>
              {focusId === selected.id && <span className="tag tag-warn">当前命中</span>}
              <button
                className="ghost-btn kg-detail-close"
                onClick={() => setSelectedId(null)}
                title="关闭详情"
              >
                关闭
              </button>
            </div>
            {selected.note && <p className="kg-detail-note">{selected.note}</p>}
            <div className="kg-detail-cols">
              <div className="kg-detail-col">
                <h4>出边（{outEdges.length}）</h4>
                {outEdges.length === 0 ? (
                  <span className="muted">无出边</span>
                ) : (
                  <ul className="kg-detail-list">
                    {outEdges.map((e) => (
                      <li key={e.id}>
                        <span className="kg-detail-rel">{e.rel}</span>
                        <span className="kg-detail-arrow">→</span>
                        <span>{nodeIndex.get(e.dst)?.name ?? "未收录节点"}</span>
                        <span className="tag">{confText(e.confidence)}</span>
                        {!e.confirmed && (
                          <span className="tag tag-warn">
                            {e.confidence < KG_CANDIDATE_CONFIDENCE ? "候选边" : "待确认"}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="kg-detail-col">
                <h4>入边（{inEdges.length}）</h4>
                {inEdges.length === 0 ? (
                  <span className="muted">无入边</span>
                ) : (
                  <ul className="kg-detail-list">
                    {inEdges.map((e) => (
                      <li key={e.id}>
                        <span>{nodeIndex.get(e.src)?.name ?? "未收录节点"}</span>
                        <span className="kg-detail-arrow">→</span>
                        <span className="kg-detail-rel">{e.rel}</span>
                        <span className="tag">{confText(e.confidence)}</span>
                        {!e.confirmed && <span className="tag tag-warn">待确认</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
