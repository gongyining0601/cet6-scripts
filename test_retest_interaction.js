/* scripts/test_retest_interaction.js
 * CET6 打卡应用 · 复测轮（性能复测 / 多视口与浏览器兼容 / 交互状态机深度测试 / 极端数据量）
 * 只读：不修改任何源文件。所有探针与状态注入均为运行期（context.addInitScript / page.evaluate）。
 * 用法：node test_retest_interaction.js [A] [B] [C] [D]   缺省 = A B C D
 * 产物：docs/retest-result.json、docs/retest-*.png
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium: loadPW, EXE, fileUrl, ensurePaper } = require('./_env');

const ROOT = path.join(__dirname, '..', 'app');
const DOCS = path.join(__dirname, '..', 'docs');
const URL = fileUrl(path.join(ROOT, 'index.html'));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

/* ============================ 结果收集 ============================ */
const R = { ts: new Date().toISOString(), env: {}, sections: {} };
let cur = null;
function sec(id, title) { cur = R.sections[id] = { title, checks: [], data: {} }; console.log('\n===== ' + title + ' ====='); return cur; }
function chk(name, ok, detail) {
  const c = { name, ok: !!ok, detail: detail === undefined || detail === null ? '' : String(detail) };
  if (cur) cur.checks.push(c);
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (c.detail ? ' | ' + c.detail : ''));
  return c;
}
function note(k, v) { if (cur) cur.data[k] = v; console.log('   . ' + k + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : v)); }

/* ============================ 页面注入工具 ============================ */
// 1) CET6_BANKS.push 探针：记录第 1 次 / 第 N 次入栈时刻（题库就绪时间）
function PROBE() {
  try {
    window.__probe = { first: null, last: null, n: 0 };
    var arr = [];
    var origPush = Array.prototype.push;
    arr.push = function () {
      if (window.__probe.first == null) window.__probe.first = performance.now();
      window.__probe.n++;
      window.__probe.last = performance.now();
      return origPush.apply(this, arguments);
    };
    Object.defineProperty(window, 'CET6_BANKS', {
      configurable: true,
      get: function () { return arr; },
      // 题库脚本每卷都会写 window.CET6_BANKS = window.CET6_BANKS || [];
      // 由于 getter 总返回同一个 arr，这里必须对自赋值 no-op，否则会把 arr 推进自身导致指数膨胀。
      set: function (v) { if (Array.isArray(v) && v !== arr) { for (var i = 0; i < v.length; i++) origPush.call(arr, v[i]); } },
    });
  } catch (e) { }
}

// 2) 测试用只读/注入 API（不触碰应用源码，只读写 localStorage 与读取 window 上的公共对象）
function PAGE_API() {
  try {
    window.__t = {
      user: function () { return localStorage.getItem('cet6_user') || ''; },
      key: function () { return 'cet6_p1_state_v1_' + localStorage.getItem('cet6_user'); },
      raw: function () { return localStorage.getItem(window.__t.key()); },
      state: function () { try { return JSON.parse(window.__t.raw() || '{}'); } catch (e) { return null; } },
      setState: function (o) { localStorage.setItem(window.__t.key(), JSON.stringify(o)); },
      delState: function () { localStorage.removeItem(window.__t.key()); },
      today: function () { return window.CET6Core.todayStr(); },
      core: function () { return window.CET6Core; },
      banks: function () { return window.CET6_BANKS || []; },
      allQids: function () { var a = []; (window.CET6_BANKS || []).forEach(function (b) { (b.questions || []).forEach(function (q) { a.push(q.id); }); }); return a; },
      /* 全库 qid 列表（按需加载版）：首屏 CET6_BANKS 为空，但 meta.qLite 已含每一题的 {id,type,qno}，
         足够枚举全库题号。C5a"全部做完"这类用例必须用它——旧写法走 allQids()（读 BANKS）会得到空数组，
         seed 出"什么都没做过"的存档，于是清单照常生成 5 组新题、加练也照常能加，用例全线误判。 */
      allQidsMeta: function () {
        var M = window.CET6_META || {}, out = [];
        (M.order || []).forEach(function (pid) {
          var p = (M.papers || {})[pid];
          if (!p || !Array.isArray(p.qLite)) return;
          p.qLite.forEach(function (q) { out.push(q.id); });
        });
        return out;
      },
      /* 全库不同考点数（同样取自 meta 骨架）。D3 要断言"考点表渲染完整"，
         期望行数 = 不同考点数 + 1（表头）。写死阈值（曾经是 ptRows > 20）会随题库/考点体系变化误判。 */
      distinctPointsMeta: function () {
        var M = window.CET6_META || {}, set = {};
        (M.order || []).forEach(function (pid) {
          var p = (M.papers || {})[pid];
          if (!p || !Array.isArray(p.qLite)) return;
          p.qLite.forEach(function (q) { (q.points || []).forEach(function (pt) { set[pt] = 1; }); });
        });
        return Object.keys(set).length;
      },
      qidsOf: function (paperId, kind, from, to) {
        // 按需加载架构（2026-10 起）：首屏 window.CET6_BANKS 是空数组，卷正文要等点「开始」才注入。
        // 旧实现只查 BANKS，于是 seed 出来的 reading 组 qids 恒为 []（表现为 n:0），
        // 清单里出现"可开始但一道题都没有"的空组 → openFirstOpenGroup 找不到能开的卡。
        // 题集改从 meta 骨架取：papers[pid].qLite 已含 {id,type,qno}，足够拼出 qids，且无需先加载卷。
        var M = window.CET6_META || null;
        var p = M && M.papers ? M.papers[paperId] : null;
        var qs;
        if (p && Array.isArray(p.qLite)) qs = p.qLite.slice();
        else {
          var b = (window.CET6_BANKS || []).filter(function (x) { return x.id === paperId; })[0];
          qs = b ? b.questions.slice() : [];
        }
        if (!qs.length) return [];
        qs.sort(function (a, c) { return a.qno - c.qno; });
        if (kind === 'cloze') qs = qs.filter(function (q) { return q.type === 'cloze'; });
        else if (kind === 'match') qs = qs.filter(function (q) { return q.type === 'match'; });
        else if (kind === 'reading') qs = qs.filter(function (q) { return q.type === 'reading' && (from == null || (q.qno >= from && q.qno <= to)); });
        else if (kind === 'listening') qs = qs.filter(function (q) { return q.type === 'listening' && (from == null || (q.qno >= from && q.qno <= to)); });
        return qs.map(function (q) { return q.id; });
      },
      answerOf: function (qid) { var q = window.CET6Core.findQ(window.CET6_BANKS, qid); return q ? q.answer : null; },
      // 构造 state 并写入 localStorage（不 reload，由 Node 侧控制）
      seed: function (spec) {
        var C = window.CET6Core, B = window.CET6_BANKS || [];
        var today = C.todayStr();
        var items = (spec.items || []).map(function (s, ix) {
          var qids = s.qids || window.__t.qidsOf(s.paperId, s.kind, s.qnoFrom, s.qnoTo);
          var it = {
            key: s.key || ('t-' + s.kind + '-' + (s.paperId || '') + '-' + ix),
            type: s.kind, qids: qids, done: !!s.done, minutes: 0,
          };
          if (s.paperId) it.paperId = s.paperId;
          if (s.label) it.label = s.label;
          if (s.draft) it.draft = s.draft;
          if (s.timerLeft != null) it.timerLeft = s.timerLeft;
          if (s.review) it.review = true;
          if (s.extra) it.extra = true;
          if (s.isWrong) it.isWrong = true;
          return it;
        });
        var st = Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, spec.state || {});
        st.version = 1; st.plan = { date: spec.planDate || today, v: C.PLAN_VERSION, items: items };
        if (spec.noPlan) st.plan = null;
        var user = spec.user || '9901';
        localStorage.setItem('cet6_user', user);
        localStorage.setItem('cet6_p1_state_v1_' + user, JSON.stringify(st));
        return { today: today, items: items.map(function (i) { return { key: i.key, type: i.type, n: i.qids.length }; }) };
      },
      // 统计当前 DOM 中的题组进度信息
      quiz: function () {
        var q = document.getElementById('quiz');
        var opts = Array.prototype.map.call(document.querySelectorAll('.opt'), function (b) {
          return { q: b.getAttribute('data-q'), v: b.getAttribute('data-v'), sel: b.classList.contains('sel'), right: b.classList.contains('right'), wrong: b.classList.contains('wrongpick'), disabled: !!b.disabled };
        });
        return {
          open: !!q && q.classList.contains('show'),
          prog: (document.getElementById('quizProg') || {}).textContent || '',
          timer: (document.getElementById('quizTimer') || {}).textContent || '',
          timerCls: (document.getElementById('quizTimer') || {}).className || '',
          submitted: !!document.getElementById('groupDone'),
          opts: opts,
        };
      },
      plan: function () { var s = window.__t.state() || {}; return (s.plan && s.plan.items) || []; },
      planObj: function () { var s = window.__t.state() || {}; return s.plan || null; },
      history: function () { var s = window.__t.state() || {}; return s.history || {}; },
      wrongbook: function () { var s = window.__t.state() || {}; return s.wrongbook || {}; },
      essays: function () { var s = window.__t.state() || {}; return s.essays || {}; },
      hl: function () { var s = window.__t.state() || {}; return s.hl || {}; },
      /* 题型无关的作答助手（第三轮修复）。选词填空组的 UI 是「词库 .wb-chip + 段落空格 .cloze-slot」，
         整组没有一个 .opt；旧用例一律 document.querySelectorAll('.opt') 去找题，遇到选词填空组
         就一题也答不上 → #groupSubmit 因"还有 N 题未作答"拒绝提交 → 后续等待判分超时。
         mode='first' 与原口径一致：客观题点每题第一个选项；选词填空点空格进入待选态再点第一个可用词块。
         返回真正作答的 qid 列表。 */
      answerSome: function (maxN, mode) {
        var done = [];
        var full = function () { return maxN != null && done.length >= maxN; };
        Array.prototype.forEach.call(document.querySelectorAll('.opt:not([disabled])'), function (b) {
          if (full()) return;
          var q = b.getAttribute('data-q');
          if (done.indexOf(q) >= 0) return;
          done.push(q);
          b.click();
        });
        Array.prototype.forEach.call(document.querySelectorAll('.cloze-slot:not([disabled])'), function (slot) {
          if (full()) return;
          if (slot.getAttribute('data-picked')) return;
          var q = slot.getAttribute('data-q');
          if (done.indexOf(q) >= 0) return;
          var chips = Array.prototype.filter.call(document.querySelectorAll('.wb-chip'), function (c) { return !c.disabled; });
          if (!chips.length) return;
          done.push(q);
          slot.click();
          chips[0].click();
        });
        return done;
      },
      nav: function (p) { document.querySelector('nav button[data-p="' + p + '"]').click(); },
    };
  } catch (e) { }
}

const PAGE_API_INIT = PAGE_API;

/* ============================ Node 侧助手 ============================ */
const waitInit = (page) => page.waitForFunction(
  () => { const e = document.getElementById('todayLabel'); return !!e && e.textContent.length === 10; },
  null, { timeout: 30000 });

const waitPlan = (page) => page.waitForFunction(
  () => { const e = document.getElementById('planSummary'); return !!e && e.textContent.indexOf('今日清单') === 0; },
  null, { timeout: 30000 });

async function newBrCtx(br, opts) {
  const ctx = await br.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, opts || {}));
  await ctx.route(/^https?:\/\//, (r) => r.abort().catch(() => { })); // 第三方（听力 iframe）阻断，保证确定性
  await ctx.addInitScript(PROBE);
  await ctx.addInitScript(PAGE_API_INIT);
  await ctx.addInitScript('window.__scan = ' + SCAN.toString() + '; window.__contrast = ' + CONTRAST.toString() + ';');
  if (!ctx.pages().length) await ctx.newPage(); // 新建 context 默认没有页面
  return ctx;
}
const newCtx = (browser, opts) => newBrCtx(browser, opts);

/* 第三方资源噪声（与应用自身代码无关），统一在采集口剔除。
   本机对这两类外部依赖是时通时断的，不过滤会造成大面积随机假红：
     · 懒笔记听力页/站点：lazynote.cn / english-exam.lazynote.cn
     · 烘焙音频 CDN：cdn.jsdelivr.net 上的 cet-audio 包的 .m4a 音频
       （断网/抖动时报 "Failed to load resource: net::ERR_CONNECTION_RESET|ERR_FAILED"）
   实测一次全量跑里，B 段 6 个视口 + 2 个内核的"无页面错误"断言全部因此误判失败。 */
const THIRD_PARTY_NOISE = /lazynote|english-exam|cdn\.jsdelivr\.net|cet-audio|\.m4a(\?|$)|net::ERR_(CONNECTION_RESET|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_CLOSED|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED|FAILED)/i;
function isThirdPartyNoise(s) { return THIRD_PARTY_NOISE.test(String(s)); }

function watchErrors(page, sink) {
  page.on('pageerror', (e) => {
    const t = 'pageerror: ' + e.message + ' || ' + String(e.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 300);
    if (!isThirdPartyNoise(t)) sink.push(t);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const l = m.location() || {};
    const t = 'console.error: ' + m.text().slice(0, 200) + ' @ ' + (l.url || 'unknown');
    if (!isThirdPartyNoise(t)) sink.push(t);
  });
  return sink;
}

// 首屏注入：seeded state（token 守卫，避免 reload 时把测试中产生的真实数据冲掉）
async function seedInit(ctx, user, stateObj, token) {
  await ctx.addInitScript(({ user, stateObj, token }) => {
    try {
      if (localStorage.getItem('__seedToken') === token) return;
      localStorage.clear();
      localStorage.setItem('cet6_user', user);
      if (stateObj) localStorage.setItem('cet6_p1_state_v1_' + user, JSON.stringify(stateObj));
      localStorage.setItem('__seedToken', token);
    } catch (e) { }
  }, { user, stateObj, token });
}

async function navEntry(page) {
  return page.evaluate(() => {
    const e = performance.getEntriesByType('navigation')[0] || null;
    const t = performance.timing || {};
    const ns = t.navigationStart || 0;
    const rd = (a, b) => (a != null ? Math.round(a) : (b != null ? Math.round(b - ns) : null));
    return {
      dcl: e ? rd(e.domContentLoadedEventEnd) : rd(null, t.domContentLoadedEventEnd),
      load: e ? rd(e.loadEventEnd) : rd(null, t.loadEventEnd),
      di: e ? rd(e.domInteractive) : rd(null, t.domInteractive),
      probe: window.__probe || null,
      banksN: (window.CET6_BANKS || []).length,
      // 按需加载（2026-10 架构）：首屏只有 meta 骨架，卷正文在点击「开始」时才注入。
      // 因此"题库是否就绪"不能再看 CET6_BANKS.length，要看 meta.order / meta.papers。
      //
      // 关于"首屏有没有偷偷拉卷正文"：不能数 performance.getEntriesByType('resource') ——
      // 实测本机 file:// 场景下该接口返回空数组，会导致"请求数恒为 0"的假绿。
      // 改为直接数 DOM 里 <script src="...bank/cet6-*.js"> 的个数，任何加载方式都逃不掉。
      // 注意：src 属性是相对路径 `bank/meta.js`（没有前导斜杠），正则必须允许行首。
      metaN: ((window.CET6_META || {}).order || []).length,
      metaPapers: Object.keys((window.CET6_META || {}).papers || {}).length,
      bankJs: (function () {
        var n = 0;
        Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) {
          if (/(?:^|\/)bank\/cet6-[^/]*\.js(\?|$)/.test(s.getAttribute('src') || '')) n++;
        });
        return n;
      })(),
      skeletonJs: (function () {
        var n = 0;
        Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) {
          if (/(?:^|\/)bank\/(meta|listeningMeta)\.js(\?|$)/.test(s.getAttribute('src') || '')) n++;
        });
        return n;
      })(),
      allScripts: (function () {
        var out = [];
        Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) { out.push(s.getAttribute('src')); });
        return out;
      })(),
    };
  });
}

