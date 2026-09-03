// 小窗渲染逻辑
const $ = (id) => document.getElementById(id);
let taskId = 0; let running = false; let buffer = '';
let cfgCache = null;
let recordingHotkey = false;
let pendingHotkey = '';

// ---- 主题应用 ----
const THEMES = {
  dark: { name:'深色', bg:'linear-gradient(160deg,#161b22,#0d1117)', surface:'rgba(255,255,255,0.05)', border:'rgba(255,255,255,0.12)', text:'#e6edf3', muted:'#8b949e', accent:'#58a6ff', inputBg:'rgba(255,255,255,0.04)', codeBg:'rgba(0,0,0,0.35)', codeText:'#e6edf3' },
  light: { name:'白色', bg:'linear-gradient(160deg,#ffffff,#f0f2f5)', surface:'rgba(0,0,0,0.035)', border:'rgba(0,0,0,0.12)', text:'#1a1a1a', muted:'#6b7280', accent:'#2563eb', inputBg:'rgba(0,0,0,0.025)', codeBg:'rgba(0,0,0,0.06)', codeText:'#1a1a1a' }
};

function applyTheme(theme) {
  const r = document.documentElement.style;
  r.setProperty('--bg', theme.bg);
  r.setProperty('--surface', theme.surface);
  r.setProperty('--border', theme.border);
  r.setProperty('--text', theme.text);
  r.setProperty('--muted', theme.muted);
  r.setProperty('--accent', theme.accent);
  r.setProperty('--input-bg', theme.inputBg);
  r.setProperty('--code-bg', theme.codeBg);
  r.setProperty('--code-text', theme.codeText);
  $('btnTheme').textContent = theme.name === '白色' ? '☀' : '🌙';
}

function toggleTheme() {
  const next = cfgCache.theme === 'dark' ? 'light' : 'dark';
  cfgCache.theme = next;
  applyTheme(THEMES[next]); // 立即应用（之前缺这行）
  window.api.setTheme(next);
}

