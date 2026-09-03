// 配置管理：持久化 AI Key、皮肤、悬浮球位置、快捷键等
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const configDir = app
  ? path.join(app.getPath('userData'))
  : __dirname;
const configFile = path.join(configDir, 'floating-ball-config.json');

const DEFAULT_CONFIG = {
  // AI 配置（OpenAI 兼容接口）
  ai: {
    baseURL: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-v4-flash',
    timeoutMs: 60000
  },
  // 球皮肤（BALL_SKINS 的 key）
  skin: 'aurora',
  // 面板主题（PANEL_THEMES 的 key）
  theme: 'dark',
  // 全局选词快捷键
  hotkey: 'Alt+Q',
  // 悬浮球位置（屏幕坐标），null 表示默认右下角
  ballPos: null,
  // 小窗宽度
  panelWidth: 420,
  // 是否随父项目启动（命令行 --child）
  childMode: false
};

function load() {
  try {
    if (fs.existsSync(configFile)) {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      // 深合并，保证新增字段有默认值
      return deepMerge(structuredClone(DEFAULT_CONFIG), data);
    }
  } catch (e) {
    console.error('读取配置失败:', e);
  }
  return structuredClone(DEFAULT_CONFIG);
}

function save(cfg) {
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error('写入配置失败:', e);
  }
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      target[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

module.exports = { load, save, DEFAULT_CONFIG, configFile };
