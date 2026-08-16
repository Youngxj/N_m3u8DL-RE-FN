/* N_m3u8DL-RE Web UI（fnOS index.cgi 轮询版，零依赖原生 JS） */
'use strict';

// 所有 API 通过相对 URL '?action=...' 调用当前 CGI（页面位于 .../index.cgi/ 下）
const API = (params) => '?' + new URLSearchParams(params).toString();
const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  queued: '排队中', running: '下载中', stopping: '停止中',
  success: '已完成', failed: '失败', stopped: '已停止',
};
const POLL_MS = 500; // 轮询间隔（越短越接近 CLI 实时）

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}
function fmtSpeed(s) { return s ? fmtSize(s) + '/s' : ''; }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

let tasks = [];
let dir = '';

// ---------- 任务渲染 ----------
function renderTasks() {
  const list = $('task-list');
  $('task-count').textContent = tasks.length;
  if (!tasks.length) {
    list.innerHTML = '<p class="empty">暂无任务，在上方创建第一个下载任务吧。</p>';
    return;
  }
  list.innerHTML = tasks.map(taskCard).join('');
  tasks.forEach((t) => {
    const card = $('task-' + t.id);
    if (!card) return;
    card.querySelector('.btn-stop')?.addEventListener('click', () => act({ action: 'stop', id: t.id }));
    card.querySelector('.btn-retry')?.addEventListener('click', () => retry(t));
    card.querySelector('.btn-del')?.addEventListener('click', () => {
      if (confirm('确定删除任务「' + t.name + '」的记录吗？（不会删除已下载文件）')) act({ action: 'remove', id: t.id });
    });
    wireOpenButtons(card, t);
  });
}

function taskCard(t) {
  const pct = t.status === 'success' ? 100 : Math.min(100, Math.max(0, Math.round(t.progress || 0)));
  const showStop = t.status === 'running' || t.status === 'queued';
  const showRetry = ['failed', 'stopped'].includes(t.status);
  const showDel = ['success', 'failed', 'stopped'].includes(t.status);
  const stats = [];
  if (t.segments) stats.push(`分片 <b>${t.segments}</b>`);
  if (t.createdAt) stats.push(`创建 ${fmtTime(t.createdAt)}`);
  if (t.exitCode != null) stats.push(`退出码 <b>${t.exitCode}</b>`);

  // 状态徽章：运行中只显示阶段（避免"下载中·下载中"重复）
  const badge = t.status === 'running'
    ? (t.stage || '处理中')
    : (STATUS_TEXT[t.status] || t.status);
  const badgeCls = t.status === 'running' ? 'bg-running' : t.status === 'success' ? 'bg-success'
    : t.status === 'failed' ? 'bg-failed' : (t.status === 'stopped' || t.status === 'stopping') ? 'bg-stopped' : 'bg-queued';

  // 进度描述：由解析出的字段合成，清晰且无杂乱日志
  const STREAM_TEXT = { Vid: '视频', Aud: '音频', Sub: '字幕' };
  const descParts = [];
  if (t.status === 'running') {
    if (t.stream) descParts.push(STREAM_TEXT[t.stream] || t.stream);
    if (t.segments) descParts.push(`分片 ${t.segments}`);
    if (pct > 0) descParts.push(`已完成 ${pct}%`);
    if (t.downloaded && t.total) descParts.push(`${t.downloaded}/${t.total}`);
    if (t.speed) descParts.push(`速度 ${t.speed}`);
    if (t.eta) descParts.push(`剩余 ${t.eta}`);
  } else if (t.status === 'success') {
    descParts.push('下载完成');
    if (t.segments) descParts.push(`共 ${t.segments.split('/').pop()} 分片`);
  } else if (t.status === 'failed' || t.status === 'stopped') {
    descParts.push(t.last || STATUS_TEXT[t.status] || t.status);
  }
  const desc = descParts.join(' · ') || '准备中…';
  const lastRaw = t.last || '';

  return `
  <div class="task" id="task-${t.id}">
    <div class="task-head">
      <div style="min-width:0">
        <div class="task-title">${esc(t.name)}</div>
        <div class="task-url">${esc(t.url)}</div>
      </div>
      <div class="task-meta">
        <span class="badge ${badgeCls}">${esc(badge)}</span>
      </div>
    </div>
    <div class="progress-wrap">
      <div class="progress">
        <div class="progress-bar ${t.status === 'success' ? 'bg-ok' : ''}" style="width:${pct}%"></div>
      </div>
      <span class="progress-pct">${pct}%</span>
    </div>
    <div class="task-stats">${stats.join('<span>·</span>') || '<span>等待开始</span>'}</div>
    <div class="task-last" title="${esc(lastRaw)}">${esc(desc)}</div>
    <div class="task-actions">
      ${showStop ? `<button class="btn btn-sm btn-outline-danger btn-stop">停止</button>` : ''}
      ${showRetry ? `<button class="btn btn-sm btn-outline-secondary btn-retry">重试</button>` : ''}
      ${showDel ? `<button class="btn btn-sm btn-outline-secondary btn-del">删除记录</button>` : ''}
      ${t.status === 'success' && t.outDir ? `
        ${t.outputFiles && t.outputFiles.length === 1 ? `<button class="btn btn-sm btn-outline-primary btn-open-file">打开文件</button>` : ''}
        <button class="btn btn-sm btn-outline-primary btn-open-dir">打开目录</button>` : ''}
    </div>
  </div>`;
}