// ---- Markdown 渲染 ----
function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderMarkdown(md) {
  const parts = md.split(/```/); let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n'); let code = part;
      if (nl > -1) code = part.slice(nl + 1);
      html += `<pre><code>${escapeHtml(code)}</code></pre>`;
    } else { html += renderInline(part); }
  });
  return html;
}
function renderInline(text) {
  const lines = text.split(/\n/); let out = '';
  let inUl = false, inOl = false, para = [];
  const flushPara = () => {
    if (para.length) { out += `<p>${inlineFmt(para.join(' '))}</p>`; para = []; }
  };
  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (/^#{1,6}\s+/.test(line)) {
      flushPara(); if (inUl){out+='</ul>';inUl=false;} if (inOl){out+='</ol>';inOl=false;}
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      out += `<h${m[1].length}>${inlineFmt(m[2])}</h${m[1].length}>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      flushPara(); if (inOl){out+='</ol>';inOl=false;} if(!inUl){out+='<ul>';inUl=true;}
      out += `<li>${inlineFmt(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushPara(); if (inUl){out+='</ul>';inUl=false;} if(!inOl){out+='<ol>';inOl=true;}
      out += `<li>${inlineFmt(line.replace(/^\s*\d+\.\s+/, ''))}</li>`;
    } else if (line.trim() === '') {
      flushPara(); if (inUl){out+='</ul>';inUl=false;} if (inOl){out+='</ol>';inOl=false;}
    } else { para.push(line); }
  });
  flushPara(); if (inUl) out += '</ul>'; if (inOl) out += '</ol>';
  return out;
}
function inlineFmt(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}
function renderResult(appendCursor) {
  $('result').innerHTML = renderMarkdown(buffer) + (appendCursor ? '<span class="cursor"></span>' : '');
  $('result').scrollTop = $('result').scrollHeight;
}
function setStatus(t) { $('status').textContent = t || ''; }
function setRunning(v) {
  running = v; ['btnTranslate','btnAsk'].forEach((id) => ($(id).disabled = v));
}

// ---- AI 任务 ----
function startTask(kind, opts) {
  if (running) return;
  buffer = ''; renderResult(true); setRunning(true);
  const id = ++taskId; setStatus('生成中…');
  window.api.runTask(kind, opts, id);
}
window.api.onTaskChunk(({ id, chunk }) => { if (id !== taskId) return; buffer += chunk; renderResult(true); });
window.api.onTaskDone(({ id, aborted }) => {
  if (id !== taskId) return;
  setRunning(false); setStatus(aborted ? '已停止' : '完成'); renderResult(false);
});
window.api.onTaskError(({ id, message }) => {
  if (id !== taskId) return;
  setRunning(false); setStatus('出错');
  buffer += `\n\n> 错误：${message}`; renderResult(false);
});

window.api.onSelectionResult((text) => {
  if (text) { $('source').value = text; setStatus('已抓取选中文字'); }
  else setStatus('未抓取到文字（请先选中文本）');
});
window.api.onApplyTheme((theme) => applyTheme(theme));

window.api.onExternalRunTask(({ kind, opts }) => {
  const text = opts.text || opts.question || '';
  if (text) $('source').value = text;
  if (kind === 'translate' && opts.target) $('lang').value = opts.target;
  if (kind === 'relate') showRelatePlaceholder(opts.text);
  else startTask(kind, opts);
});

// ---- 按钮事件 ----
$('btnTranslate').addEventListener('click', () => {
  const text = $('source').value.trim();
  if (!text) { setStatus('请先输入/抓取文本'); return; }
  startTask('translate', { text, target: $('lang').value });
});

$('btnRelate').addEventListener('click', () => {
  const text = $('source').value.trim();
  if (!text) { setStatus('请先输入/抓取文本'); return; }
  showRelatePlaceholder(text);
});

function showRelatePlaceholder(text) {
  buffer = `> 关联查找 🗄（功能预留中）\n\n已选中文本：\`${text.slice(0, 60)}${text.length > 60 ? '…' : ''}\`\n\n关联查找后续将接入本地/远端数据库，支持：\n- 向量检索相似概念\n- 历史查找记录\n- 知识库关联推荐\n\n当前先用 AI 模拟一个关联结果：`;
  renderResult(true);
  startTask('relate', { text });
}

$('btnAsk').addEventListener('click', () => {
  const sourceText = $('source').value.trim();
  // 有选中文字 → 关联模式（显示上下文提示条）；无选中文字 → 纯询问模式
  if (sourceText) {
    $('askContextBar').style.display = 'block';
    $('askContextText').textContent = sourceText.length > 120 ? sourceText.slice(0, 120) + '…' : sourceText;
    $('askUseContext').checked = true; // 每次弹出默认启用关联
  } else {
    $('askContextBar').style.display = 'none';
  }
  $('askInput').value = '';
  $('askModal').classList.add('show');
  setTimeout(() => $('askInput').focus(), 100);
});
$('askCancel').addEventListener('click', () => $('askModal').classList.remove('show'));
$('askOk').addEventListener('click', () => {
  const q = $('askInput').value.trim();
  $('askModal').classList.remove('show');
  if (!q) { setStatus('问题不能为空'); return; }
  const sourceText = $('source').value.trim();
  // 有关联上下文且 checkbox 勾选 → 关联询问；否则 → 纯询问
  const useContext = sourceText && $('askUseContext').checked;
  if (useContext) {
    startTask('ask', { question: q, context: sourceText });
    setStatus('关联询问中…');
  } else {
    startTask('ask', { question: q, context: '' });
    setStatus('询问中…');
  }
});

$('btnStop').addEventListener('click', () => window.api.stopTask());
$('btnCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(buffer); setStatus('已复制'); }
  catch { setStatus('复制失败'); }
});

$('btnSkinPicker').addEventListener('click', () => window.api.openSkinPicker());
$('btnTheme').addEventListener('click', () => toggleTheme());
$('btnWorkbench').addEventListener('click', async () => {
  const text = $('source').value.trim() || '';
  const res = await window.api.pushToWorkbench(text, 'prefill');
  if (res?.ok) setStatus(text ? '已推送到律政工作台' : '已拉起律政工作台');
  else setStatus('操作失败：' + (res?.error || '未知错误'));
});
$('btnSettings').addEventListener('click', async () => {
  $('setDrawer').classList.toggle('open');
  if ($('setDrawer').classList.contains('open')) fillSettings();
});
$('btnClose').addEventListener('click', () => window.api.hidePanel());

