// 赛事版·法规查询页：
// - “按法浏览”模式：选国家 → 国家专属页（政体/法律体系概览 + 法律领域分组列表）→ 点法律名进入整法浏览页
// - “关键词检索”模式：原有跨/单国家关键词检索（中文关键词可命中译名/译文），命中按篇名分组，可一键进入整法浏览

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Law } from "../data/laws";
import { useLaws } from "../hooks/useLaws";
import { lawRoute, LawHome, loadCountryHome } from "../lib/lawBrowse";
import { callRust, isTauri } from "../lib/tauri";

const ALL = "全部国家";
const FLAGS: Record<string, string> = {
  中国: "🇨🇳",
  美国: "🇺🇸",
  日本: "🇯🇵",
  其他: "🏳️",
  [ALL]: "🌐",
};
const ORDER: string[] = [ALL, "日本", "美国", "中国"];
const BROWSE_COUNTRIES = ["日本", "美国", "中国"];
type Mode = "browse" | "search";

interface CountryRow {
  country: string;
  rows: number;
}
interface PreviewRow {
  title: string;
  articles: number;
  title_zh?: string | null;
}

/** 展示双语法名：中文译名优先，原文名作副标题（相同则省略） */
function LawTitleCell({ title, title_zh }: { title: string; title_zh?: string | null }) {
  const zh = title_zh && title_zh.trim() && title_zh.trim() !== title ? title_zh.trim() : "";
  return (
    <span className="law-snippet">
      {zh && <b>{zh}</b>}
      {zh ? <span className="muted" style={{ marginLeft: 6 }}>{title}</span> : title}
    </span>
  );
}

