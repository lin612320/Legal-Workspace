interface PlaceholderProps {
  badge: string;
  title: string;
  desc: string;
  modules: string[];
}

/** 版块骨架占位页：展示该版块已规划的页面结构与待实现模块 */
export default function Placeholder({ badge, title, desc, modules }: PlaceholderProps) {
  return (
    <div className="placeholder">
      <span className="badge">{badge}</span>
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p className="muted" style={{ marginTop: 4 }}>{desc}</p>
      <div className="card" style={{ marginTop: 8 }}>
        <h3>本版块结构（骨架已就位，字段待实现）</h3>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          {modules.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}