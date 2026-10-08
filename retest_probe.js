'use strict';
/* 最小探针：定位「点击 #exportBtn / #wrongCsvBtn 无 download 事件」的原因（脚本问题 or 应用缺陷） */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'app', 'index.html');
const URL = fileUrl(INDEX);
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const cons = [], pe = [];
  page.on('console', m => cons.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => pe.push(String(e.message || e)));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ t }) => {
    const st = { version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' };
    st.history[t] = { minutes: 33, done: true, floor: false, qCount: 10, right: 7, timed: 2, timedWithin: 1, timedSec: 150 };
    st.papers['2026-06-1-r-46'] = { seen: 1, right: 0, wrong: 1, lastAt: t, lastResult: 'wrong', lastAnswer: 'C' };
    st.wrongbook['2026-06-1-r-46'] = { addedAt: t, box: 0, wrongCount: 2, due: t, ease: 2.5, iv: 1, streak: 0 };
    localStorage.setItem('cet6_user', '9203');
    localStorage.setItem('cet6_p1_state_v1_9203', JSON.stringify(st));
  }, { t: TODAY });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  const dom = await page.evaluate(() => {
    const g = id => { const e = document.getElementById(id); if (!e) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { visible: cs.display !== 'none' && cs.visibility !== 'hidden', display: cs.display, w: Math.round(r.width), h: Math.round(r.height), hasHandler: typeof e.onclick === 'function', parentPage: (e.closest('section') || {}).id || null }; };
    return {
      exportBtn: g('exportBtn'), wrongCsvBtn: g('wrongCsvBtn'),
      pages: Array.from(document.querySelectorAll('section[id^="page-"]')).map(s => s.id + ':' + getComputedStyle(s).display),
      activeNav: Array.from(document.querySelectorAll('nav button')).map(b => b.getAttribute('data-p') + (b.classList.contains('on') || b.classList.contains('active') ? '*' : '')),
    };
  });
  console.log('DOM 状态：' + JSON.stringify(dom, null, 2));
  // 1) 直接点（不导航）看下载
  for (const id of ['exportBtn', 'wrongCsvBtn']) {
    try {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), page.locator('#' + id).click({ timeout: 6000 })]);
      console.log(id + ' 直接点 → download OK: ' + dl.suggestedFilename());
    } catch (e) {
      console.log(id + ' 直接点 → 失败: ' + String(e.message).split('\n')[0]);
    }
  }
  // 2) 先切到备份页再点
  await page.evaluate(() => { const b = document.querySelector('nav button[data-p="backup"]'); if (b) b.click(); });
  await page.waitForTimeout(400);
  const dom2 = await page.evaluate(() => ({ pages: Array.from(document.querySelectorAll('section[id^="page-"]')).map(s => s.id + ':' + getComputedStyle(s).display), exp: (document.getElementById('exportBtn') || {}).offsetParent !== null }));
  console.log('切到备份页后：' + JSON.stringify(dom2));
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.locator('#exportBtn').click({ timeout: 8000 })]);
    const p = await dl.path();
    console.log('切页后 exportBtn → download OK: ' + dl.suggestedFilename() + ' 文件大小=' + fs.statSync(p).size);
    console.log('JSON 头部: ' + fs.readFileSync(p, 'utf8').slice(0, 80).replace(/\n/g, ' '));
  } catch (e) {
    console.log('切页后 exportBtn → 失败: ' + String(e.message).split('\n')[0]);
  }
  console.log('pageerror=' + JSON.stringify(pe));
  console.log('console=' + JSON.stringify(cons.slice(0, 10)));
  await browser.close();
})().catch(e => { console.log('FATAL ' + e.stack); process.exitCode = 2; });
