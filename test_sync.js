/* scripts/test_sync.js —— 私有同步层回归（CET4 / CET6 共用，两仓文件字节一致）
 *
 * 覆盖两类风险：
 *  1) mergeStates 的字段级合并是否幂等、是否在两人分叉时都不丢数据；
 *  2) 端点契约（401 / 404 / 乐观锁 409 / 原子写 / 按编号与项目隔离）与
 *     「设备 C 清了浏览器数据 → 从端点恢复」的完整闭环。
 *
 * 用法：node scripts/test_sync.js   （也被 run_all.js 的 core 组调用）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const SYNC = require(path.join(__dirname, '..', 'app', 'sync.js'));
let ok = 0, fail = 0;
function chk(cond, name) {
  if (cond) { ok++; console.log('ok - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
// 规范化后比较：对象键排序；纯字符串数组（高亮片段）排序后再比。
// 高亮数组本身保留首次出现顺序（可能承载文中先后），所以不做字节级可交换断言，
// 但语义上它必须是同一组片段。
function canon(v) {
  if (Array.isArray(v)) {
    const a = v.map(canon);
    if (a.length && typeof a[0] === 'string') return a.slice().sort();
    return a;
  }
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).sort().forEach(k => { o[k] = canon(v[k]); });
    return o;
  }
  return v;
}
function eq(a, b, name) { chk(JSON.stringify(canon(a)) === JSON.stringify(canon(b)), name); }
function blank() { return { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, hl: {}, plan: null, lastBackup: '' }; }
function hist(minutes, qCount, right, done) {
  return { minutes: minutes, done: !!done, floor: false, qCount: qCount, right: right, timed: 0, timedWithin: 0, timedSec: 0 };
}

// ---------------- 1) 合并算法 ----------------
(() => {
  const A = blank();
  A.history['2026-11-01'] = hist(20, 10, 8, true);
  A.papers.q1 = { seen: 1, right: 1, wrong: 0, lastAt: '2026-11-01', lastResult: 'right' };
  A.wrongbook.q9 = { addedAt: '2026-11-01', box: 1, wrongCount: 2, due: '2026-11-03', ease: 2.3, iv: 2, streak: 0 };
  A.essays.writing = { lastAt: '2026-11-01', text: 'aaa' };
  A.hl.p1 = ['x', 'y'];
  A.plan = { date: '2026-11-01', v: 9, items: [{ key: 'k', done: true }] };
  A.lastBackup = '2026-11-01';

  const mergedSelf = SYNC.mergeStates(A, A);
  eq(mergedSelf, A, '合并幂等：同一份状态合并后不变');
  eq(mergedSelf, SYNC.mergeStates(mergedSelf, A), '合并可重复：重试/并发不会放大数值');

  const restored = SYNC.mergeStates(blank(), A);
  eq(restored, A, '清浏览器数据：空本地 + 远端副本可完整恢复');
  eq(SYNC.mergeStates(null, A), A, '远端为唯一来源时仍能恢复');
  eq(SYNC.mergeStates(A, null), A, '远端为空时保留本地，不清空');

  const B = blank();
  B.history['2026-11-01'] = hist(15, 6, 5, false);
  B.history['2026-11-02'] = hist(30, 12, 11, true);
  B.papers.q1 = { seen: 2, right: 1, wrong: 1, lastAt: '2026-11-02', lastResult: 'wrong' };
  B.papers.q2 = { seen: 1, right: 0, wrong: 1, lastAt: '2026-11-02', lastResult: 'wrong' };
  B.wrongbook.q9 = { addedAt: '2026-11-01', box: 2, wrongCount: 3, due: '2026-11-08', ease: 2.1, iv: 5, streak: 1 };
  B.essays.writing = { lastAt: '2026-11-03', text: 'aaaaa' };
  B.hl.p1 = ['y', 'z'];
  B.hl.p2 = ['w'];
  B.plan = { date: '2026-11-02', v: 9, items: [{ key: 'k2', done: true }, { key: 'k3', done: true }] };
  B.lastBackup = '2026-11-03';

  const M = SYNC.mergeStates(A, B);
  chk(M.history['2026-11-01'].minutes === 20 && M.history['2026-11-01'].qCount === 10, 'history 同日逐字段取 max（不虚增也不丢失）');
  chk(M.history['2026-11-01'].done === true, 'history 布尔标记取或');
  chk(M.history['2026-11-02'].minutes === 30, 'history 独有日期被保留');
  chk(M.papers.q1.lastAt === '2026-11-02' && M.papers.q1.seen === 2, 'papers 按 lastAt 取较新的一条');
  chk(!!M.papers.q2, 'papers 独有题目不会被覆盖掉');
  chk(M.wrongbook.q9.due === '2026-11-08' && M.wrongbook.q9.wrongCount === 3, 'wrongbook 取复习推进更远的一条');
  chk(M.essays.writing.text === 'aaaaa', 'essays 按 lastAt 取较新');
  eq(M.hl.p1.sort(), ['x', 'y', 'z'], '高亮按卷取并集去重');
  chk(M.hl.p2 && M.hl.p2[0] === 'w', '高亮独有卷被保留');
  chk(M.plan.date === '2026-11-02', 'plan 按日期取较新');
  chk(M.lastBackup === '2026-11-03', 'lastBackup 取较晚日期');
  eq(SYNC.mergeStates(A, B), SYNC.mergeStates(B, A), '合并与参数顺序无关（可交换）');

  const C = blank(); C.history['2026-11-03'] = hist(5, 2, 2, false);
  const M3 = SYNC.mergeStates(SYNC.mergeStates(A, B), C);
  const M3b = SYNC.mergeStates(A, SYNC.mergeStates(B, C));
  eq(M3, M3b, '三设备合并满足结合律');
  chk(SYNC.namespace() === 'cet4', '共享内核默认命名空间为 cet4（由 sync-config.js 覆盖）');
})();

// ---------------- 2) 端点闭环 ----------------
const PORT = 18700 + Math.floor(Math.random() * 600);
const TOKEN = 'test-circle-token';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cet-sync-test-'));
const SERVER = path.join(__dirname, 'sync-server.js');

function call(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = { 'X-Sync-Token': token == null ? '' : token };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: method, headers: headers, timeout: 3000 }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { let j = {}; try { j = JSON.parse(buf || '{}'); } catch (e) { } resolve({ status: res.statusCode, data: j }); });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady(proc) {
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) throw new Error('端点进程提前退出');
    try { const r = await call('GET', '/health', ''); if (r.status === 200) return; } catch (e) { }
    await sleep(100);
  }
  throw new Error('端点启动超时');
}

(async () => {
  const proc = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      SYNC_PORT: String(PORT), SYNC_DATA: DATA, SYNC_TOKEN: TOKEN, SYNC_ORIGIN: '*', SYNC_NS: 'cet4'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  proc.stdout.on('data', d => { serverLog += d.toString(); });
  proc.stderr.on('data', d => { serverLog += d.toString(); });

  try {
    await waitReady(proc);
    chk(true, '端点可启动并通过 /health 探活');

    chk((await call('GET', '/state/1001', '')).status === 401, '无口令读取被拒（401）');
    chk((await call('GET', '/state/1001', 'wrong')).status === 401, '错口令读取被拒（401）');
    chk((await call('GET', '/state/abc', TOKEN)).status === 404, '非 4 位编号被拒（路径穿越防护）');
    chk((await call('GET', '/state/1001/../../etc', TOKEN)).status === 404, '含路径穿越的编号被拒');
    chk((await call('GET', '/cet9/state/1001', TOKEN)).status === 404, '非法命名空间前缀被拒');

    const first = await call('GET', '/cet4/state/1001', TOKEN);
    chk(first.status === 200 && first.data.rev === 0 && first.data.state === null, '首次读取返回 rev=0 / 空状态');

    // 设备 A：写入自己的记录（无前缀的旧客户端走默认命名空间 cet4）
    const A = blank();
    A.history['2026-11-04'] = hist(25, 10, 9, true);
    A.papers.qA = { seen: 1, right: 1, wrong: 0, lastAt: '2026-11-04', lastResult: 'right' };
    const putA = await call('PUT', '/state/1001', TOKEN, { rev: 0, deviceId: 'dev-A', state: A });
    chk(putA.status === 200 && putA.data.rev === 1, '设备 A 首次写入成功，rev 0→1');
    chk((await call('GET', '/cet4/state/1001', TOKEN)).data.rev === 1, '带前缀与不带前缀命中同一份 cet4 数据');

    // 设备 B：持有旧 rev 并发写入，应被乐观锁拦下并带回远端当前值
    const B = blank();
    B.history['2026-11-05'] = hist(18, 7, 6, true);
    B.papers.qB = { seen: 1, right: 0, wrong: 1, lastAt: '2026-11-05', lastResult: 'wrong' };
    const conflict = await call('PUT', '/cet4/state/1001', TOKEN, { rev: 0, deviceId: 'dev-B', state: B });
    chk(conflict.status === 409 && conflict.data.rev === 1 && !!conflict.data.state, '设备 B 旧 rev 并发写入被拦（409 + 带回远端）');

    // B 按契约合并后用新 rev 重试
    const merged = SYNC.mergeStates(B, conflict.data.state);
    chk(!!merged.history['2026-11-04'] && !!merged.history['2026-11-05'], '冲突合并后两台设备的打卡都在');
    chk(!!merged.papers.qA && !!merged.papers.qB, '冲突合并后两台设备的做题记录都在');
    const putB = await call('PUT', '/cet4/state/1001', TOKEN, { rev: 1, deviceId: 'dev-B', state: merged });
    chk(putB.status === 200 && putB.data.rev === 2, '设备 B 合并后重试成功，rev 1→2');

    const remote = await call('GET', '/cet4/state/1001', TOKEN);
    chk(remote.status === 200 && remote.data.rev === 2, '最终状态可被读回');
    chk(!!remote.data.state.history['2026-11-04'] && !!remote.data.state.history['2026-11-05'], '端点里两台设备的记录都还在（没有 last-write-wins 覆盖）');

    // 设备 C：模拟"清了浏览器数据"，本地全空，从端点恢复
    const recovered = SYNC.mergeStates(blank(), remote.data.state);
    chk(JSON.stringify(recovered) === JSON.stringify(remote.data.state), '清浏览器数据后可无感恢复全部记录');

    // 按编号隔离
    const other = await call('GET', '/cet4/state/1002', TOKEN);
    chk(other.status === 200 && other.data.rev === 0 && other.data.state === null, '另一编号的记录独立，不串档');
    // 按项目隔离：一套服务同时供 CET4 / CET6 使用也不串档
    const cet6 = await call('GET', '/cet6/state/1001', TOKEN);
    chk(cet6.status === 200 && cet6.data.rev === 0 && cet6.data.state === null, 'CET6 命名空间与 CET4 数据隔离（一套服务两项目）');
    chk(fs.existsSync(path.join(DATA, 'cet4', 'state-1001.json.bak')), '写入保留上一版 .bak（可人工回滚）');
    chk(fs.existsSync(path.join(DATA, 'cet4', 'state-1001.json')) && !fs.existsSync(path.join(DATA, 'cet4', 'state-1001.json.tmp')), '原子写完成，无残留 .tmp');
  } catch (e) {
    fail++; console.log('FAIL - 端点测试异常：' + (e && e.message ? e.message : e));
    if (serverLog) console.log('[server] ' + serverLog.slice(-600));
  } finally {
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { }
  }

  console.log(ok + ' ok / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
