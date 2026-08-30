import { useEffect, useMemo, useState } from "react";
import { Law } from "../data/laws";
import { useLaws } from "../hooks/useLaws";

export default function Laws() {
  const { loading, search } = useLaws();
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Law[]>([]);
  const [selected, setSelected] = useState<Law | null>(null);

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

  async function run(kw = keyword) {
    setKeyword(kw);
    const r = await search(kw);
    setResults(r);
    if (r.length === 1) setSelected(r[0]);
  }

  useEffect(() => {
    void run("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            placeholder="输入关键词，检索篇名 / 条文号 / 章节 / 内容"
          />
          <button className="primary small" onClick={() => void run()}>
            搜索
          </button>
        </div>
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