function avg(a) { return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null; }
function med(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function rng(a) { return a.length ? [Math.min.apply(null, a), Math.max.apply(null, a)] : null; }

async function openFirstOpenGroup(page, anyKind) {
  const cards = page.locator('#planList .card');
  const n = await cards.count();
  // 选词填空 / 写作 / 翻译这几种题型没有 .opt，而下游多处按 .opt 采样（选项高度、对比度、键盘等），
  // 因此缺省优先挑"有选项"的题组；只有全清单都是这些题型时才回退到第一张可开启的卡。
  const NON_OPT_LABEL = /选词填空|写作|翻译/;
  let fallback = null;
  for (let i = 0; i < n; i++) {
    // 清单为空时 renderEmptyToday 会画一张**没有 button / 没有 b** 的卡（只有 .empty 文案）。
    // 旧写法直接 await btn.textContent()，会在这里吃满 30s 默认超时并抛错中断整段。
    const btn = cards.nth(i).locator('button');
    if (!(await btn.count())) continue;
    const txt = ((await btn.first().textContent()) || '').trim();
    if (txt !== '开始') continue;
    const lblLoc = cards.nth(i).locator('b');
    const label = (await lblLoc.count()) ? ((await lblLoc.first().textContent()) || '').trim() : '';
    if (anyKind || !NON_OPT_LABEL.test(label)) {
      await btn.first().click();
      await page.waitForFunction(() => document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 });
      return { i, label };
    }
    if (!fallback) fallback = { i, label, btn: btn.first() };
  }
  if (fallback) {
    await fallback.btn.click();
    await page.waitForFunction(() => document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 });
    return { i: fallback.i, label: fallback.label };
  }
  return null;
}

// 完整走完当前打开的题组：逐题作答 → 提交 → 完成。
// 注意是"题型无关"的：客观题走 .opt，选词填空走 .cloze-slot/.wb-chip（见 answerSome）。
async function completeOpenGroup(page, { answerCorrect = false } = {}) {
  // 先等题目真的渲染出来（按需加载：浮层先显示"正在加载本组题目所需题库卷…"）。
  // 只等 #quiz.show 就抢答，会偶发一题都没答上 → #groupSubmit 保持 disabled →
  // 后面 15s 等 #quiz 关闭直接超时（实测 B 段 Chrome 旅程就这样 fatal 掉整段）。
  await page.waitForFunction(() => {
    const b = document.getElementById('quizBody');
    return !!b && (b.querySelectorAll('.opt').length || b.querySelectorAll('.cloze-slot').length || b.querySelector('#essayTa'));
  }, null, { timeout: 20000 }).catch(() => { });
  const doSubmit = () => page.evaluate(() => {
    const b = document.getElementById('groupSubmit');
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  });
  let qids = await page.evaluate(() => window.__t.answerSome(null, 'first'));
  let sub = await doSubmit();
  if (!sub) {
    // 再补一轮：有的题要等一次绘制后才挂上可点元素；仍不可提交就说明这组走的不是"提交本组"入口
    await page.waitForTimeout(400);
    qids = qids.concat(await page.evaluate(() => window.__t.answerSome(null, 'first')));
    sub = await doSubmit();
  }
  if (sub) {
    await page.waitForSelector('#groupDone', { timeout: 15000 });
    await page.evaluate(() => { const d = document.getElementById('groupDone'); if (d) d.click(); });
  } else {
    // 写作/翻译这类没有"提交本组"的组：按它自己的完成入口走，不能在这儿空等到超时
    const d = (await page.$('#essayDone')) || (await page.$('#groupDone'));
    if (d) await d.click();
    else await page.evaluate(() => { const b = document.getElementById('quizBack'); if (b) b.click(); });
  }
  // 关闭浮层：正常一次即成；偶发点击落在重绘间隙时补点一次（重绘期间的 click 会被丢弃）
  const closedOk = await page.waitForFunction(
    () => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 8000 }
  ).then(() => true).catch(() => false);
  if (!closedOk) {
    await page.evaluate(() => {
      const d = document.getElementById('groupDone') || document.getElementById('essayDone') || document.getElementById('quizBack');
      if (d) d.click();
    });
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
  }
  return { qids, submitted: sub };
}

async function metrics(page) {
  const client = await page.context().newCDPSession(page);
  try { await client.send('Performance.enable'); } catch (e) { }
  try { await client.send('HeapProfiler.enable'); } catch (e) { }
  await client.send('HeapProfiler.collectGarbage').catch(() => { });
  const m = await client.send('Performance.getMetrics');
  const g = (k) => { const x = m.metrics.filter((v) => v.name === k)[0]; return x ? x.value : null; };
  const o = {
    JSHeapUsedMB: Math.round((g('JSHeapUsedSize') / 1048576) * 10) / 10,
    JSHeapTotalMB: Math.round((g('JSHeapTotalSize') / 1048576) * 10) / 10,
    Nodes: g('Nodes'), Listeners: g('JSEventListeners'), Documents: g('Documents'),
    Frames: g('Frames'), LayoutObjects: g('LayoutObjects'),
  };
  await client.detach().catch(() => { });
  return o;
}

const doubleRaf = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));

async function shot(page, name, full) {
  try { await page.screenshot({ path: path.join(DOCS, 'retest-' + name + '.png'), fullPage: !!full }); } catch (e) { }
}

/* ============================ A. 性能复测 ============================ */
async function sectionA() {
  sec('A', 'A. 性能复测（确认无回归）');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  R.env.edge = browser.version();

  /* --- A1/A2/A3：3 轮冷 + 3 轮热 --- */
  const ctx = await newCtx(browser, { viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0];
  const errs = watchErrors(page, []);
  await seedInit(ctx, '9901', { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, 'A-' + Date.now());
  const client = await ctx.newCDPSession(page);
  // 预热一次：让 16.9MB 题库的首轮磁盘读入/杀软扫描不落到被测的 3 轮冷加载上（与上轮一致——上轮冷加载前也先走过登录页）
  await page.goto(URL, { waitUntil: 'commit' });
  await waitInit(page);
  const warmMs = await page.evaluate(() => Math.round((performance.getEntriesByType('navigation')[0] || {}).loadEventEnd || 0));

  const cold = [], hot = [];
  for (let i = 0; i < 3; i++) {
    await client.send('Network.clearBrowserCache').catch(() => { });
    const t0 = Date.now();
    await page.goto(URL, { waitUntil: 'commit' });
    await waitInit(page);
    const inter = Date.now() - t0;
    await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 });
    const e = await navEntry(page);
    cold.push({ round: i + 1, interactive: inter, dcl: e.dcl, load: e.load, di: e.di, bankReady: e.probe ? Math.round(e.probe.first) : null, bankEnd: e.probe ? Math.round(e.probe.last) : null, banksN: e.banksN, metaN: e.metaN, metaPapers: e.metaPapers, bankJs: e.bankJs, skeletonJs: e.skeletonJs, allScripts: e.allScripts, pushes: e.probe ? e.probe.n : null });
  }
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const inter = Date.now() - t0;
    await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 });
    const e = await navEntry(page);
    hot.push({ round: i + 1, interactive: inter, dcl: e.dcl, load: e.load, di: e.di, bankReady: e.probe ? Math.round(e.probe.first) : null, bankEnd: e.probe ? Math.round(e.probe.last) : null, banksN: e.banksN, metaN: e.metaN, metaPapers: e.metaPapers, bankJs: e.bankJs, skeletonJs: e.skeletonJs, allScripts: e.allScripts, pushes: e.probe ? e.probe.n : null });
  }
  note('coldLoads', cold);
  note('hotLoads', hot);
  note('warmupLoadMs', warmMs);
  const cl = cold.map((x) => x.load), hl = hot.map((x) => x.load);
  const ci = cold.map((x) => x.interactive), hi = hot.map((x) => x.interactive);
  // 注：bankReady/bankEnd 来自"题库 push 探针"，按需加载下首屏不会 push，故这两项恒为 null；
  //     保留采集只为回归时对照，判定口径已改为 meta 骨架 + 卷正文请求数（见下）。
  const cb = cold.map((x) => x.bankEnd), hb = hot.map((x) => x.bankEnd);
  note('cold', { loadAvg: avg(cl), loadRange: rng(cl), interactiveAvg: avg(ci), interactiveRange: rng(ci), bankReadyAvgLegacy: avg(cb) });
  note('hot', { loadAvg: avg(hl), loadRange: rng(hl), interactiveAvg: avg(hi), interactiveRange: rng(hi), bankReadyAvgLegacy: avg(hb) });
  chk('首屏（冷）load < 1000ms', avg(cl) < 1000, 'avg=' + avg(cl) + 'ms range=' + JSON.stringify(rng(cl)));
  chk('二次访问（热）load < 200ms', avg(hl) < 200, 'avg=' + avg(hl) + 'ms range=' + JSON.stringify(rng(hl)));
  chk('首屏可交互 < 1000ms', avg(ci) < 1000, 'avg=' + avg(ci) + 'ms');
  /* 旧断言「题库 76 卷全部就绪（banksN===76 && pushes===76）」是"首屏加载全量题库"时代的产物。
     2026-10 起改为「meta 骨架常驻 + 卷正文按需注入」，首屏 BANKS 合法地就是 0 —— 该断言必然假红。
     换成语义等价的架构断言：骨架就绪 + 首屏不拉卷正文。 */
  chk('首屏 meta 骨架就绪（76 卷清单可用）',
    cold.every((x) => x.metaN === 76) && cold[0].metaPapers === 76,
    'meta.order=' + cold[0].metaN + ' meta.papers=' + cold[0].metaPapers);
  chk('首屏不加载任何卷正文（按需加载核心承诺：bank/cet6-*.js 请求数为 0）',
    cold.every((x) => x.bankJs === 0),
    '冷加载各轮卷正文请求数=' + JSON.stringify(cold.map((x) => x.bankJs)));
  chk('首屏只拉骨架脚本（meta.js / listeningMeta.js）',
    cold.every((x) => x.skeletonJs >= 2) && cold[0].banksN === 0,
    '骨架脚本请求数=' + JSON.stringify(cold.map((x) => x.skeletonJs)) + ' BANKS=' + cold[0].banksN);
  chk('未加载卷正文因此没有题库 push（pushes 恒为 0）',
    cold.every((x) => x.pushes === 0 || x.pushes == null),
    'pushes=' + JSON.stringify(cold.map((x) => x.pushes)));
  /* 旧断言「题库就绪时间合理(<600ms)」用 avg(cb)（来自 PROBE.bankEnd）判定，
     而按需加载下 PROBE 永不被触发 → 全为 null → avg() 返回 null → `null < 600` 恒真，
     是一条会永远"绿"的假断言。改为对真实的骨架就绪时间（可交互时刻）设阈。 */
  chk('骨架就绪时间合理（可交互 < 600ms）', avg(ci) != null && avg(ci) < 600, 'avgInteractive=' + avg(ci) + 'ms');
  const blocking = cold.map((x) => x.bankEnd - x.bankReady);
  note('bankBlockingWindowAvgCold', avg(blocking));
  note('architecture', { mode: 'meta 骨架 + 按需加载卷', coldBankJsRequests: cold.map((x) => x.bankJs), metaOrder: cold[0].metaN });
  chk('渲染期无页面错误(A1-A3)', errs.length === 0, errs.join(' || ') || 'none');

  /* --- A4：内存（放开第三方请求，让听力音频真实加载，采样口径与上一轮一致） --- */
  const ctxM = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctxM.addInitScript(PROBE);
  await ctxM.addInitScript(PAGE_API_INIT);
  const pageM = await ctxM.newPage();
  const memErrs = watchErrors(pageM, []);
  await seedInit(ctxM, '9903', { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, 'A4-' + Date.now());
  await pageM.goto(URL, { waitUntil: 'commit' });
  await waitInit(pageM);
  const m0 = await metrics(pageM);
  // 等听力播放器就位。听力已从"嵌第三方 iframe"改为"烘焙分片 + <audio> 播放器"，
  // 旧代码这里 sleep 4000ms 是为了等第三方页在 iframe 内加载完，现已无此必要。
  const waitListen = async (pg) => {
    await pg.waitForFunction(() => !!document.querySelector('#quizBody .listen-player'), null, { timeout: 10000 }).catch(() => { });
    await pg.waitForTimeout(300);
  };
  // 做 5 组题（4 组清单 + 1 组加练），全部走真实 UI
  const done = [];
  for (let i = 0; i < 4; i++) {
    const o = await openFirstOpenGroup(pageM);
    if (!o) break;
    if (/听力/.test(o.label)) await waitListen(pageM);
    const res = await completeOpenGroup(pageM);
    done.push({ label: o.label, n: res.qids.length });
  }
  // 加练一组听力
  const extra = await pageM.evaluate(() => {
    const btns = Array.prototype.slice.call(document.querySelectorAll('#extraBtns button'));
    if (!btns.length) return null;
    btns[0].click();
    return btns[0].textContent;
  });
  if (extra) {
    const o = await openFirstOpenGroup(pageM);
    if (o) { if (/听力/.test(o.label)) await waitListen(pageM); const res = await completeOpenGroup(pageM); done.push({ label: o.label + '(加练)', n: res.qids.length }); }
  }
  const m1 = await metrics(pageM);
  const qTotal = done.reduce((a, b) => a + b.n, 0);
  // 复现上一轮的内存采样点：判分结果在屏（DOM 最重）。
  // 必须挑"未完成"的卡：已完成的卡点开是只读回看（选项全 disabled），题也答不了，
  // 采样点就名不副实了（旧写法取 .first()，前 4 张已 done，实际点开的是只读视图）。
  {
    // 挑"未完成且真的带开始按钮"的卡（清单空时那张 .empty 卡没有 button，直接 click 会 30s 超时）
    let target = null;
    const openCards = pageM.locator('#planList .card:not(.done)');
    const nc = await openCards.count();
    for (let i = 0; i < nc; i++) {
      const b = openCards.nth(i).locator('button');
      if ((await b.count()) && ((await b.first().textContent()) || '').trim() === '开始') { target = openCards.nth(i); break; }
    }
    if (!target) {
      const all = pageM.locator('#planList .card');
      const na = await all.count();
      for (let i = 0; i < na; i++) {
        const b = all.nth(i).locator('button');
        if ((await b.count()) && ((await b.first().textContent()) || '').trim() === '开始') { target = all.nth(i); break; }
      }
    }
    if (target) {
      const lbl = ((await target.locator('b').first().textContent()) || '').trim();
      await target.locator('button').first().click();
      await pageM.waitForFunction(() => document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 });
      if (/听力/.test(lbl)) await waitListen(pageM);
    }
  }
  await pageM.waitForTimeout(3500);
  await answerAllOpts(pageM, 'first');
  await pageM.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) b.click(); });
  await pageM.waitForSelector('#groupDone', { timeout: 15000 });
  const mPeak = await metrics(pageM);
  note('mem.frames', {
    iframes: await pageM.evaluate(() => document.querySelectorAll('iframe').length),
    frames: pageM.frames().length,
    listenPlayers: await pageM.evaluate(() => document.querySelectorAll('#quizBody .listen-player').length),
  });
  await shot(pageM, 'a-mem-quiz-judged');
  await pageM.evaluate(() => document.getElementById('quizBack').click());
  await pageM.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
  // 切页 10 次
  for (const p of ['wrong', 'stat', 'backup', 'today', 'wrong', 'stat', 'backup', 'today', 'wrong', 'stat']) {
    await pageM.evaluate((p) => window.__t.nav(p), p);
    await doubleRaf(pageM);
  }
  await pageM.evaluate(() => window.__t.nav('today'));
  await doubleRaf(pageM);
