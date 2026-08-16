/* N_m3u8DL-RE Web UI（fnOS index.cgi 轮询版，零依赖原生 JS） */
'use strict';

// 所有 API 通过相对 URL '?action=...' 调用当前 CGI（页面位于 .../index.cgi/ 下）
const API = (params) => '?' + new URLSearchParams(params).toString();
const $ = (id) => document.getElementById(id);

// ---------- 轻提示 / 确认（Bootstrap 组件；fnOS iframe 中 alert/confirm 可能被屏蔽） ----------
function uiToast(msg, type = 'danger') {
  const box = $('toast-box');
  if (!box) { console.error(msg); return; }
  const cls = type === 'success' ? 'text-bg-success' : type === 'warn' ? 'text-bg-warning' : 'text-bg-danger';
  const el = document.createElement('div');
  el.className = 'toast align-items-center ' + cls + ' border-0';
  el.setAttribute('role', 'alert');
  el.innerHTML = '<div class="d-flex"><div class="toast-body">' + esc(msg) + '</div>' +
    '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>';
  box.appendChild(el);
  const t = new bootstrap.Toast(el, { delay: 4500 });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}

// 确认弹窗（替代 confirm，返回 Promise<boolean>）
function uiConfirm(msg) {
  return new Promise((resolve) => {
    $('confirm-text').textContent = msg;
    const modal = new bootstrap.Modal($('confirmModal'));
    let done = false;
    const finish = (v) => { if (!done) { done = true; modal.hide(); resolve(v); } };
    $('confirm-yes').onclick = () => finish(true);
    $('confirm-no').onclick = () => finish(false);
    $('confirmModal').addEventListener('hidden.bs.modal', () => finish(false), { once: true });
    modal.show();
  });
}

const STATUS_TEXT = {
  queued: '排队中', running: '下载中', stopping: '停止中',
  success: '已完成', failed: '失败', stopped: '已停止',
};
const POLL_MS = 300; // 轮询间隔（轮询 CLI 日志，越快越接近实时）

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}
function fmtSpeed(s) { return s ? fmtSize(s) + '/s' : ''; }
function dirOf(p) { return String(p || '').replace(/\/[^/]*$/, '') || '/'; }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

let tasks = [];
let dir = '';

// ---------- 任务渲染（仅更新变化部分，避免 300ms 全量重绘导致按钮 hover 闪烁） ----------
function renderTasks() {
  const list = $('task-list');
  // 数量标识：只显示进行中（排队/下载/停止中）任务数，全部结束后隐藏
  const active = tasks.filter((t) => ['queued', 'running', 'stopping'].includes(t.status)).length;
  const countEl = $('task-count');
  countEl.textContent = active;
  countEl.classList.toggle('d-none', active === 0);
  if (!tasks.length) {
    list.innerHTML = '<p class="empty">暂无任务，在上方创建第一个下载任务吧。</p>';
    return;
  }
  // 清除可能残留的空状态提示
  list.querySelectorAll('.empty').forEach((e) => e.remove());
  const existing = new Set();
  tasks.forEach((t) => {
    existing.add(t.id);
    let card = $('task-' + t.id);
    if (!card) {
      // 新任务：创建卡片并绑定事件
      list.insertAdjacentHTML('beforeend', taskCard(t));
      card = $('task-' + t.id);
      wireTaskEvents(card, t);
    }
    updateTaskCard(card, t);
  });
  // 移除已不存在的卡片
  list.querySelectorAll('.task').forEach((card) => {
    if (!existing.has(card.id.replace(/^task-/, ''))) card.remove();
  });
}

function wireTaskEvents(card, t) {
  card.querySelector('.btn-stop')?.addEventListener('click', () => act({ action: 'stop', id: t.id }));
  card.querySelector('.btn-retry')?.addEventListener('click', () => retry(t));
  card.querySelector('.btn-del')?.addEventListener('click', async () => {
    if (await uiConfirm('确定删除任务「' + t.name + '」的记录吗？（不会删除已下载文件）')) act({ action: 'remove', id: t.id });
  });
  wireOpenButtons(card, t);
}

