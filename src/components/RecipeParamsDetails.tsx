// 配方参数接入情况明细（**共享组件**）。
//
// 来源：`src/lib/recipe.ts` 的 `RECIPE_CONSUMPTION` —— 一张**逐字段的事实清单**，
// 声明每个派生参数是否真的被执行链路读取，并由 `tests/recipe.test.ts` 的
// 「登记表 ↔ 源码一致性」断言与 `agent.ts` 保持一致。
//
// 为什么抽成组件（而不是在两处各写一遍）：
//   隐式化把这段从 `/evolution` 页「搬」到设置页的折叠区（纪律 D11：**搬移 ≠ 删改**），
//   而 `/evolution` 深链仍要保留同样内容供答辩展示。
//   两处渲染同一份事实清单，才不会出现「一处说已接入、另一处说没有」的分裂。
//
// ⚠️ 纪律 D12：`wired: false` 的字段**必须继续被如实报出**，
//    不得因为「搬到折叠里了」就省掉这句话。

import { RECIPE_CONSUMPTION, unconsumedFields } from "../lib/recipe";

export default function RecipeParamsDetails() {
  const all = Object.entries(RECIPE_CONSUMPTION);
  const wiredCount = all.filter(([, info]) => info.wired).length;

  return (
    <details className="recipe-params">
      <summary>
        查看已调整的参数（执行链路接入 {wiredCount}/{all.length}）
      </summary>
      <ul>
        {all.map(([field, info]) => (
          <li key={field}>
            <code>{field}</code>
            {" — "}
            {info.wired ? "✓ 已接入执行链路" : "○ 尚未接入"}
            {info.note ? `：${info.note}` : ""}
          </li>
        ))}
        {unconsumedFields().length > 0 && (
          <li className="recipe-params-warn">
            未接入的 {unconsumedFields().length} 项仅为派生值，
            <strong>当前不会</strong>改变文书生成行为。
          </li>
        )}
      </ul>
    </details>
  );
}
