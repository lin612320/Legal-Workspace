import { useMemo, useState } from "react";
import { useTemplates } from "../hooks/useTemplates";

export default function Templates() {
  const { templates, loading, create, remove } = useTemplates();
  const [category, setCategory] = useState<string>("全部");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState("");

  // 自建表单
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", category: "", content: "", file_type: "txt" });

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) if (t.category) set.add(t.category);
    return ["全部", ...set];
  }, [templates]);

  const filtered = useMemo(
    () => (category === "全部" ? templates : templates.filter((t) => t.category === category)),
    [templates, category],
  );

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  async function handleCreate() {
    if (!form.title.trim() || !form.content.trim()) {
      setError("标题与正文不能为空。");
      return;
    }
    await create({
      title: form.title.trim(),
      category: form.category.trim() || "未分类",
      content: form.content,
      file_type: form.file_type,
    });
    setError("");
    setShowForm(false);
    setForm({ title: "", category: "", content: "", file_type: "txt" });
  }

  async function handleRemove(id: number) {
    const err = await remove(id);
    if (err) {
      setError(err);
    } else {
      setError("");
      setSelectedId(null);
    }
  }

  return (
    <div className="tp-page">
      {/* 顶栏：分类 chips + 自建按钮 */}
      <div className="card">
        <div className="tp-bar">
          <div className="mode-chips">
            {categories.map((c) => (
              <button
                key={c}
                className={`chip ${category === c ? "chip-active" : ""}`}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <button className="primary small" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "收起" : "+ 自建模板"}
          </button>
        </div>
        {showForm && (
          <div className="tp-form">
            <div className="form-grid">
              <label>
                <span>标题 *</span>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="模板名称" />
              </label>
              <label>
                <span>分类</span>
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="如：合同 / 诉讼文书" />
              </label>
            </div>
            <label>
              <span>正文 *</span>
              <textarea
                className="form-textarea"
                rows={7}
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="粘贴模板正文，下划线 ____ 处留给填表"
              />
            </label>
            <button className="primary small" onClick={() => void handleCreate()}>
              保存模板
            </button>
          </div>
        )}
      </div>

      <div className="tp-layout">
        {/* 列表 */}
        <div className="laws-list">
          {loading ? (
            <p className="muted">加载中…</p>
          ) : filtered.length === 0 ? (
            <div className="card empty">该分类下暂无模板。</div>
          ) : (
            filtered.map((t) => (
              <div
                key={t.id}
                className={`card tp-item ${selectedId === t.id ? "active" : ""}`}
                onClick={() => setSelectedId(t.id)}
              >
                <div className="tp-item-head">
                  <span className="tp-title">{t.title}</span>
                  {t.built_in ? <span className="tag">内置</span> : <span className="tag tag-warn">自建</span>}
                </div>
                {t.category && <span className="muted tp-cat">{t.category}</span>}
              </div>
            ))
          )}
        </div>

        {/* 详情 */}
        <div className="card law-detail">
          {selected ? (
            <>
              <div className="detail-head">
                <div className="tp-detail-head">
                  <h3>{selected.title}</h3>
                  <div>
                    {selected.file_type && <span className="tag">.{selected.file_type}</span>}
                    {!selected.built_in && (
                      <button className="danger-btn" onClick={() => void handleRemove(selected.id)}>
                        删除
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <pre className="tp-content">{selected.content}</pre>
            </>
          ) : (
            <div className="law-detail-empty">点击左侧模板查看内容。下划线 ____ 处为待填写项。</div>
          )}
        </div>
      </div>

      {error && <div className="settings-msg err">{error}</div>}
    </div>
  );
}