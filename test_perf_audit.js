/* scripts/test_perf_audit.js
 * CET6 真题打卡应用 · 性能 / 多视口兼容 / 浏览器兼容 专项审计
 *
 * 覆盖：
 *   1. 首屏与二次访问性能（冷缓存 3 次 / 热缓存 3 次 / 题库就绪时间）
 *   2. 内存稳定性（初始 / 连做 5 组 / 切页 10 次 / 强制 GC 后泄漏复核）
 *   3. 多视口布局（1920x1080 / 1366x768 / 768x1024 / 375x667 / 390x844 / 414x896）
 *   4. 主流浏览器兼容（Edge / Chrome 各自实测）
 *   5. 交互流畅度（点选 / 判分 / 切页 / 500 错题渲染 / 400 天热力图渲染）
 *
 * 结果落盘：docs/perf-audit-result.json、docs/viewport-*.png
 * 运行：node scripts/test_perf_audit.js
 *       node scripts/test_perf_audit.js perf,viewport   （只跑指定段落）
 *
 * 本脚本只读源文件，不修改 app/ 下任何文件。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();

const APP_DIR = path.join(__dirname, '..', 'app');
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const APP_URL = pathToFileURL(path.join(APP_DIR, 'index.html')).href;
const OUT_JSON = path.join(DOCS_DIR, 'perf-audit-result.json');

const ARGV = (process.argv[2] || 'perf,memory,viewport,browser,fluency').split(',');
const WANT = (s) => ARGV.indexOf(s) >= 0;

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];
const HEADED = process.env.CET6_HEADED === '1'; // CET6_HEADED=1 关闭无头模式，用于排除无头渲染造成的偏差
function launch(exe) {
  return chromium.launch({ executablePath: exe || EXE, args: LAUNCH_ARGS, headless: !HEADED });
}
const R = {
  meta: { startedAt: new Date().toISOString(), appUrl: APP_URL, browserExe: EXE, sections: ARGV },
  checks: [], perf: {}, memory: {}, viewport: {}, browser: {}, fluency: {},
  notes: [], consoleErrors: [],
};
function log(s) { console.log(s); }
function check(group, name, ok, detail) {
  const rec = { group, name, ok: !!ok, detail: detail == null ? '' : String(detail) };
  R.checks.push(rec);
  log((ok ? 'ok   ' : 'FAIL ') + '[' + group + '] ' + name + (detail != null && detail !== '' ? ' | ' + detail : ''));
  return ok;
}
function note(s) { R.notes.push(s); log('note ' + s); }
/** 归因：堆栈带 http(s) URL 的异常来自内嵌第三方页面，与应用自身代码无关 */
function isExternalStack(d) { return /https?:\/\/[^\s)]+/.test(String(d.stack || '') + ' ' + String(d.message || '')); }
function classifyErrors(details) {
  return {
    self: details.filter(function (d) { return !isExternalStack(d); }),
    external: details.filter(isExternalStack),
  };
}
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function avg(a) { return a.length ? sum(a) / a.length : 0; }
function r3(n) { return Math.round(n * 1000) / 1000; }
function r1(n) { return Math.round(n * 10) / 10; }

/* ------------------------------------------------------------ 通用 */

const EMPTY_STATE_SRC = 'function (C, today, banks) { return { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null }; }';

/** 预置状态：mutation 以字符串源码形式在页面内重建（避免闭包不可序列化） */
async function seedState(page, phone, mutateSrc, planItems) {
  await page.evaluate(function (args) {
    var C = window.CET6Core;
    var today = C.todayStr();
    var st;
    /* eslint-disable no-new-func */
    st = new Function('C', 'today', 'banks', 'return (' + args.src + ')(C, today, window.CET6_BANKS);')(C, today, window.CET6_BANKS);
    if (args.planItems) st.plan = { date: today, v: C.PLAN_VERSION, items: args.planItems };
    else if (!st.plan) st.plan = { date: today, v: C.PLAN_VERSION, items: [] };
    localStorage.setItem('cet6_user', args.phone);
    localStorage.setItem(C.stateKey(args.phone), JSON.stringify(st));
  }, { phone: phone, src: mutateSrc, planItems: planItems || null });
}

/** 启动并登录 */
async function bootLoggedIn(page, phone) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginMask', { timeout: 30000 });
  await page.evaluate(function () { window.alert = function () {}; window.prompt = function () { return null; }; });
  await page.locator('#phoneInput').fill(phone);
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 30000 });
}