// 调用 fnOS 打开任务文件/目录
function wireOpenButtons(card, t) {
  card.querySelector('.btn-open-file')?.addEventListener('click', () => {
    if (t.outputFiles && t.outputFiles.length) {
      openViaFn('openFile', t.outDir.replace(/\/+$/, '') + '/' + t.outputFiles[0]);
    }
  });
  card.querySelector('.btn-open-dir')?.addEventListener('click', () => {
    openViaFn('openFileManager', t.outDir);
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
    alert('操作失败: ' + e.message);
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
      $('svc-dir').textContent = dir;
      $('svc-dir').title = '默认输出目录：' + dir;
    }
  } catch (_) { /* 网络抖动忽略 */ }
}

// ---------- 配置字段定义（对应 N_m3u8DL-RE 全部命令行参数，中文说明） ----------
// 每个分区：checks=勾选项（一行排布），fields=文本/数字/下拉/多行（统一网格）
const CFG_FIELDS = {
  basic: {
    checks: [
      { key: 'auto', label: '自动选择最佳音视频', def: true, hint: '--auto-select' },
      { key: 'concurrent', label: '并发下载音视频/字幕', hint: '-mt' },
      { key: 'subonly', label: '只下载字幕', hint: '--sub-only' },
      { key: 'live', label: '直播按点播方式下载', hint: '--live-perform-as-vod' },
    ],
    fields: [
      { key: 'save_pattern', label: '保存命名模板', type: 'text', placeholder: '<SaveName>_<Resolution>', hint: '变量：<SaveName> <Resolution> <Codecs> <Language> <Bandwidth> <MediaType> <Channels> <FrameRate> <VideoRange> <GroupId> <Ext>' },
      { key: 'threads', label: '下载线程数', type: 'number', placeholder: '默认=CPU线程数', hint: '--thread-count' },
      { key: 'mux', label: '完成后混流格式', type: 'select', options: [['', '不混流'], ['mkv', 'mkv'], ['mp4', 'mp4']], hint: '-M format=mkv/mp4' },
      { key: 'sub_format', label: '字幕输出格式', type: 'select', options: [['SRT', 'SRT'], ['VTT', 'VTT']], hint: '--sub-format' },
      { key: 'max_speed', label: '下载限速', type: 'text', placeholder: '如 15M / 100K', hint: '-R --max-speed' },
    ],
  },
  advanced: {
    checks: [
      { key: 'use_system_proxy', label: '使用系统代理', def: true, hint: '--use-system-proxy' },
      { key: 'skip_merge', label: '跳过合并分片', hint: '--skip-merge' },
      { key: 'binary_merge', label: '二进制合并（不依赖 ffmpeg）', hint: '--binary-merge' },
      { key: 'append_url_params', label: '分片附加输入URL参数', hint: '--append-url-params' },
      { key: 'no_date_info', label: '混流不写入日期信息', hint: '--no-date-info' },
      { key: 'mp4_real_time_decryption', label: '实时解密 MP4 分片', hint: '--mp4-real-time-decryption' },
      { key: 'disable_update_check', label: '禁用版本更新检测', hint: '--disable-update-check' },
      { key: 'no_log', label: '关闭日志文件输出', hint: '--no-log' },
      { key: 'live_real_time_merge', label: '直播实时合并', hint: '--live-real-time-merge' },
      { key: 'live_keep_segments', label: '实时合并时保留分片', def: true, hint: '--live-keep-segments' },
      { key: 'live_pipe_mux', label: '直播管道实时混流', hint: '--live-pipe-mux（网络不稳定勿开）' },
    ],
    fields: [
      { key: 'tmp_dir', label: '临时文件目录', type: 'text', placeholder: '/tmp', hint: '--tmp-dir' },
      { key: 'retry_count', label: '分片失败重试次数', type: 'number', def: 3, hint: '--download-retry-count' },
      { key: 'timeout', label: 'HTTP 请求超时(秒)', type: 'number', def: 100, hint: '--http-request-timeout' },
      { key: 'custom_proxy', label: '自定义代理', type: 'text', placeholder: 'http://127.0.0.1:8888', hint: '--custom-proxy' },
      { key: 'headers', label: '自定义请求头', type: 'textarea', placeholder: 'Cookie: xxx\nUser-Agent: iOS', hint: '-H 每行一个' },
      { key: 'custom_range', label: '仅下载部分分片', type: 'text', placeholder: '0-10 / 10- / 05:00-20:00', hint: '--custom-range' },
      { key: 'task_start_at', label: '定时开始任务', type: 'text', placeholder: 'yyyyMMddHHmmss', hint: '--task-start-at' },
      { key: 'base_url', label: '指定 BaseURL', type: 'text', placeholder: 'https://cdn.example.com/', hint: '--base-url' },
      { key: 'select_video', label: '选择视频流(正则)', type: 'text', placeholder: 'best / res="3840*":codecs=hvc1', hint: '-sv --select-video' },
      { key: 'select_audio', label: '选择音频流(正则)', type: 'text', placeholder: 'lang=en:for=best', hint: '-sa --select-audio' },
      { key: 'select_subtitle', label: '选择字幕流(正则)', type: 'text', placeholder: 'name="中文":for=all', hint: '-ss --select-subtitle' },
      { key: 'drop_video', label: '排除视频流(正则)', type: 'text', hint: '-dv --drop-video' },
      { key: 'drop_audio', label: '排除音频流(正则)', type: 'text', hint: '-da --drop-audio' },
      { key: 'drop_subtitle', label: '排除字幕流(正则)', type: 'text', hint: '-ds --drop-subtitle' },
      { key: 'ad_keyword', label: '广告分片过滤(正则)', type: 'text', hint: '--ad-keyword' },
      { key: 'key', label: '解密密钥', type: 'text', placeholder: 'KID1:KEY1 或 KEY', hint: '--key' },
      { key: 'key_text_file', label: '密钥文件', type: 'text', hint: '--key-text-file' },
      { key: 'decryption_engine', label: '解密引擎', type: 'select', options: [['MP4DECRYPT', 'MP4DECRYPT'], ['FFMPEG', 'FFMPEG'], ['SHAKA_PACKAGER', 'SHAKA_PACKAGER']], hint: '--decryption-engine' },
      { key: 'decryption_binary_path', label: '解密工具路径', type: 'text', hint: '--decryption-binary-path' },
      { key: 'custom_hls_method', label: 'HLS 加密方式', type: 'select', options: [['', '自动'], ['AES_128', 'AES_128'], ['AES_128_ECB', 'AES_128_ECB'], ['CENC', 'CENC'], ['CHACHA20', 'CHACHA20'], ['NONE', 'NONE'], ['SAMPLE_AES', 'SAMPLE_AES'], ['SAMPLE_AES_CTR', 'SAMPLE_AES_CTR'], ['UNKNOWN', 'UNKNOWN']], hint: '--custom-hls-method' },
      { key: 'custom_hls_key', label: 'HLS 解密 KEY', type: 'text', hint: '--custom-hls-key (FILE/HEX/BASE64)' },
      { key: 'custom_hls_iv', label: 'HLS 解密 IV', type: 'text', hint: '--custom-hls-iv (FILE/HEX/BASE64)' },
      { key: 'log_level', label: '日志级别', type: 'select', options: [['', '默认(INFO)'], ['DEBUG', 'DEBUG'], ['INFO', 'INFO'], ['WARN', 'WARN'], ['ERROR', 'ERROR'], ['OFF', 'OFF']], hint: '--log-level' },
      { key: 'live_record_limit', label: '直播录制时长限制', type: 'text', placeholder: '01:00:00', hint: '--live-record-limit HH:mm:ss' },
      { key: 'live_wait_time', label: '直播列表刷新间隔(秒)', type: 'number', hint: '--live-wait-time' },
    ],
  },
};

