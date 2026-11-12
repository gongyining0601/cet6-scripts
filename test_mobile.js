#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_mobile.js · 移动端可用性取证（桌面 Chromium 设备模拟）

   ⚠️ 重要边界：**这不是真机，也不是 iOS Safari**。
   本机 ms-playwright 缓存只有 firefox/winldd/ffmpeg，没有 webkit，
   所以 WebKit / iPhone 真机仍属于「未实测」。本脚本能补的是：
   小屏视口 + touch 事件下的布局溢出、主要链路可点通、无 JS 错误。

   判定口径：
     · 4 个主页面都不能出现横向溢出（scrollWidth ≤ innerWidth + 1）
     · 登录 → 今日清单 → 进第一组 → 返回，链路能走通
     · 全程无 pageerror
   用法：node test_mobile.js      产物：docs/mobile-result.json
   退出码：0 = 模拟链路通过（不代表真机通过），1 = 模拟即失败
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const URL = fileUrl(path.join(ROOT, 'app', 'index.html'));
const VIEWPORT = { width: 390, height: 844 };
const PAGES = ['today', 'wrong', 'stat', 'backup'];

const R = {
  ts: new Date().toISOString(),
  engine: 'Chromium desktop binary, emulated mobile viewport (isMobile + hasTouch)',
  viewport: VIEWPORT, deviceScaleFactor: 3,
  realDevice: false, iosSafari: false, webkit: false,
  coverage: '部分覆盖：小屏布局与点按链路',
  stillMissing: ['iOS Safari / WebKit', '真机弱网', '真机 PWA 安装与离线', '真机屏幕阅读器'],
  checks: [], pageErrors: [], verdict: ''
};
function chk(name, good, detail) {
  R.checks.push({ name, ok: !!good, detail: String(detail == null ? '' : detail) });
  console.log((good ? 'ok  ' : 'FAIL') + ' - ' + name + (detail ? ' | ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 3
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => R.pageErrors.push(e.message));

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => localStorage.setItem('cet6_user', '1001'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#planList .card', { timeout: 20000 });
    chk('小屏登录后今日清单渲染', (await page.locator('#planList .card').count()) > 0,
      (await page.locator('#planList .card').count()) + ' 张卡');

    for (const p of PAGES) {
      const btn = page.locator('nav button[data-p="' + p + '"]');
      if (await btn.count()) { await btn.click(); await page.waitForTimeout(300); }
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth, iw: window.innerWidth,
        bodySw: document.body.scrollWidth
      }));
      chk(p + ' 页无横向溢出', m.sw <= m.iw + 1, 'scrollWidth=' + m.sw + ' innerWidth=' + m.iw);
    }

    // 回到今日，touch 点第一张卡进入做题，再返回
    await page.locator('nav button[data-p="today"]').click();
    await page.waitForSelector('#planList .card');
    const firstBtn = page.locator('#planList .card').first().locator('button').first();
    await firstBtn.tap();
    await page.waitForSelector('#quiz.show', { timeout: 20000 });
    chk('touch 点按可进入做题页', await page.locator('#quiz.show').isVisible());
    const back = page.locator('#quizBack');
    if (await back.count()) { await back.tap(); await page.waitForTimeout(400); }
    chk('可从做题页返回', !(await page.locator('#quiz.show').isVisible().catch(() => false)));

    chk('全程无 JS 错误', R.pageErrors.length === 0, R.pageErrors.join(' | ') || 'none');
    R.verdict = R.checks.every(c => c.ok) ? '模拟链路通过（真机仍未实测）' : '模拟链路失败';
  } catch (e) {
    R.fatal = e.message;
    R.verdict = '未实测（中断）';
    chk('链路走查完成', false, e.message);
  } finally {
    await browser.close();
  }

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'mobile-result.json'), JSON.stringify(R, null, 2), 'utf8');
  const fails = R.checks.filter(c => !c.ok).length;
  console.log('\n=== 移动端模拟: ' + (R.checks.length - fails) + ' ok / ' + fails + ' fail · ' + R.verdict + ' ===');
  console.log('产物 -> docs/mobile-result.json');
  process.exit(fails ? 1 : 0);
})();
