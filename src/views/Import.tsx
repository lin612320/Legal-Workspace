import { useState } from "react";
import { callRust, isTauri } from "../lib/tauri";

const LAWS_COLS = ["title（标题）", "chapter（章节）", "article_no（条文号）", "content（内容）", "source（来源）"];
const TEMPLATE_COLS = ["title（标题）", "category（分类）", "content（内容）", "file_type（类型）"];

export default function Import() {
  const [kind, setKind] = useState<"laws" | "templates">("laws");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const cols = kind === "laws" ? LAWS_COLS : TEMPLATE_COLS;

  async function doImport() {
    const p = path.trim();
    if (!p || busy) return;
    if (!isTauri()) {
      setMsg({ type: "err", text: "数据导入仅桌面版可用（当前为浏览器预览）。" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await callRust<{ imported: number; skipped: number }>("import_excel", {
        kind,
        path: p,
      });
      if (res) {
        setMsg({
          type: "ok",
          text: `导入完成：新增 ${res.imported} 条，跳过 ${res.skipped} 条（空行/缺内容）。`,
        });
      } else {
        setMsg({ type: "err", text: "导入失败，请检查文件路径与格式。" });
      }
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "导入异常" });
    }
    setBusy(false);
  }

  return (
    <div className="settings-page">
      <section className="card">
        <h3>Excel 数据导入</h3>
        <p className="muted hint">
          把 Excel 中的法规 / 模板数据写入本地数据库。第一行必须是表头，按下面的列名填写（中英文列名均可）。
        </p>
        <div className="form-grid">
          <label>
            <span>导入类型</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as "laws" | "templates")}>
              <option value="laws">法规（laws 表）</option>
              <option value="templates">模板（templates 表）</option>
            </select>
          </label>
          <label className="wide">
            <span>Excel 文件完整路径</span>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="例如 D:\数据\民法典.xlsx"
            />
          </label>
        </div>
        <p className="muted hint">
          表头列：<code>{cols.join("、")}</code>
        </p>
        <button className="primary" disabled={busy || !path.trim()} onClick={() => void doImport()}>
          {busy ? "导入中…" : "开始导入"}
        </button>
      </section>

      <section className="card">
        <h3>导入规则说明</h3>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li>只读取第一个工作表（Sheet）。</li>
          <li>标题（title）与内容（content）为必填列，缺失或为空的整行会被跳过。</li>
          <li>法规导入后可在「法规查询」中检索；模板导入后可在「模板库」中查看（自建模板，可删除）。</li>
          <li>重复导入不会去重，会新增记录；如需重建数据，可在「数据设置」中先手动备份。</li>
        </ul>
      </section>

      {msg && (
        <div className={`settings-msg ${msg.type}`} onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
