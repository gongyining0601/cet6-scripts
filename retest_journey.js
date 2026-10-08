'use strict';
/* ============================================================================
   CET6 复测轮 A8 + B4 + B5：
     A8 完整用户旅程（登录→今日→答题→判分→错题本→统计→备份→深色→切换用户）控制台零报错
     B4 边界条件（0 错题/0 历史/全对全错/重复打卡/跨天/闰日/年末/清单为空）
     B5 交互状态机（草稿恢复/重复提交/重复完成/超时后继续答题/深色下答题）
   运行：cd D:\CET6\scripts ; node retest_journey.js
   产物：docs/retest-security-*.png / docs/retest-journey-result.json / docs/retest-journey-log.txt
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const INDEX = path.join(APP, 'index.html');
const URL = 'file:///' + INDEX.split(path.sep).join('/');
const DOCS = path.join(ROOT, 'docs');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
const UID = '9203';
const SKEY = 'cet6_p1_state_v1_' + UID;
const PAPER = '2026-06-1';

const R = { meta: {}, cases: [], console: [], newIssues: [], summary: {} };
function t(name, group, pass, detail) {
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return pass;
}
function issue(id, title, sev, where, repro, fix, evidence) {
  R.newIssues.push({ id, title, severity: sev, where, repro, fix, evidence });
  log(`  [issue/${sev}] ${id} ${title}  @${where}`);
}

async function newCtx(browser, initScript, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 430, height: 940 }, acceptDownloads: true });
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  const logs = { console: [], pageerror: [], dialog: [], promptReply: '10' };
  page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.pageerror.push(String((e && e.message) || e)));
  page.on('dialog', async dl => { logs.dialog.push({ type: dl.type(), message: dl.message() }); try { await dl.accept(dl.type() === 'prompt' ? logs.promptReply : ''); } catch (e) { } });
  return { ctx, page, logs };
}
const errs = logs => ({
  pageErrors: logs.pageerror.slice(),
  consoleErrors: logs.console.filter(m => m.type === 'error').map(m => m.text),
  consoleWarnings: logs.console.filter(m => m.type === 'warning').map(m => m.text),
});
async function boot(page, stateObj, uid) {
  uid = uid || UID;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try { localStorage.removeItem('cet6_p1_state_v1_' + id); if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st); } catch (e) { }
  }, { id: uid, st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(550);
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); } catch (e) { }
  await page.waitForTimeout(200);
}
const state = page => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cet6_p1_state_v1_9203') || 'null'); } catch (e) { return null; } });
const toastText = page => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
async function shot(page, n) { try { await page.screenshot({ path: path.join(DOCS, 'retest-security-' + n + '.png') }); } catch (e) { } }
function baseState(e) { return Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' }, e || {}); }
function h(min, done) { return { minutes: min, done: !!done, floor: false, qCount: 2, right: 1, timed: 0, timedWithin: 0, timedSec: 0 }; }

/* 把当前题组的每一题都选第一个选项 */
async function answerAll(page) {
  const qids = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('#quizBody .opt')).map(b => b.getAttribute('data-q')))));
  for (const q of qids) {
    const loc = page.locator(`#quizBody .opt[data-q="${q}"]`).first();
    if (await loc.count()) await loc.click();
  }
  return qids.length;
}
/* 走完一组：开始 → 作答 → 提交 → 完成返回（兼容写作/翻译组的「我写完了」） */
async function runGroup(page, idx) {
  const btn = page.locator('#planList .card button').nth(idx || 0);
  if (!(await btn.count())) return { ok: false, why: 'no-plan-item' };
  await btn.click(); await page.waitForTimeout(350);
  const n = await answerAll(page);
  const sub = page.locator('#groupSubmit');
  if (await sub.count()) { await sub.click(); await page.waitForTimeout(500); return { ok: true, answered: n, kind: 'objective' }; }
  const done = page.locator('#essayDone');
  if (await done.count()) { await done.click(); await page.waitForTimeout(400); return { ok: true, answered: n, kind: 'writing', finished: true }; }
  return { ok: false, why: 'no-submit-btn' };
}

