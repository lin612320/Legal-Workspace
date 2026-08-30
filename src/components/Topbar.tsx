import { useEffect, useState } from "react";
import { useCurrentPage } from "../nav";

const LS_THEME = "workbench:theme";

export default function Topbar() {
  const page = useCurrentPage();
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
          onClick={() => setDark((d) => !d)}
          title={dark ? "切换到日间模式" : "切换到夜间模式"}
        >
          {dark ? "☀️ 日间" : "🌙 夜间"}
        </button>
        <button className="ghost-btn" title="待办提醒开关（占位）">
          提醒
        </button>
        <button className="ghost-btn" title="设置（占位）">
          设置
        </button>
      </div>
    </header>
  );
}
