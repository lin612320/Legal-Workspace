// 配方进化的**持久化层**（EV1 / EV3 落地）。
//
// 为什么要这个文件：
//   原实现 `Evolution.tsx:293-304` 的 `decide()` 只做 `setAbState` + `setJournal`，
//   **零持久化、零后端调用**，但 UI 在采纳后宣称该配方已在运行中起作用——该表述不成立。
//
// 本层用 store 的 `settings_get` / `settings_set` 命令把「配方 + 版本历史 + 当前生效版本」
// 真正写进本机 SQLite（`settings` 表，key = `evolution.recipe_state`）。
// 写入失败会**抛出**（用 invokeStrict），让 UI 能如实显示失败，而不是假装成功。
//
// ⚠️ 边界（如实说明）：本层保证「采纳动作被持久化」。
//    「配方被执行链路消费」（即行为真的随配方改变）是 EV2 —— **已落地**（见下）。
//    ✅ 自 EV2 起 `RECIPE_CONSUMED_BY_AGENT = true`：
//       `src/lib/recipe.ts` 的 `deriveParams()` 把配方折算成运行时参数，
//       `src/lib/agent.ts` 在工具循环里真实读取（轮数上限 / 回填条数 / 检索词补充 / 弱化步骤）。
//    ⚠️ 但**并非全部派生字段都已接入**：`recipe.ts` 的 `RECIPE_CONSUMPTION` 是逐字段
//       事实清单（`auditPassFloor` / `minSamples` 仍为 `wired: false`），
//       由 `unconsumedFields()` 如实报出。UI 若展示「配方已生效」，
//       必须同时说明未接入的字段。

import { invokeStrict, isTauri } from "./tauri";
import type { RecipeManifest } from "./evolution";

/** 配方状态在 `settings` 表中的键 */
export const RECIPE_STATE_KEY = "evolution.recipe_state";

/**
 * 配方变更广播（与 `useTodos` 的 `workbench:todos-changed` 同构）。
 *
 * 为什么需要：采纳 / 回滚 / 恢复默认 之后，**首页状态行**与**设置页折叠明细**
 * 都是各自持有状态的实例。没有广播，它们要等整页刷新才会更新 ——
 * 用户会看到「刚采纳了配方，首页却说没优化过」这类过期数据。
 */
export const EVT_RECIPE_CHANGED = "workbench:recipe-changed";

