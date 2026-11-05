// Firefox 兼容性实测
// 背景：本机 stock Firefox 无法被 playwright-core 驱动（无 Juggler 协议）。
// 本脚本改用 playwright 官方 Firefox 构建做真实兼容性验证。
// 准备：cd scripts ; npm i playwright ; npx playwright install firefox
// 运行：node test_firefox_playwright.js
// 2026-11-05：原来只打印 JSON、不做判定，被 run_all 判 0 断言（NO-ASSERT）。
//             现改为把观测值落成断言；未装 playwright 时明确输出 SKIP（不是"通过"）。
const path = require('path');
const { pathToFileURL } = require('url');
let playwright = null;
try { playwright = require('playwright'); } catch (e) { console.log('PLAYWRIGHT_MISSING: ' + e.message); process.exit(2); }

let ok = 0, fail = 0;
function t(name, pass, detail) {
  if (pass) ok++; else fail++;
  console.log((pass ? 'ok   ' : 'FAIL ') + ' - ' + name + (detail !== undefined && detail !== '' ? '  → ' + detail : ''));
  return pass;
}

// 2026-10-08：原来是写死的 'file:///D:/CET6/app/index.html' 与 'D:\\CET6\\docs'，
// 换台机器或上 CI 必然指向不存在的盘符。改成按脚本位置推导。
const ROOT = path.join(__dirname, '..');
const URL = pathToFileURL(path.join(ROOT, 'app', 'index.html')).href;
const DOCS = path.join(ROOT, 'docs');

/* 夹具：显式给一个「阅读选择题」题组。
   默认清单的首张卡常常是选词填空（只有 .cloze-slot，没有 .opt），
   直接拿它验「选项渲染/点选/深色对比度」会全盘落空。 */
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
const PLANV = Number((/\bPLAN_VERSION\s*=\s*(\d+)/.exec(
  require('fs').readFileSync(path.join(ROOT, 'app', 'core.js'), 'utf8')) || [])[1]);
const SEED = {
  version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, hl: {}, lastBackup: '',
  plan: {
    date: TODAY, v: PLANV,
    items: [{ key: 'ff-read', type: 'reading', qids: ['2026-06-1-r-46'], paperId: '2026-06-1', label: '阅读 R46', done: false, minutes: 0 }],
  },
};