function taskBadge(t) {
  return t.status === 'running' ? (t.stage || '处理中') : (STATUS_TEXT[t.status] || t.status);
}
function taskBadgeCls(t) {
  return t.status === 'running' ? 'bg-running' : t.status === 'success' ? 'bg-success'
    : t.status === 'failed' ? 'bg-failed' : (t.status === 'stopped' || t.status === 'stopping') ? 'bg-stopped' : 'bg-queued';
}
function taskDesc(t, pct) {
  const STREAM_TEXT = { Vid: '视频', Aud: '音频', Sub: '字幕' };
  const parts = [];
  if (t.status === 'running') {
    if (t.stream) parts.push(STREAM_TEXT[t.stream] || t.stream);
    if (t.segments) parts.push(`分片 ${t.segments}`);
    if (pct > 0) parts.push(`已完成 ${pct}%`);
    if (t.downloaded && t.total) parts.push(`${t.downloaded}/${t.total}`);
    if (t.speed) parts.push(`速度 ${t.speed}`);
    if (t.eta) parts.push(`剩余 ${t.eta}`);
  } else if (t.status === 'success') {
    parts.push('下载完成');
    if (t.segments) parts.push(`共 ${t.segments.split('/').pop()} 分片`);
  } else if (t.status === 'failed' || t.status === 'stopped') {
    parts.push(t.last || STATUS_TEXT[t.status] || t.status);
  }
  return parts.join(' · ') || '准备中…';
}
function taskStatsHtml(t) {
  const stats = [];
  if (t.segments) stats.push(`分片 <b>${t.segments}</b>`);
  if (t.createdAt) stats.push(`创建 ${fmtTime(t.createdAt)}`);
  if (t.exitCode != null) stats.push(`退出码 <b>${t.exitCode}</b>`);
  return stats.join('<span>·</span>') || '<span>等待开始</span>';
}

