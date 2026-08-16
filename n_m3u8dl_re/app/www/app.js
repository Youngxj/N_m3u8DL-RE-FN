/* N_m3u8DL-RE Web UI（fnOS index.cgi 轮询版，零依赖原生 JS） */
'use strict';

// 所有 API 通过相对 URL '?action=...' 调用当前 CGI（页面位于 .../index.cgi/ 下）
const API = (params) => '?' + new URLSearchParams(params).toString();
const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  queued: '排队中', running: '下载中', stopping: '停止中',
  success: '已完成', failed: '失败', stopped: '已停止',
};
const POLL_MS = 1500; // 轮询间隔

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
        <span class="badge ${t.status}">${esc(badge)}</span>
      </div>
    </div>
    <div class="progress-wrap">
      <div class="progress">
        <div class="progress-bar ${t.status === 'success' ? 'ok' : ''}" style="width:${pct}%"></div>
      </div>
      <span class="progress-pct">${pct}%</span>
    </div>
    <div class="task-stats">${stats.join('<span>·</span>') || '<span>等待开始</span>'}</div>
    <div class="task-last" title="${esc(lastRaw)}">${esc(desc)}</div>
    <div class="task-actions">
      ${showStop ? `<button class="btn sm danger btn-stop">停止</button>` : ''}
      ${showRetry ? `<button class="btn sm btn-retry">重试</button>` : ''}
      ${showDel ? `<button class="btn sm btn-del">删除记录</button>` : ''}
    </div>
  </div>`;
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
const CFG_FIELDS = {
  basic: [
    { key: 'save_pattern', label: '保存命名模板', type: 'text', placeholder: '<SaveName>_<Resolution>', hint: '可用变量：<SaveName> <Id> <Codecs> <Language> <Resolution> <Bandwidth> <MediaType> <Channels> <FrameRate> <VideoRange> <GroupId> <Ext>' },
    { key: 'threads', label: '下载线程数', type: 'number', placeholder: '默认=CPU线程数', hint: '--thread-count' },
    { key: 'auto', label: '自动选择最佳音视频', type: 'checkbox', def: true, hint: '--auto-select' },
    { key: 'concurrent', label: '并发下载音视频/字幕', type: 'checkbox', hint: '-mt --concurrent-download' },
    { key: 'mux', label: '完成后混流格式', type: 'select', options: [['', '不混流'], ['mkv', 'mkv'], ['mp4', 'mp4']], hint: '-M format=mkv/mp4' },
    { key: 'subonly', label: '只下载字幕', type: 'checkbox', hint: '--sub-only' },
    { key: 'sub_format', label: '字幕输出格式', type: 'select', options: [['SRT', 'SRT'], ['VTT', 'VTT']], hint: '--sub-format' },
    { key: 'live', label: '直播按点播方式下载', type: 'checkbox', hint: '--live-perform-as-vod' },
    { key: 'max_speed', label: '下载限速', type: 'text', placeholder: '如 15M / 100K', hint: '-R --max-speed' },
  ],
  advanced: [
    { key: 'tmp_dir', label: '临时文件目录', type: 'text', placeholder: '/tmp', hint: '--tmp-dir' },
    { key: 'retry_count', label: '分片失败重试次数', type: 'number', def: 3, hint: '--download-retry-count' },
    { key: 'timeout', label: 'HTTP 请求超时(秒)', type: 'number', def: 100, hint: '--http-request-timeout' },
    { key: 'custom_proxy', label: '自定义代理', type: 'text', placeholder: 'http://127.0.0.1:8888', hint: '--custom-proxy' },
    { key: 'use_system_proxy', label: '使用系统代理', type: 'checkbox', def: true, hint: '--use-system-proxy' },
    { key: 'headers', label: '自定义请求头', type: 'textarea', placeholder: 'Cookie: xxx\nUser-Agent: iOS', hint: '-H 每行一个，如：Cookie: xxx' },
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
    { key: 'skip_merge', label: '跳过合并分片', type: 'checkbox', hint: '--skip-merge' },
    { key: 'binary_merge', label: '二进制合并(不依赖ffmpeg)', type: 'checkbox', hint: '--binary-merge' },
    { key: 'append_url_params', label: '分片附加输入URL参数', type: 'checkbox', hint: '--append-url-params' },
    { key: 'no_date_info', label: '混流不写入日期信息', type: 'checkbox', hint: '--no-date-info' },
    { key: 'disable_update_check', label: '禁用版本更新检测', type: 'checkbox', hint: '--disable-update-check' },
    { key: 'key', label: '解密密钥', type: 'text', placeholder: 'KID1:KEY1 或 KEY', hint: '--key，配合 mp4decrypt/shaka-packager/ffmpeg' },
    { key: 'key_text_file', label: '密钥文件', type: 'text', hint: '--key-text-file' },
    { key: 'decryption_engine', label: '解密引擎', type: 'select', options: [['MP4DECRYPT', 'MP4DECRYPT'], ['FFMPEG', 'FFMPEG'], ['SHAKA_PACKAGER', 'SHAKA_PACKAGER']], hint: '--decryption-engine' },
    { key: 'decryption_binary_path', label: '解密工具路径', type: 'text', hint: '--decryption-binary-path' },
    { key: 'mp4_real_time_decryption', label: '实时解密 MP4 分片', type: 'checkbox', hint: '--mp4-real-time-decryption' },
    { key: 'custom_hls_method', label: 'HLS 加密方式', type: 'select', options: [['', '自动'], ['AES_128', 'AES_128'], ['AES_128_ECB', 'AES_128_ECB'], ['CENC', 'CENC'], ['CHACHA20', 'CHACHA20'], ['NONE', 'NONE'], ['SAMPLE_AES', 'SAMPLE_AES'], ['SAMPLE_AES_CTR', 'SAMPLE_AES_CTR'], ['UNKNOWN', 'UNKNOWN']], hint: '--custom-hls-method' },
    { key: 'custom_hls_key', label: 'HLS 解密 KEY', type: 'text', hint: '--custom-hls-key (FILE/HEX/BASE64)' },
    { key: 'custom_hls_iv', label: 'HLS 解密 IV', type: 'text', hint: '--custom-hls-iv (FILE/HEX/BASE64)' },
    { key: 'log_level', label: '日志级别', type: 'select', options: [['', '默认(INFO)'], ['DEBUG', 'DEBUG'], ['INFO', 'INFO'], ['WARN', 'WARN'], ['ERROR', 'ERROR'], ['OFF', 'OFF']], hint: '--log-level' },
    { key: 'no_log', label: '关闭日志文件输出', type: 'checkbox', hint: '--no-log' },
    { key: 'live_real_time_merge', label: '直播实时合并', type: 'checkbox', hint: '--live-real-time-merge' },
    { key: 'live_record_limit', label: '直播录制时长限制', type: 'text', placeholder: '01:00:00', hint: '--live-record-limit HH:mm:ss' },
    { key: 'live_wait_time', label: '直播列表刷新间隔(秒)', type: 'number', hint: '--live-wait-time' },
    { key: 'live_keep_segments', label: '实时合并时保留分片', type: 'checkbox', def: true, hint: '--live-keep-segments' },
    { key: 'live_pipe_mux', label: '直播管道实时混流', type: 'checkbox', hint: '--live-pipe-mux（网络不稳定勿开）' },
  ],
};

// 生成配置表单
function buildCfgForm() {
  for (const [section, fields] of Object.entries(CFG_FIELDS)) {
    const box = $('cfg-' + section);
    if (!box) continue;
    const html = fields.map((f) => {
      const id = 'cfg-' + f.key;
      if (f.type === 'checkbox') {
        return `<label class="check cfg-check"><input type="checkbox" id="${id}" data-cfg="${f.key}"${f.def ? ' checked' : ''} /> <span>${esc(f.label)}</span></label>`;
      }
      if (f.type === 'select') {
        const opts = f.options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
        return `<label class="cfg-field"><span>${esc(f.label)}</span><select id="${id}" data-cfg="${f.key}">${opts}</select></label>`;
      }
      if (f.type === 'textarea') {
        return `<label class="cfg-field cfg-full"><span>${esc(f.label)}</span><textarea id="${id}" data-cfg="${f.key}" placeholder="${esc(f.placeholder || '')}" rows="2"></textarea></label>`;
      }
      return `<label class="cfg-field"><span>${esc(f.label)}</span><input type="${f.type}" id="${id}" data-cfg="${f.key}" placeholder="${esc(f.placeholder || '')}" value="${f.def != null ? esc(String(f.def)) : ''}" /></label>`;
    }).join('');
    box.innerHTML = html;
  }
  // 折叠开关
  document.querySelectorAll('.cfg-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const body = $(btn.dataset.target);
      const open = body.classList.toggle('open');
      btn.querySelector('.cfg-caret').textContent = open ? '▾' : '▸';
    });
  });
}

// 收集配置字段 → 请求参数
function collectCfgParams(params) {
  document.querySelectorAll('[data-cfg]').forEach((el) => {
    const key = el.dataset.cfg;
    if (el.type === 'checkbox') {
      if (el.checked) params[key] = '1';
    } else if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number') {
      const v = el.value.trim();
      if (v !== '') params[key] = v;
    }
  });
  return params;
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
      $('f-custom-dir').closest('label').classList.remove('hidden');
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
  $('f-custom-dir').closest('label').classList.toggle('hidden', !isCustom);
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
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const isFiles = tab.dataset.tab === 'files';
    $('tab-tasks').classList.toggle('hidden', isFiles);
    $('tab-files').classList.toggle('hidden', !isFiles);
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
        <div style="flex:1;min-width:0">
          <div class="file-name" title="${esc(f.path)}">${esc(f.name)}</div>
          <div class="file-path" title="${esc(f.path)}">${esc(f.path)}</div>
        </div>
        <span class="file-meta">${fmtSize(f.size)} · ${fmtTime(f.mtime)}</span>
        <span class="file-actions">
          <a class="btn sm" href="${API({ action: 'download', path: f.path })}">下载</a>
          <button class="btn sm danger btn-fdel" data-path="${esc(f.path)}">删除</button>
        </span>
      </div>`).join('');
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
        $('f-custom-dir').closest('label').classList.remove('hidden');
        $('form-msg').textContent = '已选择目录：' + p;
      } else {
        $('form-msg').textContent = q.get('error') ? '授权未完成：' + q.get('error') : '未获取到目录';
      }
    }
  } catch (_) { /* 忽略非回调页 */ }
})();
