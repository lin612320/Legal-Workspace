import { useMemo, useState } from "react";
import { Law } from "../data/laws";
import { useLaws } from "../hooks/useLaws";

export default function Laws() {
  const { loading, search, total } = useLaws();
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Law[]>([]);
  const [selected, setSelected] = useState<Law | null>(null);
  const [searching, setSearching] = useState(false);
  const [hint, setHint] = useState("");

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

  const kw = keyword.trim();
  const capHit = results.length >= 500;

  async function run(k = keyword) {
    setKeyword(k);
    const kk = k.trim();
    if (!kk) {
      // 空关键词：不请求后端（避免全量拉取 15 万条）
      setResults([]);
      setSelected(null);
      setHint("");
      return;
    }
    setSearching(true);
    setHint("");
    try {
      const r = await search(kk);
      setResults(r);
      if (r.length === 0) setHint("没有匹配的法规条文，试试更短的关键词（如“契約”“遺留分”“商标”“contract”）。");
      else if (r.length >= 500) setHint("命中较多，仅显示前 500 条，请细化关键词缩小范围。");
      if (r.length === 1) setSelected(r[0]);
    } catch {
      setHint("检索失败，请稍后重试。");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="laws-page">
      {/* 搜索栏 */}
      <div className="card">
        <div className="search-row">
          <input
            className="search-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            placeholder="输入关键词检索篇名 / 条文号 / 正文，如：契約 / 遺留分 / trademark / 合同"
          />
          <button className="primary small" onClick={() => void run()} disabled={searching}>
            {searching ? "检索中…" : "搜索"}
          </button>
        </div>

        <div className="search-badges">
          {kw ? (
            <span className="tag">
              命中 {results.length} 条{capHit ? "（仅前 500，请细化）" : ""}
            </span>
          ) : (
            <span className="tag">
              内置法规 {total > 0 ? total.toLocaleString() : "…"} 条 · 输入关键词开始检索
            </span>
          )}
          {loading && <span className="tag">读取中…</span>}
          {hint && <span className="tag tag-warn">{hint}</span>}
        </div>
      </div>

      <div className="laws-layout">
        {/* 结果列表 */}
        <div className="laws-list">
          {loading ? (
            <p className="muted">加载中…</p>
          ) : grouped.length === 0 ? (
            <div className="card empty">
              {kw
                ? hint || "没有匹配的法规条文。"
                : `已装载 ${total > 0 ? total.toLocaleString() : "—"} 条日美法条文，输入关键词开始检索（如：契約 / 遺留分 / trademark）。`}
            </div>
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
            <div className="law-detail-empty">
              {kw ? "点击左侧任意条文查看正文。" : "搜索后点击左侧条文查看全文。"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
