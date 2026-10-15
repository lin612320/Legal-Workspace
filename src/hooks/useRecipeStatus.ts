// 配方状态数据层（R4-P0-4 触点 2 · 与 useTodos / useDocuments 同构）。
//
// 为什么要单独一个 hook 而不是在 Home.tsx 里直接调 loadRecipeState()：
//   1. 与现有模式一致 —— Home 的其它数据都走 hook（useTodos / useDocuments）
//   2. **浏览器预览环境（非 Tauri）必须有 available 判定**，
//      否则首页会尝试渲染一个本机根本没有的状态
//
// ⚠️ 纪律 D12：**无数据不得渲染状态**。
//    本 hook 把「不可用」与「未采纳过配方」都如实报出，
//    由调用方决定不渲染 —— 不得用占位文案撑场面。

import { useCallback, useEffect, useState } from "react";

import {
  EVT_RECIPE_CHANGED,
  activeVersion,
  loadParticipation,
  loadRecipeState,
  resetRecipe as resetRecipeStore,
  setParticipation as setParticipationStore,
  type Participation,
  type RecipeVersion,
} from "../lib/evolutionStore";

export interface RecipeStatus {
  /** 是否处于可读取环境（Tauri）且读取成功 */
  available: boolean;
  /** 当前生效的配方版本；`null` = 未采纳过任何配方（**不应渲染状态行**） */
  activeVersion: RecipeVersion | null;
  /** 参与意愿（三态） */
  participation: Participation;
  /** 参与意愿是否尚未选择过（true → 需要「首次使用时询问」） */
  needsAsk: boolean;
  loading: boolean;
  /** 恢复默认：把配方回退到基线 */
  resetRecipe: () => Promise<void>;
  /** 设置参与意愿 */
  setParticipation: (v: "on" | "off") => Promise<void>;
  /** 手动重新读取 */
  refresh: () => Promise<void>;
}

/**
 * 读取本机配方状态与参与意愿。
 *
 * 非 Tauri 环境（浏览器预览）：`available = false`，调用方应整段不渲染。
 * 读取失败：同样 `available = false` —— **失败时偏向不展示，而不是展示占位**。
 */
export function useRecipeStatus(): RecipeStatus {
  const [available, setAvailable] = useState(false);
  const [ver, setVer] = useState<RecipeVersion | null>(null);
  const [participation, setPart] = useState<Participation>("unset");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [{ state, available: ok }, p] = await Promise.all([
      loadRecipeState(),
      loadParticipation(),
    ]);
    setAvailable(ok);
    setVer(ok ? activeVersion(state) : null);
    setPart(p);
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ state, available: ok }, p] = await Promise.all([
        loadRecipeState(),
        loadParticipation(),
      ]);
      if (!alive) return;
      setAvailable(ok);
      setVer(ok ? activeVersion(state) : null);
      setPart(p);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 采纳 / 回滚 / 恢复默认 / 参与意愿变化后重新对齐，
  // 避免「刚采纳了配方，首页却说没优化过」这类过期显示。
  useEffect(() => {
    const sync = () => {
      void refresh();
    };
    window.addEventListener(EVT_RECIPE_CHANGED, sync);
    return () => {
      window.removeEventListener(EVT_RECIPE_CHANGED, sync);
    };
  }, [refresh]);

  const resetRecipe = useCallback(async () => {
    await resetRecipeStore();
    await refresh();
  }, [refresh]);

  const setParticipation = useCallback(
    async (v: "on" | "off") => {
      await setParticipationStore(v);
      await refresh();
    },
    [refresh],
  );

  return {
    available,
    activeVersion: ver,
    participation,
    // 只有「从未选择过」才需要询问；明确选过 off 就不再问
    needsAsk: participation === "unset",
    loading,
    resetRecipe,
    setParticipation,
    refresh,
  };
}