// 顶栏拖动
const topBar = $('top'); let drag = null;
topBar.addEventListener('mousedown', (e) => {
  if (e.target.tagName === 'BUTTON') return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false }; topBar.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(e.screenX - drag.sx) > 3 || Math.abs(e.screenY - drag.sy) > 3) drag.moved = true;
  if (drag.moved && window.api.move) window.api.move(dx, dy);
});
window.addEventListener('mouseup', () => { if (drag) { topBar.classList.remove('dragging'); drag = null; } });

// ---- 设置抽屉 ----
const PROVIDERS = {
  deepseek:  { baseURL: 'https://api.deepseek.com',            model: 'deepseek-v4-flash' },
  openai:    { baseURL: 'https://api.openai.com/v1',                model: 'gpt-4o-mini' },
  dashscope: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu:     { baseURL: 'https://open.bigmodel.cn/api/paas/v4',     model: 'glm-4' },
  moonshot:  { baseURL: 'https://api.moonshot.cn/v1',               model: 'moonshot-v1-8k' },
  qwen:      { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  glm:       { baseURL: 'https://open.bigmodel.cn/api/paas/v4',     model: 'glm-4-plus' }
};

async function fillSettings() {
  if (!cfgCache) cfgCache = (await window.api.getState()).config;
  // 检测当前配置匹配哪个内置平台
  let matched = '';
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (cfgCache.ai.baseURL === p.baseURL) { matched = key; break; }
  }
  $('cfgProvider').value = matched;
  $('cfgBase').value = cfgCache.ai.baseURL || '';
  $('cfgKey').value = cfgCache.ai.apiKey || '';
  $('cfgModel').value = cfgCache.ai.model || '';
  $('hotkeyText').textContent = cfgCache.hotkey || 'Alt+Q';
  pendingHotkey = cfgCache.hotkey || 'Alt+Q';
}

// 选择平台自动填充
$('cfgProvider').addEventListener('change', () => {
  const key = $('cfgProvider').value;
  if (PROVIDERS[key]) {
    $('cfgBase').value = PROVIDERS[key].baseURL;
    $('cfgModel').value = PROVIDERS[key].model;
  }
});

// 快捷键录制
function keyToHotkey(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Cmd');
  // 跳过单独按修饰键（只按 Ctrl 不算快捷键）
  const hasMod = parts.length > 0;
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null;
  parts.push(key);
  return parts.join('+');
}

$('hotkeyRecord').addEventListener('click', () => {
  recordingHotkey = true;
  pendingHotkey = '';
  $('hotkeyText').textContent = '按下组合键…';
  $('hotkeyBox').classList.add('recording');
});
$('hotkeyReset').addEventListener('click', () => {
  pendingHotkey = 'Alt+Q';
  $('hotkeyText').textContent = pendingHotkey;
});

window.addEventListener('keydown', (e) => {
  if (!recordingHotkey) return;
  e.preventDefault();
  e.stopPropagation();
  const combo = keyToHotkey(e);
  if (combo) {
    pendingHotkey = combo;
    $('hotkeyText').textContent = combo;
    recordingHotkey = false;
    $('hotkeyBox').classList.remove('recording');
  }
}, true);

$('btnSave').addEventListener('click', async () => {
  const patch = { ai: {} };
  const baseURL = $('cfgBase').value.trim();
  const apiKey = $('cfgKey').value.trim();
  const model = $('cfgModel').value.trim();
  if (baseURL) patch.ai.baseURL = baseURL;
  if (apiKey) patch.ai.apiKey = apiKey;
  if (model) patch.ai.model = model;
  if (pendingHotkey) patch.hotkey = pendingHotkey;
  cfgCache = await window.api.saveConfig(patch);
  setStatus('设置已保存');
  $('setDrawer').classList.remove('open');
});

// 一键测试 Key
$('btnTest').addEventListener('click', async () => {
  const baseURL = $('cfgBase').value.trim() || cfgCache.ai.baseURL;
  const apiKey = $('cfgKey').value.trim() || cfgCache.ai.apiKey;
  if (!apiKey) { setStatus('请先填写 API Key'); return; }
  if (!baseURL) { setStatus('请先填写 API 地址'); return; }
  setStatus('测试中…');
  const r = await window.api.testKey({ baseURL, apiKey });
  setStatus(r.message);
});

// 初始化
(async function init() {
  const { config } = await window.api.getState();
  cfgCache = config;
  applyTheme(THEMES[config.theme || 'dark']);
  if (!config.ai.apiKey) setStatus('未配置 API Key，请点 ⚙ 填写');
})();
