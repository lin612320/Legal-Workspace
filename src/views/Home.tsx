import { useMemo } from "react";
import { Link } from "react-router-dom";
import { NAV_ITEMS } from "../nav";
import { Todo, useTodos } from "../hooks/useTodos";
import { useDocuments } from "../hooks/useDocuments";
import { openPathFile } from "../lib/open";

export default function Home() {
  const { todos, toggle } = useTodos();
  const { docs, remove: removeDoc } = useDocuments();

  const pending = useMemo(
    () =>
      todos
        .filter((t) => !t.done)
        .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999")),
    [todos],
  );

  const overdue = pending.filter(isOverdueDay);
  const dueToday = pending.filter(isToday);
  const activeCount = pending.length;
  const stats = [
    { label: "今日待办", value: dueToday.length, danger: false },
    { label: "进行中", value: activeCount, danger: false },
    { label: "已超期", value: overdue.length, danger: overdue.length > 0 },
  ];

  return (
    <div className="home">
      {/* 欢迎 + 日期 */}
      <div className="home-welcome">
        <h2>你好，法律工作者</h2>
        <span className="muted">{todayStr()}</span>
      </div>

      {/* 超期横幅 */}
      {overdue.length > 0 && (
        <div className="overdue-banner">
          有 <b>{overdue.length}</b> 项待办已超期，点击查看{" "}
          <Link to="/todo">前往待办查看</Link>
        </div>
      )}

      {/* 统计卡 */}
      <div className="stat-row">
        {stats.map((s) => (
          <div className="card stat" key={s.label}>
            <div className="stat-value" style={{ color: s.danger ? "#c0392b" : "var(--brand)" }}>
              {s.value}
            </div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="home-grid">
        {/* 今日待办 */}
        <section className="card home-panel">
          <div className="panel-head">
            <h3>今日待办</h3>
            <Link to="/todo" className="more-link">
              全部 &gt;
            </Link>
          </div>
          {dueToday.length === 0 ? (
            <p className="muted">今天暂无到期待办。</p>
          ) : (
            <ul className="mini-todo">
              {dueToday.slice(0, 5).map((t: Todo) => (
                <li key={t.id}>
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={(e) => {
                      void toggle(t.id, e.target.checked);
                    }}
                  />
                  <span className="mini-title">{t.title}</span>
                  <span className="mini-time">{fmtHM(t.due_at!)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 最近文书（智能体交付物落点） */}
        <section className="card home-panel">
          <div className="panel-head">
            <h3>最近处理的文书</h3>
            <Link to="/agent" className="more-link">
              文书智能体 &gt;
            </Link>
          </div>
          {docs.length === 0 ? (
            <p className="muted">
              暂无文书。用「文书智能体」把委托做成审查意见书 / 起诉状 / 质证意见后，会展示在这里。
            </p>
          ) : (
            <ul className="mini-docs">
              {docs.slice(0, 5).map((d) => (
                <li key={d.id}>
                  <div className="mini-doc-main">
                    <span className="mini-title">{d.title}</span>
                    {d.file_path && (
                      <span className="muted mini-path" title={d.file_path}>
                        {d.file_path}
                      </span>
                    )}
                    <span className="muted mini-time">{fmtDateTime(d.updated_at)}</span>
                  </div>
                  <div className="mini-doc-actions">
                    {d.kind && <span className="tag">.{d.kind}</span>}
                    {d.file_path && (
                      <button
                        className="ghost-btn"
                        title="用系统默认程序打开该交付文件"
                        onClick={async () => {
                          const err = await openPathFile(d.file_path as string);
                          if (err) window.alert(`打开失败：${err}`);
                        }}
                      >
                        打开
                      </button>
                    )}
                    <button className="danger-btn" title="删除记录" onClick={() => void removeDoc(d.id)}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 常用功能快捷入口 */}
      <section className="card">
        <h3>常用功能</h3>
        <div className="quick-grid">
          {NAV_ITEMS.map((it) => (
            <Link to={it.path} className="quick-item" key={it.key}>
              <span className="quick-dot" />
              {it.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

/** 是否今日到期（未完成、due_at 落在今天） */
function isToday(t: Todo): boolean {
  if (!t.due_at || t.done) return false;
  const due = new Date(t.due_at);
  const now = new Date();
  return (
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate()
  );
}

/** 是否已超期（未完成、due_at 早于当前时刻） */
function isOverdueDay(t: Todo): boolean {
  if (!t.due_at || t.done) return false;
  return new Date(t.due_at).getTime() < Date.now();
}

function fmtHM(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function todayStr(): string {
  const d = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}