export default function Laws() {
  const { loading: countLoading, search, total } = useLaws();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("browse");

  // —— 按法浏览状态 ——
  const [browseCountry, setBrowseCountry] = useState<string | null>(null);
  const [home, setHome] = useState<LawHome | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeErr, setHomeErr] = useState("");
  const [countries, setCountries] = useState<CountryRow[]>([]);

  // —— 关键词检索状态 ——
  const [country, setCountry] = useState<string>(ALL);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Law[]>([]);
  const [selected, setSelected] = useState<Law | null>(null);
  const [searching, setSearching] = useState(false);
  const [hint, setHint] = useState("");

  const kw = keyword.trim();
  const capHit = results.length >= 500;
  const grouped = useMemo(() => {
    const map = new Map<string, Law[]>();
    for (const l of results) {
      const list = map.get(l.title) ?? [];
      list.push(l);
      map.set(l.title, list);
    }
    return [...map.entries()];
  }, [results]);

  const openLaw = useCallback((t: string) => navigate(lawRoute(t)), [navigate]);

  // 初始：读取国家统计（搜索下拉 + 浏览国家条数）
  useEffect(() => {
    let alive = true;
    (async () => {
      if (isTauri()) {
        const rows = (await callRust<CountryRow[]>("laws_countries")) ?? [];
        if (alive) setCountries(rows);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const loadPreview = useCallback(async (c: string) => {
    if (!isTauri()) {
      setPreview([]);
      return;
    }
    const cc = c === ALL ? undefined : c;
    const rows = (await callRust<PreviewRow[]>("laws_country_preview", { country: cc })) ?? [];
    setPreview(rows);
  }, []);

  const switchBrowseCountry = useCallback(
    async (c: string) => {
      setBrowseCountry(c);
      setHome(null);
      setHomeErr("");
      setHomeLoading(true);
      if (!isTauri()) {
        setHomeErr("浏览器预览模式不提供本地法库，请用桌面版查看整部法律。");
        setHomeLoading(false);
        return;
      }
      const h = await loadCountryHome(c);
      setHomeLoading(false);
      if (!h) {
        setHomeErr(`加载「${c}」法律目录失败。`);
        return;
      }
      setHome(h);
    },
    [],
  );

  const rowCount = (name: string) => {
    const c = countries.find((x) => x.country === name);
    return c?.rows ?? 0;
  };

  async function run(k = keyword) {
    setKeyword(k);
    const kk = k.trim();
    if (!kk) {
      setResults([]);
      setSelected(null);
      setHint("");
      return;
    }
    setSearching(true);
    setHint("");
    try {
      const r = await search(kk, country);
      setResults(r);
      if (r.length === 0) {
        setHint(
          `在「${country}」没有匹配的条文，试试更短的关键词（如“契約”“遺留分”“商标”“contract”“宪法”“民法典”），或切换国家/全部国家。`,
        );
      } else if (r.length >= 500) {
        setHint("命中较多，仅显示前 500 条，请细化关键词缩小范围。");
      }
      if (r.length === 1) setSelected(r[0]);
    } catch {
      setHint("检索失败，请稍后重试。");
    } finally {
      setSearching(false);
    }
  }

  const byName = new Map(countries.map((x) => [x.country, x]));
  const ordered = [
    ...ORDER.filter((n) => byName.has(n)).map((n) => ({ country: n, rows: byName.get(n)!.rows })),
    ...countries.filter((x) => !ORDER.includes(x.country)),
  ];
  const countryRows = byName.get(country)?.rows ?? 0;

  return (
    <div className="laws-page">
      {/* 顶部：模式切换 + 常用工具 */}
      <div className="card">
        <div className="search-row" style={{ marginBottom: 8 }}>
          {(
            [
              ["browse", "📚 按法浏览"],
              ["search", "🔍 关键词检索"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              className={mode === m ? "primary small" : "ghost small"}
              style={{ marginRight: 8 }}
              onClick={() => {
                setMode(m);
                if (m === "search") void loadPreview(country); // 首次进入检索模式时加载重点法规预览
              }}
            >
              {label}
            </button>
          ))}
          <span className="muted hint" style={{ fontSize: 12 }}>
            {mode === "browse"
              ? "选择国家 → 按法律领域浏览整部法律；正文可选中复制、支持打印 PDF"
              : "中文关键词可命中中文译名 / 译文（如“宪法”“民法典”）"}
          </span>
        </div>

        {/* —— 按法浏览：国家选择 —— */}
        {mode === "browse" && (
          <div className="search-row" style={{ flexWrap: "wrap", gap: 8 }}>
            {BROWSE_COUNTRIES.map((c) => (
              <button
                key={c}
                className={browseCountry === c ? "primary small" : "ghost small"}
                onClick={() => void switchBrowseCountry(c)}
                style={{ padding: "6px 14px" }}
              >
                {FLAGS[c]} {c}
                {rowCount(c) > 0 ? ` · ${rowCount(c).toLocaleString()} 条` : ""}
              </button>
            ))}
            {browseCountry && (
              <button className="ghost small" onClick={() => setBrowseCountry(null)}>
                ← 切换国家
              </button>
            )}
          </div>
        )}

        {/* —— 关键词检索：国家下拉 —— */}
        {mode === "search" && (
          <div className="search-row">
            <label className="country-label">
              <span style={{ marginRight: 6 }}>🌍 国家</span>
              <select
                value={country}
                onChange={(e) => {
                  const c = e.target.value;
                  setCountry(c);
                  setKeyword("");
                  setResults([]);
                  setSelected(null);
                  setHint("");
                  void loadPreview(c);
                }}
                style={{ minWidth: 180 }}
              >
                {ordered.map((c) => (
                  <option key={c.country} value={c.country}>
                    {FLAGS[c.country] ?? "🏳️"} {c.country}
                    {c.rows > 0 ? `（${c.rows.toLocaleString()} 条）` : ""}
                  </option>
                ))}
              </select>
            </label>
            {countLoading && <span className="tag">读取中…</span>}
          </div>
        )}
      </div>

      {/* ============ 浏览模式内容 ============ */}
      {mode === "browse" && (
        <div>
          {!browseCountry && (
            <div className="card">
              <h3 className="law-title">选择目标国家开始浏览</h3>
              <p className="muted">
                进入国家专属页面：查看该国政体、国体与法律体系概览，按法律领域找到整部法律，
                点击法律名称即可阅读完整条文（默认原文，可选中复制；支持打印 / 另存 PDF；可输入条号跳转）。
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                {BROWSE_COUNTRIES.map((c) => (
                  <button
                    key={c}
                    className="ghost"
                    style={{ fontSize: 14, padding: "10px 18px" }}
                    onClick={() => void switchBrowseCountry(c)}
                  >
                    {FLAGS[c]} {c} {rowCount(c) > 0 ? `（${rowCount(c).toLocaleString()} 条）` : ""}
                  </button>
                ))}
              </div>
            </div>
          )}

          {browseCountry && homeLoading && <div className="card empty">正在加载「{browseCountry}」法律目录…</div>}
          {browseCountry && homeErr && <div className="card empty">{homeErr}</div>}

          {browseCountry && !homeLoading && !homeErr && home && (
            <div>
              {/* 国家概览（政体 / 国体 / 法律体系） */}
              <div className="card">
                <h3 className="law-title" style={{ fontSize: 16 }}>
                  {FLAGS[home.country] ?? ""} {home.country}
                  {home.rows > 0 ? `（共 ${home.rows.toLocaleString()} 条条文）` : ""}
                </h3>
                {home.intro ? (
                  <p className="muted" style={{ lineHeight: 1.8 }}>
                    {home.intro}
                  </p>
                ) : (
                  <p className="muted">暂未收录该国概览。</p>
                )}
              </div>

              {/* 法律领域分组 */}
              {home.groups.length === 0 ? (
                <div className="card empty">该国家暂无法律目录。</div>
              ) : (
                home.groups.map((g) => (
                  <div className="card law-group" key={g.domain}>
                    <h3 className="law-title" style={{ fontSize: 14 }}>
                      📁 {g.domain}
                      <span className="muted hint">（{g.laws.length} 部）</span>
                    </h3>
                    {g.laws.map((row) => (
                      <div
                        key={row.title}
                        className="law-item"
                        style={{ cursor: "pointer" }}
                        onClick={() => openLaw(row.title)}
                        title={`打开整部法律：${row.title}`}
                      >
                        <span className="law-no">{row.articles.toLocaleString()} 条</span>
                        <LawTitleCell title={row.title} title_zh={row.title_zh} />
                        <span className="muted hint" style={{ marginLeft: "auto", fontSize: 12 }}>
                          打开整法 →
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ============ 检索模式内容 ============ */}
      {mode === "search" && (
        <>
          <div className="card">
            <div className="search-row">
              <input
                className="search-input"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void run();
                }}
                placeholder={`在「${country}」中检索篇名 / 条文号 / 正文（支持中文译名），如：契約 / 遺留分 / trademark / 宪法 / 民法典`}
              />
              <button className="primary small" onClick={() => void run()} disabled={searching}>
                {searching ? "检索中…" : "搜索"}
              </button>
            </div>
            <div className="search-badges">
              {kw ? (
                <span className="tag">
                  「{country}」命中 {results.length} 条{capHit ? "（仅前 500，请细化）" : ""}
                </span>
              ) : (
                <span className="tag">
                  已选 {FLAGS[country] ?? "🌐"} {country}
                  {country !== ALL && countryRows > 0
                    ? `（${countryRows.toLocaleString()} 条）`
                    : `（共 ${total > 0 ? total.toLocaleString() : "…"} 条）`}{" "}
                  · 输入关键词检索
                </span>
              )}
              {hint && <span className="tag tag-warn">{hint}</span>}
            </div>
          </div>

          <div className="laws-layout">
            <div className="laws-list">
              {!kw && preview.length > 0 && (
                <div className="card">
                  <h3 className="law-title" style={{ fontSize: 14 }}>
                    {FLAGS[country] ?? "🌐"} {country} · 条文最多的重点法规（点击即检索）
                  </h3>
                  {preview.map((p) => (
                    <div
                      key={p.title}
                      className="law-item"
                      style={{ cursor: "pointer" }}
                      onClick={() => void run(p.title)}
                      title={`在「${country}」中检索：${p.title}`}
                    >
                      <span className="law-no">{p.articles.toLocaleString()} 条</span>
                      <LawTitleCell title={p.title} title_zh={p.title_zh} />
                    </div>
                  ))}
                </div>
              )}

              {kw &&
                (searching ? (
                  <p className="muted">检索中…</p>
                ) : grouped.length === 0 ? (
                  <div className="card empty">{hint || "没有匹配的法规条文。"}</div>
                ) : (
                  grouped.map(([t, list]) => (
                    <div className="card law-group" key={t}>
                      <h3 className="law-title">{t}</h3>
                      <button className="ghost small" style={{ marginBottom: 6 }} onClick={() => openLaw(t)}>
                        打开整部法律 →
                      </button>
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
                ))}
            </div>

            <div className="card law-detail">
              {selected ? (
                <>
                  <div className="detail-head">
                    <h3>{selected.title}</h3>
                    {selected.chapter && <span className="tag">{selected.chapter}</span>}
                    {selected.article_no && <span className="tag tag-warn">{selected.article_no}</span>}
                  </div>
                  <p className="law-fulltext">{selected.content}</p>
                  {selected.content_zh && (
                    <p className="law-fulltext law-zh">{selected.content_zh}</p>
                  )}
                  <button className="ghost small" onClick={() => openLaw(selected.title)}>
                    在整部法律中浏览 →
                  </button>
                  {selected.source && <p className="muted hint">来源：{selected.source}</p>}
                </>
              ) : (
                <div className="law-detail-empty">
                  {kw
                    ? "点击左侧任意条文查看正文；或点「打开整部法律」进入整法浏览。"
                    : "在上方选择国家、输入关键词检索；或切到「📚 按法浏览」查看整部法律。"}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
