// Firefox 兼容性实测
// 背景：本机 stock Firefox 152.0.5 无法被 playwright-core 驱动（无 Juggler 协议）。
// 本脚本改用 playwright 官方 Firefox 构建（firefox-1543）做真实兼容性验证。
// 运行：$env:NODE_PATH='<workspace>\pw-ff\node_modules'; node test_firefox_playwright.js
const path = require('path');
const { pathToFileURL } = require('url');
let playwright = null;
try { playwright = require('playwright'); } catch (e) { console.log('PLAYWRIGHT_MISSING: ' + e.message); process.exit(2); }

// 2026-10-08：原来是写死的 'file:///D:/CET6/app/index.html' 与 'D:\\CET6\\docs'，
// 换台机器或上 CI 必然指向不存在的盘符。改成按脚本位置推导。
const ROOT = path.join(__dirname, '..');
const URL = pathToFileURL(path.join(ROOT, 'app', 'index.html')).href;
const DOCS = path.join(ROOT, 'docs');

(async () => {
  const out = { engine: 'firefox', build: null };
  const br = await playwright.firefox.launch({ headless: true });
  out.build = br.version();
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 160)); });
  await page.addInitScript(() => { try { localStorage.setItem('cet6_user', '9911'); } catch (e) { } });

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => { const e = document.getElementById('todayLabel'); return !!e && e.textContent.length === 10; }, null, { timeout: 60000 });
  out.initMs = Date.now() - t0;
  out.ua = await page.evaluate(() => navigator.userAgent);
  out.banks = await page.evaluate(() => (window.CET6_BANKS || []).length);
  out.questions = await page.evaluate(() => (window.CET6_BANKS || []).reduce((a, b) => a + ((b.questions || []).length), 0));

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
  console.log(JSON.stringify(out, null, 1));
  await br.close();
})().catch((e) => { console.log('FIREFOX_RUN_FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