/** 重新载入并等待渲染（requireCards=false 时只等容器，用于空清单场景） */
async function reloadApp(page, requireCards) {
  await page.waitForTimeout(120).catch(function () {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (requireCards === false) await page.waitForSelector('#planList', { state: 'attached', timeout: 30000 });
  else await page.waitForSelector('#planList .card', { timeout: 30000 });
}

/* ---------- 题型无关的作答助手 ----------
   应用里有两种答题 UI：客观题（听力/匹配/阅读）是一组 .opt 按钮；选词填空是
   「段落空格 .cloze-slot + 词库 .wb-chip」，整组一个 .opt 都没有。
   此前本脚本多处只扫 .opt，一旦打开的卡恰好是选词填空：
     · 兼容性用例 → answered=0、#groupSubmit 一直 disabled、click() 直接 30s 超时（假红）；
     · 内存用例  → answered=0 且提交被拒，5 组题其实一组没判分（静默降级，数据失真）。
   统一走这里：先 .opt，再「点空格 → 点第一个可用词块」。返回实际作答题数。 */
async function answerGroup(page) {
  return page.evaluate(function () {
    var n = 0, seen = {};
    document.querySelectorAll('#quizBody .opt').forEach(function (b) {
      var q = b.getAttribute('data-q');
      if (!seen[q] && !b.disabled) { seen[q] = 1; b.click(); n++; }
    });
    document.querySelectorAll('#quizBody .cloze-slot').forEach(function (slot) {
      if (slot.disabled || slot.getAttribute('data-picked')) return;
      var q = slot.getAttribute('data-q');
      if (seen[q]) return;
      var chip = Array.prototype.filter.call(document.querySelectorAll('#quizBody .wb-chip'), function (c) { return !c.disabled; })[0];
      if (!chip) return;
      seen[q] = 1;
      slot.click(); chip.click(); n++;
    });
    return n;
  });
}
/** 提交本组（仅在按钮可用时点，避免 disabled 上点 30s 超时） */
async function submitGroup(page) {
  return page.evaluate(function () {
    var b = document.getElementById('groupSubmit');
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  });
}

/** 切换深浅色主题。
 *  踩过的坑：#themeBtn 在 header 里，而 #quiz 是 position:fixed 的全屏浮层——
 *  只要上一组题没真正退出（例如提交按钮一直 disabled、#groupDone 从未出现），
 *  浮层就一直挡住 #themeBtn，locator.click() 会干等满 30s 然后抛 Timeout（表现为
 *  "Chrome 兼容性 fatal: waiting for locator('#themeBtn')"，其实和主题毫无关系）。
 *  这里先确保浮层已关，再点；仍点不动就退化为页内 DOM click（不依赖可点性判定）。 */
async function toggleTheme(page) {
  await page.waitForSelector('#quiz', { state: 'hidden', timeout: 15000 }).catch(function () {});
  const btn = page.locator('#themeBtn');
  try {
    await btn.click({ timeout: 8000 });
  } catch (e) {
    await page.evaluate(function () {
      var b = document.getElementById('themeBtn');
      if (b) b.click();
    });
  }
  await page.waitForTimeout(250);
  return page.evaluate(function () { return document.body.classList.contains('dark'); });
}

/** 打开一张"含选项"的未完成卡。选词填空卡整组没有 .opt，视口用例的
 *  「选项越界 / 相邻选项重叠 / touch 点选」三条判定就全部落空（甚至 boundingBox() 直接超时），
 *  因此这里优先挑客观题卡，只有全清单都是选词填空/写作/翻译时才回退到第一张可开启的卡。 */
async function openObjectiveCard(page) {
  const cards = page.locator('#planList .card:not(.done)');
  const n = await cards.count();
  let fallback = null;
  for (let i = 0; i < n; i++) {
    const btn = cards.nth(i).locator('button').first();
    if (((await btn.textContent()) || '').trim() !== '开始') continue;
    const label = ((await cards.nth(i).locator('b').first().textContent()) || '').trim();
    if (/选词填空|写作|翻译/.test(label)) { if (!fallback) fallback = btn; continue; }
    await btn.click();
    await page.waitForSelector('#quiz.show', { timeout: 25000 });
    await page.waitForFunction(function () { return document.querySelectorAll('#quizBody .opt').length > 0; }, null, { timeout: 20000 }).catch(function () {});
    return label;
  }
  if (fallback) {
    await fallback.click();
    await page.waitForSelector('#quiz.show', { timeout: 25000 });
    return '(仅剩选词填空/写作类卡，回退)';
  }
  return null;
}

/** 探针：骨架就绪 / 卷注入 / DCL / load 的 performance.now()
 *  按需加载架构下"题库就绪"的含义变了：首屏只加载 meta 骨架（CET6_META.order 74~76 项），
 *  卷正文（CET6_BANKS push）发生在用户点「开始」之后。两件事分开计时，不再混为一谈。 */
const PROBE_SRC = function () {
  window.__probe = { bankReady: null, bankFirst: null, appReady: null, dcl: null, load: null, bankCount: 0, skeletonReady: null, skeletonN: 0 };
  try {
    var arr = [];
    Object.defineProperty(window, 'CET6_BANKS', {
      configurable: true,
      get: function () { return arr; },
      set: function (v) { if (Array.isArray(v)) arr = v; },
    });
    var realPush = Array.prototype.push;
    arr.push = function () {
      if (window.__probe.bankFirst == null) window.__probe.bankFirst = performance.now();
      var r = realPush.apply(this, arguments);
      window.__probe.bankCount = this.length;
      return r;
    };
    // meta 骨架就绪：meta.js 直接 window.CET6_META = {...}，用 setter 捕获赋值时刻
    Object.defineProperty(window, 'CET6_META', {
      configurable: true,
      get: function () { return window.__meta; },
      set: function (v) {
        window.__meta = v;
        var n = (v && v.order && v.order.length) || 0;
        window.__probe.skeletonN = n;
        if (n >= 70 && window.__probe.skeletonReady == null) window.__probe.skeletonReady = performance.now();
      },
    });
  } catch (e) { window.__probe.probeErr = String(e); }
  document.addEventListener('DOMContentLoaded', function () {
    window.__probe.dcl = performance.now();
    var list = document.getElementById('planList');
    window.__probe.appReady = performance.now();
    window.__probe.planCards = list ? list.querySelectorAll('.card').length : -1;
  });
  window.addEventListener('load', function () { window.__probe.load = performance.now(); });
};

/** 一次导航后的性能采样 */
async function sampleNav(page) {
  return await page.evaluate(function () {
    var t = performance.timing;
    var n = performance.getEntriesByType('navigation')[0] || {};
    var res = performance.getEntriesByType('resource');
    var bankRes = res.filter(function (x) { return /bank\/cet6-/.test(x.name); });
    var maxEnd = bankRes.reduce(function (a, x) { return Math.max(a, x.responseEnd); }, 0);
    return {
      probe: window.__probe || null,
      domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
      load: t.loadEventEnd - t.navigationStart,
      domInteractive: t.domInteractive - t.navigationStart,
      responseEnd: Math.round(n.responseEnd || 0),
      resourceCount: res.length,
      bankResourceCount: bankRes.length,
      bankMaxResponseEnd: Math.round(maxEnd),
      bankBytes: bankRes.reduce(function (a, x) { return a + (x.encodedBodySize || 0); }, 0),
      transferBytes: res.reduce(function (a, x) { return a + (x.transferSize || 0); }, 0),
    };
  });
}

async function memSnapshot(client) {
  await client.send('HeapProfiler.enable').catch(function () {});
  await client.send('Performance.enable').catch(function () {});
  const res = await client.send('Performance.getMetrics');
  const m = {};
  res.metrics.forEach(function (x) { m[x.name] = x.value; });
  return m;
}
function memBrief(m) {
  return {
    JSHeapUsedMB: r1((m.JSHeapUsedSize || 0) / 1048576),
    JSHeapTotalMB: r1((m.JSHeapTotalSize || 0) / 1048576),
    Nodes: m.Nodes || 0, Documents: m.Documents || 0,
    JSEventListeners: m.JSEventListeners || 0,
    LayoutObjects: m.LayoutObjects || 0, Frames: m.Frames || 0,
    LayoutCount: m.LayoutCount || 0, RecalcStyleCount: m.RecalcStyleCount || 0,
  };
}

/* ============================================================ 1. 性能 */

async function sectionPerf(browser) {
  log('');
  log('================ 1. 首屏与二次访问性能 ================');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', function (e) { errs.push('pageerror: ' + e.message); });
  await page.addInitScript(PROBE_SRC);
  const client = await ctx.newCDPSession(page);
  await client.send('Network.enable').catch(function () {});

  await bootLoggedIn(page, '9301');

  const cold = [], warm = [];
  for (let i = 0; i < 3; i++) {
    await client.send('Network.clearBrowserCache').catch(function () {});
    const tc = Date.now();
    await page.goto(APP_URL, { waitUntil: 'commit' }).catch(function () {});
    await page.waitForSelector('#planList .card', { timeout: 30000 }).catch(function () {});
    const coldInteractive = Date.now() - tc;
    await page.waitForLoadState('load').catch(function () {});
    const c = await sampleNav(page);
    c.interactiveMs = coldInteractive;
    cold.push(c);
    const tw = Date.now();
    await page.reload({ waitUntil: 'commit' }).catch(function () {});
    await page.waitForSelector('#planList .card', { timeout: 30000 }).catch(function () {});
    const warmInteractive = Date.now() - tw;
    await page.waitForLoadState('load').catch(function () {});
    const w = await sampleNav(page);
    w.interactiveMs = warmInteractive;
    warm.push(w);
  }
  const bankStat = await page.evaluate(function () {
    // 按需加载架构（2026-10）：首屏 window.CET6_BANKS 一定还是空数组，卷正文只在点「开始」时才注入。
    // 所以「题库是否就绪」不能数 CET6_BANKS.length（恒 0），要看 meta 骨架；
    // 「有没有偷偷预载卷」也不能靠 performance.getEntriesByType('resource')（file:// 下恒为空数组，
    // 会给出"请求数=0"的假绿），要直接数 DOM 里 <script src="bank/cet6-*.js">。
    var bs = window.CET6_BANKS || [];
    var M = window.CET6_META || {};
    var preloaded = 0;
    Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) {
      if (/(?:^|\/)bank\/cet6-[^/]*\.js(\?|$)/.test(s.getAttribute('src') || '')) preloaded++;
    });
    return {
      banks: bs.length,
      questions: bs.reduce(function (a, b) { return a + (b.questions || []).length; }, 0),
      metaOrder: (M.order || []).length,
      metaPapers: Object.keys(M.papers || {}).length,
      preloadedPapers: preloaded,
      planCards: document.querySelectorAll('#planList .card').length,
    };
  });
  const slim = function (x) {
    return {
      domContentLoaded: x.domContentLoaded, load: x.load, domInteractive: x.domInteractive,
      skeletonReady: x.probe && x.probe.skeletonReady != null ? r1(x.probe.skeletonReady) : -1,
      skeletonN: x.probe ? x.probe.skeletonN : -1,
      bankLoaded: x.probe ? x.probe.bankCount : -1,
      appReady: x.probe && x.probe.appReady != null ? r1(x.probe.appReady) : -1,
      planCards: x.probe && x.probe.planCards != null ? x.probe.planCards : -1,
      interactiveMs: x.interactiveMs,
      resourceCount: x.resourceCount, bankResourceCount: x.bankResourceCount,
    };
  };
  R.perf.coldRaw = cold.map(slim);
  R.perf.warmRaw = warm.map(slim);
  R.perf.bankStat = bankStat;
  R.perf.resource = {
    encodedBodyBytes: cold[0].bankBytes, transferBytes: cold[0].transferBytes,
    bankMaxResponseEnd: cold[0].bankMaxResponseEnd, resourceCount: cold[0].resourceCount,
  };
  const S = {
    cold: {
      domContentLoaded: r1(avg(cold.map(function (x) { return x.domContentLoaded; }))),
      load: r1(avg(cold.map(function (x) { return x.load; }))),
      domInteractive: r1(avg(cold.map(function (x) { return x.domInteractive; }))),
      skeletonReady: r1(avg(cold.map(function (x) { return (x.probe && x.probe.skeletonReady) || 0; }))),
      interactiveMs: r1(avg(cold.map(function (x) { return x.interactiveMs; }))),
    },
    warm: {
      domContentLoaded: r1(avg(warm.map(function (x) { return x.domContentLoaded; }))),
      load: r1(avg(warm.map(function (x) { return x.load; }))),
      domInteractive: r1(avg(warm.map(function (x) { return x.domInteractive; }))),
      skeletonReady: r1(avg(warm.map(function (x) { return (x.probe && x.probe.skeletonReady) || 0; }))),
      interactiveMs: r1(avg(warm.map(function (x) { return x.interactiveMs; }))),
    },
  };
  R.perf.summary = S;
  R.perf.coldRaw = cold.map(slim);
  R.perf.warmRaw = warm.map(slim);
  log('meta 骨架就绪（首屏，navigationStart 起算）: 冷 ' + S.cold.skeletonReady + 'ms / 热 ' + S.warm.skeletonReady +
    'ms；首屏注入卷正文数=' + R.perf.coldRaw.map(function (x) { return x.bankLoaded; }).join('/') + '（按需加载，首屏应为 0）');
  log('冷加载(清缓存) DCL / DCL-interactive / load / 骨架就绪 / 首屏可交互  均值: ' +
    S.cold.domContentLoaded + ' / ' + S.cold.domInteractive + ' / ' + S.cold.load + ' / ' + S.cold.skeletonReady + ' / ' + S.cold.interactiveMs + ' ms');
  log('逐次冷加载: ' + JSON.stringify(R.perf.coldRaw.map(function (x) { return { dcl: x.domContentLoaded, load: x.load, skeleton: x.skeletonReady }; })));
  log('热加载(二次访问) DCL / load / 骨架就绪 / 首屏可交互  均值: ' +
    S.warm.domContentLoaded + ' / ' + S.warm.load + ' / ' + S.warm.skeletonReady + ' / ' + S.warm.interactiveMs + ' ms');
  log('逐次热加载: ' + JSON.stringify(R.perf.warmRaw.map(function (x) { return { dcl: x.domContentLoaded, load: x.load, skeleton: x.skeletonReady }; })));
  check('perf', '首屏 < 1s（冷加载 load 均值 ' + S.cold.load + 'ms）', S.cold.load < 1000);
  check('perf', '二次访问 < 0.2s（热加载 load 均值 ' + S.warm.load + 'ms）', S.warm.load < 200);
  check('perf', '首屏可交互 < 1s（冷加载 commit→清单可点 均值 ' + S.cold.interactiveMs + 'ms）', S.cold.interactiveMs < 1000);
  check('perf', 'meta 骨架就绪 < 800ms（冷 ' + S.cold.skeletonReady + 'ms / 热 ' + S.warm.skeletonReady + 'ms）',
    S.cold.skeletonReady > 0 && S.cold.skeletonReady < 800 && S.warm.skeletonReady > 0 && S.warm.skeletonReady < 800);
  check('perf', '题库 76 卷清单就绪且首屏零预载（meta.order=' + bankStat.metaOrder + '，预载卷=' + bankStat.preloadedPapers + '）',
    bankStat.metaOrder >= 76 && bankStat.preloadedPapers === 0,
    bankStat.metaOrder + ' 卷清单 / ' + bankStat.metaPapers + ' 篇 meta / 首屏已注入卷脚本 ' + bankStat.preloadedPapers +
    ' 个 / 内存中已加载 ' + bankStat.banks + ' 卷 ' + bankStat.questions + ' 题');
  const bankDir = path.join(APP_DIR, 'bank');
  const bankFiles = fs.readdirSync(bankDir).filter(function (f) { return /\.js$/.test(f); });
  const bankBytesOnDisk = bankFiles.reduce(function (a, f) { return a + fs.statSync(path.join(bankDir, f)).size; }, 0);
  R.perf.bankStat.diskBytes = bankBytesOnDisk;
  R.perf.bankStat.diskMB = r1(bankBytesOnDisk / 1048576);
  note('题库 ' + bankFiles.length + ' 个 JS 文件，磁盘合计 ' + r1(bankBytesOnDisk / 1048576) + 'MB（' + bankBytesOnDisk + ' 字节）；首屏只同步加载 meta 骨架（bank/meta.js + bank/listeningMeta.js），' +
    bankStat.metaOrder + ' 卷正文全部按需注入，实测首屏注入 ' + bankStat.preloadedPapers + ' 个卷脚本；' +
    'file:// 下 Resource Timing 不产生条目（实测 performance.getEntriesByType("resource").length=' + cold[0].resourceCount +
    '，encodedBodySize/transferSize 均为 0），故所有时序均由页内探针 performance.now() 采集，' +
    '"有没有预载卷"改由 DOM 中 <script src="bank/cet6-*.js"> 计数兜底；' +
    'file:// 资源不走 HTTP 缓存，冷/热加载差异仅来自 V8 代码缓存与渲染管线');
  R.perf.browserVersion = browser.version();
  if (errs.length) R.consoleErrors = R.consoleErrors.concat(errs);
  await ctx.close();
}