const m2 = await metrics(pageM);   // metrics() 内部已 collectGarbage
  // 再切页 10 次：判断 m1→m2 的增量是"一次性"还是"持续增长"
  for (const p of ['wrong', 'stat', 'backup', 'today', 'wrong', 'stat', 'backup', 'today', 'wrong', 'stat']) {
    await pageM.evaluate((p) => window.__t.nav(p), p);
    await doubleRaf(pageM);
  }
  await pageM.evaluate(() => window.__t.nav('today'));
  await doubleRaf(pageM);
  const m3 = await metrics(pageM);
  note('mem', { initial: m0, after5Groups_GC: m1, quizJudgedOnScreen_GC: mPeak, after10Switches_GC: m2, after20Switches_GC: m3, groupsDone: done, questionsAnswered: qTotal, thirdParty: 'allowed' });
  const peak = mPeak.JSHeapUsedMB;
  chk('内存峰值 < 100MB', peak < 100, '判分在屏峰值=' + mPeak.JSHeapUsedMB + 'MB（Nodes ' + mPeak.Nodes + '）· 5组后=' + m1.JSHeapUsedMB + 'MB · 上轮同口径 29.1MB/6904 节点');
  chk('做完 5 组题（GC 后）JSHeap 增量 < 20MB', m1.JSHeapUsedMB - m0.JSHeapUsedMB < 20, m0.JSHeapUsedMB + 'MB → ' + m1.JSHeapUsedMB + 'MB（增量 ' + Math.round((m1.JSHeapUsedMB - m0.JSHeapUsedMB) * 10) / 10 + 'MB，含统计页新增表格行）');
  chk('切页 10 次后（GC）JSHeap ≤ +1MB', m2.JSHeapUsedMB <= m1.JSHeapUsedMB + 1, m1.JSHeapUsedMB + 'MB → ' + m2.JSHeapUsedMB + 'MB');
  chk('再切页 10 次（GC）无持续增长：JSHeap ≤ +1MB', m3.JSHeapUsedMB <= m2.JSHeapUsedMB + 1, m2.JSHeapUsedMB + 'MB → ' + m3.JSHeapUsedMB + 'MB');
  chk('再切页 10 次（GC）无持续增长：Nodes ≤ +50', m3.Nodes - m2.Nodes <= 50, m2.Nodes + ' → ' + m3.Nodes);
  chk('再切页 10 次（GC）无持续增长：Listeners ≤ +10', m3.Listeners - m2.Listeners <= 10, m2.Listeners + ' → ' + m3.Listeners + '（含第三方听力页自身监听器；第 1→2 个 10 次的增量 = ' + (m2.Listeners - m1.Listeners) + '）');
  // 对照：阻断第三方，只观察应用自身文档（确定性）
  const ctxC = await newCtx(browser, { viewport: { width: 1440, height: 900 } });
  const pc = ctxC.pages()[0];
  await seedInit(ctxC, '9904', { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, 'A4c-' + Date.now());
  await pc.goto(URL, { waitUntil: 'commit' }); await waitInit(pc);
  for (let i = 0; i < 4; i++) { const o = await openFirstOpenGroup(pc); if (!o) break; await completeOpenGroup(pc); }
  const cExtra = await pc.evaluate(() => { const b = document.querySelectorAll('#extraBtns button'); if (!b.length) return null; b[0].click(); return b[0].textContent; });
  if (cExtra) { const o = await openFirstOpenGroup(pc); if (o) await completeOpenGroup(pc); }
  const c1 = await metrics(pc);
  for (const p of ['wrong', 'stat', 'backup', 'today', 'wrong', 'stat', 'backup', 'today', 'wrong', 'stat']) { await pc.evaluate((p) => window.__t.nav(p), p); await doubleRaf(pc); }
  await pc.evaluate(() => window.__t.nav('today')); await doubleRaf(pc);
  const c2 = await metrics(pc);
  note('mem.control', { after5Groups_GC: c1, after10Switches_GC: c2 });
  chk('对照（阻断第三方）切页 10 次：JSHeap ≤ +1MB', c2.JSHeapUsedMB <= c1.JSHeapUsedMB + 1, c1.JSHeapUsedMB + 'MB → ' + c2.JSHeapUsedMB + 'MB');
  chk('对照（阻断第三方）切页 10 次：Nodes ≤ +50', c2.Nodes - c1.Nodes <= 50, c1.Nodes + ' → ' + c2.Nodes);
  chk('对照（阻断第三方）切页 10 次：Listeners ≤ +10', c2.Listeners - c1.Listeners <= 10, c1.Listeners + ' → ' + c2.Listeners);
  // 噪声已在 watchErrors 采集口统一剔除（见文件上方 THIRD_PARTY_NOISE），此处无需再过滤
  const appErrs = memErrs;
  note('mem.errors', { total: memErrs.length, app: appErrs });
  chk('A4 阶段应用自身无页面错误（第三方放开）', appErrs.length === 0,
    appErrs.length ? appErrs[0] : 'none（第三方/CDN 噪声已在采集口剔除）');
  await ctxC.close();
  await shot(pageM, 'a-mem-after-switches', false);

  /* --- A5：交互响应（5 次均值） --- */
  const ctx2 = await newCtx(browser, { viewport: { width: 1440, height: 900 } });
  const page2 = ctx2.pages()[0];
  const errs2 = watchErrors(page2, []);
  await seedInit(ctx2, '9902', null, 'A5-' + Date.now());
  await page2.goto(URL, { waitUntil: 'commit' });
  await waitInit(page2);
  // A5 量的是"点选选项 → 视觉反馈"的延迟，必须有 .opt 才成立。
  // 种子改用阅读组（客观题，每卷 46-50 共 5 题）；旧写法种成 5 组选词填空，
  // 而选词填空没有 .opt，计时样本全为空、提交按钮也不可用，最后 waitForSelector('#groupDone') 直接超时中断。
  const papers = ['2020-07-1', '2020-09-1', '2020-09-2', '2020-12-1', '2020-12-2'];
  const seeded = await page2.evaluate((papers) => {
    const spec = { user: '9902', items: papers.map((p) => ({ kind: 'reading', paperId: p, qnoFrom: 46, qnoTo: 50, key: 'g-' + p })) };
    return window.__t.seed(spec);
  }, papers);
  await page2.reload({ waitUntil: 'commit' });
  await waitInit(page2);
  note('A5planSeeded', seeded.items);

  const selT = [], selSync = [], subT = [], navT = [];
  const navErr = [];
  watchErrors(page2, navErr);
  for (let g = 0; g < 5; g++) {
    const o = await openFirstOpenGroup(page2);
    if (!o) { chk('A5 第 ' + (g + 1) + ' 组可打开', false, '未找到可开始的题组'); break; }
    // 点选 3 次计时
    const q3 = await page2.evaluate(() => {
      const seen = {}, out = [];
      Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => { const q = b.getAttribute('data-q'); if (!seen[q] && !b.classList.contains('sel')) { seen[q] = 1; out.push(q); } });
      return out.slice(0, 3);
    });
    for (const qid of q3) {
      const t = await page2.evaluate((qid) => new Promise((res) => {
        const list = document.querySelectorAll('.opt[data-q="' + qid + '"]');
        const btn = list[0];
        if (!btn) return res(null);
        const t0 = performance.now();
        const mo = new MutationObserver(() => {
          if (btn.classList.contains('sel')) {
            const sync = performance.now() - t0;
            mo.disconnect();
            requestAnimationFrame(() => requestAnimationFrame(() => res({ sync: sync, paint: performance.now() - t0 })));
          }
        });
        mo.observe(btn, { attributes: true, attributeFilter: ['class'] });
        btn.click();
        setTimeout(() => { mo.disconnect(); res(null); }, 3000);
      }), qid);
      if (t) { selSync.push(t.sync); selT.push(t.paint); }
    }
    // 补满剩余题目（题型无关：客观题 .opt + 选词填空 .cloze-slot/.wb-chip）
    await page2.evaluate(() => window.__t.answerSome(null, 'first'));
    // 提交计时
    const st = await page2.evaluate(() => new Promise((res) => {
      const b = document.getElementById('groupSubmit');
      if (!b || b.disabled) return res(-1);
      const t0 = performance.now();
      b.click();
      requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)));
    }));
    if (st >= 0) subT.push(st);
    // 判分结果未出现（例如该组题型不适用）不该中断整段：记为一次失败样本继续下一组
    const doneOk = await page2.waitForSelector('#groupDone', { timeout: 10000 }).then(() => true).catch(() => false);
    if (!doneOk) { chk('A5 第 ' + (g + 1) + ' 组可判分', false, '提交后 10s 内未出现 #groupDone（label=' + o.label + '）'); break; }
    await page2.evaluate(() => document.getElementById('groupDone').click());
    await page2.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
  }
  // 切页 5 次计时
  for (const p of ['wrong', 'stat', 'backup', 'today', 'stat']) {
    const t = await page2.evaluate((p) => new Promise((res) => {
      const t0 = performance.now();
      window.__t.nav(p);
      requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)));
    }), p);
    navT.push(t);
  }
  note('fluency', { selectSyncMs: selSync, selectSyncAvg: avg(selSync), selectPaintMs: selT, selectPaintAvg: avg(selT), submitMs: subT, submitAvg: avg(subT), navMs: navT, navAvg: avg(navT), navMax: navT.length ? Math.max.apply(null, navT) : null });
  chk('点选视觉反馈（同步距变更）< 100ms', avg(selSync) < 100, 'avg=' + avg(selSync) + 'ms n=' + selSync.length + '（上轮同口径 0.7ms）');
  chk('点选后完成绘制 < 100ms', avg(selT) < 100, 'avg=' + avg(selT) + 'ms n=' + selT.length);
  chk('提交→结果渲染 < 500ms', avg(subT) < 500, 'avg=' + avg(subT) + 'ms n=' + subT.length);
  chk('切页渲染 < 100ms', avg(navT) < 100, 'avg=' + avg(navT) + 'ms max=' + (navT.length ? Math.max.apply(null, navT) : null));
  chk('A5 全程无页面错误', errs2.length === 0 && navErr.length === 0, (errs2.concat(navErr)).join(' || ') || 'none');
  await shot(page2, 'a-fluency-stat', false);

  await browser.close();
}
/* ============================ 页面侧扫描工具 ============================ */
function SCAN() {
  const de = document.documentElement;
  const W = de.clientWidth, IH = window.innerHeight;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const res = {
    clientW: W, docScrollW: de.scrollWidth, bodyScrollW: document.body.scrollWidth,
    overflowX: de.scrollWidth > W + 1, offenders: [], overlaps: [], nav: [], planBtns: [], opts: [],
  };
  Array.prototype.forEach.call(document.querySelectorAll('#app *'), (el) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.right > W + 1 || r.left < -1) res.offenders.push({ t: el.tagName, cls: String(el.className || '').slice(0, 32), l: Math.round(r.left), r: Math.round(r.right) });
  });
  res.offenders = res.offenders.slice(0, 10);
  const overlapOf = (sel, label) => {
    const els = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(vis);
    const items = els.map((el, i) => ({ el, r: el.getBoundingClientRect(), label: label + '#' + i }));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.el.parentNode !== b.el.parentNode) continue;
      const x = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
      const y = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
      if (x * y > 8) res.overlaps.push({ a: a.label, b: b.label, area: Math.round(x * y) });
    }
  };
  overlapOf('#planList .plan-item', 'plan');
  overlapOf('#extraBtns button', 'extra');
  overlapOf('#statGrid > *', 'stat');
  overlapOf('nav button', 'nav');
  overlapOf('#quizBody > .card', 'qcard');
  overlapOf('header > *', 'hdr');
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), (b) => {
    const r = b.getBoundingClientRect();
    res.nav.push({ t: b.textContent, w: Math.round(r.width), h: Math.round(r.height), aboveBottom: Math.round(IH - r.bottom) });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#planList .card button'), (b) => {
    const r = b.getBoundingClientRect();
    res.planBtns.push({ inView: r.right <= W + 1 && r.left >= -1, w: Math.round(r.width), right: Math.round(r.right) });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => {
    const r = b.getBoundingClientRect();
    res.opts.push({ right: Math.round(r.right), left: Math.round(r.left), h: Math.round(r.height), ok: r.right <= W + 1 && r.left >= -1 && r.height > 20 });
  });
  const qb = document.getElementById('quizBody');
  if (qb) { res.quizBodyScrollW = qb.scrollWidth; res.quizBodyClientW = qb.clientWidth; }
  const q = document.getElementById('quiz');
  if (q) { res.quizScrollW = q.scrollWidth; res.quizClientW = q.clientWidth; res.quizOpen = q.classList.contains('show'); }
  return res;
}

function CONTRAST(sels) {
  const lum = (c) => {
    const m = String(c).match(/[\d.]+/g).map(Number);
    const f = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.parentElement; } return 'rgb(255,255,255)'; };
  const out = [];
  sels.forEach((s) => {
    const el = document.querySelector(s); if (!el) return;
    const cs = getComputedStyle(el); const fg = cs.color, b = bgOf(el);
    const L1 = lum(fg), L2 = lum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    out.push({ sel: s, fg, bg: b, ratio: Math.round((hi + 0.05) / (lo + 0.05) * 100) / 100, visible: cs.display !== 'none' });
  });
  return out;
}