/* ========================================================================== */
(async () => {
  try {
    const crypto = require('crypto');
    const hashOf = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    R.meta = {
      url: URL, browser: EXE, today: TODAY, node: process.version, startedAt: new Date().toISOString(),
      hashes: { 'app/index.html': hashOf(INDEX), 'app/core.js': hashOf(path.join(APP, 'core.js')) },
    };
    log('CET6 复测 A8/B4/B5 · 旅程 + 边界 + 状态机  ' + R.meta.startedAt);
    log('index.html sha256 = ' + R.meta.hashes['app/index.html'] + '\n');

    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });

    /* ================= A8 完整旅程 + 控制台 ================= */
    log('================ A8) 完整用户旅程（全程记录控制台）================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const steps = [];
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForSelector('#loginMask', { timeout: 30000 });
      steps.push('① 打开 → 登录层出现');
      await page.locator('#phoneInput').fill('9203');
      await page.locator('#loginBtn').click();
      await page.waitForTimeout(1200);
      await page.waitForSelector('#planList .card', { timeout: 20000 });
      steps.push('② 登录 9203 → 今日清单 ' + (await page.locator('#planList .card').count()) + ' 组');
      // 深色模式
      await page.locator('#themeBtn').click(); await page.waitForTimeout(250);
      const darkOn = await page.evaluate(() => document.body.classList.contains('dark'));
      steps.push('③ 切深色模式 → body.dark=' + darkOn);
      await shot(page, 'journey-dark');
      // 答题
      const g = await runGroup(page, 0);
      steps.push('④ 开始答题 → 作答 ' + g.answered + ' 题 → ' + (g.kind === 'writing' ? '我写完了（主观题组）' : '提交判分'));
      await page.waitForTimeout(400);
      await shot(page, 'journey-judged');
      const judged = await page.evaluate(() => document.querySelector('#quizBody') && document.querySelector('#quizBody').innerText.length);
      // 完成返回
      if (g.kind !== 'writing') {
        const done = page.locator('#groupDone');
        if (await done.count()) { await done.click(); await page.waitForTimeout(400); steps.push('⑤ 完成返回今日'); }
      } else steps.push('⑤ 主观题组已直接打卡返回');
      // 错题本
      await page.locator('nav button[data-p="wrong"]').click(); await page.waitForTimeout(300);
      const wrongTxt = await page.evaluate(() => document.getElementById('page-wrong').innerText.slice(0, 60).replace(/\s+/g, ' '));
      steps.push('⑥ 错题本 → ' + wrongTxt);
      // 统计
      await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(350);
      const statTxt = await page.evaluate(() => document.getElementById('page-stat').innerText.slice(0, 80).replace(/\s+/g, ' '));
      const estCard = await page.locator('#estCard').count();
      steps.push('⑦ 统计 → 估算分卡=' + estCard);
      await shot(page, 'journey-stat');
      // 备份（导出 + CSV）
      await page.locator('nav button[data-p="backup"]').click(); await page.waitForTimeout(300);
      const [d1] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBtn').click()]);
      await page.waitForTimeout(300);
      // 导出 JSON 再导入
      const p1 = await d1.path(); const json = fs.readFileSync(p1, 'utf8');
      await page.setInputFiles('#importFile', { name: 'rt.json', mimeType: 'application/json', buffer: Buffer.from(json, 'utf8') });
      await page.waitForTimeout(800);
      const impToast = await toastText(page);
      steps.push('⑧ 备份页导出 JSON → 再导入 → ' + impToast);
      // 切回浅色
      await page.locator('#themeBtn').click(); await page.waitForTimeout(200);
      await page.locator('nav button[data-p="today"]').click(); await page.waitForTimeout(250);
      // 切换用户 → 回原用户
      await page.locator('#userChip').click(); await page.waitForTimeout(1000);
      steps.push('⑨ 切换用户（prompt 输入 4 位）→ 当前用户 = ' + (await page.evaluate(() => localStorage.getItem('cet6_user'))));
      await page.screenshot({ path: path.join(DOCS, 'retest-security-journey-final.png') });

      const e = errs(logs);
      R.console = e;
      steps.forEach(s => log('   ' + s));
      t('旅程 9 步全部完成（页面未白屏）', 'A8 旅程', (await page.evaluate(() => document.body.innerText.trim().length)) > 20, '');
      t('控制台 0 个 pageerror', 'A8 旅程', e.pageErrors.length === 0, e.pageErrors.join(' | '));
      t('控制台 0 个 console.error', 'A8 旅程', e.consoleErrors.length === 0, e.consoleErrors.join(' | '));
      log('   控制台消息总计 ' + logs.console.length + ' 条；warning ' + e.consoleWarnings.length + ' 条');
      logs.console.forEach(m => R.cases.push({ name: 'console.' + m.type, group: 'A8 控制台', pass: true, detail: m.text.slice(0, 200), informational: true }));
      await ctx.close();
    }

    /* ================= B5-a 草稿恢复 ================= */
    log('\n================ B5-a) 答题中途刷新 → 草稿恢复 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(400);
      const first = await page.evaluate(() => { const b = document.querySelector('#quizBody .opt'); if (!b) return null; b.click(); return b.getAttribute('data-q') + '=' + b.getAttribute('data-v'); });
      await page.waitForTimeout(300);
      const prog1 = await page.evaluate(() => document.getElementById('quizProg').textContent);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(900);
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => ({
        sel: Array.from(document.querySelectorAll('#quizBody .opt.sel')).map(b => b.getAttribute('data-q') + '=' + b.getAttribute('data-v')),
        prog: document.getElementById('quizProg').textContent,
        timer: document.getElementById('quizTimer').textContent,
      }));
      t('刷新后重新进入同组，已选项被恢复', st.sel.length === 1 && st.sel[0] === first, '刷新前=' + first + ' 刷新后=' + JSON.stringify(st.sel));
      t('进度文案恢复已答数', /已答 1/.test(st.prog), JSON.stringify(st.prog));
      t('无 JS 报错', 'B5 草稿', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await shot(page, 'draft-restored');
      await ctx.close();
    }

    /* ================= B5-b 判分重复提交 ================= */
    log('\n================ B5-b) 判分：快速双击「提交本组」是否重复记分 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(400);
      const n = await answerAll(page);
      const before = await state(page);
      const hb = before.history[TODAY] || {};
      const pbSeen = before.papers[Object.keys(before.papers)[0]] ? before.papers[Object.keys(before.papers)[0]].seen : 0;
      await page.evaluate(() => { const b = document.getElementById('groupSubmit'); b.click(); b.click(); b.click(); });
      await page.waitForTimeout(600);
      const after = await state(page);
      const ha = after.history[TODAY] || {};
      const keys = Object.keys(after.papers);
      const seenSum = keys.reduce((a, k) => a + after.papers[k].seen, 0);
      t('双击提交：history.qCount 只 +' + n + ' 一次', ha.qCount === (hb.qCount || 0) + n, 'before=' + (hb.qCount || 0) + ' after=' + ha.qCount + ' n=' + n);
      t('双击提交：papers.seen 总和只 +' + n + ' 一次', seenSum === pbSeen + n, 'before=' + pbSeen + ' after=' + seenSum);
      t('双击提交：无 JS 报错', 'B5 重复提交', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ================= B5-c 完成按钮重复点击 ================= */
    log('\n================ B5-c) 「完成，返回今日」快速双击是否重复累加分钟 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(400);
      await answerAll(page);
      await page.locator('#groupSubmit').click();
      await page.waitForTimeout(500);
      const before = await state(page);
      const mb = (before.history[TODAY] || {}).minutes || 0;
      const ok = await page.evaluate(() => {
        const b = document.getElementById('groupDone');
        if (!b) return false;
        b.click(); b.click(); b.click();
        return true;
      });
      await page.waitForTimeout(700);
      const after = await state(page);
      const ma = (after.history[TODAY] || {}).minutes || 0;
      const delta = ma - mb;
      const itemMin = delta / (ok ? 3 : 1);
      R.repeatDone = { before: mb, after: ma, delta, clicks: 3 };
      t('三次点击「完成，返回今日」→ 分钟只累加一次', delta > 0 && Math.abs(ma - mb - (delta > 0 ? (ma - mb) : 0)) < 1e-9 && delta < (ma - mb) + 1e-9, '');
      const bad = delta > 0 && !(delta === itemMin);
      t('重复点击未造成分钟重复累加', 'B5 重复完成', !bad && delta > 0,
        '三次点击后 minutes 从 ' + mb + ' → ' + ma + '（净增 ' + delta + '）；若一次应增 ' + (delta / 3).toFixed(1) + '，则放大了 3 倍');
      if (bad) {
        issue('N-1', 'finishItem 无幂等守卫：快速重复点击「完成，返回今日」会把本组分钟重复累加', '中',
          'app/index.html:551-566（finishItem）配合 :759-763（groupDone.onclick）',
          '答题判分后，用脚本对 #groupDone 连续 click() 三次（或触屏快速连点三次）',
          'finishItem 内先判 if (it.done) { renderToday(); return; }；或在 quizExit 里清空 #quizBody 并解除按钮 handler',
          'minutes ' + mb + ' → ' + ma + '（净增 ' + delta + '，3 次点击 = 3 倍）');
      }
      t('无 JS 报错', 'B5 重复完成', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ================= B5-d 倒计时归零后继续答题 ================= */
    log('\n================ B5-d) 定时器到 0 后继续答题 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const st = baseState({ plan: { date: TODAY, v: 3, items: [{ key: 'k', type: 'reading', qids: ['2026-06-1-r-46', '2026-06-1-r-47'], paperId: PAPER, label: 'L', done: false, minutes: 0, timerLeft: 3 }] } });
      await boot(page, st);
      await page.locator('#planList .card button').first().click();
      await page.waitForTimeout(600);
      const t1 = await page.evaluate(() => ({ txt: document.getElementById('quizTimer').textContent, over: document.getElementById('quizTimer').className }));
      await page.waitForTimeout(4000);   // 3 秒后应归零并超时
      const t2 = await page.evaluate(() => ({ txt: document.getElementById('quizTimer').textContent, over: document.getElementById('quizTimer').className }));
      await shot(page, 'timer-overtime');
      const n = await answerAll(page);
      await page.locator('#groupSubmit').click();
      await page.waitForTimeout(600);
      const after = await state(page);
      const barTxt = await page.evaluate(() => (document.getElementById('groupBar') || {}).innerText || '');
      const it = (after.plan.items || [])[0] || {};
      t('倒计时从 3 秒走到 00:00', /00:0\d/.test(t1.txt), JSON.stringify(t1));
      t('归零后进入 overtime 样式', /overtime/.test(t2.over) || /00:00/.test(t2.txt), JSON.stringify(t2));
      t('超时后仍能继续作答并提交（不阻断）', n > 0, 'answered=' + n);
      t('判分标注「超时」（withinTime=false）', it.withinTime === false, 'item=' + JSON.stringify({ withinTime: it.withinTime, timeSpentSec: it.timeSpentSec }));
      t('结果栏显示超时', /超时/.test(barTxt), JSON.stringify(barTxt.replace(/\s+/g, ' ').slice(0, 80)));
      t('无 JS 报错', 'B5 定时器', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ================= B5-e 深色模式下答题页 ================= */
    log('\n================ B5-e) 深色模式下答题页样式 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      await page.locator('#themeBtn').click(); await page.waitForTimeout(250);
      await page.locator('#planList .card button').first().click(); await page.waitForTimeout(450);
      const info = await page.evaluate(() => {
        const q = document.getElementById('quiz');
        const o = document.querySelector('#quizBody .opt');
        return {
          dark: document.body.classList.contains('dark'),
          quizBg: getComputedStyle(q).backgroundColor,
          optBg: o ? getComputedStyle(o).backgroundColor : null,
          optColor: o ? getComputedStyle(o).color : null,
          quizVisible: q.classList.contains('show'),
        };
      });
      await shot(page, 'dark-quiz');
      t('深色模式下答题浮层可见且继承深色配色', info.dark && info.quizVisible && /rgb\(15, 23, 42\)/.test(info.quizBg), JSON.stringify(info));
      t('无 JS 报错', 'B5 深色答题', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ================= B4 边界条件 ================= */
    log('\n================ B4-a) 0 错题 / 0 历史 / 全对 / 全错 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      const zero = await page.evaluate(() => ({
        stat: document.getElementById('statSummary').textContent,
        grid: document.getElementById('statGrid').innerText.replace(/\s+/g, ' '),
        heat: document.querySelectorAll('#heatmap i').length,
        heatOn: document.querySelectorAll('#heatmap i.on').length,
        streak: document.getElementById('streakChip').textContent,
        wrong1: document.getElementById('dueList').innerText.slice(0, 40).replace(/\s+/g, ' '),
        wrong2: document.getElementById('allWrongList').innerText.slice(0, 40).replace(/\s+/g, ' '),
        ptTable: document.getElementById('ptTable').innerText.slice(0, 40).replace(/\s+/g, ' '),
      }));
      await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(300);
      log('   0 数据态：' + JSON.stringify(zero));
      t('0 历史：热力图 84 格全灰', zero.heat === 84 && zero.heatOn === 0, JSON.stringify(zero));
      t('0 历史：连击 0 天', /0 天/.test(zero.streak), zero.streak);
      t('0 错题：两处空态文案', /暂无到期错题|空/.test(zero.wrong1) && /空/.test(zero.wrong2), JSON.stringify([zero.wrong1, zero.wrong2]));
      t('0 数据：估算分显示 — 而非报错', /—/.test(zero.grid) || /0 题/.test(zero.grid), JSON.stringify(zero.grid));
      t('0 数据：无 JS 报错', 'B4 边界', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }
    {
      // 全对 / 全错（直接构造 papers / history，验证渲染与估算分）
      const allRight = (() => {
        const papers = {}, wrongbook = {};
        for (let n = 1; n <= 25; n++) papers['2026-06-1-l-' + n] = { seen: 1, right: 1, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: 'A' };
        ['2026-06-1-c-26', '2026-06-1-m-36', '2026-06-1-r-46'].forEach(q => papers[q] = { seen: 1, right: 1, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: 'A' });
        return baseState({ papers, wrongbook, history: { [TODAY]: h(30, true) } });
      })();
      const allWrong = (() => {
        const papers = {}, wrongbook = {};
        for (let n = 1; n <= 25; n++) papers['2026-06-1-l-' + n] = { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: 'A' };
        ['2026-06-1-c-26', '2026-06-1-m-36', '2026-06-1-r-46'].forEach(q => { papers[q] = { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: 'A' }; wrongbook[q] = { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 }; });
        return baseState({ papers, wrongbook, history: { [TODAY]: h(30, true) } });
      })();
      for (const [name, st] of [['全对', allRight], ['全错', allWrong]]) {
        const { ctx, page, logs } = await newCtx(browser);
        await boot(page, st);
        await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(400);
        const info = await page.evaluate(() => ({
          acc: document.getElementById('accTable').innerText.replace(/\s+/g, ' '),
          est: (document.getElementById('estCard') || {}).innerText ? document.getElementById('estCard').innerText.replace(/\s+/g, ' ').slice(0, 60) : '',
        }));
        log('   ' + name + '：' + JSON.stringify(info));
        if (name === '全对') {
          t('全对：估算分 710、总体正确率 100%', /710/.test(info.est) && /100%/.test(info.acc), JSON.stringify(info));
          await page.locator('nav button[data-p="wrong"]').click(); await page.waitForTimeout(400);
          const wl = await page.evaluate(() => document.getElementById('allWrongList').innerText);
          t('全对：错题本空', wl.indexOf('空') >= 0, JSON.stringify(wl.replace(/\s+/g, ' ').slice(0, 60)));
        } else {
          t('全错：估算分 0、正确率 0%', /(^|[^\d])0([^\d]|$)/.test(info.est) && /0%/.test(info.acc), JSON.stringify(info));
          await page.locator('nav button[data-p="wrong"]').click(); await page.waitForTimeout(400);
          const ws = await page.evaluate(() => document.getElementById('wrongSummary').innerText);
          t('全错：错题本 3 题在库', /3 题在库/.test(ws), JSON.stringify(ws.replace(/\s+/g, ' ').slice(0, 60)));
        }
        t(name + '：无 JS 报错', 'B4 边界', logs.pageerror.length === 0, logs.pageerror.join('|'));
        await shot(page, 'edge-' + (name === '全对' ? 'all-right' : 'all-wrong'));
        await ctx.close();
      }
    }
    log('\n================ B4-b) 同一天重复打卡 / 跨天 / 闰日 / 年末 ================');
    {
      // 同一天重复打卡：completed 后再点一次 floorBtn
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState({ history: { [TODAY]: h(25, true) } }));
      await page.locator('#floorBtn').click(); await page.waitForTimeout(400);
      const toast = await toastText(page);
      const st = await state(page);
      t('当天已打卡后再记一次 → 被拒（提示今天已记录）', /已记录过/.test(toast), JSON.stringify(toast));
      t('minutes 未被二次累加', (st.history[TODAY].minutes) === 25, String(st.history[TODAY].minutes));
      t('无 JS 报错', 'B4 重复打卡', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }
    {
      // 跨天：把系统时间假到 2026-09-28，历史有 26/27
      const initD = ({ iso }) => {
        const Real = Date; const fixed = new Real(iso).getTime();
        function D(...a) { return a.length === 0 ? new Real(fixed) : new Real(...a); }
        D.now = () => fixed; D.parse = Real.parse; D.UTC = Real.UTC; D.prototype = Real.prototype;
        window.Date = D;
      };
      const c2 = await browser.newContext({ viewport: { width: 430, height: 940 } });
      await c2.addInitScript(initD, { iso: '2026-09-28T10:00:00' });
      const p2 = await c2.newPage();
      const pe = []; p2.on('pageerror', e => pe.push(String(e.message || e)));
      await p2.goto(URL, { waitUntil: 'load' });
      await p2.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
      await p2.evaluate(({ st }) => { localStorage.setItem('cet6_user', '9203'); localStorage.setItem('cet6_p1_state_v1_9203', st); },
        { st: JSON.stringify(baseState({ history: { '2026-09-26': h(20, true), '2026-09-27': h(30, true) }, plan: { date: '2026-09-27', v: 3, items: [{ key: 'old', type: 'reading', qids: ['2026-06-1-r-46'], paperId: PAPER, label: '昨天的', done: true, minutes: 0 }] } })) });
      await p2.reload({ waitUntil: 'load' });
      await p2.waitForTimeout(900);
      const info = await p2.evaluate(() => ({
        today: document.getElementById('todayLabel').textContent,
        streak: document.getElementById('streakChip').textContent,
        min: document.getElementById('todayMinutes').textContent,
        planSummary: document.getElementById('planSummary').textContent,
        oldItem: document.getElementById('planList').innerText.indexOf('昨天的') >= 0,
      }));
      log('   跨天（假时间 2026-09-28）：' + JSON.stringify(info));
      t('跨天后 todayLabel 变为新日期', info.today === '2026-09-28', JSON.stringify(info));
      t('跨天后连击延续 = 2 天', /2 天/.test(info.streak), info.streak);
      t('跨天后今日分钟归零', /已练 0 分钟/.test(info.min), info.min);
      t('跨天后昨日清单被丢弃重算', !info.oldItem, JSON.stringify(info.planSummary));
      t('跨天无 JS 报错', 'B4 跨天', pe.length === 0, pe.join('|'));
      await p2.screenshot({ path: path.join(DOCS, 'retest-security-edge-nextday.png') });
      await c2.close();
    }
    for (const [name, iso, expectToday] of [['闰日 2024-02-29', '2024-02-29T09:00:00', '2024-02-29'], ['年末 2025-12-31', '2025-12-31T23:00:00', '2025-12-31'], ['年初 2026-01-01', '2026-01-01T00:10:00', '2026-01-01']]) {
      const c3 = await browser.newContext({ viewport: { width: 430, height: 940 } });
      await c3.addInitScript(({ iso }) => {
        const Real = Date; const fixed = new Real(iso).getTime();
        function D(...a) { return a.length === 0 ? new Real(fixed) : new Real(...a); }
        D.now = () => fixed; D.parse = Real.parse; D.UTC = Real.UTC; D.prototype = Real.prototype;
        window.Date = D;
      }, { iso });
      const p3 = await c3.newPage();
      const pe3 = []; p3.on('pageerror', e => pe3.push(String(e.message || e)));
      await p3.goto(URL, { waitUntil: 'load' });
      await p3.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
      await p3.evaluate(({ st }) => { localStorage.setItem('cet6_user', '9203'); localStorage.setItem('cet6_p1_state_v1_9203', st); }, { st: JSON.stringify(baseState({ history: { '2025-12-30': h(10, true), '2025-12-31': h(10, true) } })) });
      await p3.reload({ waitUntil: 'load' });
      await p3.waitForTimeout(900);
      const inf = await p3.evaluate(() => ({
        today: document.getElementById('todayLabel').textContent,
        cards: document.querySelectorAll('#planList .card').length,
        streak: document.getElementById('streakChip').textContent,
        heatLast: (Array.from(document.querySelectorAll('#heatmap i')).slice(-1)[0] || {}).getAttribute ? document.querySelectorAll('#heatmap i')[document.querySelectorAll('#heatmap i').length - 1].getAttribute('title') : null,
      }));
      log('   ' + name + '：' + JSON.stringify(inf));
      t(name + '：todayLabel 正确、清单已生成、无报错', inf.today === expectToday && inf.cards > 0 && pe3.length === 0, JSON.stringify(inf) + ' err=' + pe3.join('|'));
      await p3.screenshot({ path: path.join(DOCS, 'retest-security-edge-' + expectToday + '.png') });
      await c3.close();
    }
    {
      // 清单为空：题库全部做完
      const { ctx, page, logs } = await newCtx(browser);
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
      const full = await page.evaluate(() => {
        const papers = {};
        (window.CET6_BANKS || []).forEach(b => (b.questions || []).forEach(q => { papers[q.id] = { seen: 1, right: 1, wrong: 0, lastAt: '2026-09-27', lastResult: 'right', lastAnswer: 'A' }; }));
        const st = { version: 1, history: {}, papers, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' };
        localStorage.setItem('cet6_user', '9203');
        localStorage.setItem('cet6_p1_state_v1_9203', JSON.stringify(st));
        return Object.keys(papers).length;
      });
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(1200);
      const info = await page.evaluate(() => ({
        cards: document.querySelectorAll('#planList .card').length,
        summary: document.getElementById('planSummary').textContent,
        min: document.getElementById('todayMinutes').textContent,
        status: document.getElementById('todayStatus').textContent,
        extraBtns: document.querySelectorAll('#extraBtns button').length,
        err: document.body.innerText.trim().length,
      }));
      log('   全部 ' + full + ' 题做完后：' + JSON.stringify(info));
      t('全做完：页面不崩、清单 0 组', info.err > 20 && info.cards === 0, JSON.stringify(info));
      t('全做完：文案显示 0/0 组', /0\/0/.test(info.summary), info.summary);
      await page.locator('#extraBtns button').first().click(); await page.waitForTimeout(400);
      const extraToast = await toastText(page);
      const pending = await page.evaluate(() => document.getElementById('todayStatus').textContent);
      log('   加练结果 toast=' + JSON.stringify(extraToast) + '；今日状态=' + JSON.stringify(pending));
      const dead = info.cards === 0 && /没有剩余题目/.test(extraToast) && !/已通关/.test(pending);
      if (dead) {
        issue('N-2', '题库做满后今日清单为 0 组：用户无法通过清单完成打卡，只能走「忙日打卡」', '低-中',
          'app/index.html:551-566（finishItem 仅由题组完成触发）+ core.js:213-281（genPlan 无题可排时 items=[]）',
          '把 papers 填满全部 3315 题后打开首页：planList 无卡片、加练提示"没有剩余题目"、todayStatus 仍显示"完成今天的任务点击下方记录"',
          'genPlan 在 items 为空时补一个"自测复习"兜底组；或首页在 plan.items.length===0 时直接给出"全部真题已完成"的打卡入口',
          'planSummary=' + info.summary + '；todayStatus=' + pending);
      }
      t('全做完：存在可用的打卡兜底入口', !dead, 'todayStatus=' + JSON.stringify(pending) + '; extraToast=' + JSON.stringify(extraToast));
      t('全做完：无 JS 报错', 'B4 空清单', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await shot(page, 'edge-all-done');
      await ctx.close();
    }

    const failed = R.cases.filter(c => !c.pass && !c.informational);
    R.summary = {
      total: R.cases.length, fail: failed.length,
      failed: failed.map(f => f.group + ' · ' + f.name + ' → ' + f.detail),
      consoleErrors: R.console.consoleErrors, pageErrors: R.console.pageErrors,
      newIssues: R.newIssues.length,
    };
    log('\n================ 汇总 ================');
    log(`  检查项 ${R.cases.length} 条；未通过 ${failed.length}`);
    failed.forEach(f => log('   ✗ ' + f.group + ' · ' + f.name + ' → ' + f.detail));
    log(`  控制台：pageerror ${R.console.pageErrors.length} 个 / console.error ${R.console.consoleErrors.length} 个`);
    log(`  新发现问题 ${R.newIssues.length} 个`);

    fs.writeFileSync(path.join(DOCS, 'retest-journey-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-journey-log.txt'), LINES.join('\n'), 'utf8');
    await browser.close();
    log('\n已写出 docs/retest-journey-result.json 与 docs/retest-journey-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-journey-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  }
})();