/* ============================================================ 2. 内存 */

async function sectionMemory(browser) {
  log('');
  log('================ 2. 内存稳定性 ================');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', function (e) { errs.push('pageerror: ' + e.message); });
  const client = await ctx.newCDPSession(page);

  await bootLoggedIn(page, '9302');
  await page.waitForTimeout(600);
  const m0 = memBrief(await memSnapshot(client));
  log('初始（登录后）: ' + JSON.stringify(m0));

  const groups = [];
  let answeredTotal = 0;
  for (let i = 0; i < 5; i++) {
    let card = page.locator('#planList .card:not(.done)').first();
    if (!(await card.count())) {
      // 清单做完仍不足 5 组：用「加练」按钮补足（真实 UI 路径）
      const btn = page.locator('#extraBtns button').nth(i % 4);
      if (!(await btn.count())) break;
      await btn.click();
      await page.waitForTimeout(200);
      card = page.locator('#planList .card:not(.done)').first();
      if (!(await card.count())) break;
    }
    const title = ((await card.locator('b').first().textContent().catch(function () { return ''; })) || '').replace(/\s+/g, ' ').trim();
    await card.locator('button').first().click();
    await page.waitForSelector('#quiz.show', { timeout: 25000 });
    const answered = await answerGroup(page);
    if (await page.locator('#essayTa').count()) {
      await page.locator('#essayTa').fill('memory audit practice essay, long enough to be saved into the local draft.');
      await page.locator('#essayDone').click();
    } else {
      await submitGroup(page);
      await page.waitForSelector('#groupDone', { timeout: 25000 }).catch(function () {});
      await page.locator('#groupDone').click({ timeout: 20000 }).catch(function () {});
    }
    await page.waitForSelector('#quiz', { state: 'hidden', timeout: 20000 }).catch(function () {});
    answeredTotal += answered;
    groups.push({ title: title, answered: answered });
  }
  await page.waitForTimeout(800);
  const m1 = memBrief(await memSnapshot(client));
  log('连做 ' + groups.length + ' 组题（' + answeredTotal + ' 题）后: ' + JSON.stringify(m1));
  R.memory.groups = groups;
  R.memory.answeredTotal = answeredTotal;

  const order = ['wrong', 'stat', 'backup', 'today', 'wrong', 'stat', 'backup', 'today', 'wrong', 'stat'];
  for (const p of order) {
    await page.locator('nav button[data-p="' + p + '"]').click();
    await page.waitForTimeout(70);
  }
  // 回到「今日」页再采样，保证与初始快照同页面、可比
  await page.locator('nav button[data-p="today"]').click();
  await page.waitForTimeout(800);
  const m2 = memBrief(await memSnapshot(client));
  log('切页 10 次后（回到今日页）: ' + JSON.stringify(m2));

  await client.send('HeapProfiler.collectGarbage').catch(function () {});
  await page.waitForTimeout(600);
  const m3 = memBrief(await memSnapshot(client));
  log('强制 GC 后: ' + JSON.stringify(m3));

  // 再来一轮 10 次切页。只做一轮时会量到「做题残留的一次性 DOM」（#quizBody 里最后一组题的
  // 节点还在），这是有界的正常开销、不是泄漏；真正该断言的是**每多切一轮是否还在涨**，
  // 所以第二轮 10 次切页的净增量才是泄漏信号。
  for (const p of order) {
    await page.locator('nav button[data-p="' + p + '"]').click();
    await page.waitForTimeout(70);
  }
  await page.locator('nav button[data-p="today"]').click();
  await page.waitForTimeout(800);
  await client.send('HeapProfiler.collectGarbage').catch(function () {});
  await page.waitForTimeout(600);
  const m4 = memBrief(await memSnapshot(client));
  log('再切页 10 次（回到今日页 + GC）后: ' + JSON.stringify(m4));

  R.memory.initial = m0;
  R.memory.afterQuiz = m1;
  R.memory.afterNav = m2;
  R.memory.afterGC = m3;
  R.memory.afterGC2 = m4;
  R.memory.delta = {
    quizHeapMB: r1(m1.JSHeapUsedMB - m0.JSHeapUsedMB),
    navHeapMB: r1(m2.JSHeapUsedMB - m1.JSHeapUsedMB),
    tailHeapMB: r1(m3.JSHeapUsedMB - m0.JSHeapUsedMB),
    nav2HeapMB: r1(m4.JSHeapUsedMB - m3.JSHeapUsedMB),
    navNodes: m2.Nodes - m1.Nodes, tailNodes: m3.Nodes - m0.Nodes,
    nav2Nodes: m4.Nodes - m3.Nodes,
    navListeners: m2.JSEventListeners - m1.JSEventListeners, tailListeners: m3.JSEventListeners - m0.JSEventListeners,
    nav2Listeners: m4.JSEventListeners - m3.JSEventListeners,
    navLayoutObjects: m2.LayoutObjects - m1.LayoutObjects,
  };
  log('增量: 做题后堆 ' + R.memory.delta.quizHeapMB + 'MB；切页后 ' + R.memory.delta.navHeapMB +
    'MB；GC 后相对初始 ' + R.memory.delta.tailHeapMB + 'MB；DOM 节点 切页' + R.memory.delta.navNodes +
    ' / 累计' + R.memory.delta.tailNodes + '；监听器 切页' + R.memory.delta.navListeners + ' / 累计' + R.memory.delta.tailListeners);
  log('第二轮 10 次切页净增（泄漏信号）: 节点 ' + R.memory.delta.nav2Nodes + ' / 监听器 ' + R.memory.delta.nav2Listeners +
    ' / 堆 ' + R.memory.delta.nav2HeapMB + 'MB');
  const peak = Math.max(m0.JSHeapUsedMB, m1.JSHeapUsedMB, m2.JSHeapUsedMB, m3.JSHeapUsedMB, m4.JSHeapUsedMB);
  check('memory', 'JS 堆未超 100MB（峰值 ' + peak + 'MB）', peak < 100);
  check('memory', '切页无持续增长：第 2 轮 10 次切页净增 节点 ' + R.memory.delta.nav2Nodes + ' / 监听器 ' + R.memory.delta.nav2Listeners,
    R.memory.delta.nav2Nodes < 200 && R.memory.delta.nav2Listeners < 50,
    '第 1 轮累计 ' + R.memory.delta.tailNodes + ' 节点（含做题残留的一次性 DOM，有界）→ 第 2 轮净增 ' +
    R.memory.delta.nav2Nodes + ' 节点 / ' + R.memory.delta.nav2Listeners + ' 监听器（每轮增量才是泄漏信号）');
  check('memory', 'GC 后堆相对初始 +8MB 以内（+' + R.memory.delta.tailHeapMB + 'MB）', R.memory.delta.tailHeapMB < 8);
  if (errs.length) R.consoleErrors = R.consoleErrors.concat(errs);
  await ctx.close();
}

