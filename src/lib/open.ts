// 桌面交付物"打开/定位"辅助：直接 invoke 以区分成功与失败（callRust 会吞错误）。
// 浏览器预览环境返回 null（按钮由调用方按 isTauri 决定是否展示）。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

/** 用系统默认程序打开文件；成功返回 null，失败返回错误文本 */
export async function openPathFile(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    await invoke("open_file", { path });
    return null;
  } catch (e) {
    return String(e);
  }
}

/** 在资源管理器中定位文件；成功返回 null，失败返回错误文本 */
export async function revealPath(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    await invoke("reveal_in_folder", { path });
    return null;
  } catch (e) {
    return String(e);
  }
}
