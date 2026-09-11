import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  LANGS,
  langLabel,
  translateLongText,
  isConfigured,
  configHint,
  splitForTranslation,
  translatedDocTitle,
} from "../lib/translate";
import { useSettings } from "../hooks/useSettings";
import {
  DOC_ACCEPT,
  importDocument,
  exportTranslatedDoc,
  downloadMarkdown,
  type DocImportResult,
} from "../lib/translateDoc";
import { openPathFile, revealPath } from "../lib/open";
import { isTauri } from "../lib/tauri";

type Mode = "text" | "doc";

export default function Translate() {
  const { s } = useSettings();

  const cfg = useMemo(
    () => ({ baseUrl: s.ai.baseUrl, apiKey: s.ai.apiKey, model: s.ai.model }),
    [s.ai.baseUrl, s.ai.apiKey, s.ai.model],
  );
  const configured = isConfigured(cfg);

  const [mode, setMode] = useState<Mode>("text");
  const [from, setFrom] = useState("auto");
  const [to, setTo] = useState("zh-CN");
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [doc, setDoc] = useState<DocImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [outPath, setOutPath] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const chunkRef = useRef(-1);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function swap() {
    if (from === "auto") return; // 自动检测侧不可作目标
    const f = from;
    setFrom(to);
    setTo(f);
    setSource(result);
    setResult(source);
    setOutPath("");
  }

  function resetOutput() {
    setResult("");
    setOutPath("");
    setMsg("");
    setError("");
  }

  /** 翻译（长文自动分块：逐块流式回显 + 进度） */
  async function doTranslate() {
    const text = source.trim();
    if (!text || loading) return;
    if (!configured) {
      setError(configHint());
      return;
    }
    setLoading(true);
    setError("");
    setMsg("");
    setResult("");
    setOutPath("");
    chunkRef.current = -1;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const total = splitForTranslation(text).length;
    setProgress({ done: 0, total });

    try {
      const out = await translateLongText(cfg, text, langLabel(from), langLabel(to), {
        signal: ctrl.signal,
        onProgress: (done, t) => setProgress({ done, total: t }),
        onDelta: (delta, i) =>
          setResult((prev) => {
            if (i !== chunkRef.current) {
              chunkRef.current = i;
              return prev ? `${prev}\n\n${delta}` : delta;
            }
            return prev + delta;
          }),
      });
      setResult(out);
      setMsg(
        total > 1
          ? `全文翻译完成（共 ${total} 段）。可点「${isTauri() ? "导出 Word" : "导出文档"}」保存译文。`
          : "翻译完成。",
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setMsg("已停止翻译，已完成的段落保留在右侧。");
      } else {
        setError(e instanceof Error ? e.message : "翻译失败");
      }
    } finally {
      setLoading(false);
      setProgress(null);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 忽略剪贴板失败 */
    }
  }

  /** 选择文档 → 提取全文（办公文档本地提取，PDF/图片走多模态模型转录） */
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选择同一个文件
    if (!file) return;
    setImporting(true);
    setError("");
    setMsg("");
    setResult("");
    setOutPath("");
    setDoc(null);
    try {
      const r = await importDocument(file, configured ? cfg : null);
      setDoc(r);
      setSource(r.text);
      setMode("doc");
      setMsg(
        `已导入「${r.fileName}」（${r.kind}）：约 ${r.text.length} 字` +
          `${r.blocks ? ` · ${r.blocks} 段` : ""}${r.truncated ? " · 超长已截断" : ""}` +
          `${r.fromModel ? " · 由模型转录" : ""}。点「翻译」开始全文翻译。`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  function clearDoc() {
    setDoc(null);
    setSource("");
    resetOutput();
  }

  /** 导出译文文档：桌面导出 .docx（并记入「最近文书」），浏览器下载 .md */
  async function doExport() {
    if (!result.trim() || exporting) return;
    setExporting(true);
    setError("");
    setMsg("");
    const title = translatedDocTitle(doc?.fileName ?? "翻译文本", langLabel(to));
    try {
      const r = await exportTranslatedDoc(title, result, {
        from: langLabel(from),
        to: langLabel(to),
        sourceFile: doc?.fileName ?? null,
      });
      if (r.path) setOutPath(r.path);
      setMsg(r.msg);
    } catch (e) {
      setError(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleOpenDoc() {
    if (!outPath) return;
    const err = await openPathFile(outPath);
    if (err) setError(`打开失败：${err}`);
  }

  async function handleRevealDoc() {
    if (!outPath) return;
    const err = await revealPath(outPath);
    if (err) setError(`定位失败：${err}`);
  }

  const exportLabel = exporting ? "导出中…" : isTauri() ? "导出 Word" : "导出文档";

  return (
    <div className="translate-page">
      {/* 语种栏 + 引擎（统一 AI 接口） */}
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
          <span className="provider-badge">AI 接口</span>
        </div>
        <p className="muted hint">
          翻译统一走「数据设置 → AI 接口」（DeepSeek / OpenAI 兼容），不再使用内置免费接口。
          当前模型：<code>{s.ai.model || "未配置"}</code>；Ctrl/Command + Enter 快速翻译；长文档自动分段翻译。
        </p>
        {s.loaded && !configured && (
          <p className="translate-warn">
            尚未配置 AI 接口，翻译与文档翻译都不可用。
            <Link to="/settings"> 前往数据设置 →</Link>
          </p>
        )}
      </div>

      {/* 模式切换 */}
      <div className="todo-list-bar">
        <button
          className={`chip ${mode === "text" ? "chip-active" : ""}`}
          onClick={() => setMode("text")}
        >
          文本翻译
        </button>
        <button
          className={`chip ${mode === "doc" ? "chip-active" : ""}`}
          onClick={() => setMode("doc")}
        >
          文档全文翻译
        </button>
      </div>

      {/* 文档导入（多模态） */}
      {mode === "doc" && (
        <div className="card">
          <h3>导入文档 · 全文翻译</h3>
          <p className="muted hint">
            支持 docx / pptx / xlsx / pdf / 图片 / txt / md / csv。办公文档在本地提取文本（原件不上传）；
            PDF 与图片由配置的模型转录为全文后再翻译，转录文本会明确标注「非原文」。
          </p>
          <div className="translate-doc-row">
            <input
              ref={fileRef}
              type="file"
              accept={DOC_ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => void onPickFile(e)}
            />
            <button className="primary" disabled={importing} onClick={() => fileRef.current?.click()}>
              {importing ? "解析文档中…" : "选择文档"}
            </button>
            {doc && (
              <span className="muted">
                当前：{doc.fileName}（{doc.kind} · {doc.text.length} 字
                {doc.blocks ? ` · ${doc.blocks} 段` : ""}
                {doc.truncated ? " · 超长已截断" : ""}）
              </span>
            )}
            {doc && (
              <button className="ghost-btn" onClick={clearDoc}>
                移除
              </button>
            )}
          </div>
          {doc?.note && (
            <p className={doc.fromModel ? "translate-warn" : "muted hint"}>{doc.note}</p>
          )}
        </div>
      )}

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
            placeholder={mode === "doc" ? "导入文档后，全文会显示在这里（可先编辑/删减再翻译）…" : "输入要翻译的内容…"}
          />
          <div className="pane-foot">
            <span className="muted">
              {source.length} 字
              {progress ? ` · 已译 ${progress.done}/${progress.total} 段` : ""}
            </span>
            <span className="translate-actions">
              {loading && (
                <button className="ghost-btn" onClick={stop}>
                  停止
                </button>
              )}
              <button
                className="ghost-btn"
                disabled={loading || (!source && !result && !doc)}
                onClick={() => {
                  setSource("");
                  clearDoc();
                }}
              >
                清空
              </button>
              <button
                className="primary small"
                onClick={() => void doTranslate()}
                disabled={loading || !source.trim()}
              >
                {loading ? "翻译中…" : "翻译"}
              </button>
            </span>
          </div>
        </div>

        <div className="pane">
          <textarea
            className="pane-input readonly"
            readOnly
            value={result}
            placeholder="译文将显示在这里…"
          />
          <div className="pane-foot">
            <span className="muted">
              {result.length} 字 · {langLabel(to)}
              {doc ? " · 文档译文" : ""}
            </span>
            <span className="translate-actions">
              <button className="ghost-btn" onClick={() => void copy()} disabled={!result}>
                {copied ? "已复制 ✓" : "复制"}
              </button>
              <button
                className="ghost-btn"
                disabled={!result}
                onClick={() =>
                  downloadMarkdown(translatedDocTitle(doc?.fileName ?? "翻译文本", langLabel(to)), result)
                }
              >
                下载 .md
              </button>
              <button className="primary small" onClick={() => void doExport()} disabled={!result || exporting}>
                {exportLabel}
              </button>
            </span>
          </div>
        </div>
      </div>

      {outPath && (
        <div className="card translate-out">
          <span className="muted mini-path" title={outPath}>
            {outPath}
          </span>
          <span className="translate-actions">
            <button className="ghost-btn" onClick={() => void handleOpenDoc()}>
              打开
            </button>
            <button className="ghost-btn" onClick={() => void handleRevealDoc()}>
              在文件夹中定位
            </button>
          </span>
        </div>
      )}

      {msg && (
        <div className="settings-msg ok" onClick={() => setMsg("")}>
          {msg}
        </div>
      )}
      {error && (
        <div className="settings-msg err" onClick={() => setError("")}>
          {error}
        </div>
      )}
    </div>
  );
}
