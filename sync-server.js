/* scripts/sync-server.js —— 零依赖私有同步端点（CET4 / CET6 共用，两仓文件字节一致）
 *
 * 只做两件事：按「项目 + 学习编号」存一份权威副本，用 rev 做乐观锁。不建账号体系、不依赖云厂商。
 * 启动：  node scripts/sync-server.js
 * 环境变量（CET4_SYNC_* / CET6_SYNC_* 为旧名，仍然兼容）：
 *   SYNC_TOKEN   必填，圈子口令（所有设备共用）
 *   SYNC_USERS   可选，'1001:口令1,1002:口令2' —— 每人独立口令、严格互相隔离；配置后 TOKEN 失效
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

if (!SHARED_TOKEN && !Object.keys(USERS).length) {
  console.error('未设置 SYNC_TOKEN（或 SYNC_USERS），服务拒绝以无口令状态启动。');
  process.exit(1);
}
for (const ns of ['cet4', 'cet6']) fs.mkdirSync(path.join(DATA, ns), { recursive: true });

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authorized(id, token) {
  if (Object.keys(USERS).length) return !!USERS[id] && safeEqual(USERS[id], token);
  return !!SHARED_TOKEN && safeEqual(SHARED_TOKEN, token);
}
function fileOf(ns, id) { return path.join(DATA, ns, 'state-' + id + '.json'); }
function readRec(ns, id) {
  try { const j = JSON.parse(fs.readFileSync(fileOf(ns, id), 'utf8')); return j && typeof j === 'object' ? j : null; }
  catch (e) { return null; }
}
function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj || {});
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token',
    'Access-Control-Max-Age': '600'
  }, extraHeaders || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
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

  if (!authorized(id, req.headers['x-sync-token'] || '')) {
    // 不区分「口令错」与「编号不存在」，避免探测哪个编号有人用
    send(res, 401, { error: 'unauthorized' }); return;
  }

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
    ' | 身份模式：' + (Object.keys(USERS).length ? '每人独立口令（' + Object.keys(USERS).length + ' 人）' : '圈子共享口令'));
});
