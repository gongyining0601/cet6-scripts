#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_stress_sync.js · 私有同步服务真实并发压测（本地自建实例）

   压什么：scripts/sync-server.js —— 零依赖 HTTP 端点，按「项目 + 学习编号」存权威副本，
           用 rev 做乐观锁。这是本项目唯一真实存在的服务端代码。
   压哪里：只打 127.0.0.1 的临时端口，数据目录在 os.tmpdir()，跑完即删。
           **绝不触碰线上 https://gongyining.top/cet6**（那是真实用户数据）。
   不压什么：GitHub Pages 是 GitHub 的 CDN，压它等于测 GitHub，不是测本项目。

   场景：
     S1 健康检查 / 鉴权（错误口令 401、无口令 401）
     S2 并发吞吐：N 个编号 × M 轮串行 PUT（真实 ~50KB 状态），全程并发
     S3 乐观锁冲突：同一编号、同一 rev 的 K 个并发 PUT → 必须恰好 1 个 200、其余 409
     S4 命名空间/编号隔离：cet4 与 cet6 互不串、相邻编号互不串
     S5 原子写完整性：GET 回读 rev 与 state 字节、每个 state-*.json 都能 JSON.parse、
        .bak 存在（进程被杀不留半个 JSON 的设计）
   产物：docs/stress-sync-result.json
   退出码：0 = 全部达标，1 = 有失败
   用法：node test_stress_sync.js
   ============================================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SERVER = path.join(__dirname, 'sync-server.js');
const TOKEN = 'cet6-stress-only-token';
const PORT = 19000 + Math.floor(Math.random() * 2000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cet6-stress-sync-'));
const USERS = 20;         // 并发编号数
const ROUNDS = 30;        // 每编号串行 PUT 次数
const CONFLICT_N = 20;    // 同 rev 并发冲突数
const PAYLOAD_KB = 50;    // 每份 state 约 50KB，接近真实多年积累

let ok = 0, fail = 0;
const checks = [];
function chk(cond, name, detail) {
  cond ? ok++ : fail++;
  checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? 'ok   - ' : 'FAIL - ') + name + (detail !== undefined ? ' | ' + detail : ''));
}

const R = {
  ts: new Date().toISOString(),
  target: '127.0.0.1:' + PORT + '（本地临时实例，非生产）',
  productionTouched: false,
  config: { users: USERS, rounds: ROUNDS, conflictN: CONFLICT_N, payloadKB: PAYLOAD_KB },
  scenarios: {}, latencyMs: [], httpStatus: {}, checks
};

function request(method, pathname, token, body) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const t0 = process.hrtime.bigint();
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: pathname,
      headers: Object.assign(
        { 'X-Sync-Token': token || '' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
      ),
      timeout: 15000
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { }
        resolve({ status: res.statusCode, ms, json, raw: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: 15000, json: null, raw: Buffer.alloc(0) }); });
    req.on('error', () => resolve({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, json: null, raw: Buffer.alloc(0) }));
    if (payload) req.write(payload);
    req.end();
  });
}
function rec(r) {
  R.latencyMs.push(r.ms);
  R.httpStatus[r.status] = (R.httpStatus[r.status] || 0) + 1;
}
function pct(p) {
  if (!R.latencyMs.length) return 0;
  const a = R.latencyMs.slice().sort((x, y) => x - y);
  return +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
}
// 造一份接近真实的 state：多年 history + 大量 papers / wrongbook
function makeState(seed) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(2020, 0, 1 + seed);
  const history = {}, papers = {}, wrongbook = {};
  for (let i = 0; i < 400; i++) {
    const day = new Date(2020, 0, 1 + i);
    const key = day.getFullYear() + '-' + pad(day.getMonth() + 1) + '-' + pad(day.getDate());
    history[key] = { minutes: 20 + (i % 40), done: true, floor: i % 17 === 0, qCount: 30, right: 20 + (i % 10), timed: 0, timedWithin: 0, timedSec: 0 };
  }
  for (let i = 0; i < 600; i++) {
    const qid = '2015-06-' + (1 + (i % 3)) + '-l-' + (1 + (i % 25));
    papers[qid] = { seen: 2, right: 1, wrong: 1, lastAt: '2026-11-01', lastResult: i % 2 ? 'right' : 'wrong', points: ['细节题', '主旨题'] };
  }
  for (let i = 0; i < 200; i++) {
    const qid = '2015-06-1-r-' + (46 + (i % 10));
    wrongbook[qid] = { addedAt: '2026-11-01', box: 2, wrongCount: 2, due: '2026-11-18', ease: 2.3, iv: 2, streak: 0 };
  }
  const base = { version: 1, history, papers, wrongbook, essays: {}, hl: {}, plan: null, lastBackup: '' };
  // 填充到目标体积（用合法字段，避免服务端/客户端校验误判）
  base.hl['2015-06-1-r-46'] = { segments: [] };
  let s = JSON.stringify(base);
  const filler = 'x'.repeat(1024);
  while (Buffer.byteLength(s) < PAYLOAD_KB * 1024) {
    base.hl['2015-06-1-r-46'].segments.push(filler);
    s = JSON.stringify(base);
  }
  return base;
}

