'use strict';
/* ============================================================================
   CET6 复测 · PWA 单点定位：为什么 HTTPS(自签证书) 下 SW 没注册？
   只读探测：直接 serve D:\CET6\app（不改任何源文件），只把 SW 注册结果/错误打出来
   运行：node retest_pwa_probe.js
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const CERTS = path.join(__dirname, 'certs');
const OUT = [];
const log = (...a) => { const s = a.join(' '); console.log(s); OUT.push(s); };

function startServer(dir, port) {
  return new Promise((resolve, reject) => {
    const opts = { key: fs.readFileSync(path.join(CERTS, 'key.pem')), cert: fs.readFileSync(path.join(CERTS, 'cert.pem')) };
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.css': 'text/css' };
    const srv = https.createServer(opts, (req, res) => {
      let u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/' || u === '') u = '/index.html';
      const fp = path.join(dir, u);
      fs.readFile(fp, (e, buf) => {
        if (e) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await startServer(APP, 9445);
  try {
    const variants = [
      { name: 'A. ignoreHTTPSErrors only', args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      { name: 'B. + --ignore-certificate-errors', args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'] },
      {
        name: 'C. + --ignore-certificate-errors + unsafely-treat-origin-as-secure',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--unsafely-treat-insecure-origin-as-secure=https://127.0.0.1:9445'],
      },
    ];
    for (const v of variants) {
      const browser = await chromium.launch({ executablePath: EXE, args: v.args });
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      const pe = [];
      page.on('pageerror', e => pe.push(String(e.message || e)));
      await page.goto('https://127.0.0.1:9445/index.html', { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      const r = await page.evaluate(async () => {
        const out = { protocol: location.protocol, isSecureContext: window.isSecureContext, hasSW: 'serviceWorker' in navigator, regErr: null, reg: null };
        if (out.hasSW) {
          try {
            const reg = await navigator.serviceWorker.register('sw.js');
            out.reg = { scope: reg.scope, active: !!(reg.active), installing: !!(reg.installing), waiting: !!(reg.waiting) };
          } catch (e) { out.regErr = (e && e.name) + ': ' + (e && e.message); }
        }
        return out;
      });
      await page.waitForTimeout(3000);
      const r2 = await page.evaluate(async () => {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          const keys = await caches.keys();
          const cached = {};
          for (const k of keys) { const c = await caches.open(k); cached[k] = (await c.keys()).map(x => new URL(x.url).pathname); }
          return { regCount: regs.length, active: !!(regs[0] && regs[0].active), keys, cached };
        } catch (e) { return { err: (e && e.name) + ': ' + (e && e.message) }; }
      });
      log('\n[' + v.name + ']');
      log('  register 尝试：' + JSON.stringify(r));
      log('  3 秒后：' + JSON.stringify(r2).slice(0, 400));
      log('  pageerror：' + JSON.stringify(pe));
      await ctx.close();
      await browser.close();
    }
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
  } finally {
    await new Promise(r => srv.close(r));
    fs.writeFileSync(path.join(ROOT, 'docs', 'retest-pwa-probe.txt'), OUT.join('\n'), 'utf8');
    log('\n已写出 docs/retest-pwa-probe.txt');
  }
})();
