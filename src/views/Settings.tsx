import { useState } from "react";
import { useSettings } from "../hooks/useSettings";

export default function Settings() {
  const { s, setAI, setTranslate, setBackup, setDefaultPopup, backupNow, restore, msg, setMsg } =
    useSettings();
  const [backupDir, setBackupDir] = useState("");
  const [restoreFile, setRestoreFile] = useState("");

  return (
    <div className="settings-page">
      {!s.loaded && <p className="muted">加载中…</p>}

      {/* AI 助手配置 */}
      <section className="card">
        <h3>AI 助手配置</h3>
        <p className="muted hint">OpenAI 兼容接口，用于合同/质证审查。留空则 AI 助手不可用。</p>
        <div className="form-grid">
          <label>
            <span>接口地址 base_url</span>
            <input
              value={s.ai.baseUrl}
              onChange={(e) => setAI({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label>
            <span>模型名</span>
            <input
              value={s.ai.model}
              onChange={(e) => setAI({ model: e.target.value })}
              placeholder="gpt-4o-mini"
            />
          </label>
          <label className="wide">
            <span>API Key</span>
            <input
              type="password"
              value={s.ai.apiKey}
              onChange={(e) => setAI({ apiKey: e.target.value })}
              placeholder="sk-…"
            />
          </label>
        </div>
      </section>

      {/* 翻译配置 */}
      <section className="card">
        <h3>翻译配置</h3>
        <div className="form-grid">
          <label>
            <span>接口</span>
            <select
              value={s.translate.provider}
              onChange={(e) => setTranslate({ provider: e.target.value })}
            >
              <option value="free">内置免费接口（开箱即用）</option>
              <option value="paid">自定义付费接口</option>
            </select>
          </label>
          <label>
            <span>模型 / 引擎</span>
            <input
              value={s.translate.baseUrl}
              onChange={(e) => setTranslate({ baseUrl: e.target.value })}
              placeholder="（可选）付费接口地址"
            />
          </label>
          <label className="wide">
            <span>API Key</span>
            <input
              type="password"
              value={s.translate.apiKey}
              onChange={(e) => setTranslate({ apiKey: e.target.value })}
              placeholder="选用自有接口时填写"
            />
          </label>
        </div>
      </section>

      {/* 数据备份 */}
      <section className="card">
        <h3>数据备份</h3>
        <p className="muted hint">所有数据都存本机，建议定期备份。换电脑或在别处使用时可导入还原。</p>
        <div className="form-grid">
          <label className="wide">
            <span>备份目标文件夹</span>
            <input
              value={backupDir || s.backup.targetDir}
              onChange={(e) => {
                setBackupDir(e.target.value);
                setBackup({ targetDir: e.target.value });
              }}
              placeholder="留空则使用下方自动备份目录"
            />
          </label>
        </div>
        <button className="primary" disabled={!backupDir?.trim()} onClick={() => void backupNow(backupDir.trim())}>
          立即手动备份
        </button>

        <h4 className="sub-title">自动备份</h4>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={s.backup.auto}
            onChange={(e) => setBackup({ auto: e.target.checked })}
          />
          <span>启用自动定期备份</span>
        </label>
        <div className="form-grid">
          <label>
            <span>备份周期（天）</span>
            <input
              type="number"
              min={1}
              value={s.backup.intervalDays}
              onChange={(e) => setBackup({ intervalDays: Number(e.target.value) })}
            />
          </label>
          <label className="wide">
            <span>自动备份目录</span>
            <input
              value={s.backup.targetDir}
              onChange={(e) => setBackup({ targetDir: e.target.value })}
              placeholder="例如 D:\法律备份"
            />
          </label>
        </div>
        {s.backup.auto && !s.backup.targetDir.trim() && (
          <p className="warn">已启用自动备份，但尚未设置自动备份目录，请填写上方目录。</p>
        )}

        <h4 className="sub-title">还原</h4>
        <div className="form-grid">
          <label className="wide">
            <span>备份文件路径</span>
            <input
              value={restoreFile}
              onChange={(e) => setRestoreFile(e.target.value)}
              placeholder="选择之前备份生成的 .db 文件完整路径"
            />
          </label>
        </div>
        <button className="primary danger" disabled={!restoreFile.trim()} onClick={() => void restore(restoreFile.trim())}>
          从备份还原
        </button>
        <p className="muted hint">还原会用备份文件覆盖当前数据库，操作前请先手动备份一次。</p>
      </section>

      {/* 偏好设置 */}
      <section className="card">
        <h3>其它偏好</h3>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={s.defaultDesktopPopup}
            onChange={(e) => setDefaultPopup(e.target.checked)}
          />
          <span>新建待办默认启用桌面弹窗提醒</span>
        </label>
      </section>

      {/* 提示 */}
      {msg && (
        <div className={`settings-msg ${msg.type}`} onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}
    </div>
  );
}