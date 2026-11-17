#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_stress_frontend.js · 前端真实压测（大数据状态 + 连续读写 + 内存）

   压什么：浏览器里那份 localStorage 状态，塞进远超日常的规模
           1000 天打卡历史 / 3000 题做题记录 / 1200 条错题本，
           再测：大状态登录渲染、统计页渲染、连续 100 次「答题→落盘」、
           JS 堆内存与页面报错。这些都是单靠单元用例测不出来的真实成本。
   压哪里：127.0.0.1 临时 HTTP 服务的本地 app/ 副本，不碰线上 Pages。
   不做：不模拟多用户并发（纯前端应用没有服务端会话），并发部分见
         test_stress_sync.js（本地同步服务）。

   产物：docs/stress-frontend-result.json
   退出码：0 = 全部达标，1 = 有失败
   用法：node test_stress_frontend.js（需先装 playwright + 本机浏览器）
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { chromium: loadChromium, EXE } = require('./_env');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const DOCS = path.join(ROOT, 'docs');
const PHONE = '9100';
// 产品 saveState 设计上只保留最近 730 天历史，压测数据必须落在合法窗口内，
// 否则「被清洗」是产品正常行为，不是丢数据。首版曾用 2022 年起的假日期 + 编造 qid，
// 结果全被 730 天裁剪和 pruneGhosts 清掉，差点误报成缺陷——改用合法数据重压。
const DAYS = 700, PAPERS = 3000, WRONGS = 1200, LOOP = 100;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon'
};

let ok = 0, fail = 0;
const checks = [];
function chk(cond, name, detail) {
  cond ? ok++ : fail++;
  checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? 'ok   - ' : 'FAIL - ') + name + (detail !== undefined ? ' | ' + detail : ''));
}
const R = {
  ts: new Date().toISOString(),
  target: '127.0.0.1 临时 HTTP 服务 / 本地 app 副本（非生产）',
  productionTouched: false,
  config: { historyDays: DAYS, papers: PAPERS, wrongbook: WRONGS, saveLoops: LOOP },
  timingsMs: {}, memory: {}, checks
};

// 从真实题库取 qid，避免被页面 pruneGhosts 当幽灵题删掉（那样测的就不是「大数据」了）
function realQids() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  const dir = path.join(APP, 'bank');
  fs.readdirSync(dir).filter(f => /^cet6-.*\.js$/.test(f)).forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox);
  });
  const ids = [];
  (sandbox.window.CET6_BANKS || []).forEach(b => (b.questions || []).forEach(q => {
    if (q && q.id) ids.push(q.id);
  }));
  return ids;
}

// 造一份「多年重度用户」状态：日期落在最近 730 天窗口内、qid 全部真实
function buildState(qids) {
  const pad = n => String(n).padStart(2, '0');
  const dateKey = daysAgo => {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - daysAgo);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  const history = {}, papers = {}, wrongbook = {};
  for (let i = DAYS; i >= 1; i--) {
    const k = dateKey(i);
    history[k] = {
      minutes: 15 + (i % 45), done: true, floor: i % 19 === 0,
      qCount: 20 + (i % 20), right: 12 + (i % 12), timed: 0, timedWithin: 0, timedSec: 0
    };
  }
  for (let i = 0; i < PAPERS && i < qids.length; i++) {
    papers[qids[i]] = {
      seen: 3, right: 2, wrong: 1, lastAt: dateKey(1), lastResult: i % 2 ? 'right' : 'wrong',
      points: ['细节题', '主旨题', '推断题']
    };
  }
  for (let i = 0; i < WRONGS && i < qids.length; i++) {
    wrongbook[qids[i]] = {
      addedAt: dateKey(1), box: 2, wrongCount: 2, due: dateKey(-1),
      ease: 2.3, iv: 2, streak: 0
    };
  }
  return { version: 1, history, papers, wrongbook, essays: {}, hl: {}, plan: null, lastBackup: '' };
}