// 增量更新卡片动态部分（不重建 DOM）
function updateTaskCard(card, t) {
  const pct = t.status === 'success' ? 100 : Math.min(100, Math.max(0, Math.round(t.progress || 0)));
  const badgeEl = card.querySelector('.badge');
  badgeEl.textContent = taskBadge(t);
  badgeEl.className = 'badge ' + taskBadgeCls(t);
  const bar = card.querySelector('.progress-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('bg-ok', t.status === 'success');
  card.querySelector('.progress-pct').textContent = pct + '%';
  card.querySelector('.task-stats').innerHTML = taskStatsHtml(t);
  const lastEl = card.querySelector('.task-last');
  lastEl.textContent = taskDesc(t, pct);
  lastEl.title = t.last || '';
  const showStop = t.status === 'running' || t.status === 'queued';
  const showRetry = ['failed', 'stopped'].includes(t.status);
  const showDel = ['success', 'failed', 'stopped'].includes(t.status);
  const showOpen = t.status === 'success' && t.outDir;
  card.querySelector('.btn-stop')?.classList.toggle('d-none', !showStop);
  card.querySelector('.btn-retry')?.classList.toggle('d-none', !showRetry);
  card.querySelector('.btn-del')?.classList.toggle('d-none', !showDel);
  card.querySelector('.btn-open-file')?.classList.toggle('d-none', !(showOpen && t.outputFiles && t.outputFiles.length === 1));
  card.querySelector('.btn-open-dir')?.classList.toggle('d-none', !showOpen);
}

function taskCard(t) {
  const pct = t.status === 'success' ? 100 : Math.min(100, Math.max(0, Math.round(t.progress || 0)));
  return `
  <div class="task" id="task-${t.id}">
    <div class="task-head">
      <div style="min-width:0">
        <div class="task-title">${esc(t.name)}</div>
        <div class="task-url">${esc(t.url)}</div>
      </div>
      <div class="task-meta">
        <span class="badge ${taskBadgeCls(t)}">${esc(taskBadge(t))}</span>
      </div>
    </div>
    <div class="progress-wrap">
      <div class="progress">
        <div class="progress-bar ${t.status === 'success' ? 'bg-ok' : ''}" style="width:${pct}%"></div>
      </div>
      <span class="progress-pct">${pct}%</span>
    </div>
    <div class="task-stats">${taskStatsHtml(t)}</div>
    <div class="task-last" title="${esc(t.last || '')}">${esc(taskDesc(t, pct))}</div>
    <div class="task-actions">
      <button class="btn btn-sm btn-outline-danger btn-stop${(t.status === 'running' || t.status === 'queued') ? '' : ' d-none'}">停止</button>
      <button class="btn btn-sm btn-outline-secondary btn-retry${['failed', 'stopped'].includes(t.status) ? '' : ' d-none'}">重试</button>
      <button class="btn btn-sm btn-outline-secondary btn-del${['success', 'failed', 'stopped'].includes(t.status) ? '' : ' d-none'}">删除记录</button>
      <button class="btn btn-sm btn-outline-primary btn-open-file${t.status === 'success' && t.outDir && t.outputFiles && t.outputFiles.length === 1 ? '' : ' d-none'}">打开文件</button>
      <button class="btn btn-sm btn-outline-primary btn-open-dir${t.status === 'success' && t.outDir ? '' : ' d-none'}">打开目录</button>
    </div>
  </div>`;
}

// 调用 fnOS 打开任务文件/目录（优先使用真实路径 /vol1/...，fnOS 才能识别）
function wireOpenButtons(card, t) {
  const realDir = t.realOutDir || t.outDir;
  card.querySelector('.btn-open-file')?.addEventListener('click', () => {
    if (t.outputFiles && t.outputFiles.length) {
      openViaFn('openFile', realDir.replace(/\/+$/, '') + '/' + t.outputFiles[0], t.outputFiles[0]);
    }
  });
  card.querySelector('.btn-open-dir')?.addEventListener('click', () => {
    openViaFn('openFileManager', realDir, t.name);
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- API ----------
async function act(params) {
  try {
    const res = await fetch(API(params));
    return await res.json();
  } catch (e) {
    uiToast('操作失败: ' + e.message);
    return { ok: false };
  }
}

async function refreshTasks() {
  try {
    const data = await act({ action: 'status' });
    if (data.ok && Array.isArray(data.tasks)) {
      tasks = data.tasks;
      dir = data.dir || dir;
      renderTasks();
    }
  } catch (_) { /* 网络抖动忽略 */ }
}

// ---------- 配置字段定义（对应 N_m3u8DL-RE 全部命令行参数，中文说明） ----------
// 每区 = 若干分组：{ title, checks=[], fields=[] }
const CFG_FIELDS = {
  basic: [
    {
      title: '下载选项',
      checks: [
        { key: 'auto', label: '自动选择最佳音视频', def: true, hint: '--auto-select' },
        { key: 'concurrent', label: '并发下载音视频/字幕', hint: '-mt' },
      ],
      fields: [
        { key: 'threads', label: '下载线程数', type: 'number', placeholder: '默认=CPU线程数', hint: '--thread-count' },
        { key: 'max_speed', label: '下载限速', type: 'text', placeholder: '如 15M / 100K', hint: '-R --max-speed' },
      ],
    },
    {
      title: '输出与命名',
      fields: [
        { key: 'save_pattern', label: '保存命名模板', type: 'text', placeholder: '<SaveName>_<Resolution>', hint: '变量：<SaveName> <Resolution> <Codecs> <Language> <Bandwidth> <MediaType> <Channels> <FrameRate> <VideoRange> <GroupId> <Ext>' },
      ],
    },
    {
      title: '混流与字幕',
      checks: [{ key: 'subonly', label: '只下载字幕', hint: '--sub-only' }],
      fields: [
        { key: 'mux', label: '完成后混流格式', type: 'select', options: [['', '不混流'], ['mkv', 'mkv'], ['mp4', 'mp4']], hint: '-M format=mkv/mp4' },
        { key: 'sub_format', label: '字幕输出格式', type: 'select', options: [['SRT', 'SRT'], ['VTT', 'VTT']], hint: '--sub-format' },
      ],
    },
    {
      title: '直播',
      checks: [{ key: 'live', label: '直播按点播方式下载', hint: '--live-perform-as-vod' }],
      fields: [],
    },
  ],
  advanced: [
    {
      title: '网络与代理',
      checks: [{ key: 'use_system_proxy', label: '使用系统代理', def: true, hint: '--use-system-proxy' }],
      fields: [
        { key: 'custom_proxy', label: '自定义代理', type: 'text', placeholder: 'http://127.0.0.1:8888', hint: '--custom-proxy' },
        { key: 'headers', label: '自定义请求头', type: 'textarea', placeholder: 'Cookie: xxx\nUser-Agent: iOS', hint: '-H 每行一个' },
        { key: 'timeout', label: 'HTTP 请求超时(秒)', type: 'number', def: 100, hint: '--http-request-timeout' },
        { key: 'retry_count', label: '分片失败重试次数', type: 'number', def: 3, hint: '--download-retry-count' },
        { key: 'custom_range', label: '仅下载部分分片', type: 'text', placeholder: '0-10 / 10- / 05:00-20:00', hint: '--custom-range' },
        { key: 'base_url', label: '指定 BaseURL', type: 'text', placeholder: 'https://cdn.example.com/', hint: '--base-url' },
      ],
    },
    {
      title: '任务计划',
      fields: [
        { key: 'task_start_at', label: '定时开始任务', type: 'datetime-local', hint: '--task-start-at（选择时间，格式自动转换）' },
      ],
    },
    {
      title: '流选择与过滤',
      fields: [
        { key: 'select_video', label: '选择视频流(正则)', type: 'text', placeholder: 'best / res="3840*":codecs=hvc1', hint: '-sv --select-video' },
        { key: 'select_audio', label: '选择音频流(正则)', type: 'text', placeholder: 'lang=en:for=best', hint: '-sa --select-audio' },
        { key: 'select_subtitle', label: '选择字幕流(正则)', type: 'text', placeholder: 'name="中文":for=all', hint: '-ss --select-subtitle' },
        { key: 'drop_video', label: '排除视频流(正则)', type: 'text', hint: '-dv --drop-video' },
        { key: 'drop_audio', label: '排除音频流(正则)', type: 'text', hint: '-da --drop-audio' },
        { key: 'drop_subtitle', label: '排除字幕流(正则)', type: 'text', hint: '-ds --drop-subtitle' },
        { key: 'ad_keyword', label: '广告分片过滤(正则)', type: 'text', hint: '--ad-keyword' },
      ],
    },
    {
      title: '合并与临时文件',
      checks: [
        { key: 'skip_merge', label: '跳过合并分片', hint: '--skip-merge' },
        { key: 'binary_merge', label: '二进制合并（不依赖 ffmpeg）', hint: '--binary-merge' },
        { key: 'append_url_params', label: '分片附加输入URL参数', hint: '--append-url-params' },
        { key: 'no_date_info', label: '混流不写入日期信息', hint: '--no-date-info' },
      ],
      fields: [
        { key: 'tmp_dir', label: '临时文件目录', type: 'text', placeholder: '/tmp', hint: '--tmp-dir' },
      ],
    },
    {
      title: '解密与 HLS 自定义',
      checks: [{ key: 'mp4_real_time_decryption', label: '实时解密 MP4 分片', hint: '--mp4-real-time-decryption' }],
      fields: [
        { key: 'key', label: '解密密钥', type: 'text', placeholder: 'KID1:KEY1 或 KEY', hint: '--key' },
        { key: 'key_text_file', label: '密钥文件', type: 'text', hint: '--key-text-file' },
        { key: 'decryption_engine', label: '解密引擎', type: 'select', options: [['MP4DECRYPT', 'MP4DECRYPT'], ['FFMPEG', 'FFMPEG'], ['SHAKA_PACKAGER', 'SHAKA_PACKAGER']], hint: '--decryption-engine' },
        { key: 'decryption_binary_path', label: '解密工具路径', type: 'text', hint: '--decryption-binary-path' },
        { key: 'custom_hls_method', label: 'HLS 加密方式', type: 'select', options: [['', '自动'], ['AES_128', 'AES_128'], ['AES_128_ECB', 'AES_128_ECB'], ['CENC', 'CENC'], ['CHACHA20', 'CHACHA20'], ['NONE', 'NONE'], ['SAMPLE_AES', 'SAMPLE_AES'], ['SAMPLE_AES_CTR', 'SAMPLE_AES_CTR'], ['UNKNOWN', 'UNKNOWN']], hint: '--custom-hls-method' },
        { key: 'custom_hls_key', label: 'HLS 解密 KEY', type: 'text', hint: '--custom-hls-key (FILE/HEX/BASE64)' },
        { key: 'custom_hls_iv', label: 'HLS 解密 IV', type: 'text', hint: '--custom-hls-iv (FILE/HEX/BASE64)' },
      ],
    },
    {
      title: '日志与更新',
      checks: [
        { key: 'no_log', label: '关闭日志文件输出', hint: '--no-log' },
        { key: 'disable_update_check', label: '禁用版本更新检测', hint: '--disable-update-check' },
      ],
      fields: [
        { key: 'log_level', label: '日志级别', type: 'select', options: [['', '默认(INFO)'], ['DEBUG', 'DEBUG'], ['INFO', 'INFO'], ['WARN', 'WARN'], ['ERROR', 'ERROR'], ['OFF', 'OFF']], hint: '--log-level' },
      ],
    },
    {
      title: '直播高级',
      checks: [
        { key: 'live_real_time_merge', label: '直播实时合并', hint: '--live-real-time-merge' },
        { key: 'live_keep_segments', label: '实时合并时保留分片', def: true, hint: '--live-keep-segments' },
        { key: 'live_pipe_mux', label: '直播管道实时混流', hint: '--live-pipe-mux（网络不稳定勿开）' },
      ],
      fields: [
        { key: 'live_record_limit', label: '直播录制时长限制', type: 'text', placeholder: '01:00:00', hint: '--live-record-limit HH:mm:ss' },
        { key: 'live_wait_time', label: '直播列表刷新间隔(秒)', type: 'number', hint: '--live-wait-time' },
      ],
    },
  ],
};

// 生成配置表单（按分组渲染：组标题 + 勾选行 + 字段网格；Bootstrap 组件）
function buildCfgForm() {
  for (const [section, groups] of Object.entries(CFG_FIELDS)) {
    const box = $('cfg-' + section);
    if (!box) continue;
    box.innerHTML = groups.map((g) => {
      const checksHtml = (g.checks || []).map((f) =>
        `<div class="form-check form-check-inline cfg-check" title="${esc(f.hint || '')}">` +
        `<input class="form-check-input" type="checkbox" id="cfg-${f.key}" data-cfg="${f.key}"${f.def ? ' checked' : ''} />` +
        `<label class="form-check-label" for="cfg-${f.key}">${esc(f.label)}</label></div>`
      ).join('');
      const fieldsHtml = (g.fields || []).map((f) => {
        const id = 'cfg-' + f.key;
        if (f.type === 'select') {
          const opts = f.options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
          return `<label class="cfg-field"><span>${esc(f.label)}</span><select class="form-select" id="${id}" data-cfg="${f.key}">${opts}</select>${f.hint ? `<span class="cfg-hint">${esc(f.hint)}</span>` : ''}</label>`;
        }
        if (f.type === 'textarea') {
          return `<label class="cfg-field cfg-full"><span>${esc(f.label)}</span><textarea class="form-control" id="${id}" data-cfg="${f.key}" placeholder="${esc(f.placeholder || '')}" rows="2"></textarea>${f.hint ? `<span class="cfg-hint">${esc(f.hint)}</span>` : ''}</label>`;
        }
        return `<label class="cfg-field"><span>${esc(f.label)}</span><input class="form-control" type="${f.type}" id="${id}" data-cfg="${f.key}" placeholder="${esc(f.placeholder || '')}" value="${f.def != null ? esc(String(f.def)) : ''}" />${f.hint ? `<span class="cfg-hint">${esc(f.hint)}</span>` : ''}</label>`;
      }).join('');
      return `<div class="cfg-group">` +
        `<div class="cfg-group-title">${esc(g.title)}</div>` +
        (checksHtml ? `<div class="cfg-checks">${checksHtml}</div>` : '') +
        (fieldsHtml ? `<div class="cfg-grid">${fieldsHtml}</div>` : '') +
        `</div>`;
    }).join('');
  }
}

// 收集配置字段 → 请求参数（勾选项显式传 1/0；datetime-local 转为 yyyyMMddHHmmss）
function collectCfgParams(params) {
  document.querySelectorAll('[data-cfg]').forEach((el) => {
    const key = el.dataset.cfg;
    if (el.type === 'checkbox') {
      params[key] = el.checked ? '1' : '0';
    } else if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number' || el.type === 'datetime-local') {
      const v = el.value.trim();
      if (v !== '') {
        params[key] = key === 'task_start_at' ? v.replace(/\D/g, '') : v;
      }
    }
  });
  return params;
}

// ---------- fnOS SDK 单例（关键：整个页面只与宿主握手一次，重复 new TrimApp() 会导致
//   宿主只响应首次握手，后续点击打开/浏览静默无响应；重开应用=新页面所以又能用） ----------
let trimSdkPromise = null;
function getTrimSdk(force) {
  if (!trimSdkPromise || force) {
    trimSdkPromise = (async () => {
      const mod = await import('./vendor/trim-app.js');
      const sdk = new mod.TrimApp();
      await sdk.ready();
      return sdk;
    })();
  }
  return trimSdkPromise;
}
// 返回可用（宿主桥接就绪）的 SDK；不可用时返回 null（调用方可选择重建一次）
async function sdkReady(force) {
  try {
    const sdk = await getTrimSdk(force);
    if (sdk.isWeb && !sdk.isStandaloneWeb) {
      try { sdk.getWebMethods(); return sdk; } catch (_) { return null; }
    }
  } catch (_) { /* 加载失败 */ }
  return null;
}

// 调用 fnOS 打开文件/目录（开放平台 SDK 页面路由能力，无 Scope 要求）
// 失败时错误可见，并提供"复制路径"兜底
async function openViaFn(method, path, displayName) {
  try {
    let sdk = await sdkReady(false);
    if (!sdk) sdk = await sdkReady(true); // 宿主桥接可能晚建立，重建一次
    if (!sdk) throw new Error('当前为独立浏览器环境或 fnOS 宿主桥接不可用，无法直接打开');
    await sdk[method](path);
    uiToast('已通过 fnOS 打开' + (displayName ? '：' + displayName : ''), 'success');
  } catch (e) {
    console.error('[fnOS open]', method, path, e);
    try {
      await navigator.clipboard.writeText(path || '');
      uiToast('fnOS 打开失败：' + (e && e.message ? e.message : e) + '，路径已复制到剪贴板', 'warn');
    } catch (_) {
      uiToast('fnOS 打开失败：' + (e && e.message ? e.message : e) + '（路径：' + path + '）', 'danger');
    }
  }
}

// 从 fnOS 选择结果中提取路径（兼容多种返回形态）
function extractPickedPath(res) {
  if (!res) return null;
  if (typeof res === 'string') return res || null;
  if (Array.isArray(res)) {
    const first = res[0];
    return typeof first === 'string' ? first : (first && (first.path || first.name)) || null;
  }
  // 对象：尝试常见字段
  for (const key of ['path', 'paths', 'result', 'data', 'value']) {
    const c = res[key];
    if (typeof c === 'string' && c) return c;
    if (Array.isArray(c) && c.length) {
      const first = c[0];
      if (typeof first === 'string') return first;
      if (first && typeof first.path === 'string') return first.path;
    }
  }
  return null;
}

// 调用 fnOS 文件管理器选择目录（复用 SDK 单例；不支持时回退手动输入）
$('btn-browse').addEventListener('click', async () => {
  $('form-msg').textContent = '';
  try {
    let sdk = await sdkReady(false);
    if (!sdk) sdk = await sdkReady(true); // 宿主桥接可能晚建立，重建一次
    const params = {
      directory: true,
      title: '选择输出目录',
      okText: '选择此目录',
      creatable: true,
    };
    let res;
    if (sdk && sdk.isWeb && !sdk.isStandaloneWeb) {
      // 桌面/应用中心宿主环境：直接调起文件管理器
      res = await sdk.pickUserFile(params);
    } else {
      // 独立浏览器：走 openAppAuth 授权跳转，选完后回调回本页
      $('form-msg').textContent = '正在打开文件管理器…';
      if (!sdk) throw new Error('SDK 不可用');
      await sdk.openAppAuth('pickUserFile', {
        ...params,
        appName: 'm3u8_down',
        redirectUri: location.origin + location.pathname,
      });
      return; // 页面将被跳转，回调由启动时的解析处理
    }
    const p = extractPickedPath(res);
    if (p) {
      $('f-custom-dir').value = p;
      $('f-dir').value = 'custom';
      $('f-custom-dir').closest('.custom-dir').classList.remove('d-none');
      $('form-msg').textContent = '已选择目录：' + p;
    } else {
      $('form-msg').textContent = '未获取到目录，请重试或手动输入';
      $('f-custom-dir').focus();
    }
  } catch (e) {
    $('form-msg').textContent = '无法打开文件管理器（需 fnOS 1.2.0401+ 并从桌面/应用中心打开本应用），请手动输入路径';
    $('f-custom-dir').focus();
  }
});

// 输出目录切换：显示/隐藏自定义目录行
$('f-dir').addEventListener('change', () => {
  const isCustom = $('f-dir').value === 'custom';
  $('f-custom-dir').closest('.custom-dir').classList.toggle('d-none', !isCustom);
  if (isCustom) $('f-custom-dir').focus();
});

$('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('f-url').value.trim();
  if (!url) return;
  const params = { action: 'create', url, name: $('f-name').value.trim() };
  collectCfgParams(params);
  const custom = $('f-custom-dir').value.trim();
  if ($('f-dir').value === 'custom') {
    // 自定义目录：必须选择或输入有效路径（不再静默回退默认目录）
    if (!custom) {
      $('form-msg').textContent = '请点击「浏览…」选择目录或手动输入路径';
      $('f-custom-dir').focus();
      return;
    }
    if (!custom.startsWith('/')) {
      $('form-msg').textContent = '自定义目录需以 / 开头（如 /vol1/Users/admin/Downloads）';
      return;
    }
    params.dir = custom;
  }
  const btn = $('btn-submit');
  btn.disabled = true;
  $('form-msg').textContent = '';
  try {
    const data = await act(params);
    if (!data.ok) throw new Error(data.error || '创建失败');
    $('f-url').value = '';
    $('f-name').value = '';
    await refreshTasks();
  } catch (err) {
    $('form-msg').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// 重试 = 用创建时的原始参数重新提交
async function retry(t) {
  const params = { action: 'create' };
  if (t.rawparams) {
    const rp = new URLSearchParams(t.rawparams);
    for (const [k, v] of rp) params[k] = v;
  } else {
    params.url = t.url;
    params.name = t.name;
  }
  const data = await act(params);
  if (!data.ok) uiToast(data.error || '重试失败');
  else await refreshTasks();
}

// ---------- 文件标签页 ----------
document.querySelectorAll('.nav-link[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-link[data-tab]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const isFiles = tab.dataset.tab === 'files';
    $('tab-tasks').classList.toggle('d-none', isFiles);
    $('tab-files').classList.toggle('d-none', !isFiles);
    if (isFiles) loadFiles();
  });
});

async function loadFiles() {
  const box = $('file-list');
  try {
    const data = await act({ action: 'files' });
    dir = data.dir || dir;
    if (!data.files || !data.files.length) {
      box.innerHTML = '<p class="empty">暂无已下载文件（仅列出本应用下载的文件）</p>';
      return;
    }
    box.innerHTML = data.files.map((f) => `
      <div class="file-row">
        <span class="file-icon">🎬</span>
        <div class="file-main">
          <div class="file-name" title="${esc(f.path)}">${esc(f.name)}</div>
          <div class="file-path" title="${esc(f.path)}">${esc(f.path)}</div>
        </div>
        <span class="file-meta">${fmtSize(f.size)} · ${fmtTime(f.mtime)}</span>
        <span class="file-actions">
          <button class="btn btn-sm btn-outline-primary btn-fopen" data-path="${esc(f.realPath || f.path)}" data-name="${esc(f.name)}">打开</button>
          <button class="btn btn-sm btn-outline-primary btn-fopendir" data-dir="${esc(dirOf(f.realPath || f.path))}">打开目录</button>
          <a class="btn btn-sm btn-outline-secondary" href="${API({ action: 'download', path: f.path })}">下载</a>
          <button class="btn btn-sm btn-outline-danger btn-fdel" data-path="${esc(f.path)}">删除</button>
        </span>
      </div>`).join('');
    box.querySelectorAll('.btn-fopen').forEach((b) => {
      b.addEventListener('click', () => openViaFn('openFile', b.dataset.path, b.dataset.name));
    });
    box.querySelectorAll('.btn-fopendir').forEach((b) => {
      b.addEventListener('click', () => openViaFn('openFileManager', b.dataset.dir, b.dataset.dir));
    });
    box.querySelectorAll('.btn-fdel').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!(await uiConfirm('确定删除文件「' + b.dataset.path + '」吗？'))) return;
        await act({ action: 'delete_file', path: b.dataset.path });
        loadFiles();
      });
    });
  } catch (e) {
    box.innerHTML = '<p class="empty">加载失败: ' + esc(e.message) + '</p>';
  }
}

