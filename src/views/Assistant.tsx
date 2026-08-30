import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChatMsg, SYSTEM_PROMPTS, chatStream } from "../lib/ai";
import { useSettings } from "../hooks/useSettings";
import { callRust, isTauri } from "../lib/tauri";

const MODES = ["通用", "审合同", "审质证"] as const;

/** 聊天记录跨窗口共享键：大窗口 ⇄ 悬浮窗共用同一份对话 */
const LS_CHAT_KEY = "workbench:chat";

/** 轻量 Markdown 渲染：支持代码块、行内代码、加粗、列表、标题、空行分段 */
function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      return (
        <code key={i} className="md-inline-code">
          {p.slice(1, -1)}
        </code>
      );
    }
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    }
    return <span key={i}>{p}</span>;
  });
}

function renderMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let key = 0;
  let codeBuf: string[] | null = null;
  let listBuf: string[] | null = null;

  const flushList = () => {
    if (listBuf) {
      nodes.push(
        <ul key={key++} className="md-list">
          {listBuf.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>,
      );
      listBuf = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      flushList();
      if (codeBuf) {
        nodes.push(
          <pre key={key++} className="md-code">
            <code>{codeBuf.join("\n")}</code>
          </pre>,
        );
        codeBuf = null;
      } else {
        codeBuf = [];
      }
      continue;
    }
    if (codeBuf) {
      codeBuf.push(line);
      continue;
    }
    const ulMatch = line.match(/^\s*[-*]\s+(.*)/);
    const olMatch = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ulMatch || olMatch) {
      if (!listBuf) listBuf = [];
      listBuf.push((ulMatch ?? olMatch)![1]);
      continue;
    }
    flushList();
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("### ")) {
      nodes.push(
        <h4 key={key++} className="md-h4">
          {inline(t.slice(4))}
        </h4>,
      );
    } else if (t.startsWith("## ")) {
      nodes.push(
        <h3 key={key++} className="md-h3">
          {inline(t.slice(3))}
        </h3>,
      );
    } else if (t.startsWith("# ")) {
      nodes.push(
        <h2 key={key++} className="md-h2">
          {inline(t.slice(2))}
        </h2>,
      );
    } else {
      nodes.push(
        <p key={key++} className="md-p">
          {inline(t)}
        </p>,
      );
    }
  }
  flushList();
  if (codeBuf) {
    nodes.push(
      <pre key={key++} className="md-code">
        <code>{codeBuf.join("\n")}</code>
      </pre>,
    );
  }
  return nodes;
}