(async () => {
  const out = { engine: 'firefox', build: null };
  const br = await playwright.firefox.launch({ headless: true });
  out.build = br.version();
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 160)); });
  await page.addInitScript((seed) => {
    try {
      localStorage.setItem('cet6_user', '9911');
      localStorage.setItem('cet6_p1_state_v1_9911', seed);
    } catch (e) { }
  }, JSON.stringify(SEED));

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => { const e = document.getElementById('todayLabel'); return !!e && e.textContent.length === 10; }, null, { timeout: 60000 });
  out.initMs = Date.now() - t0;
  out.ua = await page.evaluate(() => navigator.userAgent);
  out.banksAtLoad = await page.evaluate(() => (window.CET6_BANKS || []).length);
  out.questionsAtLoad = await page.evaluate(() => (window.CET6_BANKS || []).reduce((a, b) => a + ((b.questions || []).length), 0));

  out.scan = await page.evaluate(() => {
    const de = document.documentElement, W = de.clientWidth;
    const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const off = [];
    Array.prototype.forEach.call(document.querySelectorAll('#app *'), (el) => { if (!vis(el)) return; const r = el.getBoundingClientRect(); if (r.right > W + 1 || r.left < -1) off.push(el.tagName + '.' + String(el.className || '').slice(0, 24)); });
    const nav = Array.prototype.map.call(document.querySelectorAll('nav button'), (b) => Math.round(b.getBoundingClientRect().width));
    return { overflowX: de.scrollWidth > W + 1, docScrollW: de.scrollWidth, clientW: W, offenders: off.slice(0, 8), navWidths: nav, planCards: document.querySelectorAll('#planList .card').length, todayVisible: document.getElementById('page-today').style.display !== 'none' };
  });

  await page.locator('#planList .card').first().locator('button').click();
  await page.waitForFunction(() => document.getElementById('quiz').classList.contains('show'), null, { timeout: 20000 });
  // 按需加载：浮层弹出时题目还没渲染，必须等 .opt 真的挂载（否则 nOpt 恒为 0）
  await page.waitForSelector('#quizBody .opt', { timeout: 20000 }).catch(() => { });
  out.nOpt = await page.evaluate(() => document.querySelectorAll('.opt').length);
  out.optColorLight = await page.evaluate(() => { const b = document.querySelector('.opt'); return b ? getComputedStyle(b).color : null; });
  await page.evaluate(() => { const b = document.querySelector('.opt'); if (b) b.click(); });
  out.selectWorks = await page.evaluate(() => document.querySelectorAll('.opt.sel').length) > 0;
  out.timerText = await page.evaluate(() => (document.getElementById('quizTimer') || {}).textContent || '');

  await page.evaluate(() => { const t = document.getElementById('themeBtn'); if (t) t.click(); });
  await page.waitForTimeout(300);
  out.dark = await page.evaluate(() => {
    const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.parentElement; } return 'none'; };
    const lum = (c) => { const m = String(c).match(/[\d.]+/g).map(Number); const f = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
    const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b), hi = Math.max(L1, L2), lo = Math.min(L1, L2); return Math.round((hi + 0.05) / (lo + 0.05) * 100) / 100; };
    const b = document.querySelector('.opt');
    const cs = b ? getComputedStyle(b) : null;
    const bg = b ? bgOf(b) : null;
    return { on: document.body.classList.contains('dark'), optColor: cs ? cs.color : null, optBg: bg, optRatio: cs ? ratio(cs.color, bg) : null, bodyColor: getComputedStyle(document.body).color };
  });
  await page.screenshot({ path: path.join(DOCS, 'retest-browser-firefox.png') });
  out.errs = errs;
  out.questionsAfterOpen = await page.evaluate(() => (window.CET6_BANKS || []).reduce((a, b) => a + ((b.questions || []).length), 0));
  console.log(JSON.stringify(out, null, 1));
  await br.close();

  /* ---------------- 判定：把观测值落成断言 ---------------- */
  console.log('\n================ Firefox 兼容性判定 ================');
  t('页面初始化完成（todayLabel 渲染为 10 位日期）', true, out.initMs + 'ms');
  t('用户代理确为 Firefox', /Firefox\//.test(out.ua || ''), out.ua);
  t('首屏未预载题库正文（按需加载生效）', out.questionsAtLoad === 0, '首屏题数=' + out.questionsAtLoad);
  t('打开题组后卷被按需加载', out.questionsAfterOpen > 0, '加载后题数=' + out.questionsAfterOpen);
  t('题目选项正常渲染', out.nOpt > 0, '.opt=' + out.nOpt);
  t('点选可选中（.opt.sel 生效）', out.selectWorks === true, '');
  t('计时器已启动并显示时间', /\d\d:\d\d/.test(String(out.timerText)), 'timer=' + JSON.stringify(out.timerText));
  t('无横向溢出（390 宽视口）', out.scan.overflowX === false, 'docScrollW=' + out.scan.docScrollW + ' clientW=' + out.scan.clientW);
  t('深色模式可切换（body.dark）', out.dark.on === true, '');
  t('深色模式选项对比度 ≥ 4.5:1', typeof out.dark.optRatio === 'number' && out.dark.optRatio >= 4.5,
    'ratio=' + out.dark.optRatio + '（' + out.dark.optColor + ' on ' + out.dark.optBg + '）');
  t('全程无 pageerror / console.error', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n  ${ok} ok / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FIREFOX_RUN_FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