// ---------- 主题切换（默认暗黑；可手动切换并记忆） ----------
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.bsTheme = t;
  const icon = document.querySelector('#btn-theme svg path');
  if (icon) icon.setAttribute('d', t === 'dark'
    ? 'M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13zm8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8zm10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0zm-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0zm9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707zM4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708z'
    : 'M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z');
}
function toggleTheme() {
  const cur = document.documentElement.dataset.bsTheme === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem('m3u8_theme', next); } catch (_) {}
}
async function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('m3u8_theme'); } catch (_) {}
  if (saved === 'light' || saved === 'dark') { applyTheme(saved); return; }
  // 未手动选择过 → 跟随 fnOS 主题（复用 SDK 单例），默认暗黑
  try {
    const sdk = await getTrimSdk();
    if (sdk.isWeb) {
      try {
        const cfg = await sdk.getPlatformConfig();
        if (cfg && cfg.theme) applyTheme(cfg.theme);
        sdk.$on('os/theme', (t) => { if (!localStorage.getItem('m3u8_theme')) applyTheme(t && t.theme ? t.theme : t); });
      } catch (_) { /* 保持默认暗黑 */ }
    }
  } catch (_) { /* SDK 不可用时保持默认暗黑 */ }
}

// ---------- 更新检查 ----------
// 由 CGI action=update_check 完成：读取本地版本 + 查询 GitHub 最新 Release
// （引擎走 nilaoda/N_m3u8DL-RE，应用走本项目 Releases）。
// 网络不可达时后端优雅降级：network 非 "ok"，仅返回本地版本。
// 引擎/应用更新由后台任务执行（updateJob 轮询进度）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkUpdate(manual) {
  const box = $('update-info');
  if (!box) return null;
  if (manual) box.innerHTML = '<p class="empty">正在检查更新…</p>';
  const data = await act({ action: 'update_check' });
  renderUpdateInfo(box, data);
  return data;
}

