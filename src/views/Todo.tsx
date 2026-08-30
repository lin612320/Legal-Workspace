import { useMemo, useState } from "react";
import { Todo, useTodos } from "../hooks/useTodos";

type Filter = "all" | "active" | "done" | "overdue";

const EMPTY_FORM = { title: "", note: "", due_at: "", remind_minutes: 30, desktop_popup: true };

export default function TodoPage() {
  const { todos, loading, create, save, remove, toggle } = useTodos();
  const [filter, setFilter] = useState<Filter>("all");
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<number | null>(null);

  // 到期：due_at 未完成且已过时间（提醒时间前的也算临近）
  const isOverdue = (t: Todo): boolean =>
    !!t.due_at && !t.done && new Date(t.due_at as string).getTime() < Date.now();
  const isDueSoon = (t: Todo): boolean => {
    if (!t.due_at || t.done) return false;
    const ms = new Date(t.due_at).getTime() - Date.now();
    return ms > 0 && ms < (t.remind_minutes || 30) * 60_000;
  };

  const filtered = useMemo(() => {
    switch (filter) {
      case "active":
        return todos.filter((t) => !t.done);
      case "done":
        return todos.filter((t) => t.done);
      case "overdue":
        return todos.filter(isOverdue);
      default:
        return todos;
    }
  }, [todos, filter]);

  const editingTodo = editingId !== null ? todos.find((t) => t.id === editingId) ?? null : null;

  const counts = useMemo(
    () => ({
      all: todos.length,
      active: todos.filter((t) => !t.done).length,
      done: todos.filter((t) => t.done).length,
      overdue: todos.filter(isOverdue).length,
    }),
    [todos],
  );

  async function handleCreate() {
    if (!form.title.trim()) return;
    await create({
      title: form.title.trim(),
      note: form.note.trim() ? form.note.trim() : undefined,
      due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
      remind_minutes: form.remind_minutes,
      desktop_popup: form.desktop_popup,
    });
    setForm({ ...EMPTY_FORM });
  }

  return (
    <div className="todo-page">
      {/* 新建表单 */}
      <div className="card">
        <h3>新建待办</h3>
        <div className="form-grid">
          <label>
            <span>标题 *</span>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="要做什么"
            />
          </label>
          <label>
            <span>备注</span>
            <input
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="补充说明（可选）"
            />
          </label>
          <label>
            <span>截止时间</span>
            <input
              type="datetime-local"
              value={form.due_at}
              onChange={(e) => setForm({ ...form, due_at: e.target.value })}
            />
          </label>
          <label>
            <span>提前提醒（分钟）</span>
            <input
              type="number"
              min={0}
              value={form.remind_minutes}
              onChange={(e) => setForm({ ...form, remind_minutes: Number(e.target.value) })}
            />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={form.desktop_popup}
              onChange={(e) => setForm({ ...form, desktop_popup: e.target.checked })}
            />
            <span>启用桌面弹窗提醒</span>
          </label>
        </div>
        <button className="primary" onClick={handleCreate} disabled={!form.title.trim()}>
          添加待办
        </button>
      </div>

      {/* 筛选 + 列表 */}
      <div className="todo-list-bar">
        {(
          [
            ["all", `全部 ${counts.all}`],
            ["active", `进行中 ${counts.active}`],
            ["done", `已完成 ${counts.done}`],
            ["overdue", `已超期 ${counts.overdue}`],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`chip ${filter === key ? "chip-active" : ""}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="muted">加载中…</p>
      ) : filtered.length === 0 ? (
        <div className="card empty">这里还没有待办，先在顶部添加一个。</div>
      ) : (
        filtered.map((t) => <TodoRow key={t.id} t={t} isOverdue={isOverdue} isDueSoon={isDueSoon} />)
      )}

      {/* 编辑面板：由父组件传入当前编辑对象，按 id 重置表单 */}
      {editingTodo && (
        <EditPanel key={editingTodo.id} t={editingTodo} onClose={() => setEditingId(null)} onSave={save} />
      )}
    </div>
  );

  function TodoRow({
    t,
    isOverdue,
    isDueSoon,
  }: {
    t: Todo;
    isOverdue: (t: Todo) => boolean;
    isDueSoon: (t: Todo) => boolean;
  }) {
    const overdue = isOverdue(t);
    const soon = isDueSoon(t);
    return (
      <div className={`todo-row ${t.done ? "done" : ""}`}>
        <input
          type="checkbox"
          checked={t.done}
          onChange={(e) => toggle(t.id, e.target.checked)}
        />
        <div className="todo-main">
          <div className="todo-title">{t.title}</div>
          {t.note && <div className="todo-note">{t.note}</div>}
          <div className="todo-meta">
            {t.due_at && (
              <span className={overdue ? "tag tag-danger" : soon ? "tag tag-warn" : "tag"}>
                {overdue ? "已超期" : soon ? "即将到期" : "到期"} · {fmtDate(t.due_at)}
              </span>
            )}
            {!t.desktop_popup && <span className="muted">（桌面弹窗已关）</span>}
          </div>
        </div>
        <div className="todo-actions">
          <button className="ghost-btn" onClick={() => setEditingId(t.id)}>
            编辑
          </button>
          <button className="danger-btn" onClick={() => remove(t.id)}>
            删除
          </button>
        </div>
      </div>
    );
  }
}

function EditPanel({
  t,
  onClose,
  onSave,
}: {
  t: Todo;
  onClose: () => void;
  onSave: (id: number, patch: Partial<Todo>) => Promise<void>;
}) {
  const [title, setTitle] = useState(t.title);
  const [note, setNote] = useState(t.note ?? "");
  const [due_at, setDue] = useState(t.due_at ? toLocalInput(t.due_at) : "");
  const [remind, setRemind] = useState<number>(t.remind_minutes);
  const [popup, setPopup] = useState<boolean>(t.desktop_popup);

  return (
    <div className="card edit-panel">
      <h3>编辑待办</h3>
      <div className="form-grid">
        <label>
          <span>标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span>备注</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label>
          <span>截止时间</span>
          <input
            type="datetime-local"
            value={due_at}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        <label>
          <span>提前提醒（分钟）</span>
          <input
            type="number"
            min={0}
            value={remind}
            onChange={(e) => setRemind(Number(e.target.value))}
          />
        </label>
        <label className="inline">
          <input type="checkbox" checked={popup} onChange={(e) => setPopup(e.target.checked)} />
          <span>桌面弹窗提醒</span>
        </label>
      </div>
      <div className="edit-actions">
        <button
          className="primary"
          onClick={async () => {
            await onSave(t.id, {
              title: title.trim() || t.title,
              note: note.trim() ? note.trim() : null,
              due_at: due_at ? new Date(due_at).toISOString() : null,
              remind_minutes: remind,
              desktop_popup: popup,
            });
            onClose();
          }}
        >
          保存
        </button>
        <button className="ghost-btn" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

/** ISO → datetime-local 需要的本地字符串 */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}