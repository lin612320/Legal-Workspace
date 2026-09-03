// 开发模式一键启动：Vite 前端 + floating-ball 悬浮球（子进程模式）
// spawn 用 detached + CREATE_BREAKAWAY_FROM_JOB 脱离父进程，双方互不影响
const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BALL_DIR = path.resolve(ROOT, 'floating-ball');

// 启动前清理残留 Vite 进程（端口 TIME_WAIT / 旧 vite 没退出）
function killPort(port) {
  if (process.platform !== 'win32') return;
  try {
    // 找占用该端口的 PID（排除 TIME_WAIT 状态的，那些会自动释放）
    const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8' });
    const pids = out.split('\n')
      .map((l) => l.trim().split(/\s+/).pop())
      .filter(Boolean);
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        console.log(`[port] 已清理占用 ${port} 的进程 ${pid}`);
      } catch {}
    }
  } catch {
    // 端口没被占用，正常
  }
}
killPort(1420);

// 找 Electron 可执行文件（和 Rust 端 resolve_electron 一致）
function resolveElectron() {
  const dev = path.join(BALL_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(dev)) return dev;
  const unpacked = path.join(BALL_DIR, 'dist', 'win-unpacked', '悬浮球助手.exe');
  if (fs.existsSync(unpacked)) return unpacked;
  const portable = path.join(BALL_DIR, 'dist', '悬浮球助手 1.0.0.exe');
  if (fs.existsSync(portable)) return portable;
  return null;
}

const electron = resolveElectron();
if (electron) {
  console.log(`[ball] 启动悬浮球: ${electron}`);
  const flags = {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  };
  const proc = spawn(electron, [BALL_DIR, '--child'], flags);
  proc.unref();
  proc.on('error', (e) => console.warn(`[ball] 启动失败: ${e.message}`));
} else {
  console.warn('[ball] 找不到 Electron 可执行文件，跳过自动拉起悬浮球');
  console.warn(`[ball] 请确认 ${BALL_DIR} 下已执行 npm install 或 npm run dist`);
}

// 启动 Vite（带 BALL_BRIDGE=1 启用 HMR 桥接插件）
// Windows 下 spawn 要加 .cmd 后缀，或用 cmd /c
const isWin = process.platform === 'win32';
const viteProc = isWin
  ? spawn('cmd', ['/c', 'npx vite'], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: false,
      env: { ...process.env, BALL_BRIDGE: '1' }
    })
  : spawn('npx', ['vite'], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: false,
      env: { ...process.env, BALL_BRIDGE: '1' }
    });

viteProc.on('exit', (code) => process.exit(code ?? 0));
viteProc.on('error', (e) => { console.error(e); process.exit(1); });