(async () => {
  const child = spawn(process.execPath, [SERVER], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      SYNC_TOKEN: TOKEN, SYNC_PORT: String(PORT), SYNC_DATA: DATA, SYNC_NS: 'cet6'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  try {
    // 等就绪（最多 10 秒）
    let ready = false;
    for (let i = 0; i < 50; i++) {
      const r = await request('GET', '/health');
      if (r.status === 200) { ready = true; break; }
      await new Promise(x => setTimeout(x, 200));
    }
    chk(ready, 'S1 本地同步实例启动并响应 /health', ready ? '端口 ' + PORT : serverLog.slice(0, 200));
    if (!ready) throw new Error('服务未就绪');

    // ---- S1 鉴权 ----
    const bad = await request('GET', '/cet6/state/9001', 'wrong-token');
    rec(bad);
    chk(bad.status === 401, 'S1 错误口令被拒 401', 'status=' + bad.status);
    const none = await request('GET', '/cet6/state/9001', '');
    rec(none);
    chk(none.status === 401, 'S1 无口令被拒 401', 'status=' + none.status);
    const empty = await request('GET', '/cet6/state/9001', TOKEN);
    rec(empty);
    chk(empty.status === 200 && empty.json && empty.json.rev === 0, 'S1 新编号读空档 rev=0', 'rev=' + (empty.json && empty.json.rev));

    // ---- S2 并发吞吐 ----
    const t0 = Date.now();
    const expectedRev = {};
    const jobs = [];
    for (let u = 0; u < USERS; u++) {
      const id = String(9001 + u);
      expectedRev[id] = 0;
      jobs.push((async () => {
        const state = makeState(u);
        const dayKey = Object.keys(state.history)[0];
        let good = 0, bad = 0;
        for (let r = 0; r < ROUNDS; r++) {
          state.history[dayKey].minutes = r; // 每轮内容都变，保证真的写了盘
          const resp = await request('PUT', '/cet6/state/' + id, TOKEN,
            { rev: expectedRev[id], deviceId: 'stress-' + id, state });
          rec(resp);
          if (resp.status === 200 && resp.json && resp.json.rev === expectedRev[id] + 1) {
            expectedRev[id]++; good++;
          } else bad++;
        }
        return { id, good, bad };
      })());
    }
    const results = await Promise.all(jobs);
    const elapsed = (Date.now() - t0) / 1000;
    const totalReq = USERS * ROUNDS;
    const goodReq = results.reduce((a, x) => a + x.good, 0);
    const qps = +(totalReq / elapsed).toFixed(1);
    R.scenarios.throughput = {
      requests: totalReq, succeeded: goodReq, failed: totalReq - goodReq,
      elapsedSec: +elapsed.toFixed(2), qps,
      p50: pct(0.5), p95: pct(0.95), p99: pct(0.99)
    };
    chk(goodReq === totalReq, 'S2 并发 PUT 全部成功且 rev 严格递增',
      goodReq + '/' + totalReq + ', ' + qps + ' req/s, p95=' + pct(0.95) + 'ms');
    chk(pct(0.95) < 2000, 'S2 p95 延迟 < 2000ms（本地实例）', 'p95=' + pct(0.95) + 'ms');
    chk(!Object.keys(R.httpStatus).some(s => +s >= 500), 'S2 无 5xx 服务端错误', JSON.stringify(R.httpStatus));

    // ---- S3 乐观锁冲突 ----
    const conflictId = '9099';
    const cur = await request('GET', '/cet6/state/' + conflictId, TOKEN);
    rec(cur);
    const baseRev = cur.json.rev;
    const cjobs = [];
    for (let i = 0; i < CONFLICT_N; i++) {
      cjobs.push(request('PUT', '/cet6/state/' + conflictId, TOKEN,
        { rev: baseRev, deviceId: 'conflict-' + i, state: { version: 1, marker: i } }));
    }
    const conflicts = (await Promise.all(cjobs));
    conflicts.forEach(rec);
    const c200 = conflicts.filter(r => r.status === 200).length;
    const c409 = conflicts.filter(r => r.status === 409).length;
    R.scenarios.optimisticLock = { concurrent: CONFLICT_N, accepted: c200, rejected409: c409, baseRev };
    chk(c200 === 1 && c409 === CONFLICT_N - 1, 'S3 同 rev 并发恰好 1 成功、其余 409',
      '200=' + c200 + ' / 409=' + c409);
    const after = await request('GET', '/cet6/state/' + conflictId, TOKEN);
    rec(after);
    chk(after.json && after.json.rev === baseRev + 1, 'S3 冲突后 rev 只 +1，未丢写', 'rev=' + (after.json && after.json.rev));

    // ---- S4 命名空间 / 编号隔离 ----
    const ns4 = await request('GET', '/cet4/state/9001', TOKEN);
    rec(ns4);
    const ns6 = await request('GET', '/cet6/state/9001', TOKEN);
    rec(ns6);
    const neighbor = await request('GET', '/cet6/state/9002', TOKEN);
    rec(neighbor);
    chk(ns4.json && ns4.json.rev === 0, 'S4 cet4 命名空间读不到 cet6 的数据', 'cet4 rev=' + (ns4.json && ns4.json.rev));
    chk(ns6.json && ns6.json.rev === ROUNDS, 'S4 cet6 本编号数据完整', 'rev=' + (ns6.json && ns6.json.rev));
    chk(neighbor.json && neighbor.json.rev === ROUNDS, 'S4 相邻编号互不覆盖', 'rev=' + (neighbor.json && neighbor.json.rev));

    // ---- S5 原子写完整性 ----
    let files = [], parsed = 0, baks = 0, revMatches = 0;
    for (const ns of ['cet6', 'cet4']) {
      const dir = path.join(DATA, ns);
      if (!fs.existsSync(dir)) continue;
      fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (f.endsWith('.bak')) { baks++; return; }
        if (!f.endsWith('.json')) return;
        files.push(f);
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          parsed++;
          const id = /state-(\d{4})\.json/.exec(f);
          if (id && expectedRev[id[1]] !== undefined && j.rev === expectedRev[id[1]]) revMatches++;
        } catch (e) { }
      });
    }
    R.scenarios.atomicWrite = { jsonFiles: files.length, parsed, bakFiles: baks, revMatched: revMatches, expected: USERS };
    chk(parsed === files.length && files.length > 0, 'S5 所有 state 文件都是完整合法 JSON（无半个文件）', parsed + '/' + files.length);
    chk(baks >= USERS, 'S5 每份数据都保留上一版 .bak', 'bak=' + baks);
    chk(revMatches === USERS, 'S5 落盘 rev 与成功写入次数逐个一致', revMatches + '/' + USERS);

    // ---- 结论 ----
    R.summary = {
      totalRequests: R.latencyMs.length, httpStatus: R.httpStatus,
      p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
      max: +Math.max.apply(null, R.latencyMs).toFixed(1),
      verdict: fail === 0 ? '达标' : '未达标'
    };
  } catch (e) {
    R.fatal = e.message;
    chk(false, '压测流程中断', e.message);
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { }
  }

  R.ok = ok; R.fail = fail;
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'stress-sync-result.json'), JSON.stringify(R, null, 2), 'utf8');
  console.log('\n===== 同步服务并发压测: ' + ok + ' ok / ' + fail + ' fail · ' +
    R.latencyMs.length + ' 请求 · p95=' + pct(0.95) + 'ms =====');
  console.log('产物 -> docs/stress-sync-result.json');
  process.exit(fail ? 1 : 0);
})();