// 可控时钟：只替换 Date（定时器保持真实），使"跨天"可复现
function DATE_SHIFT(anchorIso) {
  try {
    var RealDate = Date, KEY = '__fakeClock';
    var stored = localStorage.getItem(KEY);
    var base = stored != null ? Number(stored) : new RealDate(anchorIso).getTime();
    var offset = base - RealDate.now();
    function FakeDate(a, b, c, d, e, f, g) {
      if (arguments.length === 0) return new RealDate(RealDate.now() + offset);
      if (arguments.length === 1) return new RealDate(a);
      return new RealDate(a, b, c == null ? 1 : c, d == null ? 0 : d, e == null ? 0 : e, f == null ? 0 : f, g == null ? 0 : g);
    }
    FakeDate.now = function () { return RealDate.now() + offset; };
    FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    window.Date = FakeDate;
    window.__fakeNow = function () { return RealDate.now() + offset; };
    window.__shiftClock = function (ms) {
      offset += ms;
      try { localStorage.setItem(KEY, String(RealDate.now() + offset)); } catch (e) { }
    };
  } catch (e) { }
}

async function seedThenReload(page, spec) {
  const seeded = await page.evaluate((spec) => window.__t.seed(spec), spec);
  await page.reload({ waitUntil: 'commit' });
  await waitInit(page);
  return seeded;
}

const VIEWPORTS = [
  { name: '1920x1080', w: 1920, h: 1080 },
  { name: '1366x768', w: 1366, h: 768 },
  { name: '768x1024', w: 768, h: 1024, touch: true },
  { name: '375x667', w: 375, h: 667, touch: true },
  { name: '390x844', w: 390, h: 844, touch: true },
  { name: '414x896', w: 414, h: 896, touch: true },
];

