#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_webkit.js · WebKit 引擎 + iPhone 视口兼容取证

   诚实边界：这是 **桌面版 WebKit（Playwright 自带）+ iPhone 视口/UA**，
   不是 iOS 真机 Safari。它能覆盖「引擎差异」（WebCore 与 Blink 在
   localStorage / document.write / CSP / 触摸事件上的行为差别），
   但覆盖不到 iOS 真机的内存限制、Safari 私有策略与真机触控。
   报告里必须按「部分证据」记，不得写成「iOS 实测通过」。

   输出遵循仓库约定：ok - <name> / FAIL - <name> + 汇总行。
   产物：docs/webkit-result.json
   主流程跑在本机临时 HTTP 服务器上（与线上同为 http(s) 源）；
   file:// 仅作单独探针——WebKit 对 file:// 资源会报
   "Origin null is not allowed by Access-Control-Allow-Origin"，
   那是浏览器安全模型限制，不是产品缺陷，故如实记录但不计入门禁。
   用法：先 npx playwright install webkit，再 node test_webkit.js
   退出码：0 = 全过，1 = 有失败（含引擎缺失）
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium: loadCore, fileUrl } = require('./_env');
const core = loadCore();
const ROOT = path.join(__dirname, '..');
const FILE_URL = fileUrl(path.join(ROOT, 'app', 'index.html'));
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      // WebKit 对部分子资源会发送「绝对 URL」形式的请求行（代理风格），
      // 不先剥掉 origin 会让 path.join 拼出不存在的文件 → 假 404 → 假兼容缺陷。
      let raw = req.url;
      if (/^https?:\/\//i.test(raw)) { try { const u = new URL(raw); raw = u.pathname + u.search; } catch (e) { } }
      let rel = decodeURIComponent(raw.split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const file = path.join(ROOT, 'app', rel);
      if (file.indexOf(path.join(ROOT, 'app')) !== 0 || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
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
  const results = [], facts = {};
  const check = (name, good, extra) => {
    results.push((good ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));
    console.log((good ? 'ok   ' : 'FAIL ') + '- ' + name + (extra ? ' | ' + extra : ''));
  };
  const fact = (k, v) => { facts[k] = v; console.log('fact  - ' + k + ' = ' + JSON.stringify(v)); };

  let webkit;
  try { webkit = core.webkit; } catch (e) { webkit = null; }
  if (!webkit) {
    check('WebKit 引擎可用', false, '请先执行 npx playwright install webkit');
    console.log('=== WebKit 兼容: 0 ok / 1 fail ===');
    process.exit(1);
  }

  let browser;
  try { browser = await webkit.launch(); }
  catch (e) {
    check('WebKit 引擎可启动', false, String(e.message || e).split('\n')[0].slice(0, 180) + '（需 npx playwright install webkit）');
    console.log('=== WebKit 兼容: 0 ok / 1 fail ===');
    process.exit(1);
  }

  const errors = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
      isMobile: true, hasTouch: true, userAgent: UA
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 160)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    // WebKit 下 document.write 注入的 core.js 可能晚于 load 事件就绪，等它落地再判定，
    // 避免把「还没加载完」误判成引擎不兼容。真加载不了会在 10s 后仍判 FAIL。
    await page.waitForFunction(() => !!window.CET6Core, null, { timeout: 10000 }).catch(() => { });
    check('首屏可加载', !!(await page.locator('body').count()));
    const boot = await page.evaluate(() => ({
      core: !!window.CET6Core, meta: !!(window.CET6_META && window.CET6_META.order),
      banks: Array.isArray(window.CET6_BANKS) ? window.CET6_BANKS.length : -1,
      ua: navigator.userAgent.slice(0, 40),
      scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src')).slice(0, 8)
    }));
    fact('引擎与首屏', boot);
    check('core.js 在 WebKit 下加载成功', boot.core, errors.slice(0, 2).join(' | '));
    check('meta 骨架在 WebKit 下加载成功', boot.meta);
    check('document.write 注入的 core.js?v= 未阻断首屏', boot.core && boot.meta);

    // file:// 只作单独探针：WebKit 对本地文件资源的 CORS 限制会产生
    // "Origin null ..." console error，与主流程（http(s)）的 JS 错误分开统计。
    const fileProbe = await (async () => {
      const fp = await ctx.newPage();
      const ferr = [];
      fp.on('console', m => { if (m.type() === 'error') ferr.push(m.text().slice(0, 120)); });
      fp.on('pageerror', e => ferr.push(e.message.slice(0, 120)));
      await fp.goto(FILE_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => { });
      const r = await fp.evaluate(() => {
        let ls;
        try { localStorage.setItem('__wb', '1'); ls = localStorage.getItem('__wb') === '1'; localStorage.removeItem('__wb'); }
        catch (e) { ls = 'ERR: ' + String(e && e.name || e); }
        return { core: !!window.CET6Core, meta: !!(window.CET6_META && window.CET6_META.order), ls };
      }).catch(e => ({ err: String(e.message) }));
      await fp.close();
      return Object.assign({}, r, { consoleErrorCount: ferr.length, consoleErrors: ferr.slice(0, 3) });
    })();
    fact('file:// 探针（环境限制，不计入门禁）', fileProbe);
    check('file:// 下 localStorage 可读写', fileProbe.ls === true, String(fileProbe.ls));

    await page.waitForSelector('#loginMask, #planList .card', { timeout: 20000 });
    await page.locator('#phoneInput').fill('1001').catch(() => {});
    await page.locator('#loginBtn').click().catch(() => {});
    await page.waitForSelector('#planList .card', { timeout: 20000 });
    const cards = await page.locator('#planList .card').count();
    check('登录后生成今日清单', cards >= 1, cards + ' 张卡');

    // 触摸点击（tap）走一遍做题浮层入口
    const firstBtn = page.locator('#planList .card button').first();
    await firstBtn.tap().catch(async () => await firstBtn.click());
    await page.waitForTimeout(800);
    const quiz = await page.evaluate(() => ({
      shown: !!document.getElementById('quiz') && document.getElementById('quiz').classList.contains('show'),
      body: ((document.getElementById('quizBody') || {}).textContent || '').trim().slice(0, 60)
    }));
    fact('做题浮层', quiz);
    check('触摸点击能打开做题浮层', quiz.shown);
    check('浮层内已渲染内容（非永久加载中）', quiz.shown && !/正在加载/.test(quiz.body), quiz.body);

    await page.locator('#quizBack, .back, [id*=back]').first().click().catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    for (const p of ['stat', 'backup', 'today']) {
      await page.locator('nav button[data-p="' + p + '"]').tap().catch(async () => await page.locator('nav button[data-p="' + p + '"]').click());
      await page.waitForTimeout(250);
      check('页面切换 ' + p + ' 可点且无异常', (await page.locator('#page-' + p).count()) > 0);
    }
    check('全程无 JS 错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''), errors.length === 0);
    await ctx.close();
  } catch (e) {
    check('WebKit 流程执行完成（无异常）', false, String(e && e.message || e).split('\n')[0].slice(0, 180));
  } finally {
    await browser.close();
    srv.close();
  }

  const fails = results.filter(r => r.startsWith('FAIL')).length;
  try {
    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'webkit-result.json'), JSON.stringify({
      ts: new Date().toISOString(),
      method: 'Playwright 桌面 WebKit + iPhone 视口/UA（非 iOS 真机）',
      scope: '引擎差异 / 触摸事件 / localStorage / document.write；不含 iOS 真机策略',
      ua: UA, facts, errors, ok: results.length - fails, fail: fails,
      verdict: fails ? 'FAIL' : 'PASS'
    }, null, 2), 'utf8');
  } catch (e) { }
  console.log('=== WebKit 兼容: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  process.exit(fails ? 1 : 0);
})();
