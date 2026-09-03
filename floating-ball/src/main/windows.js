// 窗口管理：悬浮球 + 小窗 + 桌宠气泡 + 皮肤选择窗口
const { BrowserWindow, screen, shell, Menu } = require('electron');
const path = require('path');
const { getBallSkin, getPanelTheme } = require('./skins');

// 编辑菜单（用于透明无边框窗口内支持 Ctrl+C/V/X/A）
function buildEditMenu() {
  return Menu.buildFromTemplate([
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' }
  ]);
}

let ballWin = null;
let panelWin = null;
let bubbleWin = null;
let skinPickerWin = null;
let panelVisible = false;

function getBall() { return ballWin; }
function getPanel() { return panelWin; }
function getBubble() { return bubbleWin; }
function getSkinPicker() { return skinPickerWin; }
function isPanelVisible() { return panelVisible; }

// 把渲染层 console / preload 错误转发到 stdout，便于诊断
function attachLog(win, tag) {
  if (!win) return;
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[${tag}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('preload-error', (_e, p, error) => {
    console.log(`[${tag} preload-error] ${error && error.message ? error.message : String(error)}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[${tag} did-fail-load] ${code} ${desc}`);
  });
}

function createBall(config, onBallClick) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const size = 56;
  let x = Math.round(sw - size - 24);
  let y = Math.round(sh - size - 24);
  if (config.ballPos) { x = config.ballPos.x; y = config.ballPos.y; }

  ballWin = new BrowserWindow({
    width: size, height: size, x, y,
    frame: false, transparent: true, resizable: false,
    maximizable: false, minimizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ball-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ballWin.setAlwaysOnTop(true, 'floating');
  ballWin.loadFile(path.join(__dirname, '..', 'renderer', 'ball.html'));
  attachLog(ballWin, 'ball');

  // 悬浮球右键菜单：隐藏 / 退出
  ballWin.webContents.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate([
      { label: '隐藏悬浮球', click: () => { hideBall(); } },
      { type: 'separator' },
      { label: '退出应用', click: () => { require('./main').quitApp(); } }
    ]).popup({ window: ballWin, x: params.x, y: params.y });
  });

  ballWin.once('ready-to-show', () => { ballWin.show(); applySkinToBall(config); });
  ballWin.on('moved', () => {
    const b = ballWin.getBounds();
    config.ballPos = { x: b.x, y: b.y };
  });
  ballWin._onBallClick = onBallClick;
  return ballWin;
}

function createBubble() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;
  bubbleWin = new BrowserWindow({
    width: 220, height: 80, frame: false, transparent: true,
    resizable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bubble-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubbleWin.setAlwaysOnTop(true, 'floating');
  bubbleWin.setIgnoreMouseEvents(true, { forward: false });
  bubbleWin.loadFile(path.join(__dirname, '..', 'renderer', 'bubble.html'));
  attachLog(bubbleWin, 'bubble');
  return bubbleWin;
}

function showBubble(text) {
  if (!bubbleWin) createBubble();
  if (!ballWin || ballWin.isDestroyed()) return;
  const b = ballWin.getBounds();
  const BW = 220, BH = 80;
  let x = b.x + b.width / 2 - BW / 2;
  let y = b.y - BH - 8;
  if (y < 4) y = b.y + b.height + 8;
  const sw = screen.getPrimaryDisplay().size.width;
  x = Math.max(4, Math.min(x, sw - BW - 4));
  bubbleWin.setBounds({ x: Math.round(x), y: Math.round(y), width: BW, height: BH });
  bubbleWin.webContents.send('bubble:text', text);
  if (!bubbleWin.isVisible()) bubbleWin.showInactive();
}

function hideBubble() {
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('bubble:hide');
    bubbleWin.hide();
  }
}

function updateBubblePosition() {
  if (!bubbleWin || !ballWin || bubbleWin.isDestroyed() || ballWin.isDestroyed()) return;
  if (!bubbleWin.isVisible()) return;
  const b = ballWin.getBounds();
  const BW = 220, BH = 80;
  let x = b.x + b.width / 2 - BW / 2;
  let y = b.y - BH - 8;
  if (y < 4) y = b.y + b.height + 8;
  const sw = screen.getPrimaryDisplay().size.width;
  x = Math.max(4, Math.min(x, sw - BW - 4));
  bubbleWin.setBounds({ x: Math.round(x), y: Math.round(y), width: BW, height: BH });
}