function updBadge(upToDate) {
  if (upToDate === true) return '<span class="upd-badge upd-ok">已是最新</span>';
  if (upToDate === false) return '<span class="upd-badge upd-new">有新版本</span>';
  return '<span class="upd-badge upd-unknown">未知</span>';
}

function renderUpdateInfo(box, d) {
  if (!d || !d.ok) {
    box.innerHTML = '<p class="empty">更新检查失败，请稍后重试。</p>';
    return;
  }
  // 页脚显示当前应用版本
  const fv = $('foot-version');
  if (fv && d.appVersion) fv.textContent = '当前版本 v' + d.appVersion;

  const parts = [];
  if (d.network !== 'ok') {
    const msg = d.network === 'skipped'
      ? '本环境已禁用联网检查，以下仅显示本地版本信息。'
      : '⚠️ 无法连接 GitHub（网络受限或 GitHub 不可达），仅显示本地版本信息，请检查网络后重试。';
    parts.push('<div class="upd-warn">' + esc(msg) + '</div>');
  }

  // 更新任务进行中提示
  const job = d.updateJob;
  if (job && job.status === 'running') {
    const what = job.mode === 'engine' ? '核心引擎' : '新版应用';
    const target = job.targetVersion ? ' → v' + job.targetVersion : '';
    parts.push('<div class="upd-warn upd-running">⏳ 正在更新' + what + target + '…（大文件下载可能需要几分钟，请勿关闭页面）</div>');
  } else if (job && job.status === 'failed') {
    parts.push('<div class="upd-warn">❌ 上次更新失败：' + esc(job.message || '未知原因') + '</div>');
  } else if (job && job.status === 'ok') {
    const okMsg = job.message || '更新完成';
    parts.push('<div class="upd-warn upd-okline">✅ ' + esc(okMsg) +
      (job.path ? '<div class="upd-path">' + esc(job.path) + '</div>' +
        '<button type="button" class="btn btn-sm btn-outline-primary upd-btn" id="btn-open-update-dir">打开所在目录</button>' : '') +
      '</div>');
  }

  // 应用版本行
  const app = d.app || {};
  const appBusy = job && job.status === 'running' && job.mode === 'app';
  parts.push(
    '<div class="upd-row">' +
      '<span class="upd-name">应用版本</span>' +
      '<span class="upd-cur">' + esc(d.appVersion || '未知') + '</span>' +
      (app.latest ? '<span class="upd-latest">最新 ' + esc(app.latest) + '</span>' : '') +
      (app.latest ? updBadge(app.upToDate) : '') +
      (app.upToDate === false && !appBusy
        ? '<button type="button" class="btn btn-sm btn-primary upd-btn" id="btn-download-app">下载新版 (.fpk)</button>' : '') +
      (app.upToDate === false && app.releaseUrl
        ? '<a class="btn btn-sm btn-outline-primary upd-btn" href="' + esc(app.releaseUrl) + '" target="_blank" rel="noopener">Release 页面</a>' : '') +
    '</div>'
  );

  // 引擎版本行
  const eng = d.engine || {};
  const engBusy = job && job.status === 'running' && job.mode === 'engine';
  parts.push(
    '<div class="upd-row">' +
      '<span class="upd-name">引擎版本</span>' +
      '<span class="upd-cur">' + esc(d.engineVersion || '未知') + '</span>' +
      (eng.latest ? '<span class="upd-latest">最新 ' + esc(eng.latest) + '</span>' : '') +
      (eng.latest ? updBadge(eng.upToDate) : '') +
      (eng.upToDate === false && !engBusy
        ? '<button type="button" class="btn btn-sm btn-primary upd-btn" id="btn-update-engine">更新引擎</button>' : '') +
      (eng.upToDate === false && eng.releaseUrl
        ? '<a class="btn btn-sm btn-outline-primary upd-btn" href="' + esc(eng.releaseUrl) + '" target="_blank" rel="noopener">引擎 Release</a>' : '') +
    '</div>'
  );

  if (eng.upToDate === false) {
    parts.push('<div class="upd-note">💡 也可点击「更新引擎」应用内直接升级核心引擎；或等待新版应用（内置新引擎）发布后升级应用。</div>');
  }
  box.innerHTML = parts.join('');

  // 按钮事件
  box.querySelector('#btn-update-engine')?.addEventListener('click', () => startEngineUpdate());
  box.querySelector('#btn-download-app')?.addEventListener('click', () => startAppDownload());
  box.querySelector('#btn-open-update-dir')?.addEventListener('click', () => {
    if (job && job.path) openViaFn('openFileManager', dirOf(job.path), dirOf(job.path));
  });
}

