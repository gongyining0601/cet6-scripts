'use strict';
/* ============================================================================
   CET6 缺陷修复验证（N-SEC-1~7 / N-UI-1~6 / N-CONT-1 UI 部分）
   逐个缺陷构造最小复现场景，断言修复后的行为。
   运行：cd D:\CET6\scripts ; node verify_fixes.js
   产物：docs/verify-fixes-log.txt / docs/verify-fixes-result.json
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const INDEX = path.join(APP, 'index.html');
const URL = fileUrl(INDEX);
const DOCS = path.join(ROOT, 'docs');
const CORE = require(path.join(ROOT, 'app/core.js')); // 取 PLAN_VERSION（按需加载后注入 plan 需匹配当前版本号，否则被 ensurePlan 丢弃重算）
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
const A = '9203', C = '5566';
const PAPER = '2026-06-1';
const LEGACY = 'cet6_p1_state_v1';
const KB = k => 'cet6_p1_state_v1_' + k;
const LQ = ['2026-06-1-l-1', '2026-06-1-l-2', '2026-06-1-l-3', '2026-06-1-l-4'];

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { meta: {}, cases: [], data: {}, summary: {} };
function t(name, group, pass, detail) {
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return !!pass;
}
function fact(name, value) { R.data[name] = value; log(`  [fact] ${name} = ${JSON.stringify(value)}`); }

async function newCtx(browser, init) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const logs = { console: [], pageerror: [], dialog: [] };
  page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.pageerror.push(String((e && e.message) || e)));
  page.on('dialog', async dl => { logs.dialog.push({ type: dl.type(), message: dl.message() }); try { await dl.accept(dl.type() === 'prompt' ? (logs.promptReply || '10') : ''); } catch (e) { } });
  return { ctx, page, logs };
}
async function boot(page, stateObj, uid) {
  uid = uid || A;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try { localStorage.removeItem('cet6_p1_state_v1_' + id); if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st); } catch (e) { }
  }, { id: uid, st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); } catch (e) { }
  await page.waitForTimeout(200);
}
const stateOf = (page, uid) => page.evaluate(k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }, KB(uid || A));
const toastText = page => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
const minutesTxt = page => page.evaluate(() => (document.getElementById('todayMinutes') || {}).textContent || '');
const openFirst = async (page, wait) => { await page.locator('#planList .card button').first().click(); await page.waitForTimeout(wait || 900); };
const back = async page => { await page.evaluate(() => { const b = document.getElementById('quizBack'); if (b) b.click(); }); await page.waitForTimeout(400); };
// R4-M5：P7 按需加载后首屏 BANKS=0。测试若需在 openFirst 前访问 window.CET6_BANKS，先动态注入目标卷脚本。
const ensureBank = async (page, pid) => {
  await page.evaluate((pid) => new Promise((res, rej) => {
    if ((window.CET6_BANKS || []).find(x => x.id === pid)) { res(true); return; }
    const s = document.createElement('script');
    s.src = 'bank/cet6-' + pid + '.js';
    s.onload = () => res(true);
    s.onerror = () => rej(new Error('bank load fail ' + pid));
    document.head.appendChild(s);
  }), pid);
};

function baseState(e) { return Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' }, e || {}); }
function planWith(items) { return { date: TODAY, v: CORE.PLAN_VERSION, items: items }; }
function listenItem(extra) {
  return Object.assign({ key: 'l1', type: 'listening', qids: LQ.slice(), paperId: PAPER, label: '听力·长对话 1-4', done: false, minutes: 0 }, extra || {});
}

/* ========================================================================== */
(async () => {
  try {
    const crypto = require('crypto');
    const hashOf = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    R.meta = { url: URL, browser: EXE, today: TODAY, node: process.version, startedAt: new Date().toISOString(), hashes: { 'app/index.html': hashOf(INDEX), 'app/core.js': hashOf(path.join(APP, 'core.js')) } };
    log('CET6 缺陷修复验证  ' + R.meta.startedAt);
    log('index.html sha256 = ' + R.meta.hashes['app/index.html']);
    log('core.js    sha256 = ' + R.meta.hashes['app/core.js'] + '\n');
    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });

    /* ============== 1) N-SEC-1 听力 iframe 协议白名单 ============== */
    log('\n============== 1) N-SEC-1 听力 iframe 协议/域名白名单 ==============');
    {
      const init = () => { window.__pwned = 0; window.__pwnedTags = []; window.__probe = function (tag) { window.__pwned++; window.__pwnedTags.push(tag); }; };
      const { ctx, page, logs } = await newCtx(browser, init);
      await boot(page, baseState({ plan: planWith([listenItem()]) }));
      const probe = async (badUrl, label, opts) => {
        opts = opts || {};
        await ensureBank(page, PAPER); // R4-M5：按需加载后 BANKS=0，先注入目标卷再改写 listeningUrl
        await page.evaluate(({ id, u, noBaked }) => {
          const b = (window.CET6_BANKS || []).find(x => x.id === id);
          b.listeningUrl = u;
          // 清掉烘焙分片 → 强制走"烘焙缺失 → 退回原站 iframe"的降级路径。
          // 不这么做的话永远走 <audio> 分支，iframe 那条白名单路径根本没被覆盖（旧版就漏了这里）。
          if (noBaked) window.CET6_LISTEN_META = {};
        }, { id: PAPER, u: badUrl, noBaked: !!opts.noBaked });
        await openFirst(page);
        const info = await page.evaluate(() => {
          const root = document.getElementById('quizBody');
          const f = root.querySelector('iframe');
          const a = root.querySelector('a');
          const au = root.querySelector('audio');
          const html = root.innerHTML;
          return {
            hasIframe: !!f, srcAttr: f ? f.getAttribute('src') : null,
            hasAudio: !!au, audioControls: au ? au.hasAttribute('controls') : false,
            hasPlayer: !!root.querySelector('.listen-player'),
            linkHref: a ? a.getAttribute('href') : null,
            pwned: window.__pwned, tags: window.__pwnedTags.slice(),
            jsUrlInDom: html.indexOf('javascript:') >= 0,
            body: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
          };
        });
        await back(page);
        return info;
      };
      // 1a 恶意伪协议
      const a1 = await probe('javascript:window.top.__probe("iframeJsUrl")', 'js-url');
      R.data['1a'] = a1;
      t('javascript: 地址不再进入 iframe src', 'N-SEC-1', a1.hasIframe === false && a1.srcAttr === null, JSON.stringify({ hasIframe: a1.hasIframe, src: a1.srcAttr }));
      t('javascript: 地址未执行父页代码（__pwned 保持 0）', 'N-SEC-1', a1.pwned === 0, 'pwned=' + a1.pwned + ' tags=' + JSON.stringify(a1.tags));
      t('javascript: 地址未进入 <a href>（新窗口兜底链接同样过滤）', 'N-SEC-1', !a1.linkHref || a1.linkHref.indexOf('javascript:') !== 0, 'href=' + JSON.stringify(a1.linkHref));
      /* 旧断言写的是"降级为『本卷听力页暂不可用』提示"——那是 iframe 单路径时代的文案。
         现在的渲染是三级：烘焙分片存在 → <audio> 播放器；否则退回白名单 iframe；再否则提示文案。
         目标卷有烘焙分片，所以这里走 <audio> 分支，那句提示根本不该出现。
         改成直接断言安全属性本身：恶意地址不得出现在渲染结果的任何位置。       */
      t('javascript: 地址未出现在渲染结果任何位置（iframe src / 兜底链接 / DOM 源码）', 'N-SEC-1',
        a1.hasIframe === false && a1.srcAttr === null && !a1.linkHref && a1.jsUrlInDom === false,
        JSON.stringify({ hasIframe: a1.hasIframe, src: a1.srcAttr, href: a1.linkHref, jsUrlInDom: a1.jsUrlInDom }));
      // 1b 非白名单 https 域名
      const a2 = await probe('https://evil.example.com/cet6/paper/2026-06-1/?f=w', 'evil');
      R.data['1b'] = a2;
      t('非白名单域名（https://evil.example.com）被拒', 'N-SEC-1', a2.hasIframe === false, 'src=' + JSON.stringify(a2.srcAttr) + ' body=' + JSON.stringify(a2.body));
      // 1c 白名单域名但非 https
      const a3 = await probe('http://english-exam.lazynote.cn/cet6/paper/2026-06-1/?f=w', 'http');
      R.data['1c'] = a3;
      t('白名单域名但 http: 协议被拒（只认 https）', 'N-SEC-1', a3.hasIframe === false, 'src=' + JSON.stringify(a3.srcAttr));
      // 1d 仿冒后缀域名
      const a4 = await probe('https://english-exam.lazynote.cn.evil.com/x/?f=w', 'suffix');
      R.data['1d'] = a4;
      t('仿冒后缀域名（lazynote.cn.evil.com）被拒', 'N-SEC-1', a4.hasIframe === false, 'src=' + JSON.stringify(a4.srcAttr));
      // 1e 正常白名单地址：走烘焙 <audio> 分支，兜底链接指向听力专项页
      const a5 = await probe('https://english-exam.lazynote.cn/cet6/paper/2026-06-1/?f=w', 'legit');
      R.data['1e'] = Object.assign({ frames: page.frames().map(f => f.url()) }, a5);
      const want = 'https://english-exam.lazynote.cn/cet6/paper/2026-06-1/listening/';
      /* 旧断言要求"仍然渲染 iframe，src=听力专项页"。现在只要烘焙分片存在就渲染 <audio> 播放器，
         不再嵌 iframe；iframe 只在烘焙缺失时兜底。故此处断言播放器本身，
         并在 1f/1g 单独覆盖 iframe 兜底路径（旧版从未覆盖到那条分支）。 */
      t('正常白名单地址渲染 <audio> 播放器（烘焙分片优先）', 'N-SEC-1',
        a5.hasPlayer === true && a5.hasAudio === true && a5.audioControls === true,
        JSON.stringify({ hasPlayer: a5.hasPlayer, hasAudio: a5.hasAudio, controls: a5.audioControls }));
      t('“新窗口打开”兜底链接指向听力专项页（/?f=w 已换成 /listening/）', 'N-SEC-1', a5.linkHref === want, 'href=' + JSON.stringify(a5.linkHref));
      fact('iframe 帧是否真的导航到远端（受本机网络影响）', R.data['1e'].frames);

      // 1f/1g 烘焙缺失 → 退回白名单 iframe 的降级路径（同一套白名单必须同样生效）
      const f1 = await probe('javascript:window.top.__probe("fbJs")', 'fallback-js', { noBaked: true });
      R.data['1f'] = f1;
      t('[降级路径] 烘焙缺失时恶意地址仍被拒（不渲染 iframe、不入 DOM）', 'N-SEC-1',
        f1.hasIframe === false && f1.jsUrlInDom === false,
        JSON.stringify({ hasIframe: f1.hasIframe, src: f1.srcAttr, jsUrlInDom: f1.jsUrlInDom }));
      t('[降级路径] 恶意地址降级为"本卷听力暂不可用"提示', 'N-SEC-1', /本卷听力暂不可用/.test(f1.body), JSON.stringify(f1.body));
      const f2 = await probe('https://english-exam.lazynote.cn/cet6/paper/2026-06-1/?f=w', 'fallback-legit', { noBaked: true });
      R.data['1g'] = f2;
      t('[降级路径] 烘焙缺失时白名单地址渲染 iframe，src 已换成听力专项页', 'N-SEC-1',
        f2.hasIframe === true && f2.srcAttr === want, 'src=' + JSON.stringify(f2.srcAttr));

      t('全程无 JS 报错', 'N-SEC-1', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 2) N-UI-1 深色模式按钮对比度 ============== */
    log('\n============== 2) N-UI-1 深色模式文字对比度（≥4.5:1）==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([listenItem()]) }));
      await page.evaluate(() => document.getElementById('themeBtn').click()); // 切深色
      await page.waitForTimeout(200);
      const preQuiz = await page.evaluate(() => {
        function px(s) { return (String(s).match(/[\d.]+/g) || []).map(Number).slice(0, 3); }
        function al(s) { const m = (String(s).match(/[\d.]+/g) || []).map(Number); return m.length >= 4 ? m[3] : 1; }
        function rel(c) { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
        function bgOf(el) { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (px(c).length >= 3 && al(c) > 0.5) return c; n = n.parentElement; } return 'rgb(255,255,255)'; }
        function ratio(el) { if (!el) return null; const cs = getComputedStyle(el); const bg = bgOf(el); const a = rel(px(cs.color)), b = rel(px(bg)); const hi = Math.max(a, b), lo = Math.min(a, b); return { sel: String(el.className || el.tagName), color: cs.color, bg: bg, r: +((hi + 0.05) / (lo + 0.05)).toFixed(2) }; }
        return {
          dark: document.body.classList.contains('dark'),
          navOn: ratio(document.querySelector('nav button.on')),
          navOff: ratio(document.querySelector('nav button:not(.on)')),
          navBg: getComputedStyle(document.querySelector('nav')).backgroundColor,
          ghost: ratio(document.querySelector('#extraBtns .btn.ghost')),
          soapBtn: ratio(document.getElementById('floorBtn')),
        };
      });
      await openFirst(page);
      const disBtn = await page.evaluate(() => { const el = document.getElementById('groupSubmit'); return el ? { disabled: el.disabled, text: el.textContent, bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color } : null; });
      // 故意选一个错选项 + 其余选对，保证 .opt.right / .opt.wrongpick 都出现
      const picks = await page.evaluate(({ lq }) => {
        const C = window.CET6Core, B = window.CET6_BANKS;
        const out = [];
        lq.forEach((id, i) => {
          const q = C.findQ(B, id);
          const letters = (q.options || []).map((_, j) => String.fromCharCode(65 + j));
          const wrong = letters.find(x => x !== q.answer) || letters[0];
          out.push(i === 0 ? wrong : q.answer);
        });
        return out;
      }, { lq: LQ });
      for (let i = 0; i < LQ.length; i++) {
        await page.evaluate(({ qid, v }) => {
          const b = document.querySelector('#quizBody .opt[data-q="' + qid + '"][data-v="' + v + '"]');
          if (b) b.click();
        }, { qid: LQ[i], v: picks[i] });
      }
      await page.waitForTimeout(200);
      const beforeSubmit = await page.evaluate(() => {
        const el = document.getElementById('groupSubmit');
        return el ? { disabled: el.disabled, bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color } : null;
      });
      await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b) b.click(); });
      await page.waitForTimeout(600);
      const res = await page.evaluate(() => {
        function rel(c) { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
        function px(s) { const m = (String(s).match(/[\d.]+/g) || []).map(Number); return m.slice(0, 3); }
        function alpha(s) { const m = (String(s).match(/[\d.]+/g) || []).map(Number); return m.length >= 4 ? m[3] : 1; }
        function bgOf(el) { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (px(c).length >= 3 && alpha(c) > 0.5) return c; n = n.parentElement; } return 'rgb(255,255,255)'; }
        function ratio(el) { if (!el) return null; const cs = getComputedStyle(el); const bg = bgOf(el); const a = rel(px(cs.color)), b = rel(px(bg)); const hi = Math.max(a, b), lo = Math.min(a, b); return { sel: el.className || el.tagName, color: cs.color, bg: bg, r: +((hi + 0.05) / (lo + 0.05)).toFixed(2) }; }
        const q = document.querySelector.bind(document);
        return {
          dark: document.body.classList.contains('dark'),
          opt: ratio(q('#quizBody .opt')),
          optSel: (function () { const el = q('#quizBody .opt'); if (!el) return null; el.classList.add('sel'); const r = ratio(el); el.classList.remove('sel'); return r; })(),
          optRight: ratio(q('#quizBody .opt.right')),
          optWrong: ratio(q('#quizBody .opt.wrongpick')),
          navOn: ratio(q('nav button.on')),
          navOff: ratio(document.querySelector('nav button:not(.on)')),
          btn: ratio(document.querySelector('#groupDone') || q('#quizBody .btn')),
          btnGhost: ratio(document.querySelector('#quizBody .btn.ghost')),
          verdictOk: ratio(q('#quizBody .verdict.ok')),
          pt: ratio(q('#quizBody .analysis .pt')),
          counts: { right: document.querySelectorAll('#quizBody .opt.right').length, wrong: document.querySelectorAll('#quizBody .opt.wrongpick').length, opt: document.querySelectorAll('#quizBody .opt').length },
        };
      });
      R.data['2'] = Object.assign({ preQuiz, disBtn, beforeSubmit }, res);
      t('已处于深色模式', 'N-UI-1', res.dark === true, '');
      t('.opt 前景=--ink（不再是 UA 黑）', 'N-UI-1', res.opt && /226, 232, 240/.test(res.opt.color), JSON.stringify(res.opt));
      t('.opt 对比度 ≥4.5（原 1.44）', 'N-UI-1', res.opt && res.opt.r >= 4.5, 'r=' + (res.opt && res.opt.r));
      t('.opt.sel 对比度 ≥4.5', 'N-UI-1', res.optSel && res.optSel.r >= 4.5, JSON.stringify(res.optSel));
      t('.opt.right 对比度 ≥4.5 且确实渲染出对错两种状态', 'N-UI-1', res.optRight && res.optRight.r >= 4.5 && res.counts.right > 0 && res.counts.wrong > 0, JSON.stringify(res.counts));
      t('.opt.wrongpick 对比度 ≥4.5', 'N-UI-1', res.optWrong && res.optWrong.r >= 4.5, JSON.stringify(res.optWrong));
      t('nav 激活项对比度 ≥4.5（原 2.72）', 'N-UI-1', preQuiz.navOn && preQuiz.navOn.r >= 4.5, JSON.stringify(preQuiz.navOn));
      t('nav 未激活项对比度 ≥4.5', 'N-UI-1', preQuiz.navOff && preQuiz.navOff.r >= 4.5, JSON.stringify(preQuiz.navOff));
      t('.btn 对比度 ≥4.5', 'N-UI-1', preQuiz.soapBtn && preQuiz.soapBtn.r >= 4.5, JSON.stringify(preQuiz.soapBtn));
      t('.btn.ghost 对比度 ≥4.5（深色下原为白底蓝字）', 'N-UI-1', preQuiz.ghost && preQuiz.ghost.r >= 4.5, JSON.stringify(preQuiz.ghost));
      t('.btn:disabled 对比度 ≥4.5（深色下原为灰底黑字）', 'N-UI-1', disBtn && disBtn.disabled === true && (function () { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; const g = s => (s.match(/[\d.]+/g) || []).map(Number).slice(0, 3); const rl = c => 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); const a = rl(g(disBtn.bg)), b = rl(g(disBtn.color)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5; })(), JSON.stringify(disBtn));
      t('考点标签 .pt 对比度 ≥4.5', 'N-UI-1', !res.pt || res.pt.r >= 4.5, JSON.stringify(res.pt));
      t('无 JS 报错', 'N-UI-1', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 3) N-UI-2 finishItem 幂等 ============== */
    log('\n============== 3) N-UI-2 “完成”按钮幂等（连点只计一次）==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const answers = {}; LQ.forEach(id => { answers[id] = 'A'; });
      await boot(page, baseState({
        plan: planWith([listenItem({ judged: true, rightCount: 2, answers: answers })]),
        history: { [TODAY]: { minutes: 0, done: false, floor: false, qCount: 0, right: 0, timed: 0, timedWithin: 0, timedSec: 0 } },
      }));
      await openFirst(page);
      const hasDone = await page.evaluate(() => !!document.getElementById('groupDone'));
      const perOnce = await page.evaluate(() => { const C = window.CET6Core; return C.TYPE_META.listening.minPerQ * 4; });
      const clicks = await page.evaluate(() => {
        const b = document.getElementById('groupDone');
        if (!b) return { err: 'no groupDone' };
        b.click(); b.click(); b.click(); // 同步连点 3 次（最狠的重入路径）
        return { ok: true };
      });
      await page.waitForTimeout(500);
      const st = await stateOf(page);
      const res = {
        hasDone, perOnce, clicks, minutes: st && st.history && st.history[TODAY] ? st.history[TODAY].minutes : null,
        done: st && st.plan && st.plan.items[0] ? st.plan.items[0].done : null,
        toast: await toastText(page),
      };
      R.data['3'] = res;
      t('进入已判分组后有“完成，返回今日”按钮', 'N-UI-2', res.hasDone === true, '');
      t('连点 3 次只计入一次分钟数', 'N-UI-2', res.minutes === res.perOnce, 'minutes=' + res.minutes + ' 期望=' + res.perOnce);
      t('清单条目被标记完成', 'N-UI-2', res.done === true, 'done=' + res.done);
      t('提示为成功文案（不是保存失败文案）', 'N-UI-2', /(本组完成 \+|清单全部完成)/.test(res.toast) && !/保存失败/.test(res.toast), JSON.stringify(res.toast));
      t('无 JS 报错', 'N-UI-2', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 4) N-UI-3 判分后刷新不可重复判分 ============== */
    log('\n============== 4) N-UI-3 判分结果持久化（刷新后不重复判分）==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([listenItem()]) }));
      await openFirst(page);
      const picks = await page.evaluate(({ lq }) => lq.map(id => window.CET6Core.findQ(window.CET6_BANKS, id).answer), { lq: LQ });
      for (let i = 0; i < LQ.length; i++) {
        await page.evaluate(({ qid, v }) => { const b = document.querySelector('#quizBody .opt[data-q="' + qid + '"][data-v="' + v + '"]'); if (b) b.click(); }, { qid: LQ[i], v: picks[i] });
      }
      await page.waitForTimeout(200);
      await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b) b.click(); });
      await page.waitForTimeout(700);
      const st1 = await stateOf(page);
      const seen1 = LQ.map(id => (st1.papers[id] || {}).seen);
      const item1 = st1.plan.items[0];
      R.data['4a'] = { seen: seen1, judged: item1.judged, rightCount: item1.rightCount, answers: item1.answers, hasDraft: !!item1.draft };
      t('判分后 plan 条目落盘 judged/rightCount/answers', 'N-UI-3', item1.judged === true && item1.rightCount === 4 && item1.answers && Object.keys(item1.answers).length === 4, JSON.stringify(R.data['4a']));
      t('判分后草稿已清空（不再落在条目上）', 'N-UI-3', !item1.draft, 'draft=' + JSON.stringify(item1.draft));
      t('首次判分 papers[].seen=1', 'N-UI-3', seen1.join(',') === '1,1,1,1', seen1.join(','));
      // 刷新后重进同一组
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(800);
      await openFirst(page, 900);
      const after = await page.evaluate(() => ({
        hasSubmit: !!document.getElementById('groupSubmit'),
        hasDone: !!document.getElementById('groupDone'),
        prog: (document.getElementById('quizProg') || {}).textContent || '',
        bar: (document.getElementById('groupBar') || {}).innerText.replace(/\s+/g, ' ') || '',
        right: document.querySelectorAll('#quizBody .opt.right').length,
        sel: document.querySelectorAll('#quizBody .opt.sel').length,
        opt: document.querySelectorAll('#quizBody .opt').length,
      }));
      const st2 = await stateOf(page);
      const seen2 = LQ.map(id => (st2.papers[id] || {}).seen);
      R.data['4b'] = { after, seen: seen2 };
      t('刷新后进入的是“已判分”只读视图（无提交按钮）', 'N-UI-3', after.hasSubmit === false && after.hasDone === true, JSON.stringify(after));
      t('刷新后恢复当时作答（选项标记恢复）', 'N-UI-3', after.right === 4 && after.opt === 16, 'right=' + after.right + ' opt=' + after.opt);
      t('刷新后 papers[].seen 仍为 1（未重复判分）', 'N-UI-3', seen2.join(',') === '1,1,1,1', seen2.join(','));
      t('进度条文案含“已判分”', 'N-UI-3', /已判分/.test(after.prog), JSON.stringify(after.prog));
      t('无 JS 报错', 'N-UI-3', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 5) N-SEC-2 存储被禁时的登录 ============== */
    log('\n============== 5) N-SEC-2 存储被禁（SecurityError）时的登录死路 ==============');
    {
      const init = () => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); } }); };
      const { ctx, page, logs } = await newCtx(browser, init);
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForTimeout(1300);
      const first = await page.evaluate(() => ({ mask: !!document.getElementById('loginMask'), warn: (document.getElementById('saveWarn') || {}).textContent || '', body: document.body.innerText.trim().slice(0, 60) }));
      t('存储被禁时不白屏、出现登录层', 'N-SEC-2', first.mask === true && first.body.length > 5, JSON.stringify(first));
      t('出现存储不可用横幅', 'N-SEC-2', /禁止本地存储/.test(first.warn), JSON.stringify(first.warn));
      const attempts = [];
      for (let i = 0; i < 2; i++) {
        const n = await page.locator('#phoneInput').count();
        if (!n) break;
        await page.locator('#phoneInput').fill(i === 0 ? '1001' : '1001');
        await page.locator('#loginBtn').click();
        await page.waitForTimeout(900);
        attempts.push({
          stillMask: await page.evaluate(() => !!document.getElementById('loginMask')),
          cards: await page.locator('#planList .card').count(),
          minutes: await minutesTxt(page),
          alerts: logs.dialog.length,
        });
        if (!attempts[attempts.length - 1].stillMask) break;
      }
      R.data['5'] = { first, attempts };
      t('内存兜底模式下点“开始学习”能直接进入应用（不再 reload 空转）', 'N-SEC-2', attempts.length > 0 && attempts[0].stillMask === false && attempts[0].cards > 0, JSON.stringify(attempts));
      t('进入后没有弹“不允许保存数据”的 alert（写入被读回校验通过）', 'N-SEC-2', attempts[0].alerts === 0, JSON.stringify(attempts[0]));
      // 原地登录后绑定是否真的生效：切主题 + 点加练
      const bound = await page.evaluate(() => { document.getElementById('themeBtn').click(); return document.body.classList.contains('dark'); });
      const beforeCards = await page.locator('#planList .card').count();
      await page.locator('#extraBtns button').first().click();
      await page.waitForTimeout(600);
      const afterCards = await page.locator('#planList .card').count();
      const tst = await toastText(page);
      R.data['5b'] = { bound, beforeCards, afterCards, toast: tst };
      t('原地登录后事件绑定有效（主题切换生效）', 'N-SEC-2', bound === true, '');
      t('原地登录后加练按钮有效（清单新增一组）', 'N-SEC-2', afterCards > beforeCards && /已加入一组/.test(tst), JSON.stringify(R.data['5b']));
      t('无 JS 报错', 'N-SEC-2', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 6) N-SEC-3 plan 幽灵 qid ============== */
    log('\n============== 6) N-SEC-3 plan.items 幽灵 qid 清理 ==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({
        plan: planWith([
          { key: 'ghost-1', type: 'reading', qids: ['ghost-9999-r-1', 'ghost-9999-r-2'], paperId: PAPER, label: '幽灵组', done: false, minutes: 0 },
          { key: 'real-1', type: 'reading', qids: ['2026-06-1-r-46'], paperId: PAPER, label: '正常组', done: false, minutes: 0 },
        ]),
      }));
      const shown = await page.evaluate(() => ({ cards: document.querySelectorAll('#planList .card').length, text: document.getElementById('planList').innerText, summary: document.getElementById('planSummary').textContent }));
      const st = await stateOf(page);
      const keys = (st.plan.items || []).map(x => x.key + ':' + x.qids.join(','));
      R.data['6'] = { shown: { cards: shown.cards, summary: shown.summary }, keys, ghostText: /幽灵组/.test(shown.text) };
      t('幽灵 qid 组在载入时被删除（不再出现 0 题组）', 'N-SEC-3', !/幽灵组/.test(shown.text) && keys.join('|') === 'real-1:2026-06-1-r-46', JSON.stringify(R.data['6']));
      t('正常组保留', 'N-SEC-3', shown.cards === 1 && /正常组/.test(shown.text), JSON.stringify(shown.summary));
      await openFirst(page, 800);
      const quiz = await page.evaluate(() => ({ opt: document.querySelectorAll('#quizBody .opt').length, submit: !!document.getElementById('groupSubmit') }));
      t('正常组可作答（有选项、有提交按钮）', 'N-SEC-3', quiz.opt > 0 && quiz.submit === true, JSON.stringify(quiz));
      t('无 JS 报错', 'N-SEC-3', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 7) N-SEC-4 csvEsc 裸 \r ============== */
    log('\n============== 7) N-SEC-4 错题 CSV 不含裸 \\r ==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({
        plan: planWith([listenItem()]),
        papers: { '2026-06-1-r-46': { seen: 1, right: 0, lastAnswer: 'A' } },
        wrongbook: { '2026-06-1-r-46': { box: 0, wrongCount: 1, addedAt: TODAY, due: TODAY, ease: 2.5, iv: 1, streak: 0 } },
      }));
      const patched = await (async () => {
        await ensureBank(page, '2026-06-1'); // R4-M5：首屏 BANKS=0，先注入卷再找题改题干
        return page.evaluate(() => {
          const q = window.CET6Core.findQ(window.CET6_BANKS, '2026-06-1-r-46');
          q.stem = 'LINE-ONE\rLINE-TWO "quoted"';
          return q.stem;
        });
      })();
      await page.evaluate(() => { const b = document.querySelector('nav button[data-p="backup"]'); if (b) b.click(); });
      await page.waitForTimeout(300);
      let csv = null;
      try {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator('#wrongCsvBtn').click()]);
        const p = await dl.path();
        csv = fs.readFileSync(p, 'utf8');
      } catch (e) { csv = 'DOWNLOAD-ERROR:' + e.message; }
      const bare = csv ? csv.replace(/\r\n/g, '').indexOf('\r') : -2;
      R.data['7'] = { patched, bareIndex: bare, row: String(csv).split('\r\n').find(x => x.indexOf('LINE-ONE') >= 0) };
      t('CSV 中不存在裸 \\r（行分隔符仅为 \\r\\n）', 'N-SEC-4', bare === -1, 'bareIndex=' + bare);
      t('题干里的 \\r 被转成空格，字段未被撑成多行', 'N-SEC-4', /LINE-ONE LINE-TWO/.test(String(csv)), JSON.stringify(R.data['7'].row));
      t('无 JS 报错', 'N-SEC-4', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 8) N-SEC-5 加练 save 失败提示 ============== */
    log('\n============== 8) N-SEC-5 加练时 save() 失败要说实话 ==============');
    {
      const init = () => {
        window.__quotaBlock = true;
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (window.__quotaBlock && String(k).indexOf('cet6_p1_state_v1') === 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          return orig.call(this, k, v);
        };
      };
      const { ctx, page, logs } = await newCtx(browser, init);
      await boot(page, baseState({
        plan: planWith([listenItem()]),
        history: { [TODAY]: { minutes: 5, done: false, floor: false, qCount: 0, right: 0, timed: 0, timedWithin: 0, timedSec: 0 } },
      }));
      const before = await page.locator('#planList .card').count();
      await page.locator('#extraBtns button').first().click();
      await page.waitForTimeout(600);
      const after = await page.locator('#planList .card').count();
      const tst = await toastText(page);
      const warn = await page.evaluate(() => (document.getElementById('saveWarn') || {}).textContent || '');
      R.data['8'] = { before, after, toast: tst, warn: warn.slice(0, 60) };
      t('落盘失败时提示语明确说明没写进本机存储', 'N-SEC-5', /没写进本机存储|刷新会丢/.test(tst), JSON.stringify(tst));
      t('不再出现“已加入一组…”的虚假成功提示', 'N-SEC-5', !/^已加入一组/.test(tst), JSON.stringify(tst));
      t('常驻横幅点亮', 'N-SEC-5', /保存失败/.test(warn), JSON.stringify(warn.slice(0, 40)));
      t('加练组本身仍出现在本次页面（不回滚副作用）', 'N-SEC-5', after > before, before + '→' + after);
      t('无 JS 报错', 'N-SEC-5', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 9) N-SEC-6 遗留 key 不再污染下一个账号 ============== */
    log('\n============== 9) N-SEC-6 切换账号不继承别人的存档 ==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const aState = baseState({ history: { [TODAY]: { minutes: 77, done: true, floor: false, qCount: 1, right: 1, timed: 0, timedWithin: 0, timedSec: 0 } }, lastBackup: '2020-01-01' });
      const legacy = JSON.stringify(baseState({ lastBackup: '2019-01-01', history: { [TODAY]: { minutes: 33, done: true, floor: false, qCount: 1, right: 1, timed: 0, timedWithin: 0, timedSec: 0 } } }));
      await page.goto(URL, { waitUntil: 'load' });
      await page.evaluate(({ a, as, lg }) => {
        localStorage.clear();
        localStorage.setItem('cet6_p1_state_v1', lg);
        localStorage.setItem('cet6_p1_state_v1_' + a, as);
        localStorage.setItem('cet6_user', a);
      }, { a: A, as: JSON.stringify(aState), lg: legacy });
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(800);
      const aMin = await minutesTxt(page);
      const legacyAfterA = await page.evaluate(() => localStorage.getItem('cet6_p1_state_v1'));
      const aStateNow = await stateOf(page, A);
      t('已登录账号自己的存档不受影响（77 分钟）', 'N-SEC-6', /77/.test(aMin), JSON.stringify(aMin));
      t('遗留 key 在该账号加载后被清理（不再留给下一个编号）', 'N-SEC-6', legacyAfterA === null && aStateNow.lastBackup === '2020-01-01', 'legacy=' + JSON.stringify(legacyAfterA) + ' lastBackup=' + (aStateNow && aStateNow.lastBackup));
      // 切到全新编号 C
      await page.evaluate(c => localStorage.setItem('cet6_user', c), C);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(900);
      const cState = await stateOf(page, C);
      const cMin = await minutesTxt(page);
      R.data['9'] = { aMin, legacyAfterA, cMin, cLastBackup: cState && cState.lastBackup, cHistoryKeys: cState ? Object.keys(cState.history || {}) : null };
      t('新编号 C 不继承旧账号/遗留数据', 'N-SEC-6', (cState ? cState.lastBackup !== '2019-01-01' && Object.keys(cState.history || {}).length === 0 : false) && /已练 0/.test(cMin), JSON.stringify(R.data['9']));
      t('无 JS 报错', 'N-SEC-6', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 10) N-UI-4 清单为 0 组的今日页 ============== */
    log('\n============== 10) N-UI-4 全部做完后今日页不再空白 ==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([]) }));
      const info = await page.evaluate(() => ({
        listText: (document.getElementById('planList') || {}).innerText.replace(/\s+/g, ' '),
        summary: (document.getElementById('planSummary') || {}).textContent || '',
        extraBtns: document.querySelectorAll('#extraBtns button').length,
        todayStatus: (document.getElementById('todayStatus') || {}).textContent || '',
      }));
      R.data['10'] = info;
      t('显示“全部题目已完成”提示而非空白', 'N-UI-4', /全部题目已完成/.test(info.listText) && /错题本|加练/.test(info.listText), JSON.stringify(info.listText));
      t('清单汇总为 0/0', 'N-UI-4', /0\/0/.test(info.summary), JSON.stringify(info.summary));
      t('加练入口仍在（4 个按钮）', 'N-UI-4', info.extraBtns === 4, 'buttons=' + info.extraBtns);
      await page.locator('#extraBtns button').first().click();
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => ({ cards: document.querySelectorAll('#planList .card').length, toast: (document.getElementById('toast') || {}).textContent || '' }));
      t('空态下的加练按钮可点（事件已绑定）', 'N-UI-4', after.cards > 0 && /已加入一组/.test(after.toast), JSON.stringify(after));
      t('无 JS 报错', 'N-UI-4', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 11) N-UI-6 高亮上限提示 ============== */
    log('\n============== 11) N-UI-6 高亮超过 50 处要提示 ==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([{ key: 'r1', type: 'reading', qids: ['2026-06-1-r-46'], paperId: PAPER, label: '阅读·整篇', done: false, minutes: 0 }]) }));
      await openFirst(page, 900);
      const info = await page.evaluate(() => {
        const p = document.querySelector('#quizBody .passage[data-pid]');
        if (!p) return { err: 'no passage' };
        const pid = p.getAttribute('data-pid');
        let html = 'PLAINTEXT-BLOCK ';
        for (let i = 0; i < 96; i++) html += '<mark class="hl">w' + i + '</mark> ';
        p.innerHTML = html;
        // 走真实路径触发 saveHl：在段落里划选文字 → 点「高亮」（内部会新建第 97 处 <mark> 再调 saveHl）
        const t0 = p.firstChild;
        const r = document.createRange();
        r.setStart(t0, 0); r.setEnd(t0, 8);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        document.querySelector('#quizBody .hl-add').click();
        return { pid, marksAfter: p.querySelectorAll('mark.hl').length, marksBefore: 96 };
      });
      await page.waitForTimeout(400);
      const st = await stateOf(page);
      const saved = st.hl ? st.hl[info.pid] : null;
      const tst = await toastText(page);
      R.data['11'] = { info, savedLen: saved ? saved.length : null, toast: tst };
      t('落盘的高亮被截到上限 50 处', 'N-UI-6', saved && saved.length === 50, 'len=' + (saved ? saved.length : null));
      t('提示用户“已达上限 50 处”', 'N-UI-6', /上限 50 处/.test(tst), JSON.stringify(tst));
      t('DOM 与存档一致（多余 <mark> 被移除）', 'N-UI-6', info.marksAfter === 50, 'marksAfter=' + info.marksAfter + '（96 处 + 新加 1 处 = 97，截到 50）');
      t('无 JS 报错', 'N-UI-6', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 12) N-CONT-1 写作题配图渲染 ============== */
    log('\n============== 12) N-CONT-1 写作题配图（writing.image）==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([{ key: 'w1', type: 'writing', qids: [], paperId: '2021-06-1', done: false, minutes: 0 }]) }));
      await ensureBank(page, '2021-06-1'); // R4-M5：首屏 BANKS=0，先注入卷再改 writing.image
      await page.evaluate(() => { const b = (window.CET6_BANKS || []).find(x => x.id === '2021-06-1'); b.writing.image = 'img/2021-06-1.jpg'; });
      await openFirst(page, 900);
      await page.waitForTimeout(800);
      const withImg = await page.evaluate(() => {
        const img = document.querySelector('#quizBody img');
        const card = document.querySelector('#quizBody .card');
        const psg = document.querySelector('#quizBody .passage');
        return {
          hasImg: !!img,
          srcAttr: img ? img.getAttribute('src') : null,
          resolved: img ? img.src : null,
          natural: img ? { w: img.naturalWidth, h: img.naturalHeight, complete: img.complete } : null,
          alt: img ? img.getAttribute('alt') : null,
          afterPassage: !!(img && psg && psg.nextElementSibling === img),
          passageText: psg ? psg.innerText.slice(0, 40) : '',
          textarea: !!document.getElementById('essayTa'),
        };
      });
      R.data['12a'] = withImg;
      t('写作题面下方渲染出配图', 'N-CONT-1', withImg.hasImg === true && withImg.afterPassage === true, JSON.stringify(withImg));
      t('src 为相对路径 bank/img/<卷号>.jpg', 'N-CONT-1', withImg.srcAttr === 'bank/img/2021-06-1.jpg' && /\/app\/bank\/img\/2021-06-1\.jpg$/.test(withImg.resolved || ''), JSON.stringify({ srcAttr: withImg.srcAttr, resolved: withImg.resolved }));
      t('图片文件真的加载成功（naturalWidth>0）', 'N-CONT-1', !!(withImg.natural && withImg.natural.w > 0), JSON.stringify(withImg.natural));
      t('题面文字与答题框仍在', 'N-CONT-1', withImg.passageText.length > 5 && withImg.textarea === true, JSON.stringify({ p: withImg.passageText, ta: withImg.textarea }));
      // 无 image 字段时不渲染 img（向后兼容旧题库）
      await back(page);
      await page.evaluate(() => { const b = (window.CET6_BANKS || []).find(x => x.id === '2021-06-1'); delete b.writing.image; });
      await openFirst(page, 900);
      const noImg = await page.evaluate(() => ({ hasImg: !!document.querySelector('#quizBody img'), hasTa: !!document.getElementById('essayTa') }));
      R.data['12b'] = noImg;
      t('题库没有 writing.image 时保持原样（不渲染 img）', 'N-CONT-1', noImg.hasImg === false && noImg.hasTa === true, JSON.stringify(noImg));
      fact('app/bank/img 现存图片', (function () { try { return fs.readdirSync(path.join(APP, 'bank', 'img')); } catch (e) { return 'MISSING'; } })());
      fact('76 卷中带 writing.image 的卷数（内容代理落盘进度）', (function () {
        const dir = path.join(APP, 'bank'); let n = 0;
        fs.readdirSync(dir).filter(f => /^cet6-.*\.js$/.test(f)).forEach(f => { if (/image\s*:/.test(fs.readFileSync(path.join(dir, f), 'utf8'))) n++; });
        return n;
      })());
      t('无 JS 报错', 'N-CONT-1', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ============== 13) N-UI-5 计时器墙钟基准 ============== */
    log('\n============== 13) N-UI-5 计时器按墙钟（主线程阻塞不再拖慢）==============');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ plan: planWith([listenItem()]) }));
      await openFirst(page);
      const t0 = (await page.locator('#quizTimer').textContent()).trim();
      const before = Date.now();
      await page.evaluate(() => { const end = Date.now() + 5000; while (Date.now() < end) { } }); // 阻塞主线程 5s
      const blocked = (Date.now() - before) / 1000;
      await page.waitForTimeout(1400); // 等一次 tick
      const wall = (Date.now() - before) / 1000;
      const t1 = (await page.locator('#quizTimer').textContent()).trim();
      const sec = s => { const m = /(\d\d):(\d\d)/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
      const d0 = sec(t0), d1 = sec(t1);
      const shown = d0 != null && d1 != null ? d0 - d1 : null;
      R.data['13'] = { t0, t1, blocked: +blocked.toFixed(1), wall: +wall.toFixed(1), shownDelta: shown };
      t('阻塞主线程后倒计时仍按真实时间推进（旧实现按 tick 计数会明显偏慢）', 'N-UI-5',
        shown != null && Math.abs(shown - wall) <= 2, '真实过 ' + wall.toFixed(1) + 's，计时器走了 ' + shown + 's（旧实现实测只走约 2s）');
      t('无 JS 报错', 'N-UI-5', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    const failed = R.cases.filter(c => !c.pass);
    R.summary = { total: R.cases.length, fail: failed.length, failed: failed.map(f => f.group + ' · ' + f.name + ' → ' + f.detail) };
    log('\n================ 汇总 ================');
    log('  检查项 ' + R.cases.length + ' 条；未通过 ' + failed.length);
    failed.forEach(f => log('   ✗ ' + f.group + ' · ' + f.name + ' → ' + f.detail));
    try {
      fs.writeFileSync(path.join(DOCS, 'verify-fixes-result.json'), JSON.stringify(R, null, 2), 'utf8');
      fs.writeFileSync(path.join(DOCS, 'verify-fixes-log.txt'), LINES.join('\n'), 'utf8');
    } catch (e) { log('(写结果文件失败: ' + e.code + ')'); }
    await browser.close();
    log('\n已写出 docs/verify-fixes-result.json 与 docs/verify-fixes-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'verify-fixes-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  }
})();
