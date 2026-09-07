// 赛事版·法律浏览页（路由 /law/:title）：
// 顶部元信息（双语法名 / 领域 / 简介），中部条文跳转与译文开关，下方整法条文（默认原文，可复制）。

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { findArticleByNumber } from "../lib/articleJump";
import { LawPage, loadLawPage } from "../lib/lawBrowse";

const FLAGS: Record<string, string> = { 日本: "🇯🇵", 美国: "🇺🇸", 中国: "🇨🇳", 其他: "🏳️" };

export default function LawBrowse() {
  const { title } = useParams<{ title: string }>();
  const navigate = useNavigate();
  const lawTitle = useMemo(() => (title ? decodeURIComponent(title) : ""), [title]);
  const [page, setPage] = useState<LawPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [jump, setJump] = useState("");
  const [jumpMsg, setJumpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [hitId, setHitId] = useState<number | null>(null);
  const [showZh, setShowZh] = useState(false);

  useEffect(() => {
    let alive = true;
    setPage(null);
    setLoading(true);
    setError("");
    setJump("");
    setJumpMsg(null);
    setHitId(null);
    setShowZh(false);
    (async () => {
      if (!lawTitle) {
        setError("缺少法律名称参数。");
        setLoading(false);
        return;
      }
      if (!("__TAURI_INTERNALS__" in window)) {
        setError("浏览器预览模式不提供本地法库，请用桌面版「法元」查看整部法律。");
        setLoading(false);
        return;
      }
      const p = await loadLawPage(lawTitle);
      if (!alive) return;
      if (!p) {
        setError(`未找到法律《${lawTitle}》，或本地法库未装载。`);
      } else {
        setPage(p);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [lawTitle]);

  const hasZh = useMemo(
    () => page?.articles.some((a) => a.content_zh && a.content_zh.trim().length > 0) ?? false,
    [page],
  );

  const primaryTitle = page?.name_zh || page?.title || lawTitle;
  const secondaryTitle =
    page?.name_orig || (page?.name_zh && page?.name_zh !== page?.title ? page?.title : "");
  const jumpPlaceholder =
    page?.country === "美国"
      ? "条文跳转：Article 1 / I / 1.2 / Amendment 5…"
      : "条文跳转：输入 1 / 100 / 百 / 第一百零三条…";

  function jumpTo() {
    if (!page) return;
    const idx = findArticleByNumber(page.articles, jump);
    if (idx < 0) {
      setHitId(null);
      setJumpMsg({ ok: false, text: `未找到与「${jump.trim()}」对应的条文。` });
      return;
    }
    const a = page.articles[idx];
    setHitId(a.id);
    setJumpMsg({ ok: true, text: `已跳转：${a.article_no ?? `第 ${idx + 1} 条`}` });
    requestAnimationFrame(() => {
      document.getElementById(`art-${a.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <div className="law-page">
      {/* 顶部工具条（打印时不显示） */}
      <div className="no-print law-toolbar">
        <button className="ghost small" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <div style={{ flex: 1 }} />
        <button className="ghost small" onClick={() => window.print()} title="打印 / 另存为 PDF">
          🖨 打印 / 另存 PDF
        </button>
      </div>

      {loading && <div className="card empty">正在加载整部法律…</div>}
      {!loading && error && <div className="card empty">{error}</div>}

      {!loading && page && (
        <>
          {/* 元信息 */}
          <div className="card law-meta">
            <div className="detail-head">
              <h2 style={{ margin: 0 }}>
                {FLAGS[page.country] ?? "🏳️"} {primaryTitle}
              </h2>
              {secondaryTitle && (
                <span className="tag" title="原文名">
                  {secondaryTitle}
                </span>
              )}
              {page.domain && <span className="tag">领域：{page.domain}</span>}
              <span className="tag tag-warn">{page.article_count.toLocaleString()} 条</span>
            </div>
            {page.intro && <p className="muted" style={{ fontSize: 13 }}>{page.intro}</p>}
            {hasZh && (
              <label className="zh-toggle">
                <input type="checkbox" checked={showZh} onChange={(e) => setShowZh(e.target.checked)} />
                条文正文有中文译文时显示译文（默认原文）
              </label>
            )}
            {!hasZh && (
              <p className="muted" style={{ fontSize: 12 }}>
                本库暂未收录该法条文中文译文（正文默认为官方原文，可选择复制）。
              </p>
            )}
          </div>

          {/* 条文跳转 */}
          <div className="card no-print law-jump">
            <div className="search-row">
              <input
                className="search-input"
                value={jump}
                onChange={(e) => {
                  setJump(e.target.value);
                  setJumpMsg(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") jumpTo();
                }}
                placeholder={jumpPlaceholder}
              />
              <button className="primary small" onClick={jumpTo}>
                跳转条文
              </button>
            </div>
            <p className="muted hint" style={{ fontSize: 12, marginTop: 6 }}>
              支持阿拉伯数字 / 中文数字（第X条），美国法律支持 Article / Amendment / §（可带小节，如 1.2）。
            </p>
            {jumpMsg && (
              <p className={jumpMsg.ok ? "tag" : "tag tag-warn"}>{jumpMsg.text}</p>
            )}
          </div>

          {/* 全文条文 */}
          <div className="card law-full">
            <h3 style={{ marginTop: 0 }}>完整条文（{page.article_count.toLocaleString()} 条）</h3>
            {page.articles.length === 0 && <div className="empty">该法暂无条文。</div>}
            {page.articles.map((a, i) => {
              const chapterChanged = i === 0 || a.chapter !== page.articles[i - 1].chapter;
              const zh = (a.content_zh ?? "").trim();
              return (
                <div key={a.id}>
                  {chapterChanged && a.chapter && (
                    <h4 className="law-chapter-head">{a.chapter}</h4>
                  )}
                  <div
                    id={`art-${a.id}`}
                    className={`law-article ${hitId === a.id ? "hit" : ""}`}
                    style={{ scrollMarginTop: 12 }}
                  >
                    <div className="detail-head" style={{ marginBottom: 4 }}>
                      <span className="law-art-no">{a.article_no ?? ""}</span>
                      {a.source && <span className="muted hint" style={{ fontSize: 11 }}>{a.source}</span>}
                    </div>
                    <p className="law-fulltext">{a.content}</p>
                    {zh && showZh && <p className="law-fulltext law-zh">{zh}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