// 启动引擎更新（后台下载→校验→原子替换）
async function startEngineUpdate() {
  if (!(await uiConfirm('将下载并替换核心引擎为最新版（更新不影响已有任务）。确定继续吗？'))) return;
  const data = await act({ action: 'engine_update' });
  if (!data.ok) { uiToast(data.error || '引擎更新启动失败'); checkUpdate(false); return; }
  uiToast('引擎更新已开始，请稍候…', 'warn');
  waitUpdateJob();
}

// 启动新版应用下载（fpk → 共享目录）
async function startAppDownload() {
  if (!(await uiConfirm('将下载新版应用安装包（.fpk）到共享目录，下载完成后需到「应用中心 → 手动安装」升级。确定继续吗？'))) return;
  const data = await act({ action: 'app_download' });
  if (!data.ok) { uiToast(data.error || '下载启动失败'); checkUpdate(false); return; }
  uiToast('新版应用下载已开始，请稍候…', 'warn');
  waitUpdateJob();
}

// 轮询更新任务直到结束（最多约 5 分钟）
async function waitUpdateJob() {
  for (let i = 0; i < 150; i++) {
    const data = await checkUpdate(false);
    const job = data && data.updateJob;
    if (!job || job.status !== 'running') {
      if (job && job.status === 'ok') uiToast(job.message || '更新完成', 'success');
      else if (job && job.status === 'failed') uiToast(job.message || '更新失败', 'danger');
      return;
    }
    await sleep(2000);
  }
  uiToast('更新任务耗时过长，请稍后在「检查更新」中查看结果', 'warn');
}