// 生成配置表单（勾选项集中一行，其余字段统一网格；Bootstrap 组件）
function buildCfgForm() {
  for (const [section, cfg] of Object.entries(CFG_FIELDS)) {
    const box = $('cfg-' + section);
    if (!box) continue;
    const checksHtml = (cfg.checks || []).map((f) =>
      `<div class="form-check form-check-inline cfg-check" title="${esc(f.hint || '')}">` +
      `<input class="form-check-input" type="checkbox" id="cfg-${f.key}" data-cfg="${f.key}"${f.def ? ' checked' : ''} />` +
      `<label class="form-check-label" for="cfg-${f.key}">${esc(f.label)}</label></div>`
    ).join('');
    const fieldsHtml = (cfg.fields || []).map((f) => {
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
    box.innerHTML = (checksHtml ? `<div class="cfg-checks">${checksHtml}</div>` : '') +
                    (fieldsHtml ? `<div class="cfg-grid">${fieldsHtml}</div>` : '');
  }
}

// 收集配置字段 → 请求参数（勾选项显式传 1/0，服务端可据此关闭默认开启的选项）
function collectCfgParams(params) {
  document.querySelectorAll('[data-cfg]').forEach((el) => {
    const key = el.dataset.cfg;
    if (el.type === 'checkbox') {
      params[key] = el.checked ? '1' : '0';
    } else if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number') {
      const v = el.value.trim();
      if (v !== '') params[key] = v;
    }
  });
  return params;
}

// 调用 fnOS 打开文件/目录（开放平台 SDK 页面路由能力，无 Scope 要求）
async function openViaFn(method, path) {
  try {
    const mod = await import('./vendor/trim-app.js');
    const sdk = new mod.TrimApp();
    await sdk.ready();
    if (sdk.isWeb && !sdk.isStandaloneWeb) {
      await sdk[method](path);
    } else {
      throw new Error('standalone');
    }
  } catch (e) {
    alert('当前环境无法调用 fnOS 打开（需从桌面/应用中心打开本应用），可改用「下载」按钮获取文件');
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

// 调用 fnOS 文件管理器选择目录（开放平台 JS SDK，动态加载；不支持时回退手动输入）
$('btn-browse').addEventListener('click', async () => {
  $('form-msg').textContent = '';
  try {
    const mod = await import('./vendor/trim-app.js');
    const sdk = new mod.TrimApp();
    await sdk.ready();
    const params = {
      directory: true,
      title: '选择输出目录',
      okText: '选择此目录',
      creatable: true,
    };
    let res;
    if (sdk.isWeb && !sdk.isStandaloneWeb) {
      // 桌面/应用中心宿主环境：直接调起文件管理器
      res = await sdk.pickUserFile(params);
    } else {
      // 独立浏览器：走 openAppAuth 授权跳转，选完后回调回本页
      $('form-msg').textContent = '正在打开文件管理器…';
      await sdk.openAppAuth('pickUserFile', {
        ...params,
        appName: 'n_m3u8dl_re',
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
  if (!data.ok) alert(data.error || '重试失败');
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
          <button class="btn btn-sm btn-outline-primary btn-fopen" data-path="${esc(f.path)}">打开</button>
          <a class="btn btn-sm btn-outline-secondary" href="${API({ action: 'download', path: f.path })}">下载</a>
          <button class="btn btn-sm btn-outline-danger btn-fdel" data-path="${esc(f.path)}">删除</button>
        </span>
      </div>`).join('');
    box.querySelectorAll('.btn-fopen').forEach((b) => {
      b.addEventListener('click', () => openViaFn('openFile', b.dataset.path));
    });
    box.querySelectorAll('.btn-fdel').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('确定删除文件「' + b.dataset.path + '」吗？')) return;
        await act({ action: 'delete_file', path: b.dataset.path });
        loadFiles();
      });
    });
  } catch (e) {
    box.innerHTML = '<p class="empty">加载失败: ' + esc(e.message) + '</p>';
  }
}

// ---------- 启动：生成配置表单 + 轮询刷新 ----------
buildCfgForm();
refreshTasks();
setInterval(refreshTasks, POLL_MS);

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