/* ============================================================ 3. 视口 */

const VIEWPORTS = [
  { name: '1920x1080', w: 1920, h: 1080, touch: false, tag: '1920x1080-desktop-wide' },
  { name: '1366x768', w: 1366, h: 768, touch: false, tag: '1366x768-desktop' },
  { name: '768x1024', w: 768, h: 1024, touch: true, tag: '768x1024-tablet' },
  { name: '375x667', w: 375, h: 667, touch: true, tag: '375x667-iphoneSE' },
  { name: '390x844', w: 390, h: 844, touch: true, tag: '390x844-iphone12' },
  { name: '414x896', w: 414, h: 896, touch: true, tag: '414x896-iphoneXR' },
];

const OVERFLOW_SRC = function () {
  var de = document.documentElement, b = document.body, vw = window.innerWidth;
  var out = {
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    bodyScrollW: b.scrollWidth, bodyClientW: b.clientWidth,
    innerW: vw, offenders: [],
  };
  var all = document.querySelectorAll('body *');
  for (var i = 0; i < all.length && out.offenders.length < 12; i++) {
    var el = all[i];
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      out.offenders.push({
        tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
        left: Math.round(r.left), right: Math.round(r.right),
      });
    }
  }
  out.containers = ['#app', '.quiz-wrap', 'nav', 'header', '.passage', '.essay-ta'].map(function (sel) {
    var n = document.querySelector(sel);
    return n ? { sel: sel, scrollW: n.scrollWidth, clientW: n.clientWidth, w: Math.round(n.getBoundingClientRect().width) } : null;
  }).filter(Boolean);
  var navBtns = Array.prototype.slice.call(document.querySelectorAll('nav button'));
  var navEl = document.querySelector('nav');
  out.nav = {
    count: navBtns.length,
    tops: navBtns.map(function (x) { return Math.round(x.getBoundingClientRect().top); }),
    heights: navBtns.map(function (x) { return Math.round(x.getBoundingClientRect().height); }),
    navHeight: navEl ? Math.round(navEl.getBoundingClientRect().height) : 0,
    onCount: navBtns.filter(function (x) { return x.classList.contains('on'); }).length,
    clipped: navBtns.map(function (x) { return x.scrollWidth > x.clientWidth + 1; }),
    visible: navBtns.map(function (x) { var r = x.getBoundingClientRect(); return r.right <= vw + 1 && r.left >= -1; }),
  };
  var header = document.querySelector('header');
  var groups = [
    ['header', Array.prototype.slice.call(header ? header.children : [])],
    ['nav', Array.prototype.slice.call(document.querySelectorAll('nav button'))],
    ['qtop', Array.prototype.slice.call(document.querySelectorAll('.qtop > *'))],
    ['actions', Array.prototype.slice.call(document.querySelectorAll('.actions > *'))],
    ['row', Array.prototype.slice.call(document.querySelectorAll('.row > *'))],
    ['statGrid', Array.prototype.slice.call(document.querySelectorAll('.stat-grid > *'))],
    ['planItem', Array.prototype.slice.call(document.querySelectorAll('.plan-item'))],
  ];
  out.planItems = (function () {
    return Array.prototype.slice.call(document.querySelectorAll('.plan-item')).map(function (pi) {
      var btn = pi.querySelector('button');
      var ic = pi.querySelector('.ic');
      var bd = pi.querySelector('.bd');
      var rb = btn ? btn.getBoundingClientRect() : null;
      return {
        hasButton: !!btn,
        buttonRight: rb ? Math.round(rb.right) : -1,
        buttonVisible: rb ? rb.right <= window.innerWidth + 1 && rb.width > 20 : false,
        icW: ic ? Math.round(ic.getBoundingClientRect().width) : -1,
        bdW: bd ? Math.round(bd.getBoundingClientRect().width) : -1,
      };
    });
  })();
  out.overlaps = [];
  groups.forEach(function (g) {
    var els = g[1].filter(function (e) { return e && e.getBoundingClientRect().width > 0; });
    for (var i = 0; i < els.length; i++) {
      for (var j = i + 1; j < els.length; j++) {
        var a = els[i].getBoundingClientRect(), c = els[j].getBoundingClientRect();
        var ix = Math.min(a.right, c.right) - Math.max(a.left, c.left);
        var iy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
        if (ix > 2 && iy > 2) {
          out.overlaps.push({
            group: g[0],
            a: els[i].tagName.toLowerCase() + (els[i].className && typeof els[i].className === 'string' ? '.' + els[i].className.trim().split(/\s+/)[0] : ''),
            b: els[j].tagName.toLowerCase() + (els[j].className && typeof els[j].className === 'string' ? '.' + els[j].className.trim().split(/\s+/)[0] : ''),
            overlapPx: Math.round(Math.min(ix, iy)),
          });
        }
      }
    }
  });
  out.header = null;
  if (header) {
    var kids = Array.prototype.slice.call(header.children).map(function (k) {
      var r2 = k.getBoundingClientRect();
      return { tag: k.tagName.toLowerCase() + (k.id ? '#' + k.id : ''), left: Math.round(r2.left), right: Math.round(r2.right), top: Math.round(r2.top), bottom: Math.round(r2.bottom) };
    });
    var overlap = false;
    for (var i2 = 0; i2 < kids.length; i2++) {
      for (var j2 = i2 + 1; j2 < kids.length; j2++) {
        var a = kids[i2], c = kids[j2];
        if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) overlap = true;
      }
    }
    out.header = { kids: kids, overlap: overlap, rightOverflow: kids.some(function (k) { return k.right > vw + 1.5; }) };
  }
  return out;
};

const LISTEN_PLAN = [{
  key: 'listen-1', type: 'listening',
  qids: ['2020-07-1-l-1', '2020-07-1-l-2', '2020-07-1-l-3', '2020-07-1-l-4'],
  paperId: '2020-07-1', label: '听力·同卷连续4题', done: false, minutes: 0,
}];
const ESSAY_PLAN = [{ key: 'essay-x', type: 'writing', qids: [], paperId: '2020-07-1', done: false, minutes: 0 }];