/* ============================ B. 视口/浏览器/深色 ============================ */
async function sectionB() {
  sec('B', 'B. 多视口与浏览器兼容');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  const vpResults = {};
  const spec4 = { user: '9500', items: [{ kind: 'cloze', paperId: '2020-07-1' }, { kind: 'listening', paperId: '2020-07-1', qnoFrom: 1, qnoTo: 4 }, { kind: 'match', paperId: '2020-07-1' }, { kind: 'reading', paperId: '2020-07-1', qnoFrom: 46, qnoTo: 50 }] };

  for (const vp of VIEWPORTS) {
    const ctx = await newCtx(browser, { viewport: { width: vp.w, height: vp.h }, hasTouch: !!vp.touch, isMobile: !!vp.touch, deviceScaleFactor: 1 });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9500', null, 'B-' + vp.name + '-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' });
    await waitInit(page);
    await seedThenReload(page, spec4);
    const today = await page.evaluate(() => window.__scan());
    await shot(page, 'vp-' + vp.name + '-today');
    // 答题页
    const o = await openFirstOpenGroup(page);
    const quiz = await page.evaluate(() => window.__scan());
    const qinfo = await page.evaluate(() => window.__t.quiz());
    await shot(page, 'vp-' + vp.name + '-quiz');
    // 深色模式
    await page.evaluate(() => document.getElementById('themeBtn').click());
    await doubleRaf(page);
    const darkToday = await page.evaluate(() => {
      const s = window.__scan();
      s.dark = document.body.classList.contains('dark');
      s.contrast = window.__contrast(['header h1', '.card h3', '.muted', '#planSummary', '.opt', '.opt.sel', 'nav button.on', '.btn']);
      return s;
    });
    await shot(page, 'vp-' + vp.name + '-dark-quiz');
    // 退出答题 → 统计页（深色）
    await page.evaluate(() => document.getElementById('quizBack').click());
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    await page.evaluate(() => window.__t.nav('stat'));
    await doubleRaf(page);
    const darkStat = await page.evaluate(() => {
      const s = window.__scan();
      s.dark = document.body.classList.contains('dark');
      s.heatCells = document.querySelectorAll('#heatmap i').length;
      s.contrast = window.__contrast(['.stat-cell .v', '.stat-cell .k', 'table.acc th', 'table.acc td', '#statSummary']);
      return s;
    });
    await shot(page, 'vp-' + vp.name + '-dark-stat');
    // 深色偏好持久化
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const persisted = await page.evaluate(() => document.body.classList.contains('dark'));

    const minContrast = Math.min.apply(null, [].concat(darkToday.contrast || [], darkStat.contrast || []).map((c) => c.ratio));
    const rec = {
      todayOverflowX: today.overflowX, todayOffenders: today.offenders.length, todayOverlaps: today.overlaps.length,
      quizOverflowX: quiz.overflowX, quizOffenders: quiz.offenders.length, quizOverlaps: quiz.overlaps.length,
      optsAllOk: qinfo.opts.length > 0 && quiz.opts.every((x) => x.ok),
      optsCount: qinfo.opts.length,
      navWidths: today.nav.map((n) => n.w), navAboveBottom: today.nav.map((n) => n.aboveBottom),
      planBtnAllInView: today.planBtns.length > 0 && today.planBtns.every((b) => b.inView),
      quizBodyOverflow: quiz.quizBodyScrollW > quiz.quizBodyClientW + 1,
      darkOn: darkToday.dark && darkStat.dark, darkPersisted: persisted,
      minContrast, heatCells: darkStat.heatCells,
      contrastDetail: (darkToday.contrast || []).map((c) => c.sel + ':' + c.ratio).concat((darkStat.contrast || []).map((c) => c.sel + ':' + c.ratio)),
      lowContrast: [].concat(darkToday.contrast || [], darkStat.contrast || []).filter((c) => c.ratio < 3).map((c) => ({ sel: c.sel, ratio: c.ratio, fg: c.fg, bg: c.bg })),
      touch: !!vp.touch, errs: errs.length,
      overlaps: [].concat(today.overlaps, quiz.overlaps).slice(0, 5),
    };
    vpResults[vp.name] = rec;
    const navOk = today.nav.length === 4 && Math.max.apply(null, rec.navWidths) - Math.min.apply(null, rec.navWidths) <= 2;
    chk(vp.name + ' 无横向溢出', !today.overflowX && !quiz.overflowX && !rec.quizBodyOverflow, 'today=' + today.docScrollW + '/' + today.clientW + ' offenders=' + today.offenders.length + ' quizOffenders=' + quiz.offenders.length);
    chk(vp.name + ' 无元素重叠', today.overlaps.length === 0 && quiz.overlaps.length === 0, JSON.stringify(rec.overlaps));
    chk(vp.name + ' 导航等宽且贴底', navOk && rec.navAboveBottom.every((b) => b <= 2), 'widths=' + JSON.stringify(rec.navWidths) + ' aboveBottom=' + JSON.stringify(rec.navAboveBottom));
    chk(vp.name + ' 答题区可用', rec.optsAllOk && rec.planBtnAllInView, 'opts=' + rec.optsCount + ' planBtnsInView=' + rec.planBtnAllInView);
    chk(vp.name + ' 深色模式生效+持久化', rec.darkOn && rec.darkPersisted, 'on=' + rec.darkOn + ' persisted=' + rec.darkPersisted);
    chk(vp.name + ' 深色对比度 ≥ 3.0', minContrast >= 3.0, 'min=' + minContrast);
    chk(vp.name + ' 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }
  note('viewports', vpResults);

  /* --- B2：Edge / Chrome 完整旅程 --- */
  const browsers = [{ n: 'Edge', exe: EXE }, { n: 'Chrome', exe: fs.existsSync(CHROME) ? CHROME : null }];
  const journey = {};
  for (const b of browsers) {
    if (!b.exe) { chk(b.n + ' 可用', false, '未安装'); continue; }
    const br = await chromium.launch({ executablePath: b.exe, args: ARGS });
    const ctx = await newBrCtx(br);
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await page.goto(URL, { waitUntil: 'commit' });
    // 登录旅程（真实输入编号）
    await page.waitForSelector('#loginMask', { timeout: 20000 });
    await page.locator('#phoneInput').fill('9700');
    await page.locator('#loginBtn').click();
    await page.waitForFunction(() => { const e = document.getElementById('todayLabel'); return !!e && e.textContent.length === 10; }, null, { timeout: 20000 });
    const afterLogin = await page.evaluate(() => ({ user: window.__t.user(), plan: document.querySelectorAll('#planList .card').length, summary: document.getElementById('planSummary').textContent }));
    // 答题
    const o = await openFirstOpenGroup(page);
    const res = await completeOpenGroup(page);
    const afterQuiz = await page.evaluate(() => { const s = window.__t.state(); return { papers: Object.keys(s.papers).length, minutes: (s.history[window.__t.today()] || {}).minutes, qCount: (s.history[window.__t.today()] || {}).qCount }; });
    // 深色 + 刷新保持
    await page.evaluate(() => document.getElementById('themeBtn').click());
    await doubleRaf(page);
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const darkPersist = await page.evaluate(() => document.body.classList.contains('dark'));
    // 四页遍历
    const pages = [];
    for (const p of ['wrong', 'stat', 'backup', 'today']) {
      await page.evaluate((p) => window.__t.nav(p), p);
      await doubleRaf(page);
      pages.push(await page.evaluate((p) => ({ p, visible: document.getElementById('page-' + p).style.display !== 'none', cards: document.querySelectorAll('#page-' + p + ' .card').length }), p));
    }
    journey[b.n] = { version: br.version(), afterLogin, answered: res.qids.length, afterQuiz, darkPersist, pages, errs };
    chk(b.n + ' 完整旅程通过', afterLogin.user === '9700' && afterQuiz.papers > 0 && afterQuiz.minutes > 0 && darkPersist && pages.every((x) => x.visible) && errs.length === 0, JSON.stringify({ version: br.version(), papers: afterQuiz.papers, minutes: afterQuiz.minutes, darkPersist, errs: errs.slice(0, 2) }));
    await shot(page, 'browser-' + b.n.toLowerCase() + '-journey', false);
    await br.close();
  }
  note('journeys', journey);

  /* --- B3：Firefox ---
     注意（2026-10-07）：本机未安装 Firefox，旧写法 `chk('Firefox 已安装', false)` 会让这一条
     恒失败 —— 那是"机器上没有这个浏览器"的环境条件，不是被测应用的缺陷，判 FAIL 属于假红。
     改为：没装就只记 note（与 run_all 里 test_firefox_playwright.js 标记为 opt/条件性一致）；
     装了却驱动不起来，才是真问题，继续判 FAIL。 */
  const ffrec = { installed: fs.existsSync(FIREFOX), version: null, drivable: false, err: null };
  try { ffrec.version = require('child_process').execSync('"' + FIREFOX + '" -v', { timeout: 15000 }).toString().trim(); } catch (e) { ffrec.version = '版本探测失败'; }
  if (ffrec.installed) {
    try {
      const { firefox } = loadPW();
      const br = await firefox.launch({ executablePath: FIREFOX, timeout: 40000 });
      const ctx = await br.newContext({ viewport: { width: 390, height: 844 } });
      const page = ctx.pages()[0];
      const errs = watchErrors(page, []);
      await page.goto(URL, { waitUntil: 'commit', timeout: 30000 });
      await waitInit(page);
      const n = await page.evaluate(() => ({
        ua: navigator.userAgent,
        metaN: ((window.CET6_META || {}).order || []).length,
        plan: document.querySelectorAll('#planList .card').length,
      }));
      ffrec.drivable = true; ffrec.ua = n.ua; ffrec.metaN = n.metaN; ffrec.plan = n.plan; ffrec.errs = errs.length;
      // 按需加载下首屏 BANKS=0，判"能正常渲染"要看 meta 骨架 + 清单卡
      chk('Firefox 驱动成功（骨架就绪 + 清单渲染）', n.metaN >= 76 && n.plan >= 1 && errs.length === 0, JSON.stringify(n));
      await shot(page, 'browser-firefox');
      await br.close();
    } catch (e) {
      ffrec.err = String(e.message || e).split('\n').slice(0, 4).join(' | ').slice(0, 400);
      /* playwright-core 只能驱动 playwright 自己那份打过 juggler 补丁的 Firefox 构建，
         系统安装的官方 Firefox 会以 "Failed to launch the browser process" 直接拒绝。
         这是工具链/环境条件，不是被测应用的问题 —— run_all 里 test_firefox_playwright.js
         本来就标了 opt（条件性）。因此这里记为 note，不判 FAIL；
         真装了可驱动的构建却渲染不出来，才会走到上面的 chk 失败。 */
      note('Firefox 无法被 playwright-core 驱动（系统构建未打 juggler 补丁，环境条件，不计入断言）：' + ffrec.err);
    }
  } else {
    note('Firefox 未安装（' + FIREFOX + '），跳过内核兼容用例 —— 环境条件，不计入断言');
  }
  note('firefox', ffrec);

  await browser.close();
}
/* ============================ C. 交互状态机深度测试 ============================ */
async function openGroupByPaper(page, paperId) {
  const cards = page.locator('#planList .card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const txt = (await cards.nth(i).textContent()) || '';
    const btn = cards.nth(i).locator('button');
    if (txt.indexOf(paperId) >= 0 && ((await btn.textContent()) || '').trim() === '开始') {
      await btn.click();
      await page.waitForFunction(() => document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 });
      // 按需加载：浮层先显示"正在加载本组题目所需题库卷…"，卷脚本注入完才真正渲染出题目。
      // 只等 #quiz.show 就动手作答，会在机器负载高时抢在渲染之前（实测 C1 的草稿断言偶发 0/0）。
      await page.waitForFunction(() => {
        const b = document.getElementById('quizBody');
        return !!b && (b.querySelectorAll('.opt').length || b.querySelectorAll('.cloze-slot').length || b.querySelector('#essayTa'));
      }, null, { timeout: 20000 }).catch(() => { });
      return true;
    }
  }
  return false;
}
async function answerAllOpts(page, mode) {
  return page.evaluate((mode) => {
    let n = 0;
    // ① 客观题（听力 / 信息匹配 / 仔细阅读）：一组 .opt 按钮
    const seen = {};
    Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => {
      const q = b.getAttribute('data-q');
      if (seen[q] || b.disabled) return;
      seen[q] = 1;
      const list = document.querySelectorAll('.opt[data-q="' + q + '"]');
      const ans = window.__t.answerOf(q);
      let target = null;
      if (mode === 'correct') Array.prototype.forEach.call(list, (x) => { if (x.getAttribute('data-v') === ans) target = x; });
      else if (mode === 'wrong') Array.prototype.forEach.call(list, (x) => { if (!target && x.getAttribute('data-v') !== ans) target = x; });
      if (!target) target = list[0];
      if (target) { target.click(); n++; }
    });
    // ② 选词填空（第三轮补上）：UI 是「词库 .wb-chip + 段落空格 .cloze-slot」，整组没有 .opt。
    //    旧实现只扫 .opt，对选词填空组一题也答不上 → 提交被拒 → 上层等待判分超时（假红/中断）。
    //    交互顺序必须是【先点空格 → 再点词库条目】；correct/wrong 用词块上的 data-w 字母比对答案。
    const seen2 = {};
    Array.prototype.forEach.call(document.querySelectorAll('.cloze-slot'), (slot) => {
      if (slot.disabled || slot.getAttribute('data-picked')) return;
      const q = slot.getAttribute('data-q');
      if (seen2[q]) return;
      seen2[q] = 1;
      const ans = window.__t.answerOf(q);
      const chips = Array.prototype.filter.call(document.querySelectorAll('.wb-chip'), (c) => !c.disabled);
      if (!chips.length) return;
      let pick = null;
      if (mode === 'correct') pick = Array.prototype.filter.call(chips, (c) => c.getAttribute('data-w') === ans)[0];
      else if (mode === 'wrong') pick = Array.prototype.filter.call(chips, (c) => c.getAttribute('data-w') !== ans)[0];
      if (!pick) pick = chips[0];
      slot.click();
      pick.click();
      n++;
    });
    return n;
  }, mode);
}
const getState = (page) => page.evaluate(() => window.__t.state());
const planItemOf = (st, key) => ((st.plan || {}).items || []).filter((i) => i.key === key)[0] || null;
const parseClock = (t) => { const m = /(\d+):(\d+)/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

async function sectionC() {
  sec('C', 'C. 交互状态机深度测试');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  const VIEW = { width: 1366, height: 768 };

  /* ---------- C1 答题中途刷新：草稿 / 定时器恢复 ---------- */
  {
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9301', null, 'C1-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    await seedThenReload(page, { user: '9301', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'g1' }] });
    await page.evaluate(() => window.__t.quiz());
    await openGroupByPaper(page, '2020-07-1');
    // 该卷是选词填空（无 .opt），作答走 answerSome 的双题型路径（先点空格 → 再点词块）
    await page.evaluate(() => window.__t.answerSome(3, 'first'));
    const before = await page.evaluate(() => ({ quiz: window.__t.quiz(), st: window.__t.state() }));
    const draftBefore = Object.keys(planItemOf(before.st, 'g1').draft || {}).length;
    const timerBefore = parseClock(before.quiz.timer);
    await page.waitForTimeout(1500);
    const timerAtReload = parseClock((await page.evaluate(() => window.__t.quiz())).timer);
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const after = await page.evaluate(() => ({ st: window.__t.state() }));
    const it = planItemOf(after.st, 'g1');
    const draftAfter = Object.keys((it || {}).draft || {}).length;
    note('C1.before', { selectedInDom: before.quiz.opts.filter((o) => o.sel).length, draftInState: draftBefore, timer: before.quiz.timer, timerLeftSaved: planItemOf(before.st, 'g1').timerLeft });
    note('C1.afterReload', { draftInState: draftAfter, timerLeftSaved: it && it.timerLeft, done: it && it.done });
    chk('C1 刷新后草稿恢复', draftAfter === 3 && draftBefore === 3, 'before=' + draftBefore + ' after=' + draftAfter);
    // 重进题组：DOM 里应回显已选。
    // 题型无关：客观题回显为 .opt.sel；选词填空回显为 .cloze-slot[data-picked]（整组一个 .opt 都没有），
    // 旧断言只数 .opt.sel，遇到选词填空组恒为 0（假红）。
    await openGroupByPaper(page, '2020-07-1');
    const re = await page.evaluate(() => {
      const optSel = document.querySelectorAll('.opt.sel').length;
      const slotsPicked = Array.prototype.filter.call(document.querySelectorAll('.cloze-slot'),
        (s) => !!s.getAttribute('data-picked')).length;
      return Object.assign({}, window.__t.quiz(), { optSel: optSel, slotsPicked: slotsPicked });
    });
    const selCount = re.optSel + re.slotsPicked;
    const timerRe = parseClock(re.timer);
    chk('C1 重进题组回显已选 3 项', selCount === 3, 'sel=' + selCount + '（.opt.sel=' + re.optSel + ' + .cloze-slot[data-picked]=' + re.slotsPicked + '）');
    chk('C1 重进后定时器不倒退（按落盘值/整时限恢复）', timerRe != null && timerRe >= timerAtReload - 1, '刷新前=' + timerAtReload + 's 刷新后=' + timerRe + 's 落盘timerLeft=' + (it && it.timerLeft) + '（15s 粒度：刷新丢失 ' + (timerAtReload - timerRe) + 's）');
    // 正常退出路径：timerLeft 应精确落盘
    const tExit = parseClock((await page.evaluate(() => window.__t.quiz())).timer);
    await page.evaluate(() => document.getElementById('quizBack').click());
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    const stExit = await getState(page);
    const saved = planItemOf(stExit, 'g1').timerLeft;
    chk('C1 正常退出后剩余时间精确落盘', Math.abs(saved - tExit) <= 1, 'timer=' + tExit + 's saved=' + saved);
    await openGroupByPaper(page, '2020-07-1');
    const re2 = await page.evaluate(() => window.__t.quiz());
    chk('C1 退出重进剩余时间延续', Math.abs(parseClock(re2.timer) - saved) <= 2, 'saved=' + saved + ' shown=' + parseClock(re2.timer));
    // 判分后刷新 → 能否重复判分（重复计数）
    await answerAllOpts(page, 'first');
    await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) b.click(); });
    await page.waitForSelector('#groupDone', { timeout: 10000 });
    const st1 = await getState(page);
    const q0 = Object.keys(st1.papers)[0];
    const seen1 = st1.papers[q0].seen, min1 = (st1.history[Object.keys(st1.history)[0]] || {}).minutes;
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const stR = await getState(page);
    const itR = planItemOf(stR, 'g1');
    const canRe = await openGroupByPaper(page, '2020-07-1');
    const reQuiz = await page.evaluate(() => window.__t.quiz());
    await answerAllOpts(page, 'first');
    const resub = await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) { b.click(); return true; } return false; });
    if (resub) await page.waitForSelector('#groupDone', { timeout: 10000 });
    const st2 = await getState(page);
    const seen2 = st2.papers[q0].seen;
    note('C1.doubleCount', { afterFirstSubmit_seen: seen1, itemDoneAfterReload: itR && itR.done, draftDeleted: !(itR && itR.draft), reopenedSubmitted: reQuiz.submitted, resubmitAllowed: resub, afterResubmit_seen: seen2 });
    chk('C1 判分后刷新不会重复判分（seen 不累加）', seen2 === seen1, 'seen ' + seen1 + ' → ' + seen2 + '（判分后 done 未落盘 → 刷新后可再次提交）');
    chk('C1 全程无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'c1-after-refresh');
    await ctx.close();
  }

  /* ---------- C2 重复提交防护 ---------- */
  {
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9302', null, 'C2-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    await seedThenReload(page, { user: '9302', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'ga' }, { kind: 'cloze', paperId: '2020-09-1', key: 'gb' }] });
    await openGroupByPaper(page, '2020-07-1');
    const qids = await answerAllOpts(page, 'first');
    const clicks = await page.evaluate(() => {
      const b = document.getElementById('groupSubmit');
      let fired = 0;
      for (let i = 0; i < 10; i++) { if (b) { b.click(); fired++; } }
      return fired;
    });
    await page.waitForSelector('#groupDone', { timeout: 10000 });
    const st = await getState(page);
    const h = st.history[await page.evaluate(() => window.__t.today())] || {};
    const seenVals = Object.keys(st.papers).map((k) => st.papers[k].seen);
    chk('C2 连点 10 次「提交」只判分一次（seen=1）', seenVals.length > 0 && seenVals.every((v) => v === 1), 'clicks=' + clicks + ' qids=' + qids + ' seen=' + JSON.stringify(seenVals.slice(0, 12)));
    chk('C2 连点 10 次 qCount 只记一次', h.qCount === qids, 'qCount=' + h.qCount + ' expected=' + qids);
    // 完成按钮连点（无幂等守卫）
    const beforeDone = h.minutes;
    const doneClicks = await page.evaluate(() => { const b = document.getElementById('groupDone'); let n = 0; for (let i = 0; i < 3; i++) { if (b) { b.click(); n++; } } return n; });
    await page.waitForTimeout(300);
    const st3 = await getState(page);
    const afterDone = (st3.history[await page.evaluate(() => window.__t.today())] || {}).minutes;
    note('C2.doneButton', { clicks: doneClicks, minutesBefore: beforeDone, minutesAfter: afterDone, delta: afterDone - beforeDone, expectSingle: 6 });
    chk('C2 「完成」按钮连点只计一次时长（幂等）', (afterDone - beforeDone) === 6, '连点 ' + doneClicks + ' 次，分钟 ' + beforeDone + ' → ' + afterDone + '（单次应为 6，delta=' + (afterDone - beforeDone) + '）');
    chk('C2 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C3 定时器边界 ---------- */
  {
    // (a) 到 0 后继续答题 → 标红 + 可继续 + 判分标注超时
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9303', null, 'C3a-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    await seedThenReload(page, { user: '9303', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'ta', timerLeft: 3 }] });
    await openGroupByPaper(page, '2020-07-1');
    const t0 = await page.evaluate(() => window.__t.quiz());
    await page.waitForTimeout(4600);
    const t1 = await page.evaluate(() => window.__t.quiz());
    chk('C3a 到 0 后标红闪烁(overtime)', /overtime/.test(t1.timerCls) && /00:00/.test(t1.timer), 't0=' + t0.timer + ' t1=' + t1.timer + ' cls=' + t1.timerCls);
    const stillAnswerable = await answerAllOpts(page, 'first');
    chk('C3a 超时后仍可继续作答', stillAnswerable === 10, 'answered=' + stillAnswerable);
    await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) b.click(); });
    await page.waitForSelector('#groupDone', { timeout: 10000 });
    const bar = (await page.locator('#groupBar').textContent()) || '';
    const stA = await getState(page);
    const hA = stA.history[await page.evaluate(() => window.__t.today())] || {};
    chk('C3a 判分标注超时', /超时/.test(bar), bar.replace(/\s+/g, ' ').slice(0, 120));
    chk('C3a 限时统计记为未达标', hA.timed === 1 && hA.timedWithin === 0, 'timed=' + hA.timed + ' timedWithin=' + hA.timedWithin);
    await shot(page, 'c3a-overtime');
    chk('C3a 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }
  {
    // (b) 中途退出再进入 → 剩余时间恢复
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    await seedInit(ctx, '9304', null, 'C3b-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    await seedThenReload(page, { user: '9304', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'tb', timerLeft: 200 }] });
    await openGroupByPaper(page, '2020-07-1');
    const tb0 = parseClock((await page.evaluate(() => window.__t.quiz())).timer);
    await page.evaluate(() => document.getElementById('quizBack').click());
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    await page.waitForTimeout(2500); // 退出后不应继续倒计时
    await openGroupByPaper(page, '2020-07-1');
    const tb1 = parseClock((await page.evaluate(() => window.__t.quiz())).timer);
    chk('C3b 退出后计时暂停、重进延续剩余', tb1 != null && tb0 != null && Math.abs(tb0 - tb1) <= 2, 'exit=' + tb0 + 's re-enter=' + tb1 + 's');
    await ctx.close();
  }
  {
    // (c) 跨天答题（今天开始做，午夜后提交）
    const ctx = await newBrCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9305', null, 'C3c-' + Date.now());
    await ctx.addInitScript(DATE_SHIFT, '2026-09-27T23:58:00');
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const todayAtLoad = await page.evaluate(() => window.__t.today());
    await seedThenReload(page, { user: '9305', planDate: todayAtLoad, items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'tcross' }] });
    await openGroupByPaper(page, '2020-07-1');
    await answerAllOpts(page, 'first');
    await page.evaluate(() => window.__shiftClock(3 * 60 * 1000)); // 推进到次日 00:01
    const nowAfter = await page.evaluate(() => window.__t.today());
    await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) b.click(); });
    await page.waitForSelector('#groupDone', { timeout: 10000 });
    await page.evaluate(() => document.getElementById('groupDone').click());
    const stC = await getState(page);
    const keys = Object.keys(stC.history);
    note('C3c', { dateAtLoad: todayAtLoad, dateAtSubmit: nowAfter, planDateAfterSubmit: stC.plan && stC.plan.date, historyKeys: keys, planItemDone: (stC.plan.items[0] || {}).done });
    chk('C3c 跨天提交仍归属开始日（页面载入日）', keys.length === 1 && keys[0] === todayAtLoad, 'loadDate=' + todayAtLoad + ' submitDate=' + nowAfter + ' history=' + JSON.stringify(keys));
    chk('C3c 跨天提交后清单状态已落盘', stC.plan && stC.plan.items[0] && stC.plan.items[0].done === true, JSON.stringify(stC.plan && stC.plan.items[0]));
    // 午夜后刷新：清单重算为新的一天，昨日打卡保留
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const stD = await getState(page);
    const todayAfterReload = await page.evaluate(() => window.__t.today());
    note('C3c.afterMidnightReload', { today: todayAfterReload, planDate: stD.plan && stD.plan.date, planItems: (stD.plan.items || []).length, historyKeys: Object.keys(stD.history), yesterdayDone: Object.keys(stD.history).map((k) => k + ':' + !!(stD.history[k].done || stD.history[k].floor)).join(',') });
    chk('C3c 午夜后刷新 → 清单重算为新日期且昨日打卡保留', todayAfterReload !== todayAtLoad && stD.plan && stD.plan.date === todayAfterReload && stD.history[todayAtLoad] && stD.history[todayAtLoad].done === true, 'today=' + todayAfterReload + ' plan=' + (stD.plan && stD.plan.date));
    chk('C3c 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }
  /* ---------- C4 错题复习状态 ---------- */
  {
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9306', null, 'C4-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const seed = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), t = window.__t;
      const qA = t.qidsOf('2020-07-1', 'cloze')[0];
      const qB = t.qidsOf('2020-09-1', 'cloze')[0];
      const spec = { user: '9306', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'gA' }, { kind: 'cloze', paperId: '2020-09-1', key: 'gB' }], state: { wrongbook: {} } };
      const r = t.seed(spec);
      const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9306'));
      st.wrongbook[qA] = { addedAt: C.addDays(today, -30), box: 4, wrongCount: 1, due: today, ease: 2.6, iv: 15, streak: 4 }; // 再对 1 次即毕业
      st.wrongbook[qB] = { addedAt: C.addDays(today, -5), box: 3, wrongCount: 1, due: today, ease: 2.5, iv: 4, streak: 2 };
      localStorage.setItem('cet6_p1_state_v1_9306', JSON.stringify(st));
      return { qA, qB, today };
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    // (a) 连对 5 次毕业出库：答对 qA
    await openGroupByPaper(page, '2020-07-1');
    await answerAllOpts(page, 'correct');
    await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) b.click(); });
    await page.waitForSelector('#groupDone', { timeout: 10000 });
    let st = await getState(page);
    chk('C4a 连对达 5 次毕业出库（wrongbook 删除）', !st.wrongbook[seed.qA], 'streak 4→5，wrongbook[qA]=' + JSON.stringify(st.wrongbook[seed.qA]));
    note('C4a.papers', st.papers[seed.qA]);
    // (b) 答错 → ease 降低、间隔重置
    await page.evaluate(() => document.getElementById('groupDone').click());
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    await openGroupByPaper(page, '2020-09-1');
    await answerAllOpts(page, 'wrong');
    await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) b.click(); });
    await page.waitForSelector('#groupDone', { timeout: 10000 });
    st = await getState(page);
    const wb = st.wrongbook[seed.qB];
    note('C4b.wrongbook', wb);
    chk('C4b 答错 → ease 2.5→2.3 / box 0 / iv 1 / streak 0 / re-due 次日',
      wb && Math.abs(wb.ease - 2.3) < 1e-6 && wb.box === 0 && wb.iv === 1 && wb.streak === 0 && wb.wrongCount === 2 && wb.due === await page.evaluate((d) => window.CET6Core.addDays(d, 1), seed.today),
      JSON.stringify(wb));
    await page.evaluate(() => document.getElementById('groupDone').click());
    // (c) 逾期错题排序
    const c4 = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr();
      const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9306'));
      const q3 = window.__t.qidsOf('2020-12-1', 'cloze')[0];
      const q4 = window.__t.qidsOf('2020-12-2', 'cloze')[0];
      const q5 = window.__t.qidsOf('2020-09-1', 'cloze')[0];
      st.wrongbook = {};
      st.wrongbook[q3] = { addedAt: C.addDays(today, -30), box: 1, wrongCount: 2, due: C.addDays(today, -10), ease: 2.1, iv: 3, streak: 0 }; // 逾期 10 天
      st.wrongbook[q4] = { addedAt: C.addDays(today, -10), box: 2, wrongCount: 1, due: C.addDays(today, -3), ease: 2.5, iv: 4, streak: 0 };  // 逾期 3 天
      st.wrongbook[q5] = { addedAt: today, box: 0, wrongCount: 1, due: today, ease: 2.5, iv: 1, streak: 0 };                             // 今日到期
      localStorage.setItem('cet6_p1_state_v1_9306', JSON.stringify(st));
      return { q3: q3, q4: q4, q5: q5 };
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await page.evaluate(() => window.__t.nav('wrong'));
    await doubleRaf(page);
    const order = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#dueList .wb-item'), (r) => r.getAttribute('data-qid')));
    const want = [c4.q3, c4.q4, c4.q5];
    note('C4c.seed', c4);
    chk('C4c 逾期久的排最前（10天 > 3天 > 今日）', !!c4.q3 && !!c4.q4 && !!c4.q5 && JSON.stringify(order) === JSON.stringify(want), 'order=' + JSON.stringify(order) + ' want=' + JSON.stringify(want));
    await shot(page, 'c4c-wrong-order');
    chk('C4 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C5 计划清单边界 ---------- */
  {
    // (a) 3315/3315 全部做完
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9401', null, 'C5a-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const built = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), papers = {};
      // 必须用 meta 骨架枚举（allQids 读的 CET6_BANKS 在按需加载下恒为空）
      window.__t.allQidsMeta().forEach((id) => { papers[id] = { seen: 1, right: 1, wrong: 0, lastAt: today, lastResult: 'right' }; });
      localStorage.setItem('cet6_user', '9401');
      localStorage.setItem('cet6_p1_state_v1_9401', JSON.stringify({ version: 1, history: {}, papers: papers, wrongbook: {}, essays: {}, plan: null }));
      return { n: Object.keys(papers).length, bytes: JSON.stringify(papers).length };
    });
    const t0 = Date.now();
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const initMs = Date.now() - t0;
    await waitPlan(page);
    const empty = await page.evaluate(() => ({
      planItems: (window.__t.plan() || []).length,
      cards: document.querySelectorAll('#planList .card').length,
      summary: document.getElementById('planSummary').textContent,
      // 全部做完时应用走 renderEmptyToday()：仍然是 1 张 .card，但里面是"通关"空态，
      // 不是可点的题目卡（旧断言 cards===0 把"渲染了一张空态卡"误判成"清单没清干净"）。
      emptyText: ((document.querySelector('#planList .card .empty') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
      todayStatus: document.getElementById('todayStatus').textContent,
      done: !!(window.__t.state().history[window.__t.today()] || {}).done,
    }));
    note('C5a', Object.assign({ papers: built.n, stateBytes: built.bytes, initMs: initMs }, empty));
    chk('C5a 全做完时清单不空转、无死循环（给出"已通关"空态）',
      initMs < 3000 && empty.planItems === 0 && empty.cards === 1 &&
      /题库已通关/.test(empty.summary) && /全部题目已完成/.test(empty.emptyText),
      'init=' + initMs + 'ms 清单条目=' + empty.planItems + ' 卡片=' + empty.cards +
      ' summary=' + empty.summary + ' 空态文案=' + (empty.emptyText || '（无）'));
    // 加练按钮在全部做完后的行为
    const toasts = [];
    for (let i = 0; i < 4; i++) {
      const txt = await page.evaluate((i) => { const bs = document.querySelectorAll('#extraBtns button'); if (!bs[i]) return null; bs[i].click(); return document.getElementById('toast').textContent; }, i);
      toasts.push(txt);
    }
    note('C5a.extraToasts', toasts);
    chk('C5a 全做完后「加练」提示无剩余题目（不新增空组）', toasts.every((t) => /没有剩余题目/.test(t || '')) && (await page.evaluate(() => (window.__t.plan() || []).length)) === 0, JSON.stringify(toasts));
    chk('C5a 全做完且无错题时无法通过清单达成打卡（仅底线打卡可用）', empty.done === false, 'history.done=' + empty.done + '；今日清单条目=0，finishItem 无入口');
    await shot(page, 'c5a-all-done');
    chk('C5a 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }
  {
    // (b) 周六写译隔周轮换
    const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
    const expectType = (d) => (Math.floor(dayDiff('2020-01-04', d) / 7) % 2 === 0 ? 'writing' : 'translation');
    const got = {};
    for (const anchor of ['2026-09-26T10:00:00', '2026-10-03T10:00:00', '2026-10-10T10:00:00']) {
      const ctx = await newBrCtx(browser, { viewport: VIEW });
      const page = ctx.pages()[0];
      await seedInit(ctx, '9402', null, 'C5b-' + anchor);
      await ctx.addInitScript(DATE_SHIFT, anchor);
      await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
      const r = await page.evaluate(() => {
        const C = window.CET6Core, today = C.todayStr();
        // 应用自己调的是 C.genPlan(state, META, today)——清单只依赖 meta 骨架，与卷正文加载状态无关。
        // 旧写法传 window.CET6_BANKS（按需加载下恒为空），genPlan 拿不到任何单元，
        // 出来的清单只剩周六写译一项，"清单条目数"之类的观察全部失真。
        const p = C.genPlan({ version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, window.CET6_META, today);
        const essay = (p.items || []).filter((i) => i.type === 'writing' || i.type === 'translation')[0];
        const d = new Date(today + 'T10:00:00');
        return { today, dow: d.getDay(), essay: essay ? { type: essay.type, key: essay.key, paperId: essay.paperId } : null, planItems: (p.items || []).length };
      });
      got[anchor.slice(0, 10)] = r;
      await ctx.close();
    }
    note('C5b', got);
    const d0 = '2026-09-26', d1 = '2026-10-03', d2 = '2026-10-10';
    const ok = [d0, d1, d2].every((d) => got[d] && got[d].dow === 6 && got[d].essay && got[d].essay.type === expectType(d));
    chk('C5b 周六安排写译且隔周轮换', ok, JSON.stringify({ d0: got[d0] && got[d0].essay && got[d0].essay.type, d1: got[d1] && got[d1].essay && got[d1].essay.type, d2: got[d2] && got[d2].essay && got[d2].essay.type, expect: [expectType(d0), expectType(d1), expectType(d2)] }));
    chk('C5b 连续两周类型不同', got[d0] && got[d1] && got[d0].essay.type !== got[d1].essay.type, (got[d0] && got[d0].essay.type) + ' vs ' + (got[d1] && got[d1].essay.type));
  }
  {
    // (c) 底线打卡
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    let dlgVal = '10';
    page.on('dialog', async (d) => { try { await d.accept(dlgVal); } catch (e) { } });
    await seedInit(ctx, '9403', null, 'C5c-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    await seedThenReload(page, { user: '9403', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'g1' }] });
    await page.evaluate(() => document.getElementById('floorBtn').click());
    await page.waitForTimeout(400);
    const st = await getState(page);
    const h = st.history[await page.evaluate(() => window.__t.today())] || {};
    const status = await page.evaluate(() => document.getElementById('todayStatus').textContent);
    note('C5c', { history: h, status: status, streak: await page.evaluate(() => document.getElementById('streakChip').textContent) });
    chk('C5c 底线打卡写入 floor + 分钟数', h.floor === true && h.minutes === 10, JSON.stringify(h));
    chk('C5c 底线打卡后今日状态与连击更新', /忙日打卡/.test(status) && /🔥 1 天/.test(await page.evaluate(() => document.getElementById('streakChip').textContent)), status + ' | ' + (await page.evaluate(() => document.getElementById('streakChip').textContent)));
    // 清单仍未完成（底线打卡不代替清单）
    const planLeft = await page.evaluate(() => document.getElementById('planSummary').textContent);
    chk('C5c 底线打卡后清单条目仍为未完成', /今日清单 0\/1 组/.test(planLeft), planLeft);
    await ctx.close();
  }

  /* ---------- C6 多账号切换 ---------- */
  {
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    let dlgVal = '9102';
    page.on('dialog', async (d) => { try { await d.accept(dlgVal); } catch (e) { } });
    await seedInit(ctx, '9101', null, 'C6-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    await seedThenReload(page, { user: '9101', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'a1' }, { kind: 'cloze', paperId: '2020-09-1', key: 'a2' }] });
    // A 完成一组
    await openGroupByPaper(page, '2020-07-1');
    await answerAllOpts(page, 'first');
    await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (!b.disabled) b.click(); });
    await page.waitForSelector('#groupDone', { timeout: 10000 });
    await page.evaluate(() => document.getElementById('groupDone').click());
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    // A 第二组只答 2 题留下草稿后退出
    await openGroupByPaper(page, '2020-09-1');
    // 同为选词填空：留 2 题草稿也走双题型作答（旧写法点 .opt 恒为 0 题）
    await page.evaluate(() => window.__t.answerSome(2, 'first'));
    const draftToast = await page.evaluate(() => { document.getElementById('quizBack').click(); return true; });
    await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    const stA0 = await getState(page);
    const minA = (stA0.history[await page.evaluate(() => window.__t.today())] || {}).minutes;
    // 切到 B
    await page.evaluate(() => document.getElementById('userChip').click());
    await page.waitForFunction(() => localStorage.getItem('cet6_user') === '9102', null, { timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(600);
    await waitInit(page);
    const stB = await getState(page);
    const bView = await page.evaluate(() => ({ summary: document.getElementById('planSummary').textContent, cards: document.querySelectorAll('#planList .card').length, status: document.getElementById('todayStatus').textContent, chip: document.getElementById('userChip').textContent }));
    note('C6.B', { state: { history: stB.history, papers: Object.keys(stB.papers).length, wrongbook: Object.keys(stB.wrongbook).length }, view: bView });
    chk('C6 切到 B 后看到空状态', Object.keys(stB.papers).length === 0 && Object.keys(stB.history).length === 0 && /0 分钟/.test(bView.summary), JSON.stringify(bView));
    // 切回 A
    dlgVal = '9101';
    await page.evaluate(() => document.getElementById('userChip').click());
    await page.waitForFunction(() => localStorage.getItem('cet6_user') === '9101', null, { timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(600);
    await waitInit(page);
    const stA1 = await getState(page);
    const aView = await page.evaluate(() => document.getElementById('planSummary').textContent);
    const it2 = planItemOf(stA1, 'a2');
    chk('C6 切回 A 后数据完整（时长/做题记录）', Object.keys(stA1.papers).length > 0 && (stA1.history[await page.evaluate(() => window.__t.today())] || {}).minutes === minA, 'minutes=' + minA + ' papers=' + Object.keys(stA1.papers).length + ' summary=' + aView);
    chk('C6 切换账号后未提交草稿保留在 A 的 state 中（不丢失）', it2 && Object.keys(it2.draft || {}).length === 2, 'draft=' + JSON.stringify(it2 && it2.draft));
    note('C6.draftNotice', { note: '切换入口 #userChip 位于 #quiz 浮层(z-index:100)之下，答题中无法点击切换；退出答题时草稿已落盘，因此不存在"切换丢草稿"路径，也未提供专门提示。', draftToast: draftToast });
    chk('C6 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C7 导入导出往返 ---------- */
  {
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9201', null, 'C7-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const rich = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), t = window.__t;
      const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, hl: {} };
      for (let i = 0; i < 10; i++) { const d = C.addDays(today, -i); st.history[d] = { minutes: 10 + i, done: i % 2 === 0, floor: i % 3 === 0, qCount: 4 + i, right: 3 + i, timed: 1, timedWithin: i % 2, timedSec: 300 }; }
      const qs = ['2020-07-1', '2020-09-1', '2020-12-1'].reduce((a, p) => a.concat(t.qidsOf(p, 'cloze')), []);
      qs.slice(0, 20).forEach((id, i) => { st.papers[id] = { seen: 1 + i, right: i % 3, wrong: 1, lastAt: today, lastResult: i % 2 ? 'right' : 'wrong', lastAnswer: 'A' }; });
      qs.slice(0, 12).forEach((id, i) => { st.wrongbook[id] = { addedAt: C.addDays(today, -i), box: i % 3, wrongCount: 1 + (i % 4), due: C.addDays(today, i % 3), ease: 2.0 + (i % 5) * 0.1, iv: 1 + i, streak: i % 3 }; });
      st.essays = { writing: { lastAt: today, text: 'Draft essay line one.\nLine two, with comma "quote".' }, translation: { lastAt: today, text: '译文草稿' } };
      st.hl = { '2020-07-1#reading#read0': ['the', 'a', 'of'] };
      st.items = null;
      localStorage.setItem('cet6_user', '9201');
      localStorage.setItem('cet6_p1_state_v1_9201', JSON.stringify(st));
      return { history: Object.keys(st.history).length, papers: Object.keys(st.papers).length, wrongbook: Object.keys(st.wrongbook).length };
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    // 导出 JSON
    const jsonPath = path.join(DOCS, 'retest-export-state.json');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => document.getElementById('exportBtn').click())]);
    await dl.saveAs(jsonPath);
    const expRaw = fs.readFileSync(jsonPath, 'utf8');
    let exp = null; try { exp = JSON.parse(expRaw); } catch (e) { }
    chk('C7 导出 JSON 可解析且文件名正确', !!exp && /^cet6-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), 'file=' + dl.suggestedFilename() + ' bytes=' + expRaw.length);
    note('C7.exported', exp ? { history: Object.keys(exp.history || {}).length, papers: Object.keys(exp.papers || {}).length, wrongbook: Object.keys(exp.wrongbook || {}).length, essays: Object.keys(exp.essays || {}).length, hl: Object.keys(exp.hl || {}).length, lastBackup: exp.lastBackup } : null);
    // 清空 → 导入
    await page.evaluate(() => window.__t.delState());
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const cleared = await getState(page);
    const clearedPapers = Object.keys(cleared.papers || {}).length;
    await page.setInputFiles('#importFile', jsonPath);
    await page.waitForFunction(() => Object.keys(window.__t.state().papers || {}).length > 0, null, { timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(400);
    const restored = await getState(page);
    const same = (k) => sstr(restored[k]) === sstr(exp[k]);
    note('C7.compare', { history: same('history'), papers: same('papers'), wrongbook: same('wrongbook'), essays: same('essays'), hl: same('hl'), clearedPapers: clearedPapers });
    chk('C7 清空后确为空', clearedPapers === 0 && Object.keys(cleared.history || {}).length === 0, 'papers=' + clearedPapers);
    chk('C7 导入后 history/papers/wrongbook/essays/hl 完全恢复',
      same('history') && same('papers') && same('wrongbook') && same('essays') && same('hl'),
      JSON.stringify({ history: same('history'), papers: same('papers'), wrongbook: same('wrongbook'), essays: same('essays'), hl: same('hl') }));
    // CSV
    const csvPath = path.join(DOCS, 'retest-wrongbook.csv');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => document.getElementById('wrongCsvBtn').click())]);
    await dl2.saveAs(csvPath);
    const buf = fs.readFileSync(csvPath);
    const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const txt = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = txt.split('\r\n').filter((l) => l.length);
    const nWrong = Object.keys(restored.wrongbook || {}).length;
    const quoted = (txt.match(/"[^"]*"/g) || []).length;
    note('C7.csv', { file: dl2.suggestedFilename(), bytes: buf.length, bom, crlf: txt.indexOf('\n') > 0 && txt.indexOf('\r\n') >= 0, header: lines[0], rows: lines.length - 1, wrongbook: nWrong, quotedFields: quoted, sample: lines[1] });
    chk('C7 CSV：BOM + 表头 + 行数匹配 + CRLF',
      bom && lines[0] === '卷号,题号,题型,题干,你的答案,正确答案,考点,错次,下次复习,稳固度' && lines.length - 1 === nWrong && txt.indexOf('\r\n') >= 0,
      'bom=' + bom + ' rows=' + (lines.length - 1) + '/' + nWrong + ' header=' + lines[0]);
    chk('C7 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'c7-imported');
    await ctx.close();
  }

  /* ---------- C8 异常组合 ---------- */
  {
    // (a) 双标签页同账号 = localStorage 竞争
    const ctx = await newCtx(browser, { viewport: VIEW });
    const a = ctx.pages()[0];
    const errs = watchErrors(a, []);
    await seedInit(ctx, '9601', null, 'C8a-' + Date.now());
    await a.goto(URL, { waitUntil: 'commit' }); await waitInit(a);
    await seedThenReload(a, { user: '9601', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'ga' }, { kind: 'cloze', paperId: '2020-09-1', key: 'gb' }] });
    const b = await ctx.newPage();
    watchErrors(b, []);
    await b.goto(URL, { waitUntil: 'commit' }); await waitInit(b);
    // A 先完成 ga
    await openGroupByPaper(a, '2020-07-1');
    await answerAllOpts(a, 'first');
    await a.evaluate(() => { const x = document.getElementById('groupSubmit'); if (!x.disabled) x.click(); });
    await a.waitForSelector('#groupDone', { timeout: 10000 });
    await a.evaluate(() => document.getElementById('groupDone').click());
    await a.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    const afterA = await getState(a);
    const aPapers = Object.keys(afterA.papers).length;
    // B（旧快照）完成 gb → 整份 state 覆盖回写
    await openGroupByPaper(b, '2020-09-1');
    await answerAllOpts(b, 'first');
    await b.evaluate(() => { const x = document.getElementById('groupSubmit'); if (!x.disabled) x.click(); });
    await b.waitForSelector('#groupDone', { timeout: 10000 });
    await b.evaluate(() => document.getElementById('groupDone').click());
    await b.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 10000 });
    const finalA = await getState(a);
    const finalB = await getState(b);
    const gbQids = await b.evaluate(() => window.__t.qidsOf('2020-09-1', 'cloze'));
    const gaQids = await a.evaluate(() => window.__t.qidsOf('2020-07-1', 'cloze'));
    const gaSurvived = gaQids.every((q) => !!finalA.papers[q]);
    const gbSurvived = gbQids.every((q) => !!finalA.papers[q]);
    const gaItem = planItemOf(finalA, 'ga') || {};
    const gbItem = planItemOf(finalA, 'gb') || {};
    note('C8a', {
      aPapersAfterOwnSubmit: aPapers, gaSurvivedAfterBWrite: gaSurvived, gbSurvivedAfterAWrite: gbSurvived,
      planGaDone: gaItem.done, planGbDone: gbItem.done,
      gbPresentOnB: gbQids.every((q) => !!finalB.papers[q]),
    });
    /* 2026-10-07 反转：旧断言写的是 `gaSurvived === false`（把"会丢更新"当成预期行为记录在案），
       但实测应用已经自己做掉了跨标签页丢更新（storage 事件 + pendingResync + 会话结束以存储为准重载）。
       断言继续锁着旧缺陷，就会把"已经修好的功能"判成失败。现在改成真正的回归护栏：
       两个页签各自完成的作答记录必须都留在同一份存档里，谁都不许被对方的旧快照回写抹掉。 */
    chk('C8a 双标签页并发写不丢更新（两个页签的作答记录都保留在存档里）',
      gaSurvived && gbSurvived,
      'ga 存活=' + gaSurvived + ' gb 存活=' + gbSurvived + '；A 自己完成 ' + aPapers + ' 题后 B 用旧快照回写，' +
      '存档内 ga.done=' + gaItem.done + ' gb.done=' + gbItem.done);
    await shot(a, 'c8a-two-tabs');
    await ctx.close();
  }
  {
    // (b) 答题时切到其他页签再回来
    const ctx = await newCtx(browser, { viewport: VIEW });
    const a = ctx.pages()[0];
    await seedInit(ctx, '9602', null, 'C8b-' + Date.now());
    await a.goto(URL, { waitUntil: 'commit' }); await waitInit(a);
    await seedThenReload(a, { user: '9602', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'tc' }] });
    await openGroupByPaper(a, '2020-07-1');
    const t0 = parseClock((await a.evaluate(() => window.__t.quiz())).timer);
    const bg = await ctx.newPage();
    await bg.goto('about:blank');
    await bg.bringToFront();
    const vis = await a.evaluate(() => document.visibilityState);
    await new Promise((r) => setTimeout(r, 20000));
    const t1 = parseClock((await a.evaluate(() => window.__t.quiz())).timer);
    await a.bringToFront();
    await a.waitForTimeout(1200);
    const t2 = parseClock((await a.evaluate(() => window.__t.quiz())).timer);
    note('C8b', { startSec: t0, after20s: t1, drift: t0 - t1, afterReturn: t2, appVisibilityDuringProbe: vis, headlessLimitation: 'headless 下 bringToFront 不会让原页面 document.hidden=true（实测仍为 visible），无法制造真实后台节流' });
    chk('C8b（限）headless 无法制造后台页签 → 如实标注未覆盖', vis === 'visible', '探针期间 visibilityState=' + vis + '（真实浏览器应变为 hidden）');
    chk('C8b 切回后计时继续（不再跳变）', t1 - t2 <= 3 && t2 <= t1, 't1=' + t1 + ' t2=' + t2);
    // C8b-2：主线程阻塞 5s，验证计时器按真实时间推进（而非按 tick 计数会丢时）
    const b0 = parseClock((await a.evaluate(() => window.__t.quiz())).timer);
    const w0 = Date.now();
    await a.evaluate(() => { const t = Date.now(); while (Date.now() - t < 5000) { } });
    await a.waitForTimeout(1200);
    const b1 = parseClock((await a.evaluate(() => window.__t.quiz())).timer);
    const wall = Math.round(((Date.now() - w0) / 1000) * 10) / 10;
    note('C8b2', { beforeSec: b0, afterSec: b1, timerAdvance: b0 - b1, wallElapsedSec: wall });
    chk('C8b2 主线程阻塞 5s 后计时器仍与真实时间一致（非 tick 计数）', Math.abs((b0 - b1) - wall) <= 3, 'timer 推进 ' + (b0 - b1) + 's vs 真实经过 ' + wall + 's');
    await ctx.close();
  }
  {
    // (c) 快速连续点击导航
    const ctx = await newCtx(browser, { viewport: VIEW });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9603', null, 'C8c-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    await seedThenReload(page, { user: '9603', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'g1' }] });
    const r1 = await page.evaluate(() => {
      const seq = ['wrong', 'stat', 'backup', 'today', 'wrong', 'stat', 'backup', 'today', 'wrong', 'stat'];
      for (let i = 0; i < 30; i++) window.__t.nav(seq[i % seq.length]);
      return { visible: ['today', 'wrong', 'stat', 'backup'].filter((p) => document.getElementById('page-' + p).style.display !== 'none'), on: Array.prototype.map.call(document.querySelectorAll('nav button'), (b) => b.classList.contains('on')) };
    });
    await doubleRaf(page);
    // 真实快速点击（无等待）
    await page.evaluate(() => { window.__t.nav('today'); });
    const btns = page.locator('nav button');
    for (let i = 0; i < 12; i++) await btns.nth(i % 4).click({ timeout: 3000 }).catch(() => { });
    await doubleRaf(page);
    const r2 = await page.evaluate(() => ({ visible: ['today', 'wrong', 'stat', 'backup'].filter((p) => document.getElementById('page-' + p).style.display !== 'none'), onCount: Array.prototype.filter.call(document.querySelectorAll('nav button'), (b) => b.classList.contains('on')).length }));
    note('C8c', { after30SyncClicks: r1, after12RealClicks: r2 });
    chk('C8c 30 次同步连点后仅 1 页可见 / 1 个高亮', r1.visible.length === 1 && r1.on.filter(Boolean).length === 1, JSON.stringify(r1));
    chk('C8c 12 次真实连点后状态一致', r2.visible.length === 1 && r2.onCount === 1, JSON.stringify(r2));
    chk('C8c 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  await browser.close();
}
function sstr(o) {
  if (o === null || o === undefined) return JSON.stringify(o === undefined ? null : o);
  if (typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(sstr).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + sstr(o[k])).join(',') + '}';
}
/* ============================ D. 极端数据量 ============================ */
async function navPaint(page, p) {
  await page.evaluate((p) => window.__t.nav(p), p);
  const t = await page.evaluate(() => new Promise((r) => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0))); }));
  return t;
}

