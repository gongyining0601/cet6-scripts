'use strict';
/* ============================================================================
   CET6 安全审计 · 补充用例（P-SEC-EXTRA）
   针对主审计未覆盖的两条真实风险：
     A) 错题本/清单里存在"题库中不存在的 qid"（旧备份、跨版本题库、被篡改备份）
        → renderWrong(stem 取 bank) / allWrongIds 不过滤 / csvExport 直接 q.qno
     B) 今日清单引用不存在的卷号 → 点"开始"进入做题页
   运行：cd D:\CET6\scripts ; node test_security_extra.js
   产物：docs/security-extra-log.txt / docs/security-extra-result.json / docs/security-extra-*.png
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, ensurePaper } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const INDEX = path.join(APP, 'index.html');
const URL = 'file:///' + INDEX.split(path.sep).join('/');
const DOCS = path.join(ROOT, 'docs');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { meta: {}, cases: [] };

const pad = n => (n < 10 ? '0' + n : '' + n);
const _d = new Date();
const TODAY = _d.getFullYear() + '-' + pad(_d.getMonth() + 1) + '-' + pad(_d.getDate());
const GHOST = 'ghost-qid-9999';

async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const logs = { pageerror: [], console: [], dialog: [], promptReply: '10' };
  page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.pageerror.push({ message: String((e && e.message) || e), stack: String((e && e.stack) || '') }));
  page.on('dialog', async dl => { logs.dialog.push(dl.message()); try { await dl.accept(dl.type() === 'prompt' ? logs.promptReply : ''); } catch (e) { } });
  return { ctx, page, logs };
}
const cur = l => l.pageerror.length;
const errsSince = (l, n) => l.pageerror.slice(n).map(e => e.message + '  @' + (e.stack.split('\n')[1] || '').trim());

async function boot(page, id, stateObj) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try { if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st); } catch (e) { }
  }, { id, st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); } catch (e) { log('   ⚠ 无卡片：' + e.message.split('\n')[0]); }
  await page.waitForTimeout(400);
}
async function shot(page, name, full) {
  try { await page.screenshot({ path: path.join(DOCS, 'security-extra-' + name + '.png'), fullPage: !!full }); }
  catch (e) { log('   (截图失败 ' + name + ')'); }
}
const GOOD = 'GOODMARK987';
function goodState(extra) {
  const s = { version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '', __good: GOOD };
  s.history[TODAY] = { minutes: 12, done: false, floor: false, qCount: 8, right: 6, timed: 1, timedWithin: 1, timedSec: 70 };
  return Object.assign(s, extra || {});
}

(async () => {
  try {
    R.meta = { url: URL, browser: EXE, today: TODAY, startedAt: new Date().toISOString() };
    log('CET6 安全审计 · 补充用例  ' + R.meta.startedAt);
    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });

    /* 取真实 qid */
    const { ctx: c0, page: p0 } = await newCtx(browser);
    await p0.goto(URL, { waitUntil: 'load' });
    await p0.waitForSelector('#loginMask', { timeout: 30000 });
    // 按需加载：首屏 BANKS 为空数组，先注入样卷再取真实 qid（否则 b.questions 为 undefined 直接抛错）
    const SAMPLE_PAPER = '2015-06-1';
    await ensurePaper(p0, SAMPLE_PAPER);
    const ID = await p0.evaluate((pid) => {
      const B = window.CET6_BANKS || [];
      const b = B.find(x => x.id === pid);
      if (!b) return { qid: null, stemHead: null, hasGhost: false };
      const q = (b.questions || []).find(x => x.type === 'reading');
      return { qid: q && q.id, stemHead: (q && q.stem ? String(q.stem).slice(0, 18) : null), hasGhost: !!window.CET6Core.findQ(B, 'ghost-qid-9999') };
    }, SAMPLE_PAPER);
    log('样例卷 = ' + SAMPLE_PAPER + '；样例 qid = ' + ID.qid + '；题干片段 = ' + JSON.stringify(ID.stemHead) + '；题库中是否存在 ghost-qid-9999 = ' + ID.hasGhost);
    if (!ID.qid) { log('   x 样卷未就绪，后续用例无法定位真实 qid，终止'); throw new Error('sample paper not ready: ' + SAMPLE_PAPER); }
    await c0.close();

    const { ctx, page, logs } = await newCtx(browser);
    const wb = { addedAt: TODAY, box: 0, wrongCount: 3, due: TODAY, ease: 2.5, iv: 1, streak: 0 };

    /* ---------- A. 错题本含"题库里不存在的 qid" ---------- */
    await boot(page, '9701', goodState({
      wrongbook: { [ID.qid]: Object.assign({}, wb, { wrongCount: 1 }), [GHOST]: Object.assign({}, wb, { wrongCount: 9 }) },
      papers: { [ID.qid]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: 'A' } },
    }));
    let n = cur(logs);
    await page.locator('nav button[data-p="wrong"]').click().catch(() => { });
    await page.waitForTimeout(600);
    const wrongState = await page.evaluate((stemHead) => {
      const box = document.getElementById('page-wrong');
      const txt = (box && box.textContent) || '';
      return {
        rowsDue: document.querySelectorAll('#dueList .wb-row, #dueList .wr, #dueList .card').length,
        rowsAll: document.querySelectorAll('#allWrongList .wb-row, #allWrongList .wr, #allWrongList .card').length,
        textLen: txt.length, hasGhost: txt.indexOf('ghost-qid-9999') >= 0, hasStem: !!(stemHead && txt.indexOf(stemHead) >= 0),
      };
    }, ID.stemHead);
    const aErrs = errsSince(logs, n);
    R.cases.push({ name: '错题本含题库中不存在的 qid → 渲染错题本', render: wrongState, errors: aErrs });
    log('  · 错题本渲染：到期区行=' + wrongState.rowsDue + ' 全部区行=' + wrongState.rowsAll +
      ' 文本长度=' + wrongState.textLen + ' 出现 ghost qid=' + wrongState.hasGhost + ' 出现正常题干=' + wrongState.hasStem +
      ' 报错=' + aErrs.length);
    aErrs.forEach(e => log('        ⛔ ' + e));
    await shot(page, 'ghost-wrongbook', true);

    /* ---------- A2. 同一状态导出 CSV ---------- */
    n = cur(logs);
    await page.locator('nav button[data-p="backup"]').click();
    await page.waitForSelector('#wrongCsvBtn', { state: 'visible' });
    let csvInfo = { downloaded: false };
    try {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 12000 }), page.locator('#wrongCsvBtn').click()]);
      const raw = fs.readFileSync(await dl.path(), 'utf8');
      fs.writeFileSync(path.join(DOCS, 'security-extra-ghost.csv'), raw, 'utf8');
      csvInfo = { downloaded: true, filename: dl.suggestedFilename(), bytes: raw.length, lines: raw.split(/\r?\n/).filter(Boolean).length };
    } catch (e) { csvInfo = { downloaded: false, error: e.message.split('\n')[0] }; }
    const a2Errs = errsSince(logs, n);
    const toast = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
    R.cases.push({ name: '错题本含未知 qid → 导出 CSV', csv: csvInfo, toast, errors: a2Errs });
    log('  · 导出 CSV：下载成功=' + csvInfo.downloaded + ' ' + JSON.stringify(csvInfo) + ' toast=' + JSON.stringify(toast) + ' 报错=' + a2Errs.length);
    a2Errs.forEach(e => log('        ⛔ ' + e));

    /* ---------- B. 今日清单引用不存在的卷号 / qid ---------- */
    await boot(page, '9702', goodState({
      plan: {
        date: TODAY, v: 3, items: [
          { key: 'ghost-reading', type: 'reading', qids: [GHOST], paperId: '1900-01-1', label: '幽灵阅读', done: false, minutes: 0 },
        ],
      },
    }));
    n = cur(logs);
    const cards = await page.locator('#planList .card').count();
    await page.locator('#planList .card button').first().click().catch(() => { });
    await page.waitForTimeout(900);
    const quizOpen = await page.locator('#quiz.show').count();
    const quizInfo = await page.evaluate(() => ({
      bodyLen: (document.getElementById('quizBody') || {}).textContent ? document.getElementById('quizBody').textContent.length : 0,
      hasGhostText: ((document.getElementById('quizBody') || {}).textContent || '').indexOf('1900-01-1') >= 0,
    }));
    const bErrs = errsSince(logs, n);
    R.cases.push({ name: '今日清单含不存在卷号/qid → 进入做题页', planCards: cards, quizOpen: quizOpen > 0, quizInfo, errors: bErrs });
    log('  · 清单卡片=' + cards + ' 点开做题浮层=' + (quizOpen > 0) + ' quizBody 文本长度=' + quizInfo.bodyLen +
      ' 含幽灵卷号=' + quizInfo.hasGhostText + ' 报错=' + bErrs.length);
    bErrs.forEach(e => log('        ⛔ ' + e));
    await shot(page, 'ghost-plan-quiz', true);

    /* ---------- C. 编号 0000（合法但全新）---------- */
    n = cur(logs);
    await boot(page, '0000', undefined);
    const fresh = await page.evaluate(() => {
      const st = localStorage.getItem('cet6_p1_state_v1_0000');
      return { cards: document.querySelectorAll('#planList .card').length, stored: !!st, chip: (document.getElementById('userChip') || {}).textContent || '' };
    });
    const cErrs = errsSince(logs, n);
    R.cases.push({ name: '编号 0000（合法但无历史数据）', fresh, errors: cErrs });
    log('  · 编号 0000：清单卡片=' + fresh.cards + ' 已落盘=' + fresh.stored + ' userChip=' + JSON.stringify(fresh.chip) + ' 报错=' + cErrs.length);
    cErrs.forEach(e => log('        ⛔ ' + e));

    /* ---------- D. 存储真的写满 → save() 落盘失败：提示是否可见 ----------
       关键：把磁盘上的值换成极小串（内存态仍是完整状态），后续 save() 需要的净增量就是几百字节，
       在"只剩几十字节"的配额下必然失败；否则同尺寸覆盖写会成功，测不出任何东西。 */
    await boot(page, '9703', goodState());
    await page.evaluate(() => localStorage.setItem('cet6_p1_state_v1_9703', '{"version":1,"history":{}}'));
    const fill2 = await page.evaluate(() => {
      let n = 0, err = '';
      for (const sz of [100 * 1024, 16 * 1024, 1024, 256, 128, 64, 32, 16, 8]) {
        for (let i = 0; i < 9000; i++) {
          try { localStorage.setItem('__junk2_' + (n++), new Array(sz + 1).join('x')); }
          catch (e) { err = (e && e.name) || 'err'; break; }
        }
      }
      let canWrite4 = true;
      try { localStorage.setItem('__probe4', 'yyyy'); } catch (e) { canWrite4 = false; }
      return { n, err, canWrite4 };
    });
    await page.evaluate(() => {
      window.__writes = []; window.__toasts = [];
      const orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (k, v) {
        try { orig(k, v); window.__writes.push({ k: String(k), ok: true, len: String(v).length }); }
        catch (e) { window.__writes.push({ k: String(k), ok: false, err: e.name, len: String(v).length }); throw e; }
      };
      const t = document.getElementById('toast');
      new MutationObserver(() => {
        const x = (t.textContent || '').trim();
        if (x && window.__toasts[window.__toasts.length - 1] !== x) window.__toasts.push(x);
      }).observe(t, { childList: true, characterData: true, subtree: true });
    });
    n = cur(logs);
    logs.promptReply = '5';
    const beforeD = await page.evaluate(() => localStorage.getItem('cet6_p1_state_v1_9703'));
    await page.locator('#floorBtn').click().catch(() => { });
    await page.waitForTimeout(900);
    const dWrites = (await page.evaluate(() => window.__writes || [])).filter(w => /9703/.test(w.k));
    const dToasts = await page.evaluate(() => window.__toasts || []);
    const dStatus = await page.evaluate(() => (document.getElementById('todayStatus') || {}).textContent || '');
    const afterD = await page.evaluate(() => localStorage.getItem('cet6_p1_state_v1_9703'));
    const dErrs = errsSince(logs, n);
    R.cases.push({
      name: '存储写满 + 底线打卡：save() 落盘失败时的提示与状态', fill: fill2, stateWrite: dWrites,
      toasts: dToasts, warnIsFinalToast: /保存失败/.test(dToasts[dToasts.length - 1] || ''),
      warnShownAtAll: dToasts.some(x => /保存失败/.test(x)),
      todayStatusText: dStatus.slice(0, 80), diskValueChanged: beforeD !== afterD, errors: dErrs,
    });
    log('  · [D] 填充=' + JSON.stringify(fill2) +
      '\n      state 写入埋点=' + JSON.stringify(dWrites) +
      '\n      toast 序列=' + JSON.stringify(dToasts) + ' → 最终可见=' + JSON.stringify(dToasts[dToasts.length - 1] || '') +
      '\n      界面今日状态=' + JSON.stringify(dStatus.slice(0, 60)) + ' 磁盘值变化=' + (beforeD !== afterD) + ' 报错=' + dErrs.length);
    dErrs.forEach(e => log('        ⛔ ' + e));
    await shot(page, 'quota-save-fail', false);
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) { if (k.indexOf('__junk2_') === 0 || k === '__probe4') { try { localStorage.removeItem(k); } catch (e) { } } } });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    const dReload = await page.evaluate(() => ({
      statusText: ((document.getElementById('todayStatus') || {}).textContent || '').slice(0, 60),
      storedRaw: (localStorage.getItem('cet6_p1_state_v1_9703') || '').slice(0, 60),
    }));
    log('      ↳ 刷新后：界面今日状态=' + JSON.stringify(dReload.statusText) + ' 磁盘值=' + JSON.stringify(dReload.storedRaw) +
      '（提示"打卡成功"但并未落盘）');

    /* ---------- E. 存储写满 → 答题提交后进度静默丢失 ---------- */
    await boot(page, '9704', goodState());
    await page.evaluate(() => localStorage.setItem('cet6_p1_state_v1_9704', '{"version":1,"history":{}}'));
    await page.evaluate(() => {
      let nn = 0;
      for (const sz of [100 * 1024, 16 * 1024, 1024, 256, 128, 64, 32, 16, 8]) {
        for (let i = 0; i < 9000; i++) {
          try { localStorage.setItem('__junk3_' + (nn++), new Array(sz + 1).join('x')); } catch (e) { break; }
        }
      }
      window.__writes = [];
      const orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (k, v) { try { orig(k, v); window.__writes.push({ k: String(k), ok: true }); } catch (e) { window.__writes.push({ k: String(k), ok: false, err: e.name }); throw e; } };
    });
    n = cur(logs);
    // 直接点第一张卡片开始（今日清单由 app 自己生成）
    await page.locator('#planList .card button').first().click().catch(() => { });
    await page.waitForTimeout(800);
    const optN = await page.locator('.opt').count();
    for (let i = 0; i < optN; i++) await page.locator('.opt').nth(i).click().catch(() => { });
    await page.waitForTimeout(200);
    await page.locator('#groupSubmit').click().catch(() => { });
    await page.waitForTimeout(900);
    const eWrites = (await page.evaluate(() => window.__writes || [])).filter(w => /9704/.test(w.k));
    const eAna = await page.locator('.analysis').count();
    const eToast = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
    await page.locator('#groupDone').click().catch(() => { });
    await page.waitForTimeout(600);
    const eErrs = errsSince(logs, n);
    const eDisk = await page.evaluate(() => (localStorage.getItem('cet6_p1_state_v1_9704') || '').slice(0, 40));
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) { if (k.indexOf('__junk3_') === 0) { try { localStorage.removeItem(k); } catch (e) { } } } });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    const eAfter = await page.evaluate(() => ({
      statusText: ((document.getElementById('todayStatus') || {}).textContent || '').slice(0, 60),
      doneCards: document.querySelectorAll('#planList .card.done, #planList .card .ic.done, #planList .card .done').length,
    }));
    R.cases.push({
      name: '存储写满 → 答题提交后进度是否真的落盘', optN, analysisBlocks: eAna, toastAfterSubmit: eToast,
      stateWrite: eWrites, diskRawBeforeReload: eDisk, afterReloadStatus: eAfter.statusText,
      errors: eErrs,
    });
    log('  · [E] 选项=' + optN + ' 判分后解析块=' + eAna + ' 提交后 toast=' + JSON.stringify(eToast) +
      '\n      state 写入埋点=' + JSON.stringify(eWrites) + ' 判分后磁盘值=' + JSON.stringify(eDisk) +
      '\n      刷新后今日状态=' + JSON.stringify(eAfter.statusText) + ' 报错=' + eErrs.length);
    eErrs.forEach(e => log('        ⛔ ' + e));

    await browser.close();
    R.summary = {
      cases: R.cases.length,
      withErrors: R.cases.filter(c => (c.errors || []).length).map(c => ({ name: c.name, first: c.errors[0] })),
      finishedAt: new Date().toISOString(),
    };
    log('\n=========== 补充用例汇总 ===========');
    /* 明确判定（防空绿）：此前只打印"用例 N 个 / 异常 M 个"，不给 pass/fail、不设退出码，
       runner 只能判 NO-ASSERT——跑了却无法被机器消费。 */
    let nOk = 0, nFail = 0;
    const chk = (name, cond, detail) => {
      if (cond) { nOk++; log('ok   ' + name + (detail ? ' | ' + detail : '')); }
      else { nFail++; log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
    };
    chk('脚本完整跑完（无中断）', !R.fatal, R.fatal || '');
    chk('用例覆盖数 ≥ 6（套件未缩水）', R.cases.length >= 6, '实际 ' + R.cases.length + ' 个');
    chk('无未捕获异常', R.summary.withErrors.length === 0,
      R.summary.withErrors.length ? R.summary.withErrors.map(w => w.name).join(', ') : '0 个');
    /* 每个用例都要有自己的判定。
       此前只有上面 3 条"总括式"断言（跑完了 / 数量够 / 没异常），6 个用例的**结论**全靠人工肉眼看日志，
       等于用例本身没有可执行判定——run_all 的历史下限是 6 条，这里补齐到 9 条并让"通过"有实证。 */
    const C = (i) => R.cases[i] || {};
    /* A1 的判定口径（实测校准）：幽灵 qid 不该出现，但**正常题目必须照常渲染**。
       别去数行数——这个用例记录时用的行选择器（.wb-row/.wr/.card）与应用实际结构
       （#dueList .wb-item）对不上，恒为 0，拿它当条件会把自己的用例判红。
       真正可靠的实证是"页面有文本 + 正常题干在 + 幽灵 qid 不在"。 */
    chk('A1 错题本含未知 qid：照常渲染（幽灵 qid 被剔除、正常题目仍在）',
      !!C(0).render && C(0).render.textLen > 0 && C(0).render.hasStem === true && C(0).render.hasGhost === false,
      JSON.stringify(C(0).render));
    chk('A2 错题本含未知 qid：CSV 仍可导出（有表头且不少于 1 行）',
      !!C(1).csv && C(1).csv.downloaded === true && C(1).csv.lines >= 1,
      JSON.stringify(C(1).csv) + ' toast=' + JSON.stringify(C(1).toast));
    chk('B 清单含不存在卷号/qid：进入做题页不崩（浮层可开）',
      !!C(2) && C(2).quizOpen === true && C(2).quizInfo && C(2).quizInfo.bodyLen > 0,
      '清单卡片=' + C(2).planCards + ' 浮层=' + C(2).quizOpen + ' quizBody 文本长度=' + (C(2).quizInfo && C(2).quizInfo.bodyLen));
    chk('C 编号 0000（合法但全新账号）：生成清单并落盘',
      !!C(3).fresh && C(3).fresh.cards >= 1 && C(3).fresh.stored === true,
      JSON.stringify(C(3).fresh));
    chk('D 存储写满 + 底线打卡：明确提示"保存失败"（不假装成功）',
      !!C(4) && C(4).warnShownAtAll === true,
      'toasts=' + JSON.stringify(C(4).toasts) + ' 今日状态=' + JSON.stringify(C(4).todayStatusText));
    chk('E 存储写满：进度无法落盘时明确告警（不静默丢数据）',
      (function () {
        // 该组首张卡可能是选词填空（没有 .opt），所以不能拿"选项数/解析块数"当条件。
        // 这个用例真正要验的是：写不进去的时候，应用**必须说出来**，而不是假装已完成。
        const fails = (C(5).stateWrite || []).filter((w) => w.ok === false).length;
        return /保存失败/.test(C(5).toastAfterSubmit || '') && (fails >= 1 || (C(5).stateWrite || []).length === 0);
      })(),
      '提交后 toast=' + JSON.stringify(C(5).toastAfterSubmit) +
      '；写 9704 失败 ' + (C(5).stateWrite || []).filter((w) => w.ok === false).length + ' 次 / 尝试 ' + (C(5).stateWrite || []).length + ' 次');
    log('用例 ' + R.cases.length + ' 个，产生未捕获异常的 ' + R.summary.withErrors.length + ' 个');
    R.summary.withErrors.forEach(w => log('   ⛔ ' + w.name + ' → ' + w.first));
    R.summary.assertions = { ok: nOk, fail: nFail };
    log('\n===== 补充用例判定: ' + nOk + ' ok / ' + nFail + ' fail =====');
    process.exitCode = nFail ? 1 : 0;
  } catch (e) {
    log('‼ 补充用例中断：' + (e && e.stack ? e.stack : e));
    R.fatal = String((e && e.message) || e);
    try { await browser.close(); } catch (e2) { }
  }
  // 中断必须表现为 FAIL + 非零退出码，否则"没跑完"会被误当成通过
  if (R.fatal) { log('FAIL 脚本中断：' + R.fatal); process.exitCode = 1; }
  fs.writeFileSync(path.join(DOCS, 'security-extra-log.txt'), LINES.join('\n'), 'utf8');
  fs.writeFileSync(path.join(DOCS, 'security-extra-result.json'), JSON.stringify(R, null, 2), 'utf8');
  log('已写出：docs/security-extra-log.txt / docs/security-extra-result.json');
})();
