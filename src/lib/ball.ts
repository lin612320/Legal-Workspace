// Electron 悬浮球调用封装
//
// 三模式自适应：
//   1. Tauri 桌面模式 → Rust 端 spawn + 文件轮询 → Tauri event 推送
//   2. Vite 浏览器模式 → 写反向控制文件 → floating-ball 轮询执行
//   3. 纯浏览器（无桥接） → 所有函数静默跳过

import { callRust, isTauri } from "./tauri";
import { listen } from "@tauri-apps/api/event";

/** 律政 → 悬浮球 反向控制文件路径（和 floating-ball main.js 一致） */
const CTRL_FILE = `${import.meta.env.APPDATA || ""}/floating-ball/from-workbench.json`;

// HMR 模式下拿不到 APPDATA，用 vite-ball-bridge 共享同一目录思路
// 这里直接写绝对路径（前端访问不了文件系统，所以用 fetch 调 Vite 插件来写）
async function sendBallCmd(cmd: string, extra: Record<string, unknown> = {}) {
  if (isTauri()) return; // Tauri 走 Rust invoke，不进这里
  // Vite 模式：通过 fetch POST 给 Vite 插件，插件写控制文件
  try {
    await fetch("/__ball_cmd__", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ts: Date.now(), cmd, ...extra }),
    });
  } catch {
    // fetch 失败说明 Vite 没启 ball 插件，静默跳过
  }
}

/** 启动悬浮球（Tauri 模式直接 spawn；Vite 模式由 dev:all 提前拉起） */
export async function ballStart() {
  if (!isTauri()) return;
  await callRust<void>("ball_start_cmd");
}

/** 让悬浮球显示到桌面（打开面板） */
export async function ballShow() {
  if (isTauri()) {
    await callRust<void>("ball_show");
  } else {
    await sendBallCmd("show");
  }
}

/** 隐藏悬浮球面板（进程不退出） */
export async function ballHide() {
  if (isTauri()) {
    await callRust<void>("ball_hide");
  } else {
    await sendBallCmd("hide");
  }
}

/** 让悬浮球直接跑 AI 翻译 */
export async function ballTranslate(text: string, target = "英文") {
  if (isTauri()) {
    await callRust<void>("ball_translate", { text, target });
  } else {
    await sendBallCmd("prefill", { text });
  }
}

/** 彻底退出悬浮球进程 */
export async function ballQuit() {
  if (isTauri()) {
    await callRust<void>("ball_quit");
  } else {
    await sendBallCmd("quit");
  }
}

// ---------------------------------------------------------------------------
// floating-ball → 律政工作台 推送监听（双模式）
// ---------------------------------------------------------------------------

export interface BallPushPayload {
  text: string;
  action: string; // prefill | translate | ask
  ts: number;
}

/**
 * 监听 floating-ball 推送过来的文字
 * 自动适配 Tauri event / Vite HMR / 静默跳过
 */
export async function onBallPush(handler: (payload: BallPushPayload) => void) {
  // 1. Tauri 桌面模式
  if (isTauri()) {
    const unlisten = await listen<BallPushPayload>("ball-push", (e) => {
      handler(e.payload);
    });
    return unlisten;
  }

  // 2. Vite HMR 模式（dev:all 启用了 vite-ball-bridge 插件）
  // @ts-expect-error - import.meta.hot 是 Vite 专属
  if (import.meta.hot?.on) {
    // @ts-expect-error
    import.meta.hot.on("ball-push", (payload: BallPushPayload) => {
      handler(payload);
    });
    return () => { /* Vite HMR 不需要手动取消 */ };
  }

  // 3. 纯浏览器模式（无桥接）
  return () => {};
}
