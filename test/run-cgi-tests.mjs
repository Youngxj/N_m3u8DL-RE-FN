/**
 * index.cgi 本地集成测试（git-bash 模拟 CGI 环境）
 * 用法：node test/run-cgi-tests.mjs
 *
 * 构建一个假的 fnOS 应用目录（target），用 git-bash 直接执行 index.cgi，
 * 设置 QUERY_STRING / REQUEST_METHOD / REQUEST_URI / TRIM_* 环境变量模拟 CGI 调用。
 * 覆盖：静态页面、任务创建/进度轮询/完成、停止/删除、文件管理、目录穿越防护。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'm3u8_down');
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

// ---------- 构建假应用目录 ----------
// 双路径：fs 操作用 Windows 路径；传给 bash 的环境变量用 MSYS 风格（/c/...），
// 否则 CGI 里 ${VAR%%:*} 会按冒号把 Windows 盘符 C: 切掉。
const toMsys = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => '/' + d.toLowerCase());
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nre-cgi-'));
const WT = path.join(T, 'target');   // Windows 路径（fs 用）
const WV = path.join(T, 'var');
const WS = path.join(T, 'share');
const TARGET = toMsys(WT);           // MSYS 路径（bash 环境用）
const VAR = toMsys(WV);
const SHARE = toMsys(WS);

for (const d of [WT, WV, WS, path.join(WT, 'www'), path.join(WT, 'bin'), path.join(WT, 'ui')]) {
  fs.mkdirSync(d, { recursive: true });
}
// 复制真实文件到假目录
fs.copyFileSync(path.join(PKG, 'app', 'ui', 'index.cgi'), path.join(WT, 'ui', 'index.cgi'));
fs.copyFileSync(path.join(PKG, 'app', 'bin', 'task-run.sh'), path.join(WT, 'bin', 'task-run.sh'));
fs.copyFileSync(path.join(PKG, 'app', 'bin', 'update-run.sh'), path.join(WT, 'bin', 'update-run.sh'));
fs.copyFileSync(path.join(__dirname, 'mock-nre.sh'), path.join(WT, 'bin', 'N_m3u8DL-RE'));
for (const f of ['index.html', 'app.js', 'style.css', 'version']) {
  fs.copyFileSync(path.join(PKG, 'app', 'www', f), path.join(WT, 'www', f));
}

const CGI = TARGET + '/ui/index.cgi';

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 调用一次 CGI */
function cgi({ query = '', method = 'GET', uri, body = '', env = {} } = {}) {
  const res = spawnSync(BASH, [CGI], {
    env: {
      ...process.env,
      REQUEST_METHOD: method,
      QUERY_STRING: query,
      REQUEST_URI: uri || '/cgi/ThirdParty/m3u8_down/index.cgi/',
      TRIM_APPDEST: TARGET,
      TRIM_PKGVAR: VAR,
      TRIM_DATA_SHARE_PATHS: SHARE,
      ...env,
    },
    input: body,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = res.stdout || '';
  // 拆 headers 与 body
  const idx = out.indexOf('\r\n\r\n');
  const head = idx >= 0 ? out.slice(0, idx) : '';
  const content = idx >= 0 ? out.slice(idx + 4) : out;
  return { status: res.status, head, body: content, raw: out };
}

async function main() {
  console.log('== 1. 静态页面 ==');
  const page = cgi({ uri: '/cgi/ThirdParty/m3u8_down/index.cgi/' });
  check('index.html 返回 200 语义（无 Status 404）', !page.head.includes('404'), page.head.split('\r\n')[0]);
  check('页面包含 N_m3u8DL-RE', page.body.includes('N_m3u8DL-RE') && page.body.includes('新建下载任务'));
  check('Content-Type text/html', /text\/html/i.test(page.head), page.head.split('\r\n')[0]);

  const js = cgi({ uri: '/cgi/ThirdParty/m3u8_down/index.cgi/app.js' });
  check('app.js 正常返回', /application\/javascript/i.test(js.head) && js.body.includes('refreshTasks'), js.head.split('\r\n')[0]);
  const css = cgi({ uri: '/cgi/ThirdParty/m3u8_down/index.cgi/style.css' });
  check('style.css 正常返回', /text\/css/i.test(css.head));

  // 无尾斜杠 → 302 跳转到带斜杠版本（保证相对资源解析）
  const noredir = cgi({ uri: '/cgi/ThirdParty/m3u8_down/index.cgi' });
  check('无尾斜杠 302 跳转', /^Location: .*index\.cgi\//m.test(noredir.head) && /302/.test(noredir.head), noredir.head.split('\r\n')[0]);
  // 带查询串的无尾斜杠跳转，斜杠加在 ? 前
  const noredirQ = cgi({ uri: '/cgi/ThirdParty/m3u8_down/index.cgi?x=1' });
  check('带查询串跳转位置正确', /Location: .*index\.cgi\/\?x=1/.test(noredirQ.head), noredirQ.head.split('\r\n')[0]);

  console.log('== 2. 创建任务 ==');
  // 预置一个无关文件到共享目录，验证"已下载文件"只列出程序自身下载的文件
  fs.writeFileSync(path.join(WS, '用户自己的文件.txt'), 'not from app');
  const enc = (s) => encodeURIComponent(s);
  const shareEnc = enc(SHARE);
  const createBody = `action=create&url=${enc('https://example.com/a/b.m3u8?token=1&sig=2')}&name=${enc('测试任务')}&auto=1&mux=mkv&dir=${shareEnc}`;
  const created = cgi({ method: 'POST', body: createBody });
  let taskId = null;
  try {
    const j = JSON.parse(created.body);
    check('create 返回 ok', j.ok === true, created.body);
    taskId = j.id;
    check('create 返回任务 id', !!taskId, created.body);
  } catch (e) {
    check('create 返回合法 JSON', false, created.body);
  }
  // URL 含 & 的解析正确性：从 status 返回的 task.url 验证
  const st0 = cgi({ query: 'action=status' });
  const j0 = JSON.parse(st0.body);
  const t0 = (j0.tasks || []).find((x) => x.id === taskId);
  check('URL 含 & 参数被完整解析', !!t0 && t0.url.includes('sig=2'), t0 ? t0.url : '(无任务)');

  console.log('== 3. 实时进度轮询（最多 30s）==');
  let maxProgress = 0, sawRunning = false, lastLen = 0, finalStatus = null, optionsOk = false;
  let sawSpeed = false, sawDlTotal = false, sawStream = false, sawEta = false;
  for (let i = 0; i < 120; i++) {
    const st = cgi({ query: 'action=status' });
    try {
      const j = JSON.parse(st.body);
      const t = (j.tasks || []).find((x) => x.id === taskId);
      if (t) {
        if (t.progress > maxProgress) maxProgress = t.progress;
        if (t.status === 'running') sawRunning = true;
        if (typeof t.last === 'string') lastLen = Math.max(lastLen, t.last.length);
        if (t.speed && /MB\/s/.test(t.speed)) sawSpeed = true;
        if (t.downloaded && t.total && t.total.includes('MB')) sawDlTotal = true;
        if (t.stream === 'Vid') sawStream = true;
        if (t.eta && /^\d{2}:\d{2}:\d{2}$/.test(t.eta)) sawEta = true;
        if (t.options && t.options.autoSelect === true && t.options.muxFormat === 'mkv') optionsOk = true;
        if (t.status === 'success' || t.status === 'failed') { finalStatus = t.status; break; }
      }
    } catch (_) { /* 忽略瞬时解析失败 */ }
    await sleep(300);
  }
  check('观察到 running 状态', sawRunning);
  check('进度增长并最终 100%', maxProgress === 100, `max=${maxProgress}`);
  check('任务最终 success', finalStatus === 'success', String(finalStatus));
  check('最新一行 last 有内容', lastLen > 0, `len=${lastLen}`);
  check('速度解析为 MB/s', sawSpeed);
  check('已下载/总量解析', sawDlTotal);
  check('流类型解析(Vid)', sawStream);
  check('ETA 解析', sawEta);
  check('options 保留（重试用）', optionsOk);

  console.log('== 4. 文件管理 ==');
  const files = cgi({ query: 'action=files' });
  let hasFile = false;
  try {
    const j = JSON.parse(files.body);
    const names = (j.files || []).map((f) => f.name);
    hasFile = names.includes('测试任务.mp4');
    check('文件列表包含任务输出', hasFile, JSON.stringify(names));
    check('文件列表含完整路径', (j.files || []).some((f) => f.path && f.path.includes('测试任务.mp4')), JSON.stringify((j.files || [])[0] || {}));
    check('文件大小 > 0', (j.files || []).some((f) => f.name === '测试任务.mp4' && f.size > 0));
    check('预置的无关文件不被列出', !names.includes('用户自己的文件.txt'), JSON.stringify(names));
  } catch (e) {
    check('files 返回合法 JSON', false, files.body);
  }
  const dl = cgi({ query: `action=download&path=${enc(SHARE + '/测试任务.mp4')}` });
  check('download 返回二进制内容', dl.body.length > 0 && !dl.body.startsWith('{"ok"'), `len=${dl.body.length}`);

  console.log('== 4d. 更新检查（离线模式：NRE_UPDATE_SKIP_NET=1）==');
  const upd = cgi({ query: 'action=update_check', env: { NRE_UPDATE_SKIP_NET: '1' } });
  try {
    const j = JSON.parse(upd.body);
    check('update_check 返回 ok', j.ok === true, upd.body.slice(0, 120));
    check('离线模式 network=skipped', j.network === 'skipped', String(j.network));
    check('返回本地应用版本', typeof j.appVersion === 'string' && j.appVersion.length > 0, JSON.stringify(j.appVersion));
    check('返回本地引擎版本', typeof j.engineVersion === 'string' && j.engineVersion.length > 0, JSON.stringify(j.engineVersion));
    check('离线时无最新版本不误报有更新', !(j.engine && j.engine.upToDate === false) && !(j.app && j.app.upToDate === false), upd.body.slice(0, 160));
    check('离线时 engine/app 字段结构完整', !!(j.engine && typeof j.engine === 'object') && !!(j.app && typeof j.app === 'object'), upd.body.slice(0, 160));
  } catch (e) {
    check('update_check 返回合法 JSON', false, upd.body.slice(0, 160));
  }
  // 无 version 文件时仍应返回合法 JSON（版本字段为空）
  const updNoVer = cgi({ query: 'action=update_check', env: { NRE_UPDATE_SKIP_NET: '1', TRIM_APPDEST: toMsys(fs.mkdtempSync(path.join(os.tmpdir(), 'nre-upd-')) + '\\x') } });
  let updNoVerOk = false;
  try { const j = JSON.parse(updNoVer.body); updNoVerOk = j.ok === true; } catch (_) {}
  check('无 version 文件时 update_check 仍 ok', updNoVerOk, updNoVer.body.slice(0, 120));

  console.log('== 4e. 引擎更新 / 应用下载（离线模式）==');
  const engUpd = cgi({ query: 'action=engine_update', env: { NRE_UPDATE_SKIP_NET: '1' } });
  let engUpdOk = false;
  try { const j = JSON.parse(engUpd.body); engUpdOk = j.ok === false && /禁用联网/.test(j.error || ''); } catch (_) {}
  check('engine_update 离线时拒绝并提示', engUpdOk, engUpd.body.slice(0, 120));
  const appDl = cgi({ query: 'action=app_download', env: { NRE_UPDATE_SKIP_NET: '1' } });
  let appDlOk = false;
  try { const j = JSON.parse(appDl.body); appDlOk = j.ok === false && /禁用联网/.test(j.error || ''); } catch (_) {}
  check('app_download 离线时拒绝并提示', appDlOk, appDl.body.slice(0, 120));
  const updJob = cgi({ query: 'action=update_check', env: { NRE_UPDATE_SKIP_NET: '1' } });
  let jobFieldOk = false;
  try { const j = JSON.parse(updJob.body); jobFieldOk = j.updateJob === null || (j.updateJob && typeof j.updateJob === 'object'); } catch (_) {}
  check('update_check 含 updateJob 字段', jobFieldOk, updJob.body.slice(0, 160));

  console.log('== 4b. 无 TRIM_DATA_SHARE_PATHS 时目录回退（shares/ → var/downloads）==');
  const fb = cgi({ method: 'POST', body: `action=create&url=${enc('https://example.com/fallback.m3u8')}&name=回退测试`, env: { TRIM_DATA_SHARE_PATHS: '' } });
  let fbOk = false;
  try { fbOk = !!JSON.parse(fb.body).id; } catch (_) {}
  check('回退路径创建任务成功', fbOk, fb.body.slice(0, 120));

  console.log('== 4c. 无 TRIM_* 环境变量（真实路径推导 appname）==');
  // 模拟 fnOS 真实布局：<T2>/m3u8_down/{ui,bin,www,var,shares}，不传任何 TRIM_*
  const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nre-cgi2-'));
  const W2 = path.join(T2, 'm3u8_down');
  for (const d of [path.join(W2, 'ui'), path.join(W2, 'bin'), path.join(W2, 'www'), path.join(W2, 'var'), path.join(W2, 'shares')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(PKG, 'app', 'ui', 'index.cgi'), path.join(W2, 'ui', 'index.cgi'));
  fs.copyFileSync(path.join(PKG, 'app', 'bin', 'task-run.sh'), path.join(W2, 'bin', 'task-run.sh'));
  fs.copyFileSync(path.join(PKG, 'app', 'bin', 'update-run.sh'), path.join(W2, 'bin', 'update-run.sh'));
  fs.copyFileSync(path.join(__dirname, 'mock-nre.sh'), path.join(W2, 'bin', 'N_m3u8DL-RE'));
  for (const f of ['index.html', 'app.js', 'style.css', 'version']) fs.copyFileSync(path.join(PKG, 'app', 'www', f), path.join(W2, 'www', f));
  const CGI2 = toMsys(path.join(W2, 'ui', 'index.cgi'));
  const cgi2 = (opts = {}) => {
    const r = spawnSync(BASH, [CGI2], {
      env: { ...process.env, REQUEST_METHOD: opts.method || 'GET', QUERY_STRING: opts.query || '', REQUEST_URI: opts.uri || '/cgi/ThirdParty/m3u8_down/index.cgi/' },
      input: opts.body || '', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    const out = r.stdout || '';
    const idx = out.indexOf('\r\n\r\n');
    return { head: idx >= 0 ? out.slice(0, idx) : '', body: idx >= 0 ? out.slice(idx + 4) : out };
  };
  const c2 = cgi2({ method: 'POST', body: `action=create&url=${enc('https://example.com/real.m3u8')}&name=真机模拟` });
  let c2Id = null, c2OutDir = '';
  try {
    const j = JSON.parse(c2.body);
    c2Id = j.id;
  } catch (_) {}
  check('真实路径推导下创建成功', !!c2Id, c2.body.slice(0, 150));
  const st2 = cgi2({ query: 'action=status' });
  try {
    const j = JSON.parse(st2.body);
    const t = (j.tasks || []).find((x) => x.id === c2Id);
    c2OutDir = t ? t.outDir || '' : '';
  } catch (_) {}
  check('输出目录落到 shares/downloads', c2OutDir.endsWith('shares/downloads'), c2OutDir);
  try { fs.rmSync(T2, { recursive: true, force: true }); } catch (_) {}

  console.log('== 5. 安全：目录穿越防护 ==');
  const trav1 = cgi({ query: `action=download&file=${enc('../../../../etc/passwd')}` });
  check('download 穿越被拒绝(file)', trav1.body.includes('"ok":false'), trav1.body.slice(0, 80));
  const trav1b = cgi({ query: `action=download&path=${enc('/etc/passwd')}` });
  check('download 越权路径被拒绝(path)', trav1b.body.includes('"ok":false'), trav1b.body.slice(0, 80));
  const trav2 = cgi({ query: `action=delete_file&file=${enc('..%2F..%2Fetc%2Fpasswd')}` });
  check('delete_file 穿越被拒绝', trav2.body.includes('"ok":false'), trav2.body.slice(0, 80));
  const trav3 = cgi({ uri: '/cgi/ThirdParty/m3u8_down/index.cgi/../../../../etc/passwd' });
  check('静态路径穿越被拒绝', trav3.head.includes('404'), trav3.head.split('\r\n')[0]);

  console.log('== 6. 停止 / 删除 ==');
  const stopId = cgi({ method: 'POST', body: `action=create&url=${enc('https://example.com/slow.m3u8')}&name=停止测试` });
  const sid = JSON.parse(stopId.body).id;
  await sleep(800);
  const stopRes = cgi({ query: `action=stop&id=${sid}` });
  check('stop 返回 ok', stopRes.body.includes('"ok":true'), stopRes.body.slice(0, 80));
  let stopped = false;
  for (let i = 0; i < 30; i++) {
    const st = cgi({ query: 'action=status' });
    const j = JSON.parse(st.body);
    const t = (j.tasks || []).find((x) => x.id === sid);
    if (t && (t.status === 'stopped' || t.status === 'failed')) { stopped = true; break; }
    await sleep(300);
  }
  check('任务已停止', stopped);

  const delRes = cgi({ query: `action=remove&id=${sid}` });
  check('remove 返回 ok', delRes.body.includes('"ok":true'), delRes.body.slice(0, 80));
  const after = cgi({ query: 'action=status' });
  const jAfter = JSON.parse(after.body);
  check('任务已从列表移除', !(jAfter.tasks || []).some((t) => t.id === sid));
  const delFile = cgi({ query: `action=delete_file&path=${enc(SHARE + '/测试任务.mp4')}` });
  check('删除文件 ok', delFile.body.includes('"ok":true'));

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { /* 后台进程仍占用时忽略 */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