async function sectionViewport(browser) {
  log('');
  log('================ 3. 多视口布局 ================');
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });
    const page = await ctx.newPage();
    const errs = [];
    const errDetails = [];
    page.on('pageerror', function (e) {
      errs.push(e.message);
      errDetails.push({ message: e.message, stack: String(e.stack || '').slice(0, 300) });
    });
    await page.addInitScript(function () { window.alert = function () {}; });
    const rec = { viewport: vp.name, w: vp.w, h: vp.h, touch: vp.touch, ok: true, problems: [] };
    try {
      await bootLoggedIn(page, '9303');
      await page.waitForTimeout(250);
      const home = await page.evaluate(OVERFLOW_SRC);
      rec.home = home;
      const shotHome = path.join(DOCS_DIR, 'viewport-' + vp.tag + '.png');
      await page.screenshot({ path: shotHome, fullPage: false });
      rec.screenshot = shotHome;

      // 横向滚动条
      const hScroll = home.docScrollW > home.docClientW + 0.5 || home.bodyScrollW > home.bodyClientW + 0.5;
      rec.hScroll = hScroll;
      if (hScroll) { rec.ok = false; rec.problems.push('存在横向滚动：doc ' + home.docScrollW + '>' + home.docClientW + ' / body ' + home.bodyScrollW + '>' + home.bodyClientW); }
      if (home.offenders.length) { rec.ok = false; rec.problems.push('元素越界 ' + home.offenders.length + ' 个：' + JSON.stringify(home.offenders.slice(0, 5))); }
      if (home.header && home.header.overlap) { rec.ok = false; rec.problems.push('顶栏元素重叠：' + JSON.stringify(home.header.kids)); }
      if (home.header && home.header.rightOverflow) { rec.ok = false; rec.problems.push('顶栏元素溢出右边界：' + JSON.stringify(home.header.kids)); }
      if (new Set(home.nav.tops).size > 1) { rec.ok = false; rec.problems.push('导航按钮基线不一致（疑似换行）：' + JSON.stringify(home.nav.tops)); }
      if (home.nav.clipped.some(Boolean)) { rec.ok = false; rec.problems.push('导航按钮文字被截断：' + JSON.stringify(home.nav.clipped)); }
      if (home.overlaps && home.overlaps.length) { rec.ok = false; rec.problems.push('元素重叠 ' + home.overlaps.length + ' 处：' + JSON.stringify(home.overlaps.slice(0, 5))); }
      if (home.planItems && home.planItems.some(function (x) { return !x.hasButton || !x.buttonVisible; })) {
        rec.ok = false; rec.problems.push('清单条目按钮缺失/越界：' + JSON.stringify(home.planItems));
      }

      // 答题区（真实清单里含选项的首组）
      const openedLabel = await openObjectiveCard(page);
      rec.quizOpenedLabel = openedLabel;
      await page.waitForTimeout(300);
      const quiz = await page.evaluate(OVERFLOW_SRC);
      const quizInner = await page.evaluate(function () {
        var wrap = document.querySelector('#quiz .quiz-wrap');
        var opts = Array.prototype.slice.call(document.querySelectorAll('#quizBody .opt'));
        var widest = 0;
        opts.forEach(function (o) { widest = Math.max(widest, Math.round(o.getBoundingClientRect().right)); });
        var qb = document.getElementById('quizBody');
        return {
          wrapScrollW: wrap ? wrap.scrollWidth : -1, wrapClientW: wrap ? wrap.clientWidth : -1,
          bodyScrollW: qb ? qb.scrollWidth : -1, bodyClientW: qb ? qb.clientWidth : -1,
          optCount: opts.length, widestOptRight: widest, vw: window.innerWidth,
          quizScrollW: document.getElementById('quiz').scrollWidth,
          overlapPairs: (function () {
            var bad = 0;
            for (var i = 0; i < opts.length - 1; i++) {
              var a = opts[i].getBoundingClientRect(), b = opts[i + 1].getBoundingClientRect();
              if (a.top < b.bottom - 1 && b.top < a.bottom - 1 && a.left < b.right - 1 && b.left < a.right - 1) bad++;
            }
            return bad;
          })(),
        };
      });
      rec.quiz = { layout: quiz, inner: quizInner };
      const shotQuiz = path.join(DOCS_DIR, 'viewport-' + vp.tag + '-quiz.png');
      await page.screenshot({ path: shotQuiz, fullPage: false });
      rec.screenshotQuiz = shotQuiz;
      if (quiz.docScrollW > quiz.docClientW + 0.5) { rec.ok = false; rec.problems.push('答题页横向滚动 ' + quiz.docScrollW + '>' + quiz.docClientW); }
      if (quizInner.wrapScrollW > quizInner.wrapClientW + 1) { rec.ok = false; rec.problems.push('答题区容器溢出 ' + quizInner.wrapScrollW + '>' + quizInner.wrapClientW); }
      if (quizInner.widestOptRight > quizInner.vw + 1.5) { rec.ok = false; rec.problems.push('选项按钮越界 right=' + quizInner.widestOptRight + ' > vw=' + quizInner.vw); }
      if (quizInner.overlapPairs) { rec.ok = false; rec.problems.push('相邻选项按钮重叠 ' + quizInner.overlapPairs + ' 对'); }
      if (quiz.overlaps && quiz.overlaps.length) { rec.ok = false; rec.problems.push('答题页元素重叠 ' + quiz.overlaps.length + ' 处：' + JSON.stringify(quiz.overlaps.slice(0, 5))); }
      if (!quizInner.optCount) { rec.ok = false; rec.problems.push('打开的题组没有任何 .opt（视口断言落空，openedLabel=' + openedLabel + '）'); }

      // touch 交互
      // 注意：不要用 page.touchscreen.tap(box.x, box.y) 这种裸坐标点击。
      // #quiz 是 position:fixed 的全屏浮层，题目内容在自己的 .quiz-wrap 里滚动；
      // 当首个 .opt 位于浮层内部滚动区的下方时，boundingBox() 会给出一个
      // 远大于视口高度的 y（实测 375x667 下 y=3799），这个坐标已经落在浏览器视口之外，
      // 点击必然落空 —— 于是把"功能正常"误判成"触屏点选未生效"。
      // locator.tap() 会先滚动到可视区（能正确处理嵌套滚动容器）再派发真实触摸事件。
      if (vp.touch) {
        const opt = page.locator('#quizBody .opt').first();
        let tapVia = '';
        try {
          await opt.scrollIntoViewIfNeeded({ timeout: 8000 });
          await opt.tap({ timeout: 10000 });
          tapVia = 'locator.tap';
        } catch (e) {
          // 兜底：滚动到可视区后再按坐标补一次触摸点击
          await opt.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(function () {});
          const box = await opt.boundingBox().catch(function () { return null; });
          if (box) {
            await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2).catch(function () {});
            tapVia = 'touchscreen.tap(兜底)';
          } else {
            tapVia = '未能取到元素位置：' + String(e.message || e).split('\n')[0].slice(0, 90);
          }
        }
        await page.waitForTimeout(150);
        const sel = await page.locator('#quizBody .opt.sel').count();
        rec.touchTapSelected = sel;
        rec.touchTapVia = tapVia;
        if (!sel) { rec.ok = false; rec.problems.push('touch 点选未生效（方式=' + tapVia + '）'); }
      }
      // 退出做题
      await page.locator('#quizBack').click();
      await page.waitForSelector('#quiz', { state: 'hidden', timeout: 15000 }).catch(function () {});

      // 写作 textarea 可用性
      await seedState(page, '9303', EMPTY_STATE_SRC, ESSAY_PLAN);
      await reloadApp(page);
      await page.locator('#planList .card button').first().click();
      await page.waitForSelector('#quizBody #essayTa', { timeout: 20000 });
      await page.locator('#essayTa').fill('viewport audit essay text');
      const ta = await page.evaluate(function () {
        var t = document.getElementById('essayTa');
        var r = t.getBoundingClientRect();
        return { w: Math.round(r.width), right: Math.round(r.right), vw: window.innerWidth, scrollW: t.scrollWidth, clientW: t.clientWidth, value: t.value.length };
      });
      rec.essay = ta;
      const shotEssay = path.join(DOCS_DIR, 'viewport-' + vp.tag + '-essay.png');
      await page.screenshot({ path: shotEssay, fullPage: false });
      rec.screenshotEssay = shotEssay;
      if (ta.w < 100 || ta.right > ta.vw + 1.5) { rec.ok = false; rec.problems.push('写作 textarea 宽度异常 ' + JSON.stringify(ta)); }
      if (ta.scrollW > ta.clientW + 1) { rec.ok = false; rec.problems.push('写作 textarea 横向溢出'); }
      if (ta.value !== 'viewport audit essay text'.length) { rec.ok = false; rec.problems.push('写作 textarea 输入未生效'); }
      await page.locator('#quizBack').click();
      await page.waitForSelector('#quiz', { state: 'hidden', timeout: 15000 }).catch(function () {});

      // 听力播放器自适应。
      // 注意：听力早已不是"内嵌第三方 iframe"，而是站内 <audio> 播放器（.listen-player + .lp-piece 分片条
      // + .lp-fallback 兜底），只有没烘焙音频的卷才回退 iframe。旧断言只找 `#quiz iframe`，
      // 在播放器路径下必然判"听力 iframe 未渲染"（假红）。这里两种形态都接受，并统一量宽度。
      await seedState(page, '9303', EMPTY_STATE_SRC, LISTEN_PLAN);
      await reloadApp(page);
      await page.locator('#planList .card button').first().click();
      await page.waitForSelector('#quiz.show', { timeout: 25000 }).catch(function () {});
      await page.waitForFunction(function () {
        return document.querySelector('#quiz .listen-player audio') || document.querySelector('#quiz iframe');
      }, null, { timeout: 25000 }).catch(function () {});
      const listen = await page.evaluate(function () {
        var out = { player: false, audio: false, iframe: false, pieces: 0, fallback: false };
        var box = document.querySelector('#quiz .listen-player');
        var f = document.querySelector('#quiz iframe');
        var el = (box && box.querySelector('audio')) || document.querySelector('#quiz audio');
        if (box) { out.player = true; out.pieces = box.querySelectorAll('.lp-piece').length; out.fallback = !!box.querySelector('.lp-fallback'); }
        if (f) out.iframe = true;
        var target = el || f;
        if (el) out.audio = true;
        if (target) {
          var r = target.getBoundingClientRect();
          var p = target.parentElement.getBoundingClientRect();
          out.w = Math.round(r.width); out.right = Math.round(r.right);
          out.parentW = Math.round(p.width); out.scrollW = target.scrollWidth;
        }
        out.vw = window.innerWidth;
        return out;
      });
      rec.listening = listen;
      if (!listen.player && !listen.iframe) {
        rec.ok = false; rec.problems.push('听力播放器未渲染（.listen-player 与 iframe 都不存在）');
      } else {
        if (listen.right > listen.vw + 1.5) { rec.ok = false; rec.problems.push('听力播放器越界 ' + listen.right + '>' + listen.vw); }
        if (listen.w > listen.parentW + 1) { rec.ok = false; rec.problems.push('听力播放器宽于容器 ' + listen.w + '>' + listen.parentW); }
      }
      const shotListen = path.join(DOCS_DIR, 'viewport-' + vp.tag + '-listening.png');
      await page.screenshot({ path: shotListen, fullPage: false });
      rec.screenshotListening = shotListen;
      await page.locator('#quizBack').click();
      await page.waitForSelector('#quiz', { state: 'hidden', timeout: 15000 }).catch(function () {});

      // 深色模式截图（仅手机视口，避免截图过多）
      if (vp.w <= 414) {
        const dark = await toggleTheme(page);
        rec.dark = dark;
        const shotDark = path.join(DOCS_DIR, 'viewport-' + vp.tag + '-dark.png');
        await page.screenshot({ path: shotDark, fullPage: false });
        rec.screenshotDark = shotDark;
        await toggleTheme(page);
        if (!dark) { rec.ok = false; rec.problems.push('深色模式切换无效'); }
      }
      rec.errors = errs;
      const cls = classifyErrors(errDetails);
      rec.selfErrors = cls.self;
      rec.externalFrameErrors = cls.external;
      if (cls.self.length) { rec.ok = false; rec.problems.push('应用自身页面错误：' + cls.self.map(function (d) { return d.message; }).join(' | ')); }
      if (cls.external.length) {
        note(vp.name + ' 检出第三方听力页脚本异常 ' + cls.external.length + ' 条（非应用代码）：' + cls.external.map(function (d) { return d.message; }).join(' ;; '));
      }
    } catch (e) {
      rec.ok = false;
      rec.problems.push('异常：' + String(e && e.message || e));
    }
    R.viewport[vp.name] = rec;
    log((rec.ok ? 'ok   ' : 'FAIL ') + '[viewport] ' + vp.name + ' 布局' + (rec.ok ? '正常' : '有问题: ' + rec.problems.join(' ;; ')));
    await ctx.close();
  }
  const failed = Object.keys(R.viewport).filter(function (k) { return !R.viewport[k].ok; });
  check('viewport', '6 个视口布局全部通过', failed.length === 0, failed.length ? '未通过: ' + failed.join(',') : '截图已存 docs/viewport-*.png');
}

