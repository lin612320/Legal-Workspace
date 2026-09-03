import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

// floating-ball 项目根目录
const BALL_DIR = path.join(os.homedir(), "Desktop", "floating-ball");

// 找 Electron 可执行文件（和 Rust 端 resolve_electron 一致）
function resolveElectron(): string | null {
  const dev = path.join(BALL_DIR, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(dev)) return dev;
  const unpacked = path.join(BALL_DIR, "dist", "win-unpacked", "悬浮球助手.exe");
  if (fs.existsSync(unpacked)) return unpacked;
  const portable = path.join(BALL_DIR, "dist", "悬浮球助手 1.0.0.exe");
  if (fs.existsSync(portable)) return portable;
  return null;
}

// spawn 悬浮球（仅在没在跑时，用 spawn 方式；单实例锁保证不重复）
let spawned = false;
function ensureBallRunning() {
  if (spawned) return true;
  const electron = resolveElectron();
  if (!electron) {
    console.warn("[ball-bridge] 找不到 Electron 可执行文件，无法自动启动悬浮球");
    return false;
  }
  console.log(`[ball-bridge] 自动启动悬浮球: ${electron}`);
  try {
    const proc = spawn(electron, [BALL_DIR, "--child"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    proc.unref();
    spawned = true;
    proc.on("error", () => { spawned = false; });
    proc.on("exit", () => { spawned = false; });
    return true;
  } catch (e) {
    console.warn(`[ball-bridge] 启动悬浮球失败: ${(e as Error).message}`);
    return false;
  }
}

// 纯 JS 桥接轮询插件
// 双向：读 to-workbench.json 推给浏览器；浏览器发命令 → Vite spawn 悬浮球 + 写控制文件
function ballBridgePlugin(): Plugin {
  const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const BRIDGE_FILE = path.join(APPDATA, "floating-ball", "to-workbench.json");
  const CTRL_FILE = path.join(APPDATA, "floating-ball", "from-workbench.json");
  let lastTs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    name: "ball-bridge-poller",
    configureServer(server) {
      console.log(`[ball-bridge] 监听 ${BRIDGE_FILE}`);
      console.log(`[ball-bridge] 控制端点 POST /__ball_cmd__ → 悬浮球进程`);

      // 1. floating-ball → 律政：轮询桥接文件推给浏览器
      timer = setInterval(() => {
        try {
          if (!fs.existsSync(BRIDGE_FILE)) return;
          const content = fs.readFileSync(BRIDGE_FILE, "utf8");
          const msg = JSON.parse(content);
          if (msg.ts && msg.ts > lastTs) {
            lastTs = msg.ts;
            server.hot.send("ball-push", {
              text: msg.text ?? "",
              action: msg.action ?? "prefill",
              ts: msg.ts,
            });
            try { fs.unlinkSync(BRIDGE_FILE); } catch {}
          }
        } catch {
          // 文件不存在 / JSON 错误都是正常情况
        }
      }, 1200);

      // 2. 律政 → floating-ball：收到命令时先确保悬浮球活着，再写控制文件
      server.middlewares.use("/__ball_cmd__", async (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

          // 先启动悬浮球（如果没在跑）
          const started = ensureBallRunning();
          if (!started && body.cmd !== "quit") {
            res.statusCode = 503;
            res.end(JSON.stringify({ ok: false, error: "悬浮球无法启动" }));
            return;
          }

          // 写控制文件，悬浮球轮询到后执行
          fs.writeFileSync(CTRL_FILE, JSON.stringify(body, null, 2), "utf8");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    },
    closeServer() {
      if (timer) clearInterval(timer);
    },
  };
}

const plugins: Plugin[] = [react(), ballBridgePlugin()];

export default defineConfig({
  plugins,
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
