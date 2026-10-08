const path = require('path');
const https = require('https');
const fs = require('fs');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..', 'app');
const server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')) }, (req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript' }[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } else { res.writeHead(404); res.end('nf'); }
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const URL = 'https://127.0.0.1:' + port + '/index.html';
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'] });
  const page = await browser.newPage();
  page.on('dialog', d => d.accept(''));
  await page.goto(URL, { waitUntil: 'commit' }).catch(() => {});
  await page.waitForSelector('#loginMask', { timeout: 20000 });
  await page.locator('#phoneInput').fill('9100');
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 30000 });
  await page.waitForTimeout(6000); // SW install + 76 bank 缓存
  console.log('SW:', await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 'none';
    const keys = await caches.keys();
    let banks = 0;
    for (const k of keys) { const c = await caches.open(k); banks += (await c.keys()).filter(r => r.url.indexOf('/bank/') >= 0).length; }
    return reg.active ? 'active, banks cached: ' + banks : 'installing';
  }));
  const swBanks = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 0;
    const keys = await caches.keys();
    let n = 0;
    for (const k of keys) { const c = await caches.open(k); n += (await c.keys()).filter(r => r.url.indexOf('/bank/') >= 0 && r.url.indexOf('meta.js') < 0).length; }
    return n;
  });
  await page.context().setOffline(true);
  await page.goto(URL, { waitUntil: 'commit' }).catch(e => console.log('goto:', e.message.slice(0, 50)));
  await page.waitForTimeout(4000);
  // 按需加载（架构级）：断网首屏只有 meta 骨架（CET6_BANKS 为空数组），卷正文在点击「开始」时从 SW 缓存动态加载
  const cards = await page.locator('#planList .card').count();
  const clicked = cards >= 1;
  if (clicked) await page.locator('#planList .card button').first().click();
  await page.waitForSelector('#quiz.show', { timeout: 15000 });
  await page.waitForTimeout(1500); // 等卷从 SW 缓存加载 + 渲染
  const quizDump = await page.evaluate(() => ({
    banksLoaded: (window.CET6_BANKS || []).length,
    hasOpts: document.querySelectorAll('#quizBody .opt, #quizBody .optBtn, #quizBody .passage').length,
    quizBodyLen: (document.querySelector('#quizBody') || {}).innerHTML ? document.querySelector('#quizBody').innerHTML.length : -1,
  })).catch(() => ({ banksLoaded: -1, hasOpts: 0, quizBodyLen: -1 }));
  const results = [
    (swBanks >= 76 ? 'ok' : 'FAIL') + ' - HTTPS 下 SW 激活且 76 卷全缓存(' + swBanks + ')',
    (clicked && quizDump.hasOpts > 0 && quizDump.quizBodyLen > 300 ? 'ok' : 'FAIL') + ' - 断网按需加载：点开始后卷从 SW 缓存加载并渲染题目(加载卷 ' + quizDump.banksLoaded + ', 内容长度 ' + quizDump.quizBodyLen + ')',
    (cards >= 1 ? 'ok' : 'FAIL') + ' - 断网可生成清单(' + cards + ' 组)',
  ];
  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== 离线 PWA(HTTPS): ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close(); server.close();
  process.exit(fails ? 1 : 0);
})();