$('btn-check-update')?.addEventListener('click', () => checkUpdate(true));

// ---------- 启动：生成配置表单 + 主题 + 轮询刷新 ----------
const themeBtn = $('btn-theme');
if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
initTheme();
buildCfgForm();
refreshTasks();
setInterval(refreshTasks, POLL_MS);
checkUpdate(false); // 启动时静默检查一次更新（网络不可达时后端优雅降级）

// ---------- 开放平台授权回调（独立浏览器选择目录后跳回本页） ----------
(function handleAuthCallback() {
  try {
    const q = new URLSearchParams(location.search || '');
    const method = q.get('method');
    if (method && (method === 'pickUserFile' || method === 'pickSharedFile')) {
      let paths = [];
      try { paths = JSON.parse(q.get('path') || '[]'); } catch (_) {}
      const p = Array.isArray(paths) ? paths[0] : (typeof paths === 'string' ? paths : null);
      if (p) {
        $('f-dir').value = 'custom';
        $('f-custom-dir').value = p;
        $('f-custom-dir').closest('.custom-dir').classList.remove('d-none');
        $('form-msg').textContent = '已选择目录：' + p;
      } else {
        $('form-msg').textContent = q.get('error') ? '授权未完成：' + q.get('error') : '未获取到目录';
      }
    }
  } catch (_) { /* 忽略非回调页 */ }
})();
