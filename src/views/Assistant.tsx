import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChatMsg, SYSTEM_PROMPTS, chatStream } from "../lib/ai";
import { useSettings } from "../hooks/useSettings";
import { callRust, isTauri } from "../lib/tauri";

const MODES = ["通用", "审合同", "审质证"] as const;

/** 聊天记录跨窗口共享键：大窗口 ⇄ 悬浮窗共用同一份对话 */
const LS_CHAT_KEY = "workbench:chat";

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

  const configured = !!(s.ai.baseUrl.trim() && s.ai.apiKey.trim());
  const cfg = useMemo(
    () => ({ baseUrl: s.ai.baseUrl, apiKey: s.ai.apiKey, model: s.ai.model }),
    [s.ai],
  );

  // 首次加载：从 localStorage 读取已有对话（大窗口与悬浮窗共享）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_CHAT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ChatMsg[];
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
      }
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);

  // 对话变化时持久化（加载完成前不写，避免覆盖另一窗口的记录）
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(LS_CHAT_KEY, JSON.stringify(messages));
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
    let full = "";
    try {
      await chatStream(cfg, [system, ...history], {
        onDelta: (d) => {
          full += d;
          setMessages((prev) => prev.map((m, i) => (i === aIdx ? { ...m, content: full } : m)));
          scrollToBottom();
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "请求失败";
      setMessages((prev) =>
        prev.map((m, i) =>
          i === aIdx ? { ...m, content: m.content || `（出错了）${msg}` } : m,
        ),
      );
      setError(msg);
    } finally {
      setBusy(false);
      scrollToBottom();
    }
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
            <button className="ghost-btn" onClick={() => setMessages([])}>
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
              <div className="msg-bubble">{m.content}</div>
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
          <button className="primary small" onClick={() => void send()} disabled={busy || !input.trim()}>
            {busy ? "生成中…" : "发送"}
          </button>
        </div>
      </div>

      {error && <div className="settings-msg err">{error}</div>}
    </div>
  );
}
