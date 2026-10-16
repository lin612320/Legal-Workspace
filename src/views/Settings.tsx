import { useState } from "react";
import { useSettings } from "../hooks/useSettings";
import { useRecipeStatus } from "../hooks/useRecipeStatus";
import RecipeParamsDetails from "../components/RecipeParamsDetails";
import { callRust, isTauri } from "../lib/tauri";
import {
  computeRecipeCandidate,
  loadLocalTaskLog,
  type CandidateOutcome,
} from "../lib/evolution";
import { adoptRecipe } from "../lib/evolutionStore";
import { getRuntimeRecipeParams, refreshRuntimeRecipe } from "../lib/agent";

/** `adoptRecipe` 的第三个参数类型（`RecipeManifest`），从函数签名反推避免额外导入 */
type ManifestArg = Parameters<typeof adoptRecipe>[2];

export default function Settings() {
  const { s, setAI, setBackup, setDefaultPopup, backupNow, restore, msg, setMsg } = useSettings();
  const [backupDir, setBackupDir] = useState("");
  const [restoreFile, setRestoreFile] = useState("");
  const recipe = useRecipeStatus();
  const [recipeMsg, setRecipeMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---------- R6-P0-1：用户级「检查可用优化」 ----------
     为什么必须放在这里：`adoptRecipe` 原先只有实验台一处调用，而实验台在
     **两条深链之外**（#/evolution → #/evolution-lab），全仓没有导航入口。
     结果是三条隐式触点**永远不会亮**（首页状态行 / 计划卡标注 / 「恢复默认」按钮）——
     能撤销但不能采纳，而撤销的前提又永远不成立。
     放在设置页：用户本来就会来这里，且不需要把 /evolution 放回导航。 */
  const [optBusy, setOptBusy] = useState(false);
  /** null = 还没检查过 → **不渲染结果区**（D12） */
  const [optOutcome, setOptOutcome] = useState<CandidateOutcome | null>(null);

  const onCheckOptimization = async () => {
    setOptBusy(true);
    setOptOutcome(null);
    try {
      if (!isTauri()) {
        setOptOutcome({
          kind: "no_data",
          reason: "当前环境无法读取本机任务记录（浏览器预览模式下不可用）。",
        });
        return;
      }
      const log = await loadLocalTaskLog(callRust);
      const out = await computeRecipeCandidate(log, {
        currentParams: getRuntimeRecipeParams(),
      });
      setOptOutcome(out);
    } catch (e) {
      setOptOutcome({
        kind: "no_data",
        reason: `检查失败：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setOptBusy(false);
    }
  };

  const onApplyCandidate = async (manifest: ManifestArg) => {
    setOptBusy(true);
    try {
      // 落盘仍走 adoptRecipe（唯一写路径），随后刷新执行链路用的运行时参数
      await adoptRecipe(manifest.version, manifest.signature, manifest);
      await refreshRuntimeRecipe();
      await recipe.refresh();
      setOptOutcome(null);
      setRecipeMsg({ type: "ok", text: `已应用优化（v${manifest.version}）。下次任务即用新流程。` });
    } catch (e) {
      setRecipeMsg({ type: "err", text: `应用失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setOptBusy(false);
    }
  };

  const onSetParticipation = async (v: "on" | "off") => {
    setBusy(true);
    try {
      await recipe.setParticipation(v);
      setRecipeMsg({ type: "ok", text: v === "on" ? "已选择参与匿名聚合。" : "已选择不参与。" });
    } catch (e) {
      setRecipeMsg({ type: "err", text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const onResetRecipe = async () => {
    setBusy(true);
    try {
      await recipe.resetRecipe();
      setRecipeMsg({ type: "ok", text: "已恢复默认：编排参数回到基线。" });
    } catch (e) {
      setRecipeMsg({ type: "err", text: `恢复失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

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

      {/* 数据与隐私（隐式化触点 1 —— 隐私参与权的落点，底线项）
          ⚠️ 纪律 D13：开关默认**不参与**；从未选择过（unset）时主动询问，不得默认勾选。
          ⚠️ 纪律 D17（R6-P1-3）：环境不可用时**仍渲染本区块**并写明原因，
             不得整段静默消失。同一件事在 #/evolution 已明确说明，两页必须一致 ——
             「一句话都没有」会让用户以为功能被悄悄拿掉了。 */}
      <section className="card">
        <h3>数据与隐私</h3>
        {!recipe.available && (
          <p className="muted hint">
            当前环境无法读取本机偏好（浏览器预览模式下不可用）。
            本区块的参与开关、编排参数与恢复默认功能仅在桌面端可用。
          </p>
        )}
        {recipe.available && (
          <>
          <p className="muted hint">
            本机使用统计参与匿名聚合，用于改进默认工作流。
          </p>

          {recipe.needsAsk && (
            <p className="warn">
              你还没有选择过是否参与匿名聚合。在你选择之前，本机会按<strong>不参与</strong>处理。
            </p>
          )}

          <label className="toggle-row">
            <input
              type="radio"
              name="participation"
              checked={recipe.participation === "on"}
              disabled={busy}
              onChange={() => void onSetParticipation("on")}
            />
            <span>参与：允许上行<strong>计数类</strong>字段，用于改进默认工作流</span>
          </label>
          <label className="toggle-row">
            <input
              type="radio"
              name="participation"
              checked={recipe.participation !== "on"}
              disabled={busy}
              onChange={() => void onSetParticipation("off")}
            />
            <span>不参与（默认）</span>
          </label>

          <p className="muted hint">
            隐私承诺：只上行计数类字段，<strong>不包含文书原文</strong>。所有文书与任务数据始终留在本机。
          </p>

          <h4 className="sub-title">编排参数</h4>

          {/* R6-P0-1 · 用户级采纳入口（"控制"必须是双向的） */}
          <div className="recipe-check">
            <button
              className="primary"
              disabled={busy || optBusy || !recipe.available}
              onClick={() => void onCheckOptimization()}
            >
              {optBusy ? "正在检查…" : "检查可用优化"}
            </button>
            <span className="muted hint">
              依据本机任务记录计算，只读本机数据、不联网。
            </span>
          </div>

          {/* ⚠️ 纪律 D12：没检查过 → 整块不渲染 */}
          {optOutcome && (
            <div className="recipe-check-result">
              {optOutcome.kind === "no_data" ? (
                <p className="muted hint">暂无可用优化：{optOutcome.reason}</p>
              ) : (
                <>
                  <p>
                    可应用 <strong>v{optOutcome.value.manifest.version}</strong>
                    {optOutcome.value.decision.improved.length > 0 && (
                      <>（改善 {optOutcome.value.decision.improved.length} 项</>
                    )}
                    {optOutcome.value.decision.regressed.length > 0 ? (
                      <>，有 {optOutcome.value.decision.regressed.length} 项回退）</>
                    ) : (
                      <>，无回退）</>
                    )}
                  </p>
                  <p className="muted hint">
                    依据本机 <strong>{optOutcome.value.tasksConsidered}</strong> 个任务、
                    共 {optOutcome.value.realSamples} 条样本
                    {optOutcome.value.droppedBuckets > 0 &&
                      `；${optOutcome.value.droppedBuckets} 个样本量不足的分组未参与`}
                    。
                  </p>
                  {optOutcome.value.decision.reasons.length > 0 && (
                    <ul className="muted hint recipe-check-reasons">
                      {optOutcome.value.decision.reasons.slice(0, 4).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {!optOutcome.value.decision.adopt && (
                    <p className="warn">
                      该候选<strong>未通过采纳条件</strong>（无显著改善或存在回退），建议忽略。
                    </p>
                  )}
                  <div className="recipe-check-actions">
                    <button
                      className="primary"
                      disabled={optBusy || !optOutcome.value.decision.adopt}
                      onClick={() => void onApplyCandidate(optOutcome.value.manifest)}
                    >
                      应用
                    </button>
                    <button className="ghost-btn" disabled={optBusy} onClick={() => setOptOutcome(null)}>
                      忽略
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {recipe.activeVersion ? (
            <p className="muted hint">
              当前生效版本：v{recipe.activeVersion.version}
              （采纳于 {new Date(recipe.activeVersion.adopted_at).toLocaleString()}）
            </p>
          ) : (
            <p className="muted hint">当前未采纳任何编排配方，全部参数为基线值。</p>
          )}
          <button className="primary" disabled={busy || !recipe.activeVersion} onClick={() => void onResetRecipe()}>
            恢复默认（回到基线参数）
          </button>

          <RecipeParamsDetails />
          </>
        )}
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

      {/* 隐私/配方操作结果提示（与上方 msg 分开，避免互相覆盖） */}
      {recipeMsg && (
        <div className={`settings-msg ${recipeMsg.type}`} onClick={() => setRecipeMsg(null)}>
          {recipeMsg.text}
        </div>
      )}
    </div>
  );
}