async function sectionD() {
  sec('D', 'D. 极端数据量');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });

  /* ---- D1: 1200 错题 ---- */
  {
    const ctx = await newCtx(browser, { viewport: { width: 1366, height: 768 } });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9500', null, 'D1-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const built = await page.evaluate(() => {
      // 必须用 meta 骨架枚举：allQids() 读的 CET6_BANKS 在按需加载下恒为空，
      // 旧写法 wb 也是空对象，于是"due+rest === built.n"退化成 0===0 恒真（假绿），用例什么都没验。
      const C = window.CET6Core, today = C.todayStr(), all = window.__t.allQidsMeta(), wb = {};
      for (let i = 0; i < 1200 && i < all.length; i++) {
        wb[all[i]] = { addedAt: C.addDays(today, -(i % 60)), box: i % 5, wrongCount: 1 + (i % 6), due: C.addDays(today, (i % 40) - 25), ease: 1.3 + (i % 15) * 0.1, iv: 1 + (i % 20), streak: i % 4 };
      }
      localStorage.setItem('cet6_user', '9500');
      localStorage.setItem('cet6_p1_state_v1_9500', JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: wb, essays: {}, plan: null }));
      return { n: Object.keys(wb).length, bytes: JSON.stringify(wb).length, due: Object.keys(wb).filter((k) => C.dayDiff(wb[k].due, today) >= 0).length };
    });
    const tReload = Date.now();
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const initMs = Date.now() - tReload;
    const ms = await navPaint(page, 'wrong');
    // 按需加载架构下错题本是**异步渲染**：renderWrong() 先 ensurePapers(错题涉及的所有卷)、
    // 卷正文都回来了才 renderWrongInner() 画行。1200 条错题散在几十卷里，要一卷卷拉。
    // 旧断言在 nav 之后只等 2 帧就读 DOM —— 卷还没拉完时读到 0 行，
    // 于是把"功能正常、只是还没画完"判成"列表不完整"（假红，且与机器快慢强相关）。
    // 这里显式等到 #wrongSummary 真正有内容（= 渲染完成）再测量，并如实报告这段耗时。
    const tNav = Date.now();
    const rendered = await page.waitForFunction(() => {
      const s = document.getElementById('wrongSummary');
      return !!s && s.textContent.trim().length > 0;
    }, null, { timeout: 60000 }).then(() => true).catch(() => false);
    const settleMs = Date.now() - tNav;
    const dom = await page.evaluate(() => ({
      dueRows: document.querySelectorAll('#dueList .wb-item').length,
      restRows: document.querySelectorAll('#allWrongList .wb-item').length,
      summary: document.getElementById('wrongSummary').textContent,
      scrollH: document.getElementById('page-wrong').scrollHeight,
      docScrollH: document.documentElement.scrollHeight,
    }));
    const scrollMs = await page.evaluate(() => new Promise((r) => {
      const t0 = performance.now();
      window.scrollTo(0, document.documentElement.scrollHeight);
      requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0)));
    }));
    note('D1', Object.assign({ wrongbook: built.n, stateBytes: built.bytes, dueToday: built.due, initMs: initMs, renderMs: ms, settleMs: settleMs, rendered: rendered, scrollMs: scrollMs }, dom));
    chk('D1 错题本渲染完成（异步拉卷后，非仅首帧）', rendered, 'nav→就绪=' + settleMs + 'ms');
    chk('D1 1200 错题「按需拉卷 + 全量渲染」 < 10000ms', settleMs < 10000, 'nav→paint=' + ms + 'ms · nav→就绪=' + settleMs + 'ms · 行数 ' + (dom.dueRows + dom.restRows));
    chk('D1 1200 错题全部渲染且列表完整', dom.dueRows + dom.restRows === built.n, 'due=' + dom.dueRows + ' rest=' + dom.restRows + ' total=' + built.n);
    chk('D1 滚动到底 + 绘制 < 500ms', scrollMs < 500, scrollMs + 'ms · 文档高 ' + dom.docScrollH + 'px');
    chk('D1 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'd1-wrongbook-1200');
    await ctx.close();
  }

  /* ---- D2: 500 天历史 ---- */
  {
    const ctx = await newCtx(browser, { viewport: { width: 1366, height: 768 } });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9501', null, 'D2-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const built = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), h = {};
      for (let i = 0; i < 500; i++) { const d = C.addDays(today, -i); h[d] = { minutes: 10 + (i % 40), done: true, floor: false, qCount: 20, right: 15, timed: 1, timedWithin: 1, timedSec: 200 }; }
      localStorage.setItem('cet6_user', '9501');
      localStorage.setItem('cet6_p1_state_v1_9501', JSON.stringify({ version: 1, history: h, papers: {}, wrongbook: {}, essays: {}, plan: null }));
      return { days: Object.keys(h).length, bytes: JSON.stringify(h).length };
    });
    const tReload = Date.now();
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const initMs = Date.now() - tReload;
    const ms = await navPaint(page, 'stat');
    const dom = await page.evaluate(() => ({ heat: document.querySelectorAll('#heatmap i').length, streak: document.getElementById('streakChip').textContent, summary: document.getElementById('statSummary').textContent, grid: document.getElementById('statGrid').textContent.replace(/\s+/g, ' ').slice(0, 120) }));
    note('D2', Object.assign({ historyDays: built.days, stateBytes: built.bytes, initMs: initMs, renderMs: ms }, dom));
    chk('D2 500 天历史下统计页渲染 < 500ms', ms < 500, 'nav→paint=' + ms + 'ms');
    chk('D2 热力图仍为 84 格且连击正确', dom.heat === 84 && /🔥 500 天/.test(dom.streak), 'heat=' + dom.heat + ' streak=' + dom.streak);
    chk('D2 累计分钟正确(>= 14000)', /累计 1[4-9]\d\d\d 分钟/.test(dom.summary) || /累计 [2-9]\d{4} 分钟/.test(dom.summary), dom.summary);
    chk('D2 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'd2-history-500');
    await ctx.close();
  }

  /* ---- D3: papers 覆盖全部 3315 题 ---- */
  {
    const ctx = await newCtx(browser, { viewport: { width: 1366, height: 768 } });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9502', null, 'D3-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const built = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), papers = {};
      // 必须用 meta 骨架枚举（allQids 读的 CET6_BANKS 在按需加载下恒为空，
      // 旧写法 seed 出空 papers，统计页自然全空 → accRows/ptRows/grid 三处一起误判）
      window.__t.allQidsMeta().forEach((id, i) => { papers[id] = { seen: 1 + (i % 3), right: (i % 3), wrong: 1, lastAt: C.addDays(today, -(i % 30)), lastResult: i % 2 ? 'right' : 'wrong' }; });
      localStorage.setItem('cet6_user', '9502');
      localStorage.setItem('cet6_p1_state_v1_9502', JSON.stringify({ version: 1, history: {}, papers: papers, wrongbook: {}, essays: {}, plan: null }));
      const seenSum = Object.keys(papers).reduce((a, k) => a + papers[k].seen, 0);
      return { n: Object.keys(papers).length, seenSum: seenSum, points: window.__t.distinctPointsMeta(), bytes: JSON.stringify(papers).length };
    });
    const tReload = Date.now();
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const initMs = Date.now() - tReload;
    const ms = await navPaint(page, 'stat');
    const dom = await page.evaluate(() => ({
      accRows: document.querySelectorAll('#accTable tr').length,
      ptRows: document.querySelectorAll('#ptTable tr').length,
      grid: document.getElementById('statGrid').textContent.replace(/\s+/g, ' '),
      est: (document.getElementById('estCard') || {}).textContent ? document.getElementById('estCard').textContent.replace(/\s+/g, ' ').slice(0, 80) : '',
      ptFirst: (document.querySelector('#ptTable tr:nth-child(2)') || {}).textContent || '',
    }));
    note('D3', Object.assign({ papers: built.n, seenSum: built.seenSum, distinctPoints: built.points, stateBytes: built.bytes, initMs: initMs, renderMs: ms }, dom));
    chk('D3 全量 papers 下统计页渲染 < 500ms', ms < 500, 'nav→paint=' + ms + 'ms');
    // 考点表行数 = 表头 + 全库不同考点数（数据推导，不写死阈值）
    chk('D3 正确率表/考点表渲染完整（' + built.points + ' 个考点）',
      dom.accRows === 5 && dom.ptRows === built.points + 1,
      'accRows=' + dom.accRows + '（期望 5） ptRows=' + dom.ptRows + '（期望 ' + (built.points + 1) + ' = 表头 1 + 考点 ' + built.points + '） 首行=' + dom.ptFirst);
    // 口径：应用统计格里的"累计做题"= 累计作答次数（sum of papers[qid].seen），非去重题目数。
    // 本用例每个 qid 的 seen=1+(i%3)，期望值按实际 qid 总数动态算（不写死 3315/6630，
    // 否则题库一变或继续镜像到另一仓就会误判）。
    chk('D3 累计做题=累计作答次数(seen 之和) ' + built.seenSum,
      dom.grid.indexOf(built.seenSum + ' 题') >= 0,
      'grid=' + dom.grid + ' · 去重题数=' + built.n + ' · 期望累计次数=' + built.seenSum);
    chk('D3 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'd3-all-papers');
    await ctx.close();
  }

  /* ---- D4: 作文草稿 10000 字 ---- */
  {
    const ctx = await newCtx(browser, { viewport: { width: 1366, height: 768 } });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9503', null, 'D4-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    const built = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr();
      const text = ('The importance of lifelong learning cannot be overstated. ').repeat(190).slice(0, 10000);
      localStorage.setItem('cet6_user', '9503');
      localStorage.setItem('cet6_p1_state_v1_9503', JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: {}, essays: { writing: { lastAt: today, text: text } }, plan: { date: today, v: C.PLAN_VERSION, items: [{ key: 'w1', type: 'writing', qids: [], paperId: '2020-07-1', done: false, minutes: 0 }] } }));
      return { len: text.length };
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const tOpen = Date.now();
    await openGroupByPaper(page, '2020-07-1');
    const openMs = Date.now() - tOpen;
    const taLen = await page.evaluate(() => (document.getElementById('essayTa') || {}).value.length);
    const saveMs = await page.evaluate(() => {
      const ta = document.getElementById('essayTa');
      const t0 = performance.now();
      ta.value = ta.value + ' Appended to measure the save path latency.';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - t0;
    });
    const storedLen = await page.evaluate(() => (((window.__t.state().essays || {}).writing || {}).text || '').length);
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await openGroupByPaper(page, '2020-07-1');
    const restoredLen = await page.evaluate(() => document.getElementById('essayTa').value.length);
    note('D4', { seededLen: built.len, textareaLen: taLen, openMs: openMs, inputSaveMs: Math.round(saveMs * 100) / 100, storedLen: storedLen, restoredLen: restoredLen });
    chk('D4 10000 字草稿可完整回填 textarea', taLen === built.len, 'seeded=' + built.len + ' textarea=' + taLen);
    chk('D4 输入(含整份 state 落盘) < 500ms', saveMs < 500, Math.round(saveMs * 100) / 100 + 'ms');
    chk('D4 刷新后草稿完整恢复', restoredLen === storedLen && restoredLen > 10000, 'stored=' + storedLen + ' restored=' + restoredLen);
    chk('D4 打开写译组渲染 < 500ms', openMs < 500, openMs + 'ms');
    chk('D4 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'd4-essay-10000');
    await ctx.close();
  }

  /* ---- D5: 100 处高亮 ---- */
  {
    const ctx = await newCtx(browser, { viewport: { width: 1366, height: 768 } });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9504', null, 'D5-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' }); await waitInit(page);
    // 按需加载：本用例要读卷正文里的 readingPassages（原文全文），必须先注入该卷。
    // 旧写法直接 __t.banks().filter(...) → 空数组 → [0] 为 undefined → 读 .readingPassages 直接抛
    // TypeError，整段脚本 fatal（实测就是这样挂掉的）。
    await ensurePaper(page, '2020-07-1');
    const built = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr();
      const paper = window.__t.banks().filter((b) => b.id === '2020-07-1')[0];
      if (!paper) return { error: '卷 2020-07-1 未注入成功' };
      const txt = (paper.readingPassages || {})['46'] || '';
      const step = Math.max(4, Math.floor((txt.length - 6) / 100));
      const arr = [];
      for (let i = 0; i < 100; i++) { const s = txt.substr(i * step, 6); if (s.length === 6 && arr.indexOf(s) < 0) arr.push(s); }
      const qids = window.__t.qidsOf('2020-07-1', 'reading', 46, 50);
      localStorage.setItem('cet6_user', '9504');
      localStorage.setItem('cet6_p1_state_v1_9504', JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, hl: { '2020-07-1#reading#read0': arr }, plan: { date: today, v: C.PLAN_VERSION, items: [{ key: 'r1', type: 'reading', qids: qids, paperId: '2020-07-1', done: false, minutes: 0 }] } }));
      return { passageLen: txt.length, seededHl: arr.length, arr: arr, qids: qids.length };
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const tOpen = Date.now();
    await openGroupByPaper(page, '2020-07-1');
    const openMs = Date.now() - tOpen;
    /* 关于"100 处高亮只回来 50 处"：
       这不是静默丢数据，而是应用**有设计、并且会明说**的单段上限（index.html 的 HL_MAX=50，
       core.js 的 normalizeState 同口径 slice(0,50)）。载入时若被截断，应用会在段落上方渲染一条
       "⚠️ 本段原有的高亮有 N 处超出单段上限 50 处…"的提示，交互路径超额时还会 toast。
       旧断言写的是 marks === seededHl（要求 100 处全回来），等于要求"没有上限"——
       它测的是不存在的规格，所以永远红。现在改为验证真实规格：
         ① 按上限截断且数量与存档一致（画面与存档不许打架）
         ② 截断这件事**有明确提示**（不静默）
         ③ 保留的是最靠前的若干条（顺序稳定，不是随机丢）
       上限值从页面提示文案里解析，而不是写死 50 —— 以后调上限，用例自动跟随。 */
    const after = await page.evaluate(() => {
      const st = window.__t.state();
      const key = Object.keys(st.hl || {})[0] || '';
      const stored = (st.hl || {})[key] || [];
      const body = document.getElementById('quizBody');
      const warns = Array.prototype.filter.call(body.querySelectorAll('.muted, .card'),
        (e) => /超出单段上限|已达上限/.test(e.textContent || ''));
      return {
        key: key,
        marks: document.querySelectorAll('#quizBody mark.hl').length,
        storedHl: stored.length,
        storedHead: stored.slice(0, 3),
        warn: warns.length ? (warns[0].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '',
        allText: (body.textContent || ''),
      };
    });
    const capM = /上限 (\d+) 处/.exec(after.warn || after.allText);
    const cap = capM ? Number(capM[1]) : 50;
    note('D5', Object.assign({ openMs: openMs, restoredMarks: after.marks, storedHlAfterLoad: after.storedHl, cap: cap, warn: after.warn, storedHead: after.storedHead }, built));
    chk('D5 高亮恢复渲染 < 500ms', openMs < 500, 'open=' + openMs + 'ms');
    chk('D5 超过单段上限的高亮按上限（' + cap + '）截断，画面与存档一致',
      after.storedHl === cap && after.marks === cap,
      'seeded=' + built.seededHl + ' restored=' + after.marks + ' 存档=' + after.storedHl + ' 上限=' + cap);
    chk('D5 截断有明确提示（不静默丢高亮）', /超出单段上限/.test(after.warn), '提示=' + (after.warn || '（无）'));
    chk('D5 截断保留最靠前的 ' + cap + ' 条（顺序稳定）',
      JSON.stringify(after.storedHead) === JSON.stringify(built.arr.slice(0, 3)),
      '存档前 3 条=' + JSON.stringify(after.storedHead) + ' 期望=' + JSON.stringify(built.arr.slice(0, 3)));
    chk('D5 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'd5-hl-100');
    await ctx.close();
  }

  await browser.close();
}