/* ============================================================ 4. 浏览器 */

async function runCompat(execPath, label) {
  const ctxBundle = {};
  const browser = await chromium.launch({ executablePath: execPath, args: LAUNCH_ARGS, headless: !HEADED });
  const res = { label: label, exe: execPath, version: browser.version() };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];      // JS 异常 → 硬失败
  const errDetails = [];
  const consoleErrs = []; // 控制台报错（含外部 iframe 资源失败）→ 仅记录
  page.on('pageerror', function (e) {
    errs.push('pageerror: ' + e.message);
    errDetails.push({ message: e.message, stack: String(e.stack || '').slice(0, 400) });
  });
  page.on('console', function (m) { if (m.type() === 'error') consoleErrs.push(m.text()); });
  await page.addInitScript(function () { window.alert = function () {}; });
  try {
    await bootLoggedIn(page, '9304');
    res.render = await page.evaluate(function () {
      var M = window.CET6_META || {};
      var preloaded = 0;
      Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) {
        if (/(?:^|\/)bank\/cet6-[^/]*\.js(\?|$)/.test(s.getAttribute('src') || '')) preloaded++;
      });
      return {
        banks: (window.CET6_BANKS || []).length,
        questions: (window.CET6_BANKS || []).reduce(function (a, b) { return a + (b.questions || []).length; }, 0),
        // 按需加载：首屏 BANKS 恒为空，判"清单就绪"看 meta 骨架，判"没预载"看 DOM 里的卷脚本数
        metaOrder: (M.order || []).length,
        preloadedPapers: preloaded,
        planCards: document.querySelectorAll('#planList .card').length,
        hasCore: !!window.CET6Core,
        todayLabel: (document.getElementById('todayLabel') || {}).textContent || '',
      };
    });
    res.renderOk = res.render.metaOrder >= 76 && res.render.preloadedPapers === 0 &&
      res.render.planCards >= 1 && res.render.hasCore;

    // localStorage 读写
    res.localStorage = await page.evaluate(function () {
      var k = 'cet6_audit_probe';
      localStorage.setItem(k, 'v1');
      var v = localStorage.getItem(k);
      var stateKey = window.CET6Core.stateKey('9304');
      var hasState = !!localStorage.getItem(stateKey);
      localStorage.removeItem(k);
      return { roundTrip: v === 'v1', hasState: hasState, userKey: localStorage.getItem('cet6_user') };
    });
    res.localStorageOk = res.localStorage.roundTrip && res.localStorage.hasState;

    // 答题交互 + 判分（用"含选项"的未完成卡，避免选中选词填空卡导致 answered=0、提交按钮恒 disabled）
    const openedLabel = await openObjectiveCard(page).catch(function () { return null; });
    res.openedLabel = openedLabel;
    if (!openedLabel) throw new Error('清单中没有可开启的题组（planCards=' + res.render.planCards + '）');
    const isEssay = await page.locator('#essayTa').count();
    if (isEssay) {
      await page.locator('#essayTa').fill('compat essay');
      res.interaction = { type: 'essay', typed: (await page.locator('#essayTa').inputValue()).length };
      res.interactionOk = res.interaction.typed > 0;
      await page.locator('#essayDone').click();
    } else {
      const answered = await answerGroup(page);
      const submitOk = await submitGroup(page);
      await page.waitForSelector('#groupBar', { timeout: 20000 }).catch(function () {});
      const bar = (await page.locator('#groupBar').textContent().catch(function () { return ''; })) || '';
      res.interaction = { type: 'objective', answered: answered, submitted: submitOk, result: bar.replace(/\s+/g, ' ').trim().slice(0, 60), judged: /答对/.test(bar) };
      res.interactionOk = res.interaction.judged;
      if (await page.locator('#groupDone').count()) {
        await page.locator('#groupDone').click({ timeout: 10000 }).catch(function () {});
      }
    }
    await page.waitForSelector('#quiz', { state: 'hidden', timeout: 15000 }).catch(function () {});

    // 深色模式（toggleTheme 会先确保 #quiz 浮层已关，避免被浮层挡住点不到）
    await toggleTheme(page);
    res.dark = await page.evaluate(function () {
      var cs = getComputedStyle(document.body);
      return { cls: document.body.classList.contains('dark'), bg: cs.backgroundColor, pref: localStorage.getItem('cet6_theme') };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#planList .card', { timeout: 25000 }).catch(function () {});
    res.darkPersist = await page.evaluate(function () { return document.body.classList.contains('dark'); });
    res.darkOk = res.dark.cls && res.dark.bg === 'rgb(15, 23, 42)' && res.darkPersist;
    await toggleTheme(page);

    // 导航四页遍历
    const navErrBefore = errs.length;
    for (const p of ['wrong', 'stat', 'backup', 'today']) {
      await page.locator('nav button[data-p="' + p + '"]').click();
      await page.waitForTimeout(150);
    }
    res.navOk = errs.length === navErrBefore;

    // 对照：阻断全部 http(s) 请求（= 第三方听力页不可达）后重开，断言主页自身零异常
    const page2 = await ctx.newPage();
    const errs2 = [];
    const detail2 = [];
    page2.on('pageerror', function (e) { errs2.push(e.message); detail2.push(String(e.stack || '').slice(0, 300)); });
    await page2.route(/^https?:\/\//, function (r) { return r.abort(); });
    await page2.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('#planList .card', { timeout: 30000 });
    if (await page2.locator('#planList .card:not(.done)').count()) {
      await page2.locator('#planList .card:not(.done)').first().locator('button').first().click();
      await page2.waitForSelector('#quiz.show', { timeout: 20000 }).catch(function () {});
      await page2.waitForTimeout(2500);
    }
    res.blockedThirdParty = { errors: errs2, details: detail2, clean: errs2.length === 0 };

    // 第三方听力页加载情况（用于归因 pageerror 来源）
    res.frames = page.frames().map(function (f) { return f.url(); }).filter(function (u) { return u.indexOf('file:') !== 0 && u !== 'about:blank'; });
    const extFrame = page.frames().find(function (f) { return /lazynote/i.test(f.url()); });
    if (extFrame) {
      res.thirdPartyProbe = await extFrame.evaluate(function () {
        return { title: document.title, hasAudio: !!document.querySelector('audio'), hasPlay: !!document.querySelector('.lab__play') };
      }).catch(function (e) { return 'evalErr: ' + String(e && e.message || e).slice(0, 120); });
    } else {
      res.thirdPartyProbe = 'frame-not-loaded';
    }
  } catch (e) {
    res.fatal = String(e && e.message || e);
  }
  res.errors = errs;
  res.errorDetails = errDetails;
  res.consoleErrors = consoleErrs;
  // 归因：堆栈中带 http(s) URL 的异常来自内嵌第三方听力页，与应用自身代码无关
  const isExt = function (d) { return isExternalStack(d); };
  res.selfErrors = errDetails.filter(function (d) { return !isExt(d); });
  res.externalFrameErrors = errDetails.filter(isExt);
  res.ok = !res.fatal && res.renderOk && res.localStorageOk && res.interactionOk && res.darkOk && res.selfErrors.length === 0;
  await browser.close();
  return res;
}

async function sectionBrowser() {
  log('');
  log('================ 4. 主流浏览器兼容 ================');
  const CANDIDATES = [
    { label: 'Edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { label: 'Edge', exe: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
    { label: 'Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { label: 'Chrome', exe: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  ];
  const seen = {};
  for (const c of CANDIDATES) {
    if (seen[c.label]) continue;
    if (!fs.existsSync(c.exe)) continue;
    seen[c.label] = true;
    log('-- 测试 ' + c.label + ' (' + c.exe + ')');
    let res;
    try { res = await runCompat(c.exe, c.label); }
    catch (e) { res = { label: c.label, exe: c.exe, ok: false, fatal: String(e && e.message || e) }; }
    R.browser[c.label] = res;
    log(JSON.stringify(res).slice(0, 1400));
    check('browser', c.label + ' 兼容性（渲染/交互/localStorage/深色）', res.ok,
      res.fatal ? 'fatal: ' + res.fatal : ('version=' + (res.version || '?') +
        ' meta=' + (res.render && res.render.metaOrder) + ' 预载卷=' + (res.render && res.render.preloadedPapers) +
        ' 自身异常=' + ((res.selfErrors || []).length)));
    if ((res.externalFrameErrors || []).length) {
      note(c.label + ' 检出第三方听力页(english-exam.lazynote.cn)自身脚本异常 ' + res.externalFrameErrors.length +
        ' 条（非应用代码）：' + res.externalFrameErrors.map(function (d) { return d.message; }).join(' ;; '));
    }
    if (!res.ok && (res.selfErrors || []).length) {
      log('   ' + c.label + ' 自身异常明细: ' + JSON.stringify(res.selfErrors));
    }
    if (res.blockedThirdParty) {
      check('browser', c.label + ' 阻断第三方资源后主页零异常（对照）', res.blockedThirdParty.clean,
        res.blockedThirdParty.clean ? 'clean' : JSON.stringify(res.blockedThirdParty.details));
    }
  }
  if (Object.keys(R.browser).length < 2) {
    note('本机仅探测到 ' + Object.keys(R.browser).join('+') + '，未覆盖另一内核；结论仅代表已测浏览器');
  }
}

/* ============================================================ 5. 流畅度 */

async function sectionFluency(browser) {
  log('');
  log('================ 5. 交互流畅度 ================');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', function (e) { errs.push('pageerror: ' + e.message); });
  await page.addInitScript(function () { window.alert = function () {}; });
  const client = await ctx.newCDPSession(page);
  await bootLoggedIn(page, '9305');

  // 首组题
  // 注意：计划首卡可能是"选词填空"（UI 是词库 .wb-chip + 段落空格 .cloze-slot，没有 .opt）。
  // 旧写法无脑点第一张卡，随后整套采样都建立在 document.querySelectorAll('#quizBody .opt') 之上：
  // 选项数为 0 → 一道题都答不上 → #groupSubmit 因"还有 N 题未作答"被拒 → 提交耗时恒为 -1ms、
  // MutationObserver 永远等不到结果条。这里显式挑一张客观题卡，保证采样口径成立。
  let perfCardLabel = null;
  {
    const cards = page.locator('#planList .card:not(.done)');
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const btn = cards.nth(i).locator('button').first();
      if (((await btn.textContent()) || '').trim() !== '开始') continue;
      const label = ((await cards.nth(i).locator('b').first().textContent()) || '').trim();
      if (/选词填空|写作|翻译/.test(label)) continue;
      await btn.click();
      await page.waitForFunction(function () {
        var q = document.getElementById('quiz');
        return !!q && q.classList.contains('show') && document.querySelectorAll('#quizBody .opt').length > 0;
      }, null, { timeout: 25000 }).catch(function () {});
      perfCardLabel = label;
      break;
    }
  }
  await page.waitForSelector('#quiz.show', { timeout: 25000 });
  await page.waitForTimeout(200);
  check('fluency', '流畅度采样前确认已进入含选项的题组（' + perfCardLabel + '）',
    await page.evaluate(function () { return document.querySelectorAll('#quizBody .opt').length > 0; }));

  // (a) 点击选项 → 视觉反馈
  const clickTimes = [];
  for (let i = 0; i < 8; i++) {
    const t = await page.evaluate(function (idx) {
      var opts = Array.prototype.slice.call(document.querySelectorAll('#quizBody .opt'));
      if (!opts.length) return null;
      var b = opts[idx % opts.length];
      var t0 = performance.now();
      b.click();
      var t1 = performance.now();
      return { sync: t1 - t0, hadSel: b.classList.contains('sel') };
    }, i);
    if (t) clickTimes.push(t);
  }
  // 真实鼠标点击路径（含事件派发 + 渲染）
  const realClick = await page.evaluate(function () {
    return new Promise(function (resolve) {
      var b = document.querySelector('#quizBody .opt:not(.sel)') || document.querySelector('#quizBody .opt');
      if (!b) return resolve(null);
      var t0 = performance.now();
      var mo = new MutationObserver(function () {
        if (b.classList.contains('sel')) { mo.disconnect(); resolve(performance.now() - t0); }
      });
      mo.observe(b, { attributes: true, attributeFilter: ['class'] });
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      setTimeout(function () { mo.disconnect(); resolve(-1); }, 2000);
    });
  });
  // 真实 Playwright 点击 + 双击确认（含浏览器输入管线）
  const pwClickStart = Date.now();
  const target = page.locator('#quizBody .opt:not(.sel)').first();
  if (await target.count()) await target.click().catch(function () {});
  const pwClickMs = Date.now() - pwClickStart;
  R.fluency.optionClick = {
    syncHandlerTimes: clickTimes.map(function (x) { return r3(x.sync); }),
    syncAvg: r3(avg(clickTimes.map(function (x) { return x.sync; }))),
    syncMax: r3(Math.max.apply(null, clickTimes.map(function (x) { return x.sync; }))),
    allSelected: clickTimes.every(function (x) { return x.hadSel; }),
    domFeedbackMs: r3(realClick),
    playwrightClickMs: pwClickMs,
  };
  check('fluency', '点选选项 → 视觉反馈 < 100ms（DOM 反馈 ' + r3(realClick) + 'ms，同步处理均值 ' + R.fluency.optionClick.syncAvg + 'ms）',
    realClick >= 0 && realClick < 100 && R.fluency.optionClick.syncAvg < 100);
  await page.screenshot({ path: path.join(DOCS_DIR, 'perf-quiz-clicked.png'), fullPage: false });

  // (b) 提交判分
  await page.evaluate(function () {
    document.querySelectorAll('#quizBody .opt').forEach(function (b) {
      var q = b.getAttribute('data-q');
      if (!document.querySelector('#quizBody .opt[data-q="' + q + '"].sel')) b.click();
    });
  });
  const submitMs = await page.evaluate(function () {
    return new Promise(function (resolve) {
      var btn = document.getElementById('groupSubmit');
      if (!btn) return resolve(null);
      var t0 = performance.now();
      var mo = new MutationObserver(function () {
        if (document.querySelector('#groupBar .btn.ok')) {
          mo.disconnect();
          var t1 = performance.now();
          requestAnimationFrame(function () { requestAnimationFrame(function () { resolve({ sync: t1 - t0, painted: performance.now() - t0 }); }); });
        }
      });
      mo.observe(document.getElementById('quizBody'), { childList: true, subtree: true });
      btn.click();
      setTimeout(function () { mo.disconnect(); resolve({ sync: -1, painted: -1 }); }, 3000);
    });
  });
  const resultTxt = ((await page.locator('#groupBar').textContent().catch(function () { return ''; })) || '').replace(/\s+/g, ' ').trim();
  R.fluency.submit = { syncMs: r3(submitMs.sync), paintedMs: r3(submitMs.painted), result: resultTxt.slice(0, 80) };
  check('fluency', '提交判分 → 结果展示 < 500ms（逻辑 ' + r3(submitMs.sync) + 'ms，含绘制 ' + r3(submitMs.painted) + 'ms）',
    submitMs.sync >= 0 && submitMs.painted >= 0 && submitMs.painted < 500);
  await page.screenshot({ path: path.join(DOCS_DIR, 'perf-quiz-result.png'), fullPage: false });
  await page.locator('#groupDone').click().catch(function () {});

  // (c) 页面切换响应（逻辑同步耗时 + 含绘制的端到端耗时）
  const navTimes = {};
  for (const p of ['wrong', 'stat', 'backup', 'today', 'wrong', 'stat', 'backup', 'today']) {
    const r = await page.evaluate(function (target) {
      return new Promise(function (resolve) {
        var btn = document.querySelector('nav button[data-p="' + target + '"]');
        var t0 = performance.now();
        btn.click();
        var t1 = performance.now();
        requestAnimationFrame(function () { requestAnimationFrame(function () { resolve({ sync: t1 - t0, painted: performance.now() - t0 }); }); });
      });
    }, p);
    navTimes[p] = navTimes[p] || { sync: [], painted: [] };
    navTimes[p].sync.push(r3(r.sync));
    navTimes[p].painted.push(r3(r.painted));
  }
  const navSync = Object.keys(navTimes).reduce(function (a, k) { return a.concat(navTimes[k].sync); }, []);
  const navPainted = Object.keys(navTimes).reduce(function (a, k) { return a.concat(navTimes[k].painted); }, []);
  R.fluency.navSwitch = {
    perPage: navTimes,
    syncAvg: r3(avg(navSync)), syncMax: r3(Math.max.apply(null, navSync)),
    paintedAvg: r3(avg(navPainted)), paintedMax: r3(Math.max.apply(null, navPainted)),
  };
  check('fluency', '页面切换（点击→绘制完成）< 100ms（逻辑均值 ' + R.fluency.navSwitch.syncAvg + 'ms，含绘制均值 ' +
    R.fluency.navSwitch.paintedAvg + 'ms / 最大 ' + R.fluency.navSwitch.paintedMax + 'ms）',
    R.fluency.navSwitch.syncMax < 100 && R.fluency.navSwitch.paintedMax < 100);

  // (d) 500+ 错题渲染
  await seedState(page, '9305', 'function (C, today, banks) { return (function () {' +
    'var st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null, hl: {} };' +
    'var ids = [];' +
    'banks.forEach(function (b) { (b.questions || []).forEach(function (q) { ids.push(q.id); }); });' +
    'ids = ids.slice(0, 520);' +
    'ids.forEach(function (id, i) {' +
    '  st.papers[id] = { seen: 2, wrong: 1, right: 1, lastAt: today, lastResult: "wrong" };' +
    '  st.wrongbook[id] = { addedAt: today, box: 0, wrongCount: 1 + (i % 3), ease: 1.3 + (i % 10) / 20, streak: 0, iv: 1, due: C.addDays(today, -(i % 5)) };' +
    '});' +
    'return st; })(); }', null);
  const tBig = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await page.waitForSelector('#planList', { state: 'attached', timeout: 30000 });
  const bootBigMs = Date.now() - tBig;
  await page.waitForFunction(function () { return document.querySelectorAll('#dueList .wb-item').length > 0; }, { timeout: 30000 }).catch(function () {});
  const bootBigMs2 = Date.now() - tBig;
  await page.waitForTimeout(200);
  const wrongN = await page.evaluate(function () { return Object.keys(JSON.parse(localStorage.getItem(window.CET6Core.stateKey('9305'))).wrongbook).length; });
  const wrongMs = await page.evaluate(function () {
    var t0 = performance.now();
    document.querySelector('nav button[data-p="wrong"]').click();
    var t1 = performance.now();
    return { renderMs: t1 - t0, rows: document.querySelectorAll('#allWrongList .wb-item').length + document.querySelectorAll('#dueList .wb-item').length };
  });
  const paintMs = await page.evaluate(function () {
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(performance.now()); }); }); });
  });
  R.fluency.wrongBook500 = {
    injected: wrongN, renderMs: r3(wrongMs.renderMs), rowsRendered: wrongMs.rows,
    bootWithBigStateMs: bootBigMs, bootSettledMs: bootBigMs2,
  };
  log('500+ 错题本: 注入 ' + wrongN + ' 题, 启动(commit→容器) ' + bootBigMs + 'ms, 切换到错题页渲染 ' + r3(wrongMs.renderMs) + 'ms, 行数 ' + wrongMs.rows);
  check('fluency', '500+ 错题本渲染 < 1000ms（' + r3(wrongMs.renderMs) + 'ms，注入 ' + wrongN + ' 题）', wrongMs.renderMs < 1000);
  check('fluency', '500+ 错题状态启动 < 3s（' + bootBigMs + 'ms）', bootBigMs < 3000);
  await page.screenshot({ path: path.join(DOCS_DIR, 'perf-wrongbook-500.png'), fullPage: false });

  // (e) 300+ 天历史 → 热力图
  await seedState(page, '9305', 'function (C, today, banks) { return (function () {' +
    'var st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null, hl: {} };' +
    'for (var i = 0; i < 400; i++) {' +
    '  var d = C.addDays(today, -i);' +
    '  st.history[d] = { minutes: 20 + (i % 25), done: i % 3 !== 0, floor: i % 7 === 0, qCount: 20, right: 15, timed: 2, timedWithin: 1, timedSec: 300 };' +
    '}' +
    'return st; })(); }', null);
  await reloadApp(page, false);
  await page.waitForTimeout(200);
  const histN = await page.evaluate(function () { return Object.keys(JSON.parse(localStorage.getItem(window.CET6Core.stateKey('9305'))).history).length; });
  const statMs = await page.evaluate(function () {
    var t0 = performance.now();
    document.querySelector('nav button[data-p="stat"]').click();
    var t1 = performance.now();
    return { renderMs: t1 - t0, heatCells: document.querySelectorAll('#heatmap i').length, statCells: document.querySelectorAll('#statGrid .stat-cell').length };
  });
  R.fluency.stat400 = { injectedDays: histN, renderMs: r3(statMs.renderMs), heatCells: statMs.heatCells, statCells: statMs.statCells };
  log('400 天历史热力图渲染: 注入 ' + histN + ' 天, 渲染耗时 ' + r3(statMs.renderMs) + 'ms, 格子 ' + statMs.heatCells);
  check('fluency', '300+ 天历史热力图渲染 < 500ms（' + r3(statMs.renderMs) + 'ms，注入 ' + histN + ' 天）', statMs.renderMs < 500);
  await page.screenshot({ path: path.join(DOCS_DIR, 'perf-stat-400d.png'), fullPage: false });

  const mAfter = memBrief(await memSnapshot(client));
  R.fluency.heapAfterBigData = mAfter.JSHeapUsedMB;
  if (errs.length) R.consoleErrors = R.consoleErrors.concat(errs);
  check('fluency', '大数据量场景零页面错误', errs.length === 0, errs.join(' | ') || 'none');
  await ctx.close();
}

