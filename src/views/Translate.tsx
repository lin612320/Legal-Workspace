import { useState } from "react";
import { LANGS, langLabel, translateFree, translatePaid } from "../lib/translate";
import { useSettings } from "../hooks/useSettings";

export default function Translate() {
  const { s } = useSettings();
  const [from, setFrom] = useState("auto");
  const [to, setTo] = useState("zh-CN");
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const paid = s.translate.provider === "paid" && !!s.translate.apiKey.trim();

  async function doTranslate() {
    if (!source.trim() || loading) return;
    setLoading(true);
    setError("");
    setResult("");
    try {
      const out = paid
        ? await translatePaid(source, langLabel(from), langLabel(to), {
            baseUrl: s.translate.baseUrl,
            apiKey: s.translate.apiKey,
            model: s.ai.model,
          })
        : await translateFree(source, from, to);
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "翻译失败");
    } finally {
      setLoading(false);
    }
  }

  function swap() {
    if (from === "auto") return; // 自动检测侧不可作目标
    setFrom(to);
    setTo(from === to ? to : from);
    setSource(result);
    setResult(source);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(result);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="translate-page">
      {/* 语种栏 */}
      <div className="card">
        <div className="lang-bar">
          <select className="lang-select" value={from} onChange={(e) => setFrom(e.target.value)}>
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <button className="ghost-btn swap-btn" onClick={swap} title="互换语言">
            互换
          </button>
          <select className="lang-select" value={to} onChange={(e) => setTo(e.target.value)}>
            {LANGS.filter((l) => l.code !== "auto").map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="provider-badge">{paid ? "付费接口" : "免费接口"}</span>
        </div>
        <p className="muted hint">提示：免费接口无需配置，开箱即用。Ctrl/Command + Enter 快速翻译。</p>
      </div>

      {/* 双栏 */}
      <div className="dual-pane">
        <div className="pane">
          <textarea
            className="pane-input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void doTranslate();
            }}
            placeholder="输入要翻译的内容…"
          />
          <div className="pane-foot">
            <span className="muted">{source.length} 字</span>
            <button className="primary small" onClick={() => void doTranslate()} disabled={loading || !source.trim()}>
              {loading ? "翻译中…" : "翻译"}
            </button>
          </div>
        </div>

        <div className="pane">
          <textarea className="pane-input readonly" readOnly value={result} placeholder="译文将显示在这里…" />
          <div className="pane-foot">
            <span className="muted">{paid ? "付费模型输出" : "Google 免费接口"}</span>
            {result && (
              <button className="ghost-btn" onClick={() => void copy()}>
                复制
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <div className="settings-msg err">{error}</div>}
    </div>
  );
}