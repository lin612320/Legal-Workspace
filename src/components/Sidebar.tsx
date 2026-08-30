import { NavLink } from "react-router-dom";
import { NAV_ITEMS } from "../nav";
import { useTodos } from "../hooks/useTodos";

export default function Sidebar() {
  const { todos } = useTodos();
  const badgeCount = todos.filter((t) => !t.done && !!t.due_at).length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">律</span>
        <span className="brand-name">律政工作台</span>
      </div>
      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            to={item.path}
            className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
          >
            <span className="nav-dot" />
            <span className="nav-label">{item.label}</span>
            {item.key === "todo" && badgeCount > 0 && (
              <span className="nav-badge">{badgeCount}</span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">本地单机 · 数据在本机</div>
    </aside>
  );
}