export default function Assistant() {
  const { s } = useSettings();
  const { search } = useLocation();
  const isFloat = new URLSearchParams(search).get("float") === "1";

  const [mode, setMode] = useState<string>("审合同");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false); // 首次从 localStorage 加载完成
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null); // 中止当前生成

  const configured = !!(s.ai.baseUrl.trim() && s.ai.apiKey.trim());
  const cfg = useMemo(
    () => ({ baseUrl: s.ai.baseUrl, apiKey: s.ai.apiKey, model: s.ai.model }),
    [s.ai],
  );

  // 首次加载：桌面版从 SQLite 读取（持久化），浏览器从 localStorage 读取
  useEffect(() => {
    (async () => {
      try {
        if (isTauri()) {
          const list = await callRust<ChatMsg[]>("chat_history_load");
          if (list && list.length > 0) {
            setMessages(list);
            // 同步给其他窗口（悬浮窗 ⇄ 大窗口）
            localStorage.setItem(LS_CHAT_KEY, JSON.stringify(list));
          }
        } else {
          const raw = localStorage.getItem(LS_CHAT_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as ChatMsg[];
            if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
          }
        }
      } catch {
        /* ignore */
      }
      setLoaded(true);
    })();
  }, []);

  // 对话变化时持久化（防抖 400ms）：
  // - localStorage 作为跨窗口实时同步通道（storage 事件）
  // - 桌面版额外写入 SQLite，重启不丢
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(LS_CHAT_KEY, JSON.stringify(messages));
      } catch {
        /* ignore */
      }
      if (isTauri()) {
        void callRust<void>("chat_history_save", { messages });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [messages, loaded]);

  // 监听其他窗口（悬浮窗 ⇄ 大窗口）的对话变更，实时同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LS_CHAT_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue) as ChatMsg[];
        if (Array.isArray(parsed)) setMessages(parsed);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (!configured) {
      setError("请先在「数据与设置」中配置 AI 接口地址与 Key。");
      return;
    }
    const system: ChatMsg = { role: "system", content: SYSTEM_PROMPTS[mode] };
    const history: ChatMsg[] = [...messages, { role: "user", content: text }];
    const aIdx = history.length; // 拼接 assistant 占位后的下标
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    setError("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let full = "";
    try {
      await chatStream(cfg, [system, ...history], {
        signal: ctrl.signal,
        onDelta: (d) => {
          full += d;
          setMessages((prev) => prev.map((m, i) => (i === aIdx ? { ...m, content: full } : m)));
          scrollToBottom();
        },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        // 用户主动停止：保留已生成内容，不当作错误提示
      } else {
        const msg = e instanceof Error ? e.message : "请求失败";
        setMessages((prev) =>
          prev.map((m, i) =>
            i === aIdx ? { ...m, content: m.content || `（出错了）${msg}` } : m,
          ),
        );
        setError(msg);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      scrollToBottom();
    }
  }

  /** 中止当前生成 */
  function stop() {
    abortRef.current?.abort();
  }

  async function toFloat() {
    await callRust<void>("float_in");
    if (!isTauri()) setError("悬浮窗仅桌面版可用（当前为浏览器预览）。");
  }
  async function toBig() {
    await callRust<void>("float_out");
  }

  return (
    <div className={`assistant-page ${isFloat ? "float" : ""}`}>
      {/* 顶栏：模式 + 窗口切换 */}
      <div className="assistant-bar">
        <div className="mode-chips">
          {MODES.map((m) => (
            <button
              key={m}
              className={`chip ${mode === m ? "chip-active" : ""}`}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="assistant-actions">
          {isFloat ? (
            <button className="ghost-btn" onClick={() => void toBig()}>
              放大到大窗口
            </button>
          ) : (
            <button className="ghost-btn" onClick={() => void toFloat()}>
              置顶悬浮窗
            </button>
          )}
          {messages.length > 0 && (
            <button
              className="ghost-btn"
              onClick={() => {
                if (busy) stop();
                setMessages([]);
              }}
            >
              清空
            </button>
          )}
        </div>
      </div>

      {/* 会话区 */}
      <div className="assistant-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="assistant-empty">
            <div className="assistant-empty-title">AI 助手</div>
            <p className="muted">
              {mode === "审合同" && "粘贴/输入合同条款，自动审查风险并给出修改建议。"}
              {mode === "审质证" && "围绕证据三性帮你分析质证要点或起草质证意见。"}
              {mode === "通用" && "直接提问，本助手会以法律视角专业作答。"}
            </p>
            {!configured && (
              <Link to="/settings" className="assistant-setup">
                尚未配置 AI 接口 → 前往「数据与设置」填写 base_url 与 Key
              </Link>
            )}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`msg ${m.role === "user" ? "user" : "assistant"}`}>
              <div className="msg-bubble">
                {m.role === "assistant" && m.content ? renderMarkdown(m.content) : m.content}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 输入区 */}
      <div className="assistant-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send();
          }}
          placeholder={`当前模式：${mode}。输入内容，Ctrl+Enter 发送…`}
          rows={isFloat ? 2 : 3}
        />
        <div className="assistant-input-foot">
          <span className="muted">Ctrl/Command + Enter 发送</span>
          <button
            className="primary small"
            onClick={() => void (busy ? stop() : send())}
            disabled={!busy && !input.trim()}
          >
            {busy ? "停止" : "发送"}
          </button>
        </div>
      </div>

      {error && <div className="settings-msg err">{error}</div>}
    </div>
  );
}