(async () => {
  const srv = http.createServer((req, res) => {
    let raw = req.url || '/';
    // WebKit/部分浏览器会对子资源发「绝对 URL 形式」的请求行，必须归一化
    if (/^https?:\/\//i.test(raw)) {
      try { const u = new URL(raw); raw = u.pathname + u.search; } catch (e) { }
    }
    let rel = decodeURIComponent(raw.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(APP, rel);
    if (file.indexOf(APP) !== 0 || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const URL = 'http://127.0.0.1:' + port + '/index.html';
  let browser = null;
  try {
    const { chromium } = loadChromium();
    browser = await chromium.launch({
      executablePath: EXE,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    page.on('dialog', d => d.accept(''));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const heap = async () => {
      const m = await cdp.send('Performance.getMetrics');
      const x = m.metrics.find(v => v.name === 'JSHeapUsedSize');
      return x ? +(x.value / 1048576).toFixed(1) : -1;
    };

    // ---- 首屏（空状态）----
    const t0 = Date.now();
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#loginMask', { timeout: 20000 });
    R.timingsMs.emptyFirstPaint = Date.now() - t0;

    // ---- 注入大状态 ----
    const QIDS = realQids();
    const state = buildState(QIDS);
    R.stateBytes = Buffer.byteLength(JSON.stringify(state));
    R.realQids = QIDS.length;
    const key = await page.evaluate(() => window.CET6Core.stateKey('9100'));
    await page.evaluate(({ k, s }) => localStorage.setItem(k, JSON.stringify(s)), { k: key, s: state });
    R.memory.before = await heap();
    chk(R.stateBytes > 300 * 1024, '压测数据规模达标（>300KB 真实状态）',
      (R.stateBytes / 1024).toFixed(0) + 'KB / ' + DAYS + ' 天 / ' + PAPERS + ' 题');

    // ---- 大状态下登录 + 清单渲染（normalizeState 要清洗全部历史）----
    const t1 = Date.now();
    await page.locator('#phoneInput').fill(PHONE);
    await page.locator('#loginBtn').click();
    let planReady = true;
    try { await page.waitForSelector('#planList .card', { timeout: 40000 }); }
    catch (e) { planReady = false; }
    R.timingsMs.loginWithBigState = Date.now() - t1;
    chk(planReady, '大状态登录后清单正常渲染（未白屏/未卡死）', R.timingsMs.loginWithBigState + 'ms');
    chk(R.timingsMs.loginWithBigState < 20000, '大状态登录渲染 < 20s', R.timingsMs.loginWithBigState + 'ms');

    const stateCheck = await page.evaluate(k => {
      const C = window.CET6Core;
      const st = C.loadState(localStorage, k, []);
      return { days: Object.keys(st.history).length, papers: Object.keys(st.papers).length, wrongs: Object.keys(st.wrongbook).length };
    }, key);
    R.loadedBack = stateCheck;
    chk(stateCheck.days === DAYS && stateCheck.papers >= 3000 && stateCheck.wrongs === WRONGS,
      '大状态经 normalizeState + pruneGhosts 清洗后完整保留', JSON.stringify(stateCheck));

    // 顺带取证：产品 saveState 的 730 天保留上限确实生效（首版「数据被清空」的真原因）
    const windowCheck = await page.evaluate(() => {
      const C = window.CET6Core;
      const m = {};
      const store = { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
      const st = C.newState();
      const pad = n => String(n).padStart(2, '0');
      for (let i = 0; i < 800; i++) {
        const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
        st.history[d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())] =
          { minutes: 10, done: true, floor: false, qCount: 5, right: 4, timed: 0, timedWithin: 0, timedSec: 0 };
      }
      C.saveState(store, st, '__window_probe');
      const after = JSON.parse(m['__window_probe']).history;
      return { before: 800, after: Object.keys(after).length };
    });
    R.historyWindow = windowCheck;
    // 实测 800 → 731：实现是 `d < cutoff 才删`，cutoff 当天也保留，
    // 比注释写的「730 天」多 1 天。属边界口径差异、不影响功能，如实记录，不改生产代码。
    chk(windowCheck.after <= 731 && windowCheck.after >= 700,
      'saveState 历史保留窗口生效（实测 800→731，含 cutoff 当天）',
      windowCheck.before + ' 天 → ' + windowCheck.after + ' 天');

    // ---- 统计页渲染（1000 天热力图 + 大错题本）----
    const t2 = Date.now();
    await page.locator('nav button[data-p="stat"]').click();
    let statReady = true;
    try { await page.waitForFunction(() => {
      const el = document.getElementById('statSummary');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 30000 }); } catch (e) { statReady = false; }
    R.timingsMs.statPage = Date.now() - t2;
    chk(statReady, '统计页在大数据下正常出数（未白屏）', R.timingsMs.statPage + 'ms');
    chk(R.timingsMs.statPage < 12000, '统计页渲染 < 12s', R.timingsMs.statPage + 'ms');

    // ---- 连续答题 → 落盘 100 次（大 JSON 反复序列化 + localStorage 写）----
    const loopMs = await page.evaluate(({ k, n }) => {
      const C = window.CET6Core;
      const st = C.loadState(localStorage, k, []);
      const t = performance.now();
      for (let i = 0; i < n; i++) {
        C.recordResult(st, '2015-06-1-r-46', i % 2 === 0, '2026-11-17');
        C.saveState(localStorage, st, k);
      }
      return +(performance.now() - t).toFixed(1);
    }, { k: key, n: LOOP });
    R.timingsMs.saveLoop = loopMs;
    R.timingsMs.saveLoopAvg = +(loopMs / LOOP).toFixed(2);
    chk(loopMs < 25000, LOOP + ' 次「答题→落盘」总耗时 < 25s', loopMs + 'ms / 均 ' + R.timingsMs.saveLoopAvg + 'ms');

    R.memory.after = await heap();
    R.memory.growthMB = +(R.memory.after - R.memory.before).toFixed(1);
    chk(R.memory.after > 0 && R.memory.after < 400, 'JS 堆内存 < 400MB（无失控增长）',
      R.memory.before + 'MB → ' + R.memory.after + 'MB');

    const bodyLen = await page.evaluate(() => document.body.innerText.trim().length);
    chk(bodyLen > 50, '压测结束后页面仍有内容（未白屏）', bodyLen + ' 字符');
    chk(pageErrors.length === 0, '全程无未捕获的页面 JS 报错',
      pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '0 条');

    R.summary = { verdict: fail === 0 ? '达标' : '未达标', pageErrors: pageErrors.length };
    await ctx.close();
  } catch (e) {
    R.fatal = String(e && e.stack || e);
    chk(false, '前端压测流程中断', String(e && e.message || e));
  } finally {
    try { if (browser) await browser.close(); } catch (e) { }
    try { srv.close(); } catch (e) { }
  }

  R.ok = ok; R.fail = fail;
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'stress-frontend-result.json'), JSON.stringify(R, null, 2), 'utf8');
  console.log('\n===== 前端压测: ' + ok + ' ok / ' + fail + ' fail · ' +
    '登录 ' + R.timingsMs.loginWithBigState + 'ms / 统计 ' + R.timingsMs.statPage +
    'ms / ' + LOOP + ' 次落盘 ' + R.timingsMs.saveLoop + 'ms =====');
  console.log('产物 -> docs/stress-frontend-result.json');
  process.exit(fail ? 1 : 0);
})();
