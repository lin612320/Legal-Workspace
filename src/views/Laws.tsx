import { useCallback, useEffect, useMemo, useState } from "react";
import { Law } from "../data/laws";
import { useLaws } from "../hooks/useLaws";
import { callRust, isTauri } from "../lib/tauri";

const ALL = "全部国家";
const FLAGS: Record<string, string> = {
  中国: "🇨🇳",
  美国: "🇺🇸",
  日本: "🇯🇵",
  其他: "🏳️",
  [ALL]: "🌐",
};
// 下拉固定顺序
const ORDER: string[] = [ALL, "日本", "美国", "中国"];

interface CountryRow {
  country: string;
  rows: number;
}
interface PreviewRow {
  title: string;
  articles: number;
}

export default function Laws() {
  const { loading, search, total } = useLaws();
  const [country, setCountry] = useState<string>(ALL);
  const [countries, setCountries] = useState<CountryRow[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
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

  const loadPreview = useCallback(async (c: string) => {
    if (!isTauri()) {
      setPreview([]);
      return;
    }
    const cc = c === ALL ? undefined : c;
    const rows = (await callRust<PreviewRow[]>("laws_country_preview", { country: cc })) ?? [];
    setPreview(rows);
  }, []);

  // 初次加载：国家选项列表 + 默认全部国家的重点法规预览
  useEffect(() => {
    let alive = true;
    (async () => {
      if (isTauri()) {
        const rows = (await callRust<CountryRow[]>("laws_countries")) ?? [];
        if (alive) setCountries(rows);
      }
    })();
    void loadPreview(ALL);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeCountry = (c: string) => {
    setCountry(c);
    setKeyword("");
    setResults([]);
    setSelected(null);
    setHint("");
    void loadPreview(c);
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
          `在「${country}」没有匹配的条文，试试更短的关键词（如“契約”“遺留分”“商标”“contract”），或切换国家/全部国家。`,
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

  // 下拉选项：按固定顺序排列，未出现的国家（如“其他”）补在末尾
  const byName = new Map(countries.map((x) => [x.country, x]));
  const ordered = [
    ...ORDER.filter((n) => byName.has(n)).map((n) => ({ country: n, rows: byName.get(n)!.rows })),
    ...countries.filter((x) => !ORDER.includes(x.country)),
  ];
  const countryRows = byName.get(country)?.rows ?? 0;

  return (
    <div className="laws-page">
      {/* 搜索栏 */}
      <div className="card">
        {/* 国家下拉选择 */}
        <div className="search-row" style={{ marginBottom: 8 }}>
          <label className="country-label">
            <span style={{ marginRight: 6 }}>🌍 国家</span>
            <select
              value={country}
              onChange={(e) => changeCountry(e.target.value)}
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
          <span className="muted hint" style={{ marginLeft: 8, fontSize: 12 }}>
            {country === ALL
              ? "全库共 " + (total > 0 ? total.toLocaleString() : "…") + " 条"
              : `当前在 ${FLAGS[country] ?? ""} ${country}（${countryRows.toLocaleString()} 条）内检索`}
          </span>
        </div>

        <div className="search-row">
          <input
            className="search-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            placeholder={`在「${country}」中检索篇名 / 条文号 / 正文，如：契約 / 遺留分 / trademark / 合同`}
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
              {country !== ALL && countryRows > 0 ? `（${countryRows.toLocaleString()} 条）` : `（共 ${total > 0 ? total.toLocaleString() : "…"} 条）`} · 输入关键词检索
            </span>
          )}
          {loading && <span className="tag">读取中…</span>}
          {hint && <span className="tag tag-warn">{hint}</span>}
        </div>
      </div>

      <div className="laws-layout">
        {/* 左列：未检索时显示重点法规预览；检索后显示命中列表 */}
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
                  <span className="law-snippet">{p.title}</span>
                </div>
              ))}
              {loading && <p className="muted">加载中…</p>}
            </div>
          )}

          {kw &&
            (loading ? (
              <p className="muted">加载中…</p>
            ) : grouped.length === 0 ? (
              <div className="card empty">{hint || "没有匹配的法规条文。"}</div>
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
            ))}
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
              {kw ? "点击左侧任意条文查看正文。" : "在上方选择国家、输入关键词检索；或点击左侧重点法规预览直接查看。"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
