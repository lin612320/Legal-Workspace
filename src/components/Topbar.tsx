import { useCurrentPage } from "../nav";

export default function Topbar() {
  const page = useCurrentPage();
  return (
    <header className="topbar">
      <h1 className="page-title">{page.label}</h1>
      <div className="topbar-actions">
        <button className="ghost-btn" title="待办提醒开关（占位）">提醒</button>
        <button className="ghost-btn" title="设置（占位）">设置</button>
      </div>
    </header>
  );
}