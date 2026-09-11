import { useState } from "react";
import { useSettings } from "../hooks/useSettings";

export default function Settings() {
  const { s, setAI, setBackup, setDefaultPopup, backupNow, restore, msg, setMsg } = useSettings();
  const [backupDir, setBackupDir] = useState("");
  const [restoreFile, setRestoreFile] = useState("");

  return (
    <div className="settings-page">
      {!s.loaded && <p className="muted">加载中…</p>}

      {/* AI 接口配置（文书智能体 / 翻译 / 文档翻译 / 多模态转录共用） */}
      <section className="card">
        <h3>AI 接口配置（文书智能体 / 翻译共用）</h3>
        <p className="muted hint">
          OpenAI 兼容接口，供「文书智能体」规划/执行、「翻译」文本翻译与「文档全文翻译」（含 PDF / 图片转录）统一使用。
          留空则智能体进入演示模式（翻译不可用）。DeepSeek 示例：base_url 填 https://api.deepseek.com/v1，模型填 deepseek-chat。
        </p>
        <div className="form-grid">
          <label>
            <span>接口地址 base_url</span>
            <input
              value={s.ai.baseUrl}
              onChange={(e) => setAI({ baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
            />
          </label>
          <label>
            <span>模型名</span>
            <input
              value={s.ai.model}
              onChange={(e) => setAI({ model: e.target.value })}
              placeholder="deepseek-chat（视觉/文件输入模型如 gpt-4o、qwen-vl-max）"
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

      {/* 翻译说明：不再单独配置通道 */}
      <section className="card">
        <h3>翻译说明</h3>
        <p className="muted hint">
          翻译不再提供内置免费接口（国内网络不可达且译文不可控），已统一改为调用上面的 AI 接口：
        </p>
        <ul className="muted hint" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.9 }}>
          <li>文本翻译：长文档自动按段落分块，逐段流式输出。</li>
          <li>文档全文翻译：docx / pptx / xlsx / txt 等在本地提取文本，原件不上传；pdf 与图片由模型转录（标注「非原文」）后再翻译。</li>
          <li>译文可导出为 Word（.docx）或 Markdown，并记入首页「最近处理的文书」。</li>
          <li>如需解析 PDF / 图片，请把模型名换成支持文件或视觉输入的模型（如 gpt-4o、qwen-vl-max）。</li>
        </ul>
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