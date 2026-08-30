import { useEffect, useMemo, useState } from "react";
import { Law } from "../data/laws";
import { useLaws } from "../hooks/useLaws";
import { useSettings } from "../hooks/useSettings";
import { embedTexts, cosine } from "../lib/embed";

const LS_EMB = "workbench:law_embeddings";

function loadEmbedCache(): Record<number, number[]> {
  try {
    return JSON.parse(localStorage.getItem(LS_EMB) || "{}") as Record<number, number[]>;
  } catch {
    return {};
  }
}

export default function Laws() {
  const { loading, search, laws: lawsAll } = useLaws();
  const { s } = useSettings();
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Law[]>([]);
  const [selected, setSelected] = useState<Law | null>(null);
  const [vectorMode, setVectorMode] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexMsg, setIndexMsg] = useState("");
  const [vectors, setVectors] = useState<Record<number, number[]>>(loadEmbedCache);
  const [searching, setSearching] = useState(false);

  const configured = !!(s.ai.baseUrl.trim() && s.ai.apiKey.trim());
  const cfg = useMemo(
    () => ({ baseUrl: s.ai.baseUrl, apiKey: s.ai.apiKey, model: s.ai.model }),
    [s.ai],
  );

  // 按 篇名 分组
  const grouped = useMemo(() => {
    const map = new Map<string, Law[]>();
    for (const l of results) {
      const list = map.get(l.title) ?? [];
      list.push(l);
      map.set(l.title, list);
    }
    return [...map.entries()];
  }, [results]);

  /** 建立向量索引：为全部法规生成 embedding 并缓存 */
  async function buildIndex() {
    if (!configured) {
      setIndexMsg("请先在「数据与设置」配置 AI 接口地址与 Key（需支持 /embeddings）。");
      return;
    }
    if (lawsAll.length === 0) {
      setIndexMsg("法规库为空，先导入或补充法规数据。");
      return;
    }
    setIndexing(true);
    setIndexMsg("正在为法规建立向量索引（首次较慢）…");
    try {
      const texts = lawsAll.map(
        (l) => `${l.title}${l.article_no ? " " + l.article_no : ""} ${l.content}`,
      );
      const embs = await embedTexts(cfg, texts);
      const map: Record<number, number[]> = {};
      lawsAll.forEach((l, i) => {
        map[l.id] = embs[i];
      });
      setVectors(map);
      try {
        localStorage.setItem(LS_EMB, JSON.stringify(map));
      } catch {
        /* ignore */
      }
      setIndexMsg(`已为 ${embs.length} 条法规建立向量索引，可进行语义检索。`);
    } catch (e) {
      setIndexMsg(e instanceof Error ? e.message : "索引失败（接口可能不支持 embeddings）。");
    }
    setIndexing(false);
  }

  /** 向量检索：查询向量与法规向量做余弦相似度，取 Top 10 */
  async function vectorSearch(q: string) {
    if (!configured) {
      setIndexMsg("请先在「数据与设置」配置 AI 接口地址与 Key。");
      return;
    }
    const entries = Object.entries(vectors);
    if (entries.length === 0) {
      setIndexMsg("尚未建立向量索引，请先点击「建立向量索引」。");
      return;
    }
    setSearching(true);
    try {
      const qv = (await embedTexts(cfg, [q]))[0];
      const scored = lawsAll
        .map((l) => ({ l, score: vectors[l.id] != null ? cosine(qv, vectors[l.id]) : -1 }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score);
      setResults(scored.slice(0, 10).map((x) => x.l));
      if (scored.length > 0) setSelected(scored[0].l);
    } catch (e) {
      setIndexMsg(e instanceof Error ? e.message : "向量检索失败。");
    }
    setSearching(false);
  }

  async function run(kw = keyword) {
    setKeyword(kw);
    if (vectorMode) {
      await vectorSearch(kw);
      return;
    }
    const r = await search(kw);
    setResults(r);
    if (r.length === 1) setSelected(r[0]);
  }

  useEffect(() => {
    void run("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const indexedCount = Object.keys(vectors).length;

  return (
    <div className="laws-page">
      {/* 搜索栏 */}
      <div className="card">
        <div className="search-row">
          <div className="mode-chips">
            <button
              className={`chip ${!vectorMode ? "chip-active" : ""}`}
              onClick={() => setVectorMode(false)}
            >
              关键词检索
            </button>
            <button
              className={`chip ${vectorMode ? "chip-active" : ""}`}
              onClick={() => setVectorMode(true)}
              title="基于语义的向量检索（需配置 AI 接口）"
            >
              向量检索
            </button>
          </div>
          <input
            className="search-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            placeholder={
              vectorMode
                ? "输入自然语言，按语义检索最相关的法条，如：合同没按期交货怎么办"
                : "输入关键词，检索篇名 / 条文号 / 章节 / 内容"
            }
          />
          <button className="primary small" onClick={() => void run()} disabled={searching}>
            {searching ? "检索中…" : "搜索"}
          </button>
        </div>

        {/* 向量模式工具条 */}
        {vectorMode && (
          <div className="search-badges">
            <span className="tag">已索引 {indexedCount} 条</span>
            <button className="chip chip-new" onClick={() => void buildIndex()} disabled={indexing}>
              {indexing ? "索引中…" : "建立向量索引"}
            </button>
            {indexMsg && <span className="muted hint">{indexMsg}</span>}
          </div>
        )}

        <div className="search-badges">
          <span className="tag">共 {results.length} 条</span>
          <span className="tag tag-warn">数据源：内置示例 / 待 Excel 导入</span>
        </div>
      </div>

      <div className="laws-layout">
        {/* 结果列表 */}
        <div className="laws-list">
          {loading ? (
            <p className="muted">加载中…</p>
          ) : grouped.length === 0 ? (
            <div className="card empty">没有匹配的法规条文。</div>
          ) : (
            grouped.map(([title, list]) => (
              <div className="card law-group" key={title}>
                <h3 className="law-title">{title}</h3>
                {list.map((l) => (
                  <div
                    key={l.id}
                    className={`law-item ${selected?.id === l.id ? "active" : ""}`}
                    onClick={() => setSelected(l)}
                  >
                    <span className="law-no">{l.article_no}</span>
                    <span className="law-snippet">{l.content.slice(0, 40)}…</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {/* 正文阅读 */}
        <div className="card law-detail">
          {selected ? (
            <>
              <div className="detail-head">
                <h3>{selected.title}</h3>
                {selected.chapter && <span className="tag">{selected.chapter}</span>}
                {selected.article_no && <span className="tag tag-warn">{selected.article_no}</span>}
              </div>
              <p className="law-fulltext">{selected.content}</p>
              {selected.source && <p className="muted hint">来源：{selected.source}</p>}
            </>
          ) : (
            <div className="law-detail-empty">点击左侧任意条文查看正文。</div>
          )}
        </div>
      </div>
    </div>
  );
}