function createPanel(config) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const w = config.panelWidth || 420;
  const h = Math.min(620, Math.round(workArea.height - 80));
  panelWin = new BrowserWindow({
    width: w, height: h,
    x: Math.max(8, workArea.x + 16),
    y: Math.round(workArea.y + (workArea.height - h) / 2),
    frame: false, transparent: true, resizable: true,
    minWidth: 320, minHeight: 360,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  attachLog(panelWin, 'panel');
  // 透明无边框窗口需要显式注册编辑菜单，否则 Ctrl+C/V 不工作
  panelWin.webContents.on('context-menu', (_e, params) => {
    buildEditMenu().popup({ window: panelWin, x: params.x, y: params.y });
  });
  panelWin.webContents.on('before-input-event', (e, input) => {
    if (!input.alt && !input.shift && (input.control || input.meta) && !input.suggested) {
      if (input.type === 'keyDown') {
        const wc = panelWin.webContents;
        if (input.key === 'a') wc.selectAll();
        else if (input.key === 'c') wc.copy();
        else if (input.key === 'v') wc.paste();
        else if (input.key === 'x') wc.cut();
      }
    }
  });
  panelWin.on('closed', () => { panelWin = null; panelVisible = false; });
  panelWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return panelWin;
}

function showPanel(config) {
  if (!panelWin) createPanel(config);
  panelVisible = true;
  panelWin.show(); panelWin.focus();
  applySkinToPanel(config);
  return panelWin;
}
function hidePanel() { if (panelWin) { panelVisible = false; panelWin.hide(); } }
function togglePanel(config) { if (panelVisible) hidePanel(); else showPanel(config); }

// 皮肤选择窗口（悬浮球独立皮肤页面）
function createSkinPicker(config) {
  if (skinPickerWin && !skinPickerWin.isDestroyed()) {
    skinPickerWin.show(); skinPickerWin.focus();
    skinPickerWin.webContents.send('apply-skin', config.skin);
    return skinPickerWin;
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  skinPickerWin = new BrowserWindow({
    width: 480, height: 520,
    x: Math.round(workArea.x + workArea.width / 2 - 240),
    y: Math.round(workArea.y + workArea.height / 2 - 260),
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'skin-picker-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  skinPickerWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  skinPickerWin.setAlwaysOnTop(true, 'floating');
  skinPickerWin.loadFile(path.join(__dirname, '..', 'renderer', 'skin-picker.html'));
  attachLog(skinPickerWin, 'skin-picker');
  skinPickerWin.once('ready-to-show', () => {
    skinPickerWin.show(); skinPickerWin.focus();
    skinPickerWin.webContents.send('apply-skin', config.skin);
  });
  skinPickerWin.on('closed', () => { skinPickerWin = null; });
  return skinPickerWin;
}

// 应用球皮肤
function applySkinToBall(config) {
  if (ballWin && !ballWin.isDestroyed()) {
    const skin = getBallSkin(config.skin);
    ballWin.webContents.send('apply-skin', skin);
  }
}

// 应用面板主题（深色/白色）
function applySkinToPanel(config) {
  if (panelWin && !panelWin.isDestroyed()) {
    const theme = getPanelTheme(config.theme || 'dark');
    panelWin.webContents.send('apply-theme', theme);
  }
}

function sendToPanel(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(channel, payload);
}

function destroyAll() {
  if (bubbleWin) bubbleWin.destroy();
  if (skinPickerWin) skinPickerWin.destroy();
  if (panelWin) panelWin.destroy();
  if (ballWin) ballWin.destroy();
  bubbleWin = skinPickerWin = panelWin = ballWin = null;
  panelVisible = false;
}

function hideBall() {
  if (ballWin) ballWin.hide();
  hideBubble();
  hidePanel();
}
function showBall(config) {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.show();
    // 如果面板已存在，一起显示；不存在时不设置 panelVisible（等点击球时创建）
    if (panelWin && !panelWin.isDestroyed()) {
      panelVisible = true;
      panelWin.show();
      panelWin.focus();
    }
  }
}

module.exports = {
  createBall, createBubble, createPanel, createSkinPicker,
  showPanel, hidePanel, togglePanel,
  showBall, hideBall,
  applySkinToBall, applySkinToPanel,
  sendToPanel, showBubble, hideBubble, updateBubblePosition,
  getBall, getPanel, getBubble, getSkinPicker,
  isPanelVisible, destroyAll
};
