/* scripts/sync-server.js —— 零依赖私有同步端点（CET4 / CET6 共用，两仓文件字节一致）
 *
 * 只做两件事：按「项目 + 学习编号」存一份权威副本，用 rev 做乐观锁。不建账号体系、不依赖云厂商。
 * 启动：  node scripts/sync-server.js
 * 环境变量（CET4_SYNC_* / CET6_SYNC_* 为旧名，仍然兼容）：
 *   SYNC_TOKEN   必填，圈子口令（所有设备共用）—— 仅 SYNC_ALLOW_SHARED=1 时才允许单独使用
 *   SYNC_USERS   可选，'1001:口令1,1002:口令2' —— 每人独立口令、严格互相隔离；配置后 TOKEN 失效
 *   SYNC_ALLOW_SHARED  默认 0；设为 1 才允许"仅 SYNC_TOKEN"的共享口令模式。
 *                共享模式下服务端无法把口令绑到具体编号，任何持口令者可换编号读写他人分片，
 *                必须显式 opt-in 才放行（安全修复：防止误用共享口令却以为做到了按人隔离）。
 *   SYNC_FAIL_MAX / SYNC_FAIL_WINDOW_MS / SYNC_BLOCK_MS  鉴权失败限速（按 IP+编号），见下方
 *   SYNC_PORT    默认 8787
 *   SYNC_DATA    数据目录，默认 scripts/sync-data/；其下按 cet4/ cet6/ 分目录
 *   SYNC_NS      无前缀请求（/state/:id）使用的默认命名空间，默认 cet4
 *   SYNC_ORIGIN  CORS 允许源，默认 *；建议设为自己的 GitHub Pages 源
 *   SYNC_TLS_KEY / SYNC_TLS_CERT  可选，直接以 https 启动（否则由反向代理终结 TLS）
 *
 * 一套服务即可支撑两个项目：客户端 endpoint 分别填 https://host/cet4 与 https://host/cet6，
 * 请求落到 /cet4/state/:id 与 /cet6/state/:id，数据分目录存放；不带前缀的旧客户端走 SYNC_NS。
 *
 * 部署到公网时务必在前面挂 TLS（Caddy / Nginx / Cloudflare Tunnel 均可）：
 * GitHub Pages 是 https，浏览器会拦截 http 混合内容。本服务默认只监听本地端口，由反代转发。
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 旧名兼容：先读中性名，再读 CET4_SYNC_*，最后读 CET6_SYNC_*
function env(name, fallback) {
  const aliases = ['SYNC_' + name, 'CET4_SYNC_' + name, 'CET6_SYNC_' + name];
  for (const k of aliases) if (process.env[k]) return process.env[k];
  return fallback;
}
const PORT = Number(env('PORT', 8787));
const DATA = env('DATA', path.join(__dirname, 'sync-data'));
const ORIGIN = env('ORIGIN', '*');
const DEFAULT_NS = /^(cet4|cet6)$/.test(env('NS', 'cet4')) ? env('NS', 'cet4') : 'cet4';
const MAX_BODY = 5 * 1024 * 1024; // 与前端导入备份的 5MB 上限一致
const USERS = (env('USERS', '') || '').split(',').map(s => s.trim()).filter(Boolean)
  .reduce((m, kv) => { const i = kv.indexOf(':'); if (i > 0) m[kv.slice(0, i)] = kv.slice(i + 1); return m; }, {});
const SHARED_TOKEN = env('TOKEN', '') || '';
// 共享口令模式必须显式 opt-in：否则"换了编号就能用同一口令读写他人分片"等同于越权。
const ALLOW_SHARED = env('ALLOW_SHARED', '') === '1';
// 鉴权失败限速：按 IP + 学习编号计数，防口令爆破与跨编号试探。
const FAIL_MAX = Math.max(3, Number(env('FAIL_MAX', 10)) || 10);
const FAIL_WINDOW_MS = Math.max(1000, Number(env('FAIL_WINDOW_MS', 300000)) || 300000);
const BLOCK_MS = Math.max(1000, Number(env('BLOCK_MS', 900000)) || 900000);

if (!SHARED_TOKEN && !Object.keys(USERS).length) {
  console.error('未设置 SYNC_TOKEN（或 SYNC_USERS），服务拒绝以无口令状态启动。');
  process.exit(1);
}
// 安全修复：只有 SHARED_TOKEN、没有 SYNC_USERS 时，口令与编号不绑定 —— 持口令者可换任意编号读写。
// 要么配 SYNC_USERS 做逐人隔离，要么显式设 SYNC_ALLOW_SHARED=1 自担风险，否则拒绝启动。
if (!Object.keys(USERS).length && !ALLOW_SHARED) {
  console.error('检测到仅设置 SYNC_TOKEN（共享口令），未设置 SYNC_USERS。');
  console.error('共享口令不与学习编号绑定：任何知道口令的人换一个 4 位编号即可读写他人云端分片。');
  console.error('请改用 SYNC_USERS=1001:口令1,1002:口令2 做逐人隔离；');
  console.error('若确实要在可信小圈子里共用口令，请显式设置 SYNC_ALLOW_SHARED=1 后重启。');
  process.exit(1);
}
for (const ns of ['cet4', 'cet6']) fs.mkdirSync(path.join(DATA, ns), { recursive: true });

function safeEqual(a, b) {
  // 先定长哈希再比较：长度不同的输入也走相同耗时，避免长度短路泄露口令长度（时序侧信道修复）
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function authorized(id, token) {
  if (Object.keys(USERS).length) {
    // 逐人隔离：编号不存在或口令不符都拒绝，且两条路径都跑一次哈希比较，避免"编号不存在"可被计时区分
    const expected = USERS[id];
    const ok = !!expected && safeEqual(expected, token);
    if (!expected) safeEqual(SHARED_TOKEN || '\u0000', token);
    return ok;
  }
  // 共享口令模式：只有显式 SYNC_ALLOW_SHARED=1 才会走到这里（启动已拦截默认情况）。
  // 此模式下口令不绑定编号是设计如此，属于知情选择；日志在启动时已高声警告。
  return ALLOW_SHARED && !!SHARED_TOKEN && safeEqual(SHARED_TOKEN, token);
}

// 鉴权失败限速：key = 客户端 IP + 编号，FAIL_MAX 次失败后封锁 BLOCK_MS。
// 成功即清零，避免正常用户被偶发失败累计误伤。内存态，重启即清空（本地私有端点足够）。
const failLog = new Map();
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String((req.socket && req.socket.remoteAddress) || 'unknown');
}
function rateKey(req, id) { return clientIp(req) + '|' + String(id); }
function isThrottled(key, now) {
  const rec = failLog.get(key);
  if (!rec) return false;
  if (now - rec.firstAt > FAIL_WINDOW_MS) { failLog.delete(key); return false; }
  return rec.count >= FAIL_MAX;
}
function noteFail(key, now) {
  let rec = failLog.get(key);
  if (!rec || now - rec.firstAt > FAIL_WINDOW_MS) rec = { count: 0, firstAt: now };
  rec.count++;
  failLog.set(key, rec);
}
function noteSuccess(key) { failLog.delete(key); }
function fileOf(ns, id) { return path.join(DATA, ns, 'state-' + id + '.json'); }
function readRec(ns, id) {
  try { const j = JSON.parse(fs.readFileSync(fileOf(ns, id), 'utf8')); return j && typeof j === 'object' ? j : null; }
  catch (e) { return null; }
}
function send(res, code, obj, extraHeaders) {
  const noBody = (code === 204 || code === 304);
  const body = noBody ? '' : JSON.stringify(obj || {});
  const headers = {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token',
    'Access-Control-Max-Age': '600'
  };
  if (!noBody) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  res.writeHead(code, Object.assign(headers, extraHeaders || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let aborted = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        // 不再 req.destroy()：那会让客户端拿不到响应、只能干等超时。
        // 标记后由 end 事件统一回 400，客户端立刻知道是"太大"而非网络故障。
        aborted = true; return;
      }
      if (!aborted) chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) { reject(new Error('body too large')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const handler = (req, res) => {
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }
  if (req.url === '/health' && req.method === 'GET') { send(res, 200, { ok: true, ns: DEFAULT_NS }); return; }

  // 允许 /state/:id（旧客户端）与 /cet4|cet6/state/:id（多项目共用一套服务）
  const m = /^\/(?:(cet4|cet6)\/)?state\/(\d{4})(?:\?.*)?$/.exec(req.url || '');
  if (!m) { send(res, 404, { error: 'not found' }); return; }
  const ns = m[1] || DEFAULT_NS;
  const id = m[2];

  const rk = rateKey(req, id);
  if (isThrottled(rk, Date.now())) {
    send(res, 429, { error: 'too many attempts' }); return;
  }
  if (!authorized(id, req.headers['x-sync-token'] || '')) {
    noteFail(rk, Date.now());
    // 不区分「口令错」与「编号不存在」，避免探测哪个编号有人用
    send(res, 401, { error: 'unauthorized' }); return;
  }
  noteSuccess(rk);

  if (req.method === 'GET') {
    const rec = readRec(ns, id);
    if (!rec) { send(res, 200, { rev: 0, updatedAt: null, deviceId: null, state: null }); return; }
    send(res, 200, { rev: rec.rev || 0, updatedAt: rec.updatedAt || null, deviceId: rec.deviceId || null, state: rec.state || null });
    return;
  }

  if (req.method === 'PUT') {
    readBody(req).then(body => {
      if (!body || typeof body.state !== 'object' || body.state === null || Array.isArray(body.state)) {
        send(res, 400, { error: 'state must be an object' }); return;
      }
      const cur = readRec(ns, id) || { rev: 0, state: null };
      const incoming = Number(body.rev) || 0;
      if (incoming !== (cur.rev || 0)) {
        // 乐观锁冲突：把当前值带回，客户端自行字段级合并后用新 rev 重试
        send(res, 409, { rev: cur.rev || 0, state: cur.state || null, error: 'rev conflict' });
        return;
      }
      const next = {
        rev: (cur.rev || 0) + 1,
        updatedAt: new Date().toISOString(),
        deviceId: String(body.deviceId || '').slice(0, 64),
        state: body.state
      };
      // 原子写 + 保留上一版 .bak：同步盘/进程被杀都不会留下半个 JSON
      const f = fileOf(ns, id), tmp = f + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
        if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');
        fs.renameSync(tmp, f);
      } catch (e) {
        console.error('[' + new Date().toISOString() + '] write failed for ' + ns + '/' + id + ': ' + e.message);
        send(res, 500, { error: 'write failed' }); return;
      }
      console.log('[' + new Date().toISOString() + '] saved ' + ns + '/' + id + ' rev=' + next.rev +
        ' bytes=' + Buffer.byteLength(JSON.stringify(next.state)));
      send(res, 200, { rev: next.rev, updatedAt: next.updatedAt });
    }).catch(e => { send(res, 400, { error: e.message }); });
    return;
  }

  send(res, 405, { error: 'method not allowed' });
};

const tlsKey = env('TLS_KEY', ''), tlsCert = env('TLS_CERT', '');
const server = (tlsKey && tlsCert)
  ? https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, handler)
  : http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => {
  console.log('CET 同步端点已启动： http' + (tlsKey ? 's' : '') + '://127.0.0.1:' + PORT);
  console.log('数据目录：' + DATA + '（cet4/ 与 cet6/ 分目录）| 默认命名空间：' + DEFAULT_NS +
    ' | 身份模式：' + (Object.keys(USERS).length ? '每人独立口令（' + Object.keys(USERS).length + ' 人，严格隔离）' : '圈子共享口令（SYNC_ALLOW_SHARED=1，不按编号隔离，仅限可信环境）'));
  console.log('鉴权失败限速：' + FAIL_MAX + ' 次 / ' + Math.round(FAIL_WINDOW_MS / 1000) + ' 秒 → 封锁 ' + Math.round(BLOCK_MS / 1000) + ' 秒（按 IP+编号）');
});
