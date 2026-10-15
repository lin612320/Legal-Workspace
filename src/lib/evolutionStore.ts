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
//    「配方被执行链路消费」（即行为真的随配方改变）是 EV2，**尚未实现**。
//    因此本模块导出的 `RECIPE_CONSUMED_BY_AGENT = false`，
//    UI 必须据此选择文案，不得宣称行为已改变。

import { invokeStrict, isTauri } from "./tauri";
import type { RecipeManifest } from "./evolution";

/** 配方状态在 `settings` 表中的键 */
export const RECIPE_STATE_KEY = "evolution.recipe_state";

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
