// 与 Rust 后端通信的辅助封装（Tauri v2 invoke）。

import { invoke } from "@tauri-apps/api/core";

/** 是否运行在 Tauri 桌面环境里（true 表示可由 Rust 后端提供服务） */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * 调用 Rust 侧命令。
 * - 在 Tauri 环境正常调用；
 * - 在纯浏览器/仅前端预览时返回 null，方便先用占位数据开发 UI。
 */
export async function callRust<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    return (await invoke<T>(cmd, args)) as T;
  } catch (e) {
    console.error(`[tauri] 调用 ${cmd} 失败：`, e);
    return null;
  }
}