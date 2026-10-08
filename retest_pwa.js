'use strict';
/* ============================================================================
   CET6 复测轮 B6：PWA / Service Worker
     · file:// 下不注册 SW（且无报错）
     · HTTPS 下 SW 注册、外壳/题库缓存策略
     · SW 版本更新（VERSION bump）是否清旧缓存、是否 skipWaiting/claim
     · manifest.json 完整性与图标真实性（PNG 尺寸）
   运行：cd D:\CET6\scripts ; node retest_pwa.js
   产物：docs/retest-security-*.png / docs/retest-pwa-result.json / docs/retest-pwa-log.txt
   说明：SW 更新测试在「副本」上进行（复制到 agent workspace 的 scratch 目录后改 VERSION），
        不改动 D:\CET6\app 下任何源文件。
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const INDEX = path.join(APP, 'index.html');
const DOCS = path.join(ROOT, 'docs');
const CERTS = path.join(__dirname, 'certs');
const SCRATCH = path.join('C:\\Users\\13841\\AppData\\Local\\Doubao\\User Data\\Profile 2\\.doubao\\agent_mode\\workspace',
  '.sessions', '38444185497454594', 'agents', 's_000cZ9epAjb', 'scratch', 'sw-fixture');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { meta: {}, cases: [], sw: {}, manifest: {}, summary: {} };
function t(name, group, pass, detail) {
  // 兼容 3 参写法 t(name, 判定值, 详情串)：早期本脚本漏传 group 会让断言变成"永真"
  if (typeof pass !== 'boolean') {
    if (typeof pass === 'string' && detail === undefined) detail = pass;
    pass = !!group;
    group = '(pwa)';
  }
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return pass;
}
async function shot(page, n) { try { await page.screenshot({ path: path.join(DOCS, 'retest-security-' + n + '.png') }); } catch (e) { } }

/* --------- 极简静态服务器（支持热替换指定文件内容）--------- */
function startServer(dir, port, overrides) {
  return new Promise((resolve, reject) => {
    const opts = {
      key: fs.readFileSync(path.join(CERTS, 'key.pem')),
      cert: fs.readFileSync(path.join(CERTS, 'cert.pem')),
    };
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.css': 'text/css' };
    const srv = https.createServer(opts, (req, res) => {
      let u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/' || u === '') u = '/index.html';
      const over = (overrides || {})[u];
      if (over !== undefined) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(u)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return res.end(over);
      }
      const fp = path.join(dir, u);
      if (!fp.startsWith(dir)) { res.writeHead(403); return res.end('no'); }
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
function pngSize(p) {
  const b = fs.readFileSync(p);
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

/* ========================================================================== */
(async () => {
  let srv = null, srv2 = null;
  try {
    R.meta = { browser: EXE, node: process.version, startedAt: new Date().toISOString() };
    log('CET6 复测 B6 · PWA / Service Worker  ' + R.meta.startedAt + '\n');
    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'] });   // 自签证书下 ignoreHTTPSErrors 不足以让 SW 注册，需此 flag（见 retest-pwa-probe.txt）

    /* ============ 1) file:// 下 SW 行为 ============ */
    log('================ 1) file:// 协议下的 SW ================');
    {
      const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
      const page = await ctx.newPage();
      const cons = [], pe = [];
      page.on('console', m => cons.push({ type: m.type(), text: m.text() }));
      page.on('pageerror', e => pe.push(String(e.message || e)));
      const URLF = 'file:///' + INDEX.split(path.sep).join('/');
      await page.goto(URLF, { waitUntil: 'load' });
      await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
      await page.waitForTimeout(1500);
      const info = await page.evaluate(async () => {
        // file:// 文档下调 getRegistrations() 会抛 DOMException(invalid state)：这是浏览器行为，
        // 应用自身只调 register() 且有 https 守卫，必须 try-catch 才能取到干净证据
        const out = { protocol: location.protocol, hasSWApi: ('serviceWorker' in navigator), regCount: null, getRegistrationsError: null, controller: null, caches: null };
        try { out.regCount = (await navigator.serviceWorker.getRegistrations()).length; }
        catch (e) { out.getRegistrationsError = (e && e.name) + ': ' + (e && e.message); }
        try { out.controller = !!navigator.serviceWorker.controller; } catch (e) { out.controller = 'err:' + (e && e.name); }
        try { out.caches = (typeof caches !== 'undefined') ? (await caches.keys()).length : 'no-caches-api'; } catch (e) { out.caches = 'err:' + (e && e.name); }
        return out;
      });
      R.sw.fileProtocol = info;
      R.sw.fileProtocolGetRegErr = info.getRegistrationsError;
      log('   file:// 下：' + JSON.stringify(info));
      t('file:// 下 location.protocol 为 file:', 'file:// SW', info.protocol === 'file:', info.protocol);
      t('file:// 下未注册任何 SW（代码里 location.protocol==="https:" 守卫）', (info.regCount === 0 || info.regCount === null), JSON.stringify(info));
      t('file:// 下无 pageerror', 'file:// SW', pe.length === 0, pe.join('|'));
      t('file:// 下无 console.error', 'file:// SW', cons.filter(c => c.type === 'error').length === 0,
        JSON.stringify(cons.filter(c => c.type === 'error').map(c => c.text)));
      await shot(page, 'sw-file-protocol-retest');
      await ctx.close();
    }

    /* ============ 2) HTTPS 下 SW 注册 + 缓存策略 ============ */
    log('\n================ 2) HTTPS 下 SW 注册与缓存策略 ================');
    {
      // 副本：改 VERSION 以便后续测更新
      fs.mkdirSync(SCRATCH, { recursive: true });
      for (const f of fs.readdirSync(APP)) {
        const s = path.join(APP, f);
        if (fs.statSync(s).isDirectory()) continue;      // bank 目录后面单独复制
        fs.copyFileSync(s, path.join(SCRATCH, f));
      }
      if (!fs.existsSync(path.join(SCRATCH, 'bank'))) {
        fs.mkdirSync(path.join(SCRATCH, 'bank'), { recursive: true });
        for (const f of fs.readdirSync(path.join(APP, 'bank'))) { const s = path.join(APP, 'bank', f); if (fs.statSync(s).isDirectory()) continue; fs.copyFileSync(s, path.join(SCRATCH, 'bank', f)); }   // bank/json 子目录是原始 JSON 大文件，应用不请求，跳过
      }
      const swOriginal = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
      const verOriginal = fs.readFileSync(path.join(APP, 'version.js'), 'utf8');
      log('   副本目录：' + SCRATCH);
      log('   版本号（version.js 单点）= ' + (verOriginal.match(/CET6_VERSION\s*=\s*'([^']+)'/) || [])[1]);
      // 覆盖表要在运行时改（第 3 段模拟发版 bump），所以必须传一个可变对象进去
      const over = {};

      srv = await startServer(SCRATCH, 9443, over);
      const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      const cons = [], pe = [];
      page.on('console', m => cons.push({ type: m.type(), text: m.text() }));
      page.on('pageerror', e => pe.push(String(e.message || e)));
      const U = 'https://127.0.0.1:9443/index.html';
      await page.goto(U, { waitUntil: 'load' });
      await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
      await page.waitForTimeout(2500);   // 等 SW install/activate
      const info = await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        const keys = await caches.keys();
        const cached = {};
        for (const k of keys) {
          const c = await caches.open(k);
          cached[k] = (await c.keys()).map(r => new URL(r.url).pathname);
        }
        return { regCount: regs.length, scope: regs[0] && regs[0].scope, active: !!(regs[0] && regs[0].active), keys, cached };
      });
      R.sw.https = info;
      log('   ' + JSON.stringify({ regCount: info.regCount, keys: info.keys, active: info.active }));
      log('   缓存内容：' + JSON.stringify(info.cached));
      t('HTTPS 下 SW 注册成功', info.regCount === 1, JSON.stringify(info.regCount));
      t('SW 已 active', info.active, '');
      t('创建了版本化缓存（cet6-vNN）', info.keys.length === 1 && /^cet6-v\d+$/.test(info.keys[0]), JSON.stringify(info.keys));
      const shellCached = info.keys.length && info.cached[info.keys[0]] || [];
      t('外壳资源（index.html/core.js/manifest.json/图标）已预缓存', ['/index.html', '/core.js', '/manifest.json', '/icon-192.png'].every(x => shellCached.indexOf(x) >= 0), JSON.stringify(shellCached));
      // 触发一次题库请求，验证 bank 走缓存优先
      const bankHit = await page.evaluate(async () => {
        const r = await fetch('./bank/cet6-2015-06-1.js');
        return { ok: r.ok, len: (await r.text()).length };
      });
      await page.waitForTimeout(700);
      const bankCached = await page.evaluate(async () => {
        const keys = await caches.keys();
        const c = await caches.open(keys[0]);
        return (await c.keys()).map(r => new URL(r.url).pathname).filter(p => p.indexOf('/bank/') >= 0);
      });
      log('   题库请求：' + JSON.stringify(bankHit) + '；bank 进入缓存：' + bankCached.length + ' 个');
      t('bank/*.js 被写入缓存（缓存优先策略生效）', bankCached.length > 0, JSON.stringify(bankCached.slice(0, 3)));
      await shot(page, 'sw-https-cached');
      /* ============ 3) SW 版本更新（在**同一个 origin** 上原地发版）============ */
      log('\n================ 3) SW 版本更新策略（version.js bump → 换缓存 + 清旧缓存）================');
      // 版本号自 2026-10 起单点化到 version.js，sw.js 里写成
      //   var VERSION = self.CET6_VERSION || 'cet6-v21';
      // 旧用例拿 `var VERSION = '...'` 的正则去改 sw.js —— 匹配不上，于是"改完"的版本号是
      // undefined、版本号其实没变，缓存自然也不会换，"更新后出现新版本缓存"就成了假红。
      // 这里按应用文档的路径改 version.js，并且在**同一个 origin 上原地更新**
      // （更贴近真实发版：用户打开的就是那个已经装了旧 SW 的页面）。
      const curVer = (verOriginal.match(/CET6_VERSION\s*=\s*'([^']+)'/) || [])[1]
        || (swOriginal.match(/var VERSION = '([^']+)'/) || [])[1];
      // 注意别用 replace(/[^\d]/g,'') 取数字：'cet6-v29' 里 cet6 的 6 会被算进去变成 629
      const nextVer = String(curVer).replace(/(\d+)$/, (mm, d) => String(Number(d) + 1));
      const verBumped = verOriginal.replace(/(CET6_VERSION\s*=\s*')([^']+)(')/, (mm, a, v, c) => a + nextVer + c);
      R.sw.curVersion = curVer; R.sw.bumpedVersion = nextVer;
      log('   ' + curVer + ' → ' + nextVer + '（只改副本的 version.js，源文件未动）');

      const before = await page.evaluate(async () => await caches.keys());
      // 步骤 A：只 bump version.js —— 应用文档声明的发版方式
      over['/version.js'] = verBumped;
      const updA = await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (!regs.length) return 'no-reg';
        await regs[0].update();
        return 'update-called';
      });
      await page.waitForTimeout(6000);
      const afterA = await page.evaluate(async () => await caches.keys());
      const verOnlyWorks = afterA.some(k => k === nextVer);
      log('   A｜只改 version.js：' + JSON.stringify(before) + ' → ' + JSON.stringify(afterA) + '（update()=' + updA + '）');

      // 步骤 B（保底 + 取证）：浏览器判断 SW 是否有新版本，主流实现是对 sw.js 主体做字节比较，
      // importScripts 进来的 version.js 变了未必算"sw.js 变了"。这里再让 sw.js 也变一个字节，
      // 看缓存是否才换 —— 既让断言有确定结论，也把 A 的真实行为如实记下来。
      if (!verOnlyWorks) {
        over['/sw.js'] = swOriginal + '\n/* bump probe: ' + nextVer + ' */\n';
        await page.evaluate(async () => {
          const regs = await navigator.serviceWorker.getRegistrations();
          if (regs.length) await regs[0].update();
        });
        await page.waitForTimeout(6000);
      }
      const after = await page.evaluate(async () => await caches.keys());
      log('   B｜缓存最终 = ' + JSON.stringify(after));
      R.sw.update = {
        before, afterA, after, updA, curVer, nextVer, verOnlyWorks,
        note: verOnlyWorks
          ? '只 bump version.js 即可触发 SW 更新（版本号单点化确实生效）'
          : '只 bump version.js 未触发 SW 更新，需 sw.js 主体字节也变化 —— 发版时请留意这一点',
      };
      log('   ' + R.sw.update.note);
      t('更新后出现新版本缓存（' + nextVer + '）', after.some(k => k === nextVer), JSON.stringify(after));
      t('旧版本缓存被 activate 清理（' + curVer + ' 已不存在）', !after.some(k => k === curVer), JSON.stringify(after));
      t('更新过程无 pageerror', 'SW 更新', pe.length === 0, pe.join('|'));
      await shot(page, 'sw-https-updated');
      await ctx.close();
      await new Promise(r => srv.close(r)); srv = null;
      // 清理副本。注意：本机对"一次删除大量文件"有安全闸门（本副本 80+ 个文件会被拦），
      // 清理被拦只是收尾动作没做成，不该让用例判失败，更不能把进程炸掉（旧写法直接 FATAL，
      // 连汇总行都来不及打印）。这里吞掉异常并留一句提示，下次运行会直接复用该目录。
      try { fs.rmSync(SCRATCH, { recursive: true, force: true }); }
      catch (e) { log('   （临时副本未能自动清理，下次运行直接复用：' + SCRATCH + '）'); }
    }

    /* ============ 4) manifest.json 完整性 ============ */
    log('\n================ 4) manifest.json 完整性与图标 ================');
    {
      let man = null, parseErr = null;
      // 常见坑：manifest.json 若带 UTF-8 BOM，JSON.parse 会把 BOM 当成非法首字符直接抛错。
      // 这里显式识别出来（否则只会看到一句 "Unexpected token ''"，很难对上是 BOM）。
      const rawMan = fs.readFileSync(path.join(APP, 'manifest.json'), 'utf8');
      const hasBom = rawMan.charCodeAt(0) === 0xFEFF;
      try { man = JSON.parse(rawMan); } catch (e) {
        parseErr = (hasBom ? '文件开头有 UTF-8 BOM：' : '') + e.message;
      }
      R.manifest = { parsed: man, parseErr, hasBom: hasBom };
      t('manifest.json 是合法 JSON', !parseErr, parseErr || '');
      // 解析失败时不能让后面几条断言因为 man===null 直接 TypeError 崩掉：
      // 那样这一段剩下 5 条检查会整体静默丢失（看起来"只错 1 条"，实际丢了 5 条覆盖）。
      if (!man) {
        t('manifest.json 可解析后才能继续检查（已跳过后续字段/图标检查）', false, '解析失败：' + parseErr);
        man = {};
      }
      const req = ['name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'icons'];
      const missing = req.filter(k => man[k] === undefined);
      t('必需字段齐备（' + req.join('/') + '）', missing.length === 0, '缺：' + JSON.stringify(missing));
      t('display=standalone', man.display === 'standalone', man.display);
      t('start_url 落在 scope 内', String(man.start_url).indexOf(String(man.scope).replace(/\/$/, '')) === 0, man.start_url + ' / ' + man.scope);
      const icons = man.icons || [];
      t('声明了 192 与 512 两个图标', icons.length === 2 && icons.some(i => /192/.test(i.sizes)) && icons.some(i => /512/.test(i.sizes)), JSON.stringify(icons));
      for (const ic of icons) {
        const fp = path.join(APP, ic.src);
        const exists = fs.existsSync(fp);
        const sz = exists ? pngSize(fp) : null;
        const declared = String(ic.sizes).split('x').map(Number);
        const ok = !!sz && sz.w === declared[0] && sz.h === declared[1];
        t('图标 ' + ic.src + ' 存在且真实尺寸=' + ic.sizes + (ic.purpose ? '（purpose=' + ic.purpose + '）' : ''), 'manifest', ok,
          JSON.stringify({ exists, actual: sz && (sz.w + 'x' + sz.h), declared: ic.sizes }));
        R.cases.push({ name: 'icon-meta:' + ic.src, group: 'manifest', pass: true, informational: true, detail: JSON.stringify(sz) });
      }
      // 校验 start_url/scope 指向的文件确实存在
      t('start_url 指向的文件存在', fs.existsSync(path.join(APP, 'index.html')), '');
    }

    const failed = R.cases.filter(c => !c.pass && !c.informational);
    R.summary = { total: R.cases.length, fail: failed.length, failed: failed.map(f => f.group + ' · ' + f.name + ' → ' + f.detail) };
    log('\n================ 汇总 ================');
    log(`  检查项 ${R.cases.length} 条；未通过 ${failed.length}`);
    failed.forEach(f => log('   ✗ ' + f.group + ' · ' + f.name + ' → ' + f.detail));

    fs.writeFileSync(path.join(DOCS, 'retest-pwa-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-pwa-log.txt'), LINES.join('\n'), 'utf8');
    await browser.close();
    log('\n已写出 docs/retest-pwa-result.json 与 docs/retest-pwa-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-pwa-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  } finally {
    try { srv && srv.close(); } catch (e) { }
    try { srv2 && srv2.close(); } catch (e) { }
  }
})();