/** 广播一次配方变更（内部使用，也供测试触发） */
export function notifyRecipeChanged(): void {
  try {
    window.dispatchEvent(new Event(EVT_RECIPE_CHANGED));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/**
 * 配方是否已被**执行链路**消费（EV2）。
 *
 * ✅ 自 EV2 落地起为 `true`：`src/lib/recipe.ts` 的 `deriveParams()` 会把配方折算成
 *    运行时参数，`src/lib/agent.ts` 在工具循环里真实读取
 *    （轮数上限 / 回填条数 / 检索词补充 / 弱化步骤）。
 *
 * ⚠️ 但**并非全部派生字段都已接入**。`recipe.ts` 的 `RECIPE_CONSUMPTION`
 *    是逐字段的事实清单（`auditPassFloor`、`minSamples` 仍为 `wired: false`），
 *    由 `unconsumedFields()` 如实报出。UI 若展示"配方已生效"，
 *    必须同时说明未接入的字段。
 */
export const RECIPE_CONSUMED_BY_AGENT = true;

/** 一版配方快照 */
export interface RecipeVersion {
  /** 版本号（与进化轮次对应） */
  version: number;
  /** 配方指纹（来自 manifest.signature） */
  signature: string;
  /** 采纳时间（ISO） */
  adopted_at: string;
  /** 配方参数（RecipeManifest 整体，含 plan_templates_update / qa_threshold_update 等） */
  recipe: RecipeManifest;
}

/** 持久化的配方状态 */
export interface RecipeState {
  /** 版本历史，最新的在前 */
  history: RecipeVersion[];
  /** 当前生效版本号；null 表示尚未采纳过任何版本 */
  active_version: number | null;
}

/** 空状态 */
export function emptyRecipeState(): RecipeState {
  return { history: [], active_version: null };
}

/**
 * 读取本机配方状态。
 *
 * - 非 Tauri 环境（浏览器预览）：返回空状态，并标记 `available: false`
 * - 未采纳过：返回空状态
 * - 数据损坏：返回空状态（不让坏数据把页面卡死）
 */
export async function loadRecipeState(): Promise<{ state: RecipeState; available: boolean }> {
  if (!isTauri()) {
    return { state: emptyRecipeState(), available: false };
  }
  try {
    const raw = await invokeStrict<string | null>("settings_get", { key: RECIPE_STATE_KEY });
    if (!raw) return { state: emptyRecipeState(), available: true };
    const parsed = JSON.parse(raw) as RecipeState;
    if (!parsed || !Array.isArray(parsed.history)) {
      console.warn("[evolution] 配方状态格式异常，已重置为空状态");
      return { state: emptyRecipeState(), available: true };
    }
    return { state: parsed, available: true };
  } catch (e) {
    // 读取失败不阻塞页面，但如实回报不可用
    console.error("[evolution] 读取配方状态失败：", e);
    return { state: emptyRecipeState(), available: false };
  }
}

/** 把状态写回本机。失败会抛出（调用方负责显示错误）。 */
async function persist(state: RecipeState): Promise<void> {
  await invokeStrict<void>("settings_set", {
    key: RECIPE_STATE_KEY,
    value: JSON.stringify(state),
  });
  // 写盘成功后才广播 —— 失败时广播会让其它页面读到未变更的状态，反而混乱
  notifyRecipeChanged();
}

/** 历史最多保留的版本数（超出丢弃最旧的） */
export const MAX_HISTORY = 10;

/**
 * **采纳**一版配方：把新版本压入历史并标记为生效，然后**真正写入本机**。
 *
 * @throws 写入失败时抛出（调用方必须据此显示失败，不得显示成功）
 */
export async function adoptRecipe(
  version: number,
  signature: string,
  recipe: RecipeManifest,
): Promise<RecipeState> {
  const { state } = await loadRecipeState();
  const entry: RecipeVersion = {
    version,
    signature,
    adopted_at: new Date().toISOString(),
    recipe,
  };
  const history = [entry, ...state.history.filter((h) => h.version !== version)]
    .slice(0, MAX_HISTORY);
  const next: RecipeState = { history, active_version: version };
  await persist(next);
  return next;
}

/**
 * **回滚**到上一版：把 `active_version` 指回历史里第二新的版本，然后真正写入。
 *
 * - 若历史里没有更早的版本，则把 `active_version` 置为 null（表示未采纳）
 * - 回滚**不删除**新版本记录（保留可追溯）
 *
 * @throws 写入失败时抛出
 */
export async function rollbackRecipe(): Promise<RecipeState> {
  const { state } = await loadRecipeState();
  const rest = state.history.filter((h) => h.version !== state.active_version);
  const nextActive = rest.length > 0 ? rest[0].version : null;
  const next: RecipeState = { history: state.history, active_version: nextActive };
  await persist(next);
  return next;
}

/** 取当前生效的版本快照（没有则 null） */
export function activeVersion(state: RecipeState): RecipeVersion | null {
  if (state.active_version === null) return null;
  return state.history.find((h) => h.version === state.active_version) ?? null;
}

/* ======================================================================
 * 参与意愿（R4-P0-2 触点 1 的底线项）
 * ----------------------------------------------------------------------
 * 本模块会涉及**本机使用统计的上行**（哪怕是加噪后的计数），
 * 用户的**参与 / 退出权**不能只写在文档里 —— 那是「告知」，不是「可行使」。
 * 所以设置页必须有一个**可点的、能持久化的**开关。
 *
 * 纪律 D13：**默认不参与**；首次使用时主动询问。
 * 实现方式用三态而非布尔：
 *   "unset" = 尚未选择 → 视为**不参与**，并需要向用户询问
 *   "on"    = 明确参与
 *   "off"   = 明确不参与
 * 这样「没选过」与「明确选了不参与」在数据上可区分，
 * UI 才能做到「首次询问」而不是「假装用户选过了」。
 * ==================================================================== */

/** 参与意愿在 `settings` 表中的键 */
export const PARTICIPATION_KEY = "evolution.participation";

/** 参与意愿三态；`unset` 在行为上等价于不参与，但需要询问 */
export type Participation = "unset" | "on" | "off";

/** 是否在**行为上**视为参与（只有明确 `on` 才算） */
export function isParticipating(p: Participation): boolean {
  return p === "on";
}

/**
 * 读取参与意愿。
 *
 * - 非 Tauri 环境 → `"unset"`（不会误判为已参与）
 * - 未设置 / 值非法 / 读取失败 → 一律 `"unset"`（**失败时偏向不参与**）
 */
export async function loadParticipation(): Promise<Participation> {
  if (!isTauri()) return "unset";
  try {
    const raw = await invokeStrict<string | null>("settings_get", { key: PARTICIPATION_KEY });
    if (raw === "on" || raw === "off") return raw;
    return "unset";
  } catch (e) {
    // 读不到就当作未选择（不参与），绝不默认上行
    console.error("[evolution] 读取参与意愿失败，按「未选择」处理：", e);
    return "unset";
  }
}

/**
 * 写入参与意愿（`on` / `off`）。
 *
 * @throws 写入失败时抛出 —— 调用方必须如实显示失败，不得假装已生效
 */
export async function setParticipation(v: "on" | "off"): Promise<void> {
  await invokeStrict<void>("settings_set", { key: PARTICIPATION_KEY, value: v });
  // 参与意愿变化也会影响设置页/首页的呈现，一并广播
  notifyRecipeChanged();
}

/**
 * **恢复默认**：把配方回退到基线（清空 `active_version`），并保留历史以便追溯。
 *
 * 注意与 `rollbackRecipe()` 的区别：
 *   - `rollbackRecipe()` 回退到**上一版**（历史里的前一版）
 *   - `resetRecipe()`    回退到**基线**（`active_version = null`，即不使用任何配方）
 *
 * @throws 写入失败时抛出
 */
export async function resetRecipe(): Promise<RecipeState> {
  const { state } = await loadRecipeState();
  const next: RecipeState = { history: state.history, active_version: null };
  await persist(next);
  return next;
}
