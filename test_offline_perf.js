/* 离线 PWA + 性能复测：脚本内起 HTTPS 服务（SW 仅在 https/secure context 注册） */
const path = require('path');
const https = require('https');
const fs = require('fs');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..', 'app');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')) }, (req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } else { res.writeHead(404); res.end('nf'); }
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const URL = 'https://127.0.0.1:' + port + '/index.html';
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'] });
  const results = [];
  const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept(''));
  const t0 = Date.now();
  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 15000 });
  const first = ((Date.now() - t0) / 1000).toFixed(1);
  check('HTTP 首屏 ' + first + 's', parseFloat(first) < 3);
  const resCount = await page.evaluate(() => performance.getEntriesByType('resource').length);
  check('资源请求数 ' + resCount + '（按需加载：首屏仅 meta 骨架，不再全量拉 76 卷）', resCount <= 10);
  await page.locator('#phoneInput').fill('9100');
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  await page.waitForTimeout(3500);
  const swState = await page.evaluate(async () => {
    if (!navigator.serviceWorker) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg && reg.active ? 'active' : (reg ? 'installing' : 'none');
  });
  check('Service Worker 已激活', swState === 'active');
  await ctx.setOffline(true);
  await page.goto(URL, { waitUntil: 'commit' }).catch(() => {});
  await page.waitForTimeout(2500);
  // 已登录用户（localStorage 保留），断网下直接出清单
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  const offlinePlan = await page.locator('#planList .card').count();
  check('断网可正常生成清单(' + offlinePlan + ' 组)', offlinePlan >= 1 && errs.length === 0);
  // 按需加载（架构级）：断网点「开始」，卷从 SW 缓存动态加载并渲染题目（此前首屏全量加载 76 卷）
  if (offlinePlan >= 1) {
    await page.locator('#planList .card button').first().click();
    await page.waitForSelector('#quiz.show', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const qd = await page.evaluate(() => ({
      hasOpts: document.querySelectorAll('#quizBody .opt, #quizBody .optBtn, #quizBody .passage').length,
      bodyLen: document.querySelector('#quizBody').innerHTML.length,
    })).catch(() => ({ hasOpts: 0, bodyLen: -1 }));
    check('断网做题：卷从 SW 缓存加载并渲染题目(内容 ' + qd.bodyLen + ' 字符)', qd.hasOpts > 0 && qd.bodyLen > 300);
    await page.locator('#quizBack').click().catch(() => {});
    await page.waitForSelector('#quiz', { state: 'hidden' });
  }
  await ctx.setOffline(false);
  const t1 = Date.now();
  await page.goto(URL);
  // 已登录用户二次访问：SW 缓存命中直接进应用（不会再见登录层），以清单渲染完成计
  await page.waitForSelector('#planList .card', { timeout: 15000 });
  const second = ((Date.now() - t1) / 1000).toFixed(1);
  check('二次访问(SW 缓存) ' + second + 's', parseFloat(second) < 3);
  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== 离线+性能: ' + (results.length - fails) + ' ok / ' + fails + ' fail === errors: ' + (errs.join('|') || 'none'));
  await browser.close(); server.close();
  process.exit(fails ? 1 : 0);
})();
