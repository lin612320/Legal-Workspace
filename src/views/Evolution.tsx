// `/evolution` 深链页 —— **用户面板**，不是机制页。
//
// 隐式化（R4-P0-5）把「自我进化」从一级导航撤下，并按信息分层拆成三处隐式触点：
//   触点 1 · 设置页「数据与隐私」→ 参与开关 + 恢复默认 + 参数明细
//   触点 2 · 首页一行状态          → 「已根据你最近 N 次任务优化默认流程」
//   触点 3 · 文书智能体计划卡       → 「已按你的习惯，把「X」降为可选」
//
// 本页是**深链**（不进导航，见 src/nav.ts 与 App.tsx 的注释），
// 只承担两件事：
//   ① 让用户在一个地方看清「本机被调整过什么」并**能撤销**
//   ② 答辩时可直接直达，不必在导航里多一个入口
//
// ⚠️ 原来 926 行的「机制页」（六段管线卡 / 差分隐私与 K 匿名 / 加权平均公式 /
//    RL 对照段）**没有删除**，而是按纪律 D11「隐式 ≠ 删除」分层处理：
//      · 全部机制与边界表述已归档到 `docs/12-联邦配方进化方案.md`
//      · 完整实验台保留在 `src/evolution-lab/EvolutionLab.tsx`
//        （该目录不在 UI 文案扫描范围内，供答辩 / 内部研究直达）
//      · 用户侧只留「控制 + 状态」，不解释实现

import { Link } from "react-router-dom";

import RecipeParamsDetails from "../components/RecipeParamsDetails";
import { useRecipeStatus } from "../hooks/useRecipeStatus";

export default function Evolution() {
  const recipe = useRecipeStatus();

  return (
    <div className="evolution-page">
      <section className="card">
        <h2 style={{ marginTop: 0 }}>我的使用偏好</h2>
        <p className="muted hint">
          法元会在本机记录你的使用习惯，用于调整默认工作流——比如把你不常走的步骤降为可选、
          把常用的检索词提前。<strong>所有数据与文书都留在本机。</strong>
        </p>

        {!recipe.available && (
          <p className="muted hint">当前环境无法读取本机偏好（浏览器预览模式下不可用）。</p>
        )}

        {recipe.available && (
          <>
            {recipe.activeVersion ? (
              <p>
                当前生效版本：<strong>v{recipe.activeVersion.version}</strong>
                <span className="muted">
                  {" "}
                  （采纳于 {new Date(recipe.activeVersion.adopted_at).toLocaleString()}）
                </span>
              </p>
            ) : (
              <p className="muted">
                当前<strong>未</strong>采纳任何调整，全部使用默认工作流。
              </p>
            )}

            <p className="muted hint">
              参与匿名聚合：
              {recipe.participation === "on"
                ? "已参与"
                : recipe.participation === "off"
                  ? "已选择不参与"
                  : "尚未选择（按不参与处理）"}
              {" · "}
              <Link to="/settings">前往「数据设置 → 数据与隐私」调整</Link>
            </p>

            <RecipeParamsDetails />
          </>
        )}
      </section>

      <section className="card">
        <h3>想要看实现细节？</h3>
        <p className="muted hint">
          本页面向日常使用，只展示「被调整了什么、能否撤销」。
          机制说明、边界声明与算法口径<strong>完整保留在文档中</strong>，
          不在这里向使用者展开：
        </p>
        <ul className="muted hint" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.9 }}>
          <li>项目文档中的《联邦配方进化方案》—— 完整机制、边界与口径说明</li>
          <li>
            <code>src/evolution-lab/</code> —— 完整实验台（内部研究 / 答辩直达）
          </li>
        </ul>
      </section>
    </div>
  );
}