/* ============================================================ main */

(async function main() {
  if (!EXE) {
    console.error('未探测到本机浏览器（Edge/Chrome），无法执行；请在 _env.js 中配置 CET6_BROWSER。');
    process.exit(2);
  }
  log('浏览器可执行文件: ' + EXE);
  log('应用地址: ' + APP_URL);
  log('开始时间: ' + R.meta.startedAt);
  const browser = await launch();
  R.meta.browserVersion = browser.version();
  R.meta.headless = !HEADED;
  try {
    if (WANT('perf')) await sectionPerf(browser);
    if (WANT('memory')) await sectionMemory(browser);
    if (WANT('viewport')) await sectionViewport(browser);
  } catch (e) {
    R.meta.fatal = String(e && e.stack || e);
    log('!! 段落异常: ' + R.meta.fatal);
  }
  await browser.close();

  if (WANT('browser')) {
    try { await sectionBrowser(); }
    catch (e) { R.browser.__fatal = String(e && e.stack || e); log('!! 浏览器兼容段落异常: ' + R.browser.__fatal); }
  }
  if (WANT('fluency')) {
    try {
      const b2 = await launch();
      await sectionFluency(b2);
      await b2.close();
    } catch (e) {
      R.fluency.__fatal = String(e && e.stack || e);
      log('!! 流畅度段落异常: ' + R.fluency.__fatal);
    }
  }

  const fails = R.checks.filter(function (c) { return !c.ok; });
  R.meta.finishedAt = new Date().toISOString();
  R.meta.okCount = R.checks.length - fails.length;
  R.meta.failCount = fails.length;
  log('');
  log('==== 汇总: ' + R.meta.okCount + ' ok / ' + R.meta.failCount + ' fail ====');
  const fatals = [R.meta.fatal, R.browser.__fatal, R.fluency.__fatal].filter(Boolean);
  fatals.forEach(function (f) { log('FATAL ' + String(f).split('\n')[0]); });
  fails.forEach(function (f) { log('FAIL [' + f.group + '] ' + f.name + ' | ' + f.detail); });
  fs.writeFileSync(OUT_JSON, JSON.stringify(R, null, 2), 'utf8');
  log('结果已写入 ' + OUT_JSON);

  /* 退出码（防空绿）。此前这里恒 process.exit(0)：实测出现过"区段抛 fatal、有 FAIL，
     退出码仍是 0"，run_all 里被判成 PASS。以下四种一律判失败。 */
  const bad = [];
  if (fatals.length) bad.push('段落异常 ' + fatals.length + ' 处');
  if (R.checks.length === 0) bad.push('0 断言：脚本未做任何校验');
  else if (R.checks.length < 20) bad.push('断言总数 ' + R.checks.length + ' < 下限 20');
  if (fails.length) bad.push(fails.length + ' 条断言失败');
  if (bad.length) { log('GATE FAIL: ' + bad.join('；')); process.exit(1); }
  process.exit(0);
})();
