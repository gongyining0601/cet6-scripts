#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_paper_load_http.js · 按需加载大卷（http(s) 通道）回归

   2026-11-12 线上缺陷：约 150KB 的卷正文用 <script src> 动态注入时，
   在部分网络/CDN 组合下请求挂死、onload/onerror 都不触发，15s 超时后
   浮层被关掉，写译答题区永远出不来（test_online_p72.js 稳定红，本地
   file:// 用例却全绿 —— 因为 file:// 不走这条网络路径）。

   本用例在本机起一个临时 HTTP 静态服务器，复刻线上 http(s) 环境，
   真跑「登录 → 注入写译卡 → 点开始 → 等 #essayTa」全流程，
   把这条以前只有公网才能暴露的路径变成可离线复现的本地回归。

   输出遵循仓库约定：ok - <name> / FAIL - <name> + 汇总行。
   用法：node test_paper_load_http.js
   退出码：0 = 全过，1 = 有失败
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();

const APP = path.join(__dirname, '..', 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.m3u8': 'application/vnd.apple.mpegurl'
};

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      // 兼容「绝对 URL」形式的请求行（WebKit 会这样发，Chromium 发相对路径）
      let raw = req.url;
      if (/^https?:\/\//i.test(raw)) { try { const u = new URL(raw); raw = u.pathname + u.search; } catch (e) { } }
      let rel = decodeURIComponent(raw.split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const file = path.join(APP, rel);
      if (file.indexOf(APP) !== 0 || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port + '/' }));
  });
}

(async () => {
  const { srv, url } = await serve();
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [], bankReq = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  page.on('request', r => { if (r.url().indexOf('/bank/cet6-') >= 0) bankReq.push({ t: Date.now(), url: r.url() }); });
  page.on('response', r => { if (r.url().indexOf('/bank/cet6-') >= 0) bankReq.push({ resp: r.status(), url: r.url() }); });

  const results = [];
  const check = (name, good, extra) => {
    results.push((good ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));
    console.log((good ? 'ok   ' : 'FAIL ') + '- ' + name + (extra ? ' | ' + extra : ''));
  };
  const UID = '9207', KEY = 'cet6_p1_state_v1_' + UID;

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#loginMask', { timeout: 20000 });
    await page.locator('#phoneInput').fill(UID);
    await page.locator('#loginBtn').click();
    await page.waitForSelector('#planList .card', { timeout: 20000 });
    check('HTTP 通道登录并生成今日清单', (await page.locator('#planList .card').count()) >= 1);

    await page.evaluate(({ key }) => {
      const C = window.CET6Core, t = C.todayStr();
      const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null };
      st.plan = { date: t, v: C.PLAN_VERSION, items: [
        { key: 'essay-test', type: 'translation', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }
      ] };
      localStorage.setItem(key, JSON.stringify(st));
    }, { key: KEY });
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#planList .card', { timeout: 20000 });

    const card = page.locator('#planList .card').filter({ hasText: /翻译|写作/ }).first();
    check('写译卡注入生效', (await card.count()) > 0);
    const t0 = Date.now();
    await card.locator('button').first().click();
    let rendered = false;
    try { await page.waitForSelector('#essayTa', { timeout: 35000 }); rendered = true; } catch (e) { }
    const ms = Date.now() - t0;
    check('大卷加载后写译答题区渲染', rendered, ms + 'ms');
    check('大卷加载耗时在超时闸门内', rendered && ms < 30000, ms + 'ms / 上限 30000ms');

    const banks = await page.evaluate(() => (window.CET6_BANKS || []).map(b => b.id));
    check('卷正文确实入列且无重复', banks.filter(x => x === '2015-06-1').length === 1, '已加载=' + banks.length + ' 卷');

    if (rendered) {
      await page.locator('#essayTa').fill('The year 2011 was a historic moment in China urbanization. Over the next two decades, some 350 million rural people will move to cities.');
      await page.locator('#essayCheck').click();
      await page.waitForTimeout(500);
      const box = (await page.locator('#checkBox').textContent()) || '';
      check('踩分词自查可用', /覆盖 \d+\/\d+/.test(box));
    }
    check('全程无 JS 错误' + (errors.length ? '：' + errors.slice(0, 2).join(' | ') : ''), errors.length === 0);
    check('卷请求有响应（未挂死）', bankReq.some(r => r.resp), '请求事件=' + bankReq.length);
  } catch (e) {
    check('用例执行完成（无异常）', false, String(e && e.message || e).slice(0, 160));
  } finally {
    await browser.close();
    srv.close();
  }
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== HTTP 按需加载大卷: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  process.exit(fails ? 1 : 0);
})();
