import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentPage } from "../nav";
import { ballShow } from "../lib/ball";

const LS_THEME = "workbench:theme";

export default function Topbar() {
  const page = useCurrentPage();
  const nav = useNavigate();
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_THEME) === "dark";
    } catch {
      return false;
    }
  });

  // 应用主题并持久化
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem(LS_THEME, dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);

  return (
    <header className="topbar">
      <h1 className="page-title">{page.label}</h1>
      <div className="topbar-actions">
        <button
          className="ghost-btn"
          onClick={() => ballShow()}
          title="唤起桌面悬浮球（AI 快速助手）"
        >
          🎯 悬浮球
        </button>
        <button
          className="ghost-btn"
          onClick={() => setDark((d) => !d)}
          title={dark ? "切换到日间模式" : "切换到夜间模式"}
        >
          {dark ? "☀️ 日间" : "🌙 夜间"}
        </button>
        <button className="ghost-btn" onClick={() => nav("/todo")} title="查看待办与提醒">
          提醒
        </button>
        <button className="ghost-btn" onClick={() => nav("/settings")} title="打开数据与设置">
          设置
        </button>
      </div>
    </header>
  );
}