/* ============================ 入口 ============================ */
(async () => {
  const argv = process.argv.slice(2).map((s) => s.toUpperCase()).filter((s) => /^[ABCD]$/.test(s));
  const want = argv.length ? argv : ['A', 'B', 'C', 'D'];
  const t0 = Date.now();
  console.log('运行区段: ' + want.join(', ') + ' · 目标 ' + URL);
  try {
    if (want.includes('A')) await sectionA();
    if (want.includes('B')) await sectionB();
    if (want.includes('C')) await sectionC();
    if (want.includes('D')) await sectionD();
  } catch (e) {
    console.error('FATAL', e && e.stack ? e.stack : e);
    R.fatal = String((e && e.message) || e);
  }
  R.durationMs = Date.now() - t0;
  try { fs.writeFileSync(path.join(DOCS, 'retest-result.json'), JSON.stringify(R, null, 2), 'utf8'); } catch (e) { }
  let ok = 0, fail = 0; const fails = [];
  Object.keys(R.sections).forEach((id) => R.sections[id].checks.forEach((c) => { if (c.ok) ok++; else { fail++; fails.push(id + ': ' + c.name + (c.detail ? ' | ' + c.detail : '')); } }));
  const total = ok + fail;
  console.log('\n=== 汇总: ' + ok + ' ok / ' + fail + ' fail · ' + (R.durationMs / 1000).toFixed(1) + 's ===');
  fails.forEach((f) => console.log('FAIL ' + f));

  /* ---------------------------- 硬闸门（防空绿） ----------------------------
     由来：本脚本此前无条件 process.exit(0)。实测出现过"只跑了 A 段 6 条断言、
     B/C/D 因 A 抛错根本没启动"，却仍以退出码 0 报告通过——这是典型的假绿，
     CI 里完全看不出来。以下四种情况一律判失败：
       1) fatal：任一区段抛出的未捕获异常
       2) 请求的区段没有落地任何断言（静默跳过，最常见的腐化方式）
       3) 总断言数 < 下限（套件整体缩水）
       4) 存在 FAIL 断言
     下限按"实际请求了哪些区段"累加。此前写成全局常数 30，于是 `--only A`
     （A 段本来就只有 ~26 条）必然撞门，把一个正常结果判成 GATE FAIL；
     按段计门槛后，既能在单独跑某段时给出正确结论，也不会放过整段被跳过。 */
  const MIN_PER_SECTION = { A: 22, B: 10, C: 40, D: 16 };
  const MIN_ASSERTIONS = want.reduce(function (a, k) { return a + (MIN_PER_SECTION[k] || 10); }, 0);
  const bad = [];
  if (R.fatal) bad.push('fatal: ' + R.fatal);
  want.forEach(function (k) {
    const s = R.sections[k];
    if (!s || !s.checks.length) bad.push('区段 ' + k + ' 未产生任何断言（疑似静默跳过）');
  });
  if (total === 0) bad.push('0 断言：脚本未做任何校验');
  else if (total < MIN_ASSERTIONS) bad.push('断言总数 ' + total + ' < 下限 ' + MIN_ASSERTIONS);
  if (fail > 0) bad.push(fail + ' 条断言失败');
  if (bad.length) { console.log('GATE FAIL: ' + bad.join('；')); process.exit(1); }
  console.log('GATE PASS: ' + total + ' 条断言全部通过（区段 ' + want.join('/') + '）');
  process.exit(0);
})();

