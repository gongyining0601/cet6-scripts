/* =============================================================================
   verify_fix_report.js —— 针对本次修复清单（任务1~7）的逐项验收脚本（修复后跑）
   运行： node scripts/verify_fix_report.js
   产物： docs/fix-verify-result.json  +  控制台逐项 OK/FAIL
   覆盖：
     M-1 导入失败/渲染异常回滚 + 5MB 上限 + normalizeState 后结构校验
     M-2 脏备份兜底（5 类异常备份导入 → 不白屏、今日页有卡片、零 pageerror）
     M-3 幽灵 qid 不再让错题本/CSV 导出崩
     M-4 CSV 公式注入（题干与"你的答案"都以 ' 开头）
     M-5 存储写满：save() 返回 false（调用方分支可见）+ 常驻横幅
     M-6 localStorage 被禁：不白屏、零报错、横幅提示
   XSS 20 用例（H-1）由 scripts/test_security_audit.js 复跑，结果读 docs/security-audit-result.json
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, ensurePaper } = require('./_env.js');
const chromium = loadChromium().chromium;

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const APP = path.join(ROOT, 'app');
const URL = 'file:///' + path.join(APP, 'index.html').split(path.sep).join('/');

if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true });

const log = (s) => console.log(s);
const R = { meta: {}, nodes: [], browser: {}, startedAt: new Date().toISOString() };
const _d = new Date();
const pad = (n) => (n < 10 ? '0' : '') + n;
const TODAY = _d.getFullYear() + '-' + pad(_d.getMonth() + 1) + '-' + pad(_d.getDate());
R.meta = { today: TODAY, url: URL, browser: EXE, node: process.version };

/* ---------- A. Node 侧：core.js 的 normalizeState ---------- */
function partA_node() {
  log('\n=========== A. core.js normalizeState（Node）===========');
  const C = require(path.join(APP, 'core.js'));
  const out = { name: 'A. core.normalizeState' };
  out.exists = typeof C.normalizeState === 'function';
  const dirty = {
    version: 'x',
    history: { '2026-09-27': { minutes: '<img src=x onerror=__probe(1)>', done: 'yes', qCount: '5', right: '3', timed: 'z', timedWithin: 1, timedSec: 60 }, 'not-a-date': { minutes: 9 } },
    papers: { 'a-b': { seen: '<img>', right: 'x', wrong: null, lastAnswer: 'Z'.repeat(99) } },
    wrongbook: { q1: { due: 'not-a-date', box: '2', wrongCount: '<svg onload=__probe(2)>', ease: '99', iv: '0', streak: null }, q2: null },
    essays: { writing: { lastAt: 1, text: 'A'.repeat(30000) }, translation: 'oops' },
    hl: { p1: [1, 'ok', 'A'.repeat(500)], p2: { length: 5 } },
    plan: { date: '2026-09-27', v: '3', items: [{ type: 'reading', qids: ['x', 1, 'y'], label: 'L', done: 1, draft: { x: 'A', bad: 123 } }] },
    lastBackup: 12345,
  };
  const n = C.normalizeState(dirty);
  out.historyNumeric = n.history['2026-09-27'].minutes === 0;
  out.historyDateKeyDropped = n.history['not-a-date'] === undefined;
  out.papersNumeric = n.papers['a-b'].seen === 0 && n.papers['a-b'].wrong === 0;
  out.lastAnswerCapped = String(n.papers['a-b'].lastAnswer).length === 40;
  out.wrongbookDueFixed = /^\d{4}-\d{2}-\d{2}$/.test(n.wrongbook.q1.due);
  out.wrongbookCountNumeric = n.wrongbook.q1.wrongCount === 0;
  out.wrongbookEaseClamped = n.wrongbook.q1.ease === 2.8;
  out.wrongbookNullDropped = n.wrongbook.q2 === undefined;
  out.essayCapped = n.essays.writing.text.length === 20000;
  out.hlSanitized = n.hl.p1.length === 2 && n.hl['p2'] === undefined;
  out.planKeptWhenStructurallyValid = !!(n.plan && Array.isArray(n.plan.items) && n.plan.items[0].qids.length === 2);
  out.planDraftSanitized = n.plan.items[0].draft.x === 'A' && n.plan.items[0].draft.bad === undefined;
  out.nullInputSafe = JSON.stringify(C.normalizeState(null)) === JSON.stringify(C.newState());
  out.arrayInputSafe = !!C.normalizeState([1, 2, 3]).version;
  // loadState 走归一化
  const fake = { d: {}, getItem(k) { return this.d[k] === undefined ? null : this.d[k]; }, setItem(k, v) { this.d[k] = v; }, removeItem(k) { delete this.d[k]; } };
  C.saveState(fake, (() => { const s = C.newState(); s.history[TODAY] = { minutes: '<img src=x>', done: 1 }; return s; })());
  const loaded = C.loadState(fake);
  out.loadStateNormalized = loaded.history[TODAY].minutes === 0;
  // 合法 plan 往返不丢（今日清单完成态/断点草稿必须留住）
  const st = C.newState();
  C.recordResult(st, '2015-06-1-r-46', false, TODAY);
  st.plan = { date: TODAY, v: C.PLAN_VERSION, items: [{ key: 'k', type: 'reading', qids: ['2015-06-1-r-46'], done: true, minutes: 8.5, draft: { '2015-06-1-r-46': 'A' }, timerLeft: 33 }] };
  C.saveState(fake, st);
  const back = C.loadState(fake);
  out.planRoundTripDone = !!(back.plan && back.plan.items[0].done === true);
  out.planRoundTripDraft = !!(back.plan && back.plan.items[0].draft && back.plan.items[0].draft['2015-06-1-r-46'] === 'A');
  out.planRoundTripTimer = !!(back.plan && back.plan.items[0].timerLeft === 33);
  out.planNonArrayItemsDropped = C.normalizeState({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: { date: TODAY, v: 3, items: {} } }).plan === null;
  // 迁移块不再因 null 条目整份回退
  const mig = C.normalizeState({ version: 1, history: { [TODAY]: { minutes: 7, done: true } }, papers: {}, wrongbook: { 'x-y': null } });
  out.migrationKeepsHistory = mig.history[TODAY].minutes === 7;
  const fails = Object.keys(out).filter(k => k !== 'name' && out[k] !== true);
  out.ok = fails.length === 0;
  R.nodes.push(out);
  log((out.ok ? '✅' : '❌') + ' normalizeState 存在=' + out.exists +
    ' | 脏数据全量归一化=' + (out.historyNumeric && out.papersNumeric && out.historyDateKeyDropped) +
    ' | wrongbook due 修复=' + out.wrongbookDueFixed + ' | null 条目丢弃=' + out.wrongbookNullDropped +
    '\n   essays 限长=' + out.essayCapped + ' hl 归一化=' + out.hlSanitized +
    ' | loadState 归一化=' + out.loadStateNormalized +
    '\n   合法 plan 往返（done/draft/timerLeft）=' + (out.planRoundTripDone && out.planRoundTripDraft && out.planRoundTripTimer) +
    ' | plan.items 非数组→重算=' + out.planNonArrayItemsDropped +
    ' | 迁移不再静默清空=' + out.migrationKeepsHistory);
  if (!out.ok) log('   ❌ 未通过项：' + fails.join(', '));
  return out.ok;
}

/* ---------- Playwright 公共工具 ---------- */
async function newPage(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const logs = { pageerror: [], console: [] };
  page.on('pageerror', (e) => logs.pageerror.push(String(e.message || e)));
  page.on('console', (m) => logs.console.push({ type: m.type(), text: m.text() }));
  page.__label = label;
  page.__logs = logs;
  const cursor = () => ({ p: logs.pageerror.length });
  const since = (k) => ({ errors: logs.pageerror.slice(k.p) });
  page.__cursor = cursor;
  page.__since = since;
  return { ctx, page, logs };
}
async function boot(page, userId, stateObj) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try { if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st); } catch (e) { }
  }, { id: userId, st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  await page.waitForTimeout(300);
}
const importRaw = async (page, body, filename, mime) => {
  await page.setInputFiles('#importFile', { name: filename || 'cet6-backup-test.json', mimeType: mime || 'application/json', buffer: Buffer.from(body, 'utf8') });
  await page.waitForTimeout(700);
};
const importObj = (page, obj, filename) => importRaw(page, JSON.stringify(obj), filename);
const toastText = (page) => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
const planCards = (page) => page.locator('#planList .card').count();
const storeGet = (page, key) => page.evaluate(k => localStorage.getItem(k), key);
const GOOD = 'GOODMARK987';
function goodState(extra) {
  const s = { version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '', __good: GOOD };
  s.history[TODAY] = { minutes: 12, done: false, floor: false, qCount: 8, right: 6, timed: 1, timedWithin: 1, timedSec: 70 };
  return Object.assign(s, extra || {});
}
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const P = (kind, o) => { R.browser[kind] = R.browser[kind] || []; R.browser[kind].push(o); return o; };

/* ---------- B. M-2 脏备份导入（5 类）---------- */
async function partB_dirty(browser, IDS) {
  log('\n=========== B. M-2 脏备份导入（5 类异常）===========');
  const { ctx, page, logs } = await newPage(browser, 'dirty');
  await boot(page, '9501', goodState());
  const cases = [
    ['截断 JSON（语法错误）', '{"version":1,"history":{"20'],
    ['version 为字符串 + history 为数组', JSON.stringify({ version: '1', history: [], papers: {}, wrongbook: {} })],
    ['wrongbook[qid] = null', JSON.stringify({ version: 1, history: { [TODAY]: { minutes: 7, done: true } }, papers: {}, wrongbook: { [IDS.listening]: null } })],
    ['plan.items 为对象（非数组）', JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: { date: TODAY, v: 3, items: {} } })],
    ['缺 essays + 清单含写作条目', JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: { date: TODAY, v: 3, items: [{ key: 'e', type: 'writing', qids: [], paperId: '2015-06-1', done: false, minutes: 0 }] } })],
  ];
  const results = [];
  for (const [name, body] of cases) {
    await importObj(page, goodState());            // 先回到良好存档
    await page.waitForTimeout(350);
    await page.locator('nav button[data-p="today"]').click().catch(() => { });
    const k = page.__cursor();
    await importRaw(page, body, 'dirty.json');
    const errsImport = page.__since(k).errors;
    const toast = await toastText(page);
    const cardsAfterImport = await planCards(page);
    const bodyLen = await page.evaluate(() => (document.body.textContent || '').trim().length);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    const k2 = page.__cursor();
    await page.waitForTimeout(200);
    const cardsReload = await planCards(page);
    const errsReload = page.__since(k2).errors;
    const bodyLenReload = await page.evaluate(() => (document.body.textContent || '').trim().length);
    const alive = await page.evaluate(() => { try { document.querySelector('nav button[data-p="stat"]').click(); document.querySelector('nav button[data-p="today"]').click(); return true; } catch (e) { return false; } });
    const rec = P('dirty', {
      name, toast, rejected: /导入失败/.test(toast), errsImport, errsReload,
      cardsAfterImport, cardsReload, bodyLenAfterImport: bodyLen, bodyLenAfterReload: bodyLenReload, appAlive: alive,
      blankScreen: cardsReload <= 0 && bodyLenReload < 40,
    });
    rec.ok = rec.errsImport.length === 0 && rec.errsReload.length === 0 && rec.cardsAfterImport > 0 && rec.cardsReload > 0 && !rec.blankScreen && rec.appAlive;
    log((rec.ok ? '  ✅ ' : '  ❌ ') + name + ' → toast=' + JSON.stringify(toast) + ' 今日卡片(导入后/重载后)=' + cardsAfterImport + '/' + cardsReload +
      ' 报错(导入/重载)=' + errsImport.length + '/' + errsReload.length + ' 白屏=' + rec.blankScreen);
    if (rec.errsImport.length || rec.errsReload.length) log('      ⛔ ' + [].concat(errsImport, errsReload).map(e => e.slice(0, 150)).join(' | '));
    results.push(rec);
  }
  await ctx.close();
  return results;
}

/* ---------- C. M-1 导入回滚 + 体积上限 + 结构校验 ---------- */
async function partC_rollback(browser) {
  log('\n=========== C. M-1 导入回滚 / 5MB 上限 / 结构校验 ===========');
  const { ctx, page } = await newPage(browser, 'rollback');
  await boot(page, '9502', goodState());
  const out = [];

  // C1 结构校验：合法 JSON 但不是备份
  await importObj(page, { foo: 1 });
  out.push(P('rollback', { name: 'C1 非备份结构 JSON', toast: await toastText(page), rejected: /导入失败/.test(await toastText(page)), letters: await planCards(page) }));

  // C2 5MB 上限
  const big = 'x'.repeat(5 * 1024 * 1024 + 64);
  const k2 = page.__cursor();
  const before2 = await storeGet(page, 'cet6_p1_state_v1_9502');
  await importRaw(page, big, 'huge.json');
  const t2 = await toastText(page);
  const errs2 = page.__since(k2).errors;
  const after2 = await storeGet(page, 'cet6_p1_state_v1_9502');
  out.push(P('rollback', {
    name: 'C2 超过 5MB 的备份', bytes: big.length, toast: t2, oversizedRejected: /超过 5MB/.test(t2),
    errors: errs2, oldStateKept: before2 === after2 && !!after2,
  }));

  // C3 renderAll() 抛异常 → 回滚到导入前状态
  await importObj(page, goodState({ history: Object.assign({}, goodState().history, { [TODAY]: { minutes: 99, done: false, floor: false, qCount: 1, right: 1, timed: 0, timedWithin: 0, timedSec: 0 } }) }));
  await page.waitForTimeout(400);
  const k3 = page.__cursor();
  const before3 = await storeGet(page, 'cet6_p1_state_v1_9502');
  await page.evaluate(() => { // 只让下一次 insertAdjacentElement 抛错（renderStat 里插估分卡）
    const orig = Element.prototype.insertAdjacentElement;
    Element.prototype.insertAdjacentElement = function () { Element.prototype.insertAdjacentElement = orig; throw new Error('simulated render failure'); };
  });
  await importObj(page, goodState({ history: Object.assign({}, goodState().history, { [TODAY]: { minutes: 77, done: false, floor: false, qCount: 1, right: 1, timed: 0, timedWithin: 0, timedSec: 0 } }) }));
  const t3 = await toastText(page);
  const shownMin = await page.evaluate(() => (document.getElementById('todayMinutes') || {}).textContent || '');
  const after3 = await storeGet(page, 'cet6_p1_state_v1_9502');
  const cards3 = await planCards(page);
  const errs3 = page.__since(k3).errors;
  let storedMin = null;
  try { storedMin = JSON.parse(after3).history[TODAY].minutes; } catch (e) { }
  out.push(P('rollback', {
    name: 'C3 renderAll 抛异常时回滚', toast: t3, rolledBackToast: /导入失败/.test(t3),
    todayMinutesAfter: shownMin, showsOldData: /99/.test(shownMin), targetNotApplied: !/77/.test(shownMin),
    storedKeptOld: before3 === after3, storedTodayMinutes: storedMin, cards: cards3,
    renderErrorCount: errs3.length,
  }));

  for (const r of out) {
    r.ok = (r.name.indexOf('C1') === 0) ? r.rejected
      : (r.name.indexOf('C2') === 0) ? (r.oversizedRejected && r.errors.length === 0 && r.oldStateKept)
        : (r.rolledBackToast && r.targetNotApplied && r.cards > 0);
    log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + ' → toast=' + JSON.stringify(r.toast) + ' ' +
      (r.name.indexOf('C1') === 0 ? '拒绝=' + r.rejected : r.name.indexOf('C2') === 0 ? '超大拒绝=' + r.oversizedRejected + ' 旧存档保留=' + r.oldStateKept + ' 报错=' + r.errors.length
        : '回滚提示=' + r.rolledBackToast + ' 界面仍显示旧数据=' + r.showsOldData + '（今日 ' + r.todayMinutesAfter + '）今日卡片=' + r.cards));
  }
  await ctx.close();
  return out;
}

/* ---------- D. M-3 + M-4 CSV ---------- */
async function partD_csv(browser, IDS) {
  log('\n=========== D. M-3 幽灵 qid / M-4 公式注入（CSV 导出）===========');
  const { ctx, page } = await newPage(browser, 'csv');
  const OUT = [];
  const QID_A = IDS.reading;                // 真实阅读题
  const QID_B = 'ghost-qid-9999';           // 幽灵 qid（题库不存在）
  const FORMULA = { stem: '=1+1 题干以公式开头', lastAnswer: '=1+1', csvField: 'a,"b"\nc', due: '=cmd|\'/c calc\'!A1', wrongCount: '@SUM(A1)' };
  await boot(page, '9503', goodState({
    wrongbook: {
      [QID_A]: { addedAt: TODAY, box: 0, wrongCount: FORMULA.wrongCount, due: FORMULA.due, ease: 2.5, iv: 1, streak: 0 },
      [QID_B]: { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 },
    },
    papers: {
      [QID_A]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: FORMULA.lastAnswer },
      [QID_B]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: FORMULA.csvField },
    },
  }));
  // 载入时幽灵 qid 应已被清理（M-3 第一道防线）
  const pruned = await page.evaluate((g) => {
    const raw = localStorage.getItem('cet6_p1_state_v1_9503');
    const st = JSON.parse(raw);
    return { keys: Object.keys(st.wrongbook || {}), ghostGone: !(st.wrongbook || {})[g] };
  }, QID_B);
  P('csv', { name: 'D1 载入时清理幽灵 qid', storedWrongbook: pruned.keys, ghostRemoved: pruned.ghostGone });
  log('  ' + (pruned.ghostGone ? '✅' : '❌') + ' 载入清理幽灵 qid：localStorage 错题键=' + JSON.stringify(pruned.keys) + ' 幽灵已移除=' + pruned.ghostGone);

  // 题干换成公式开头（运行时改内存对象，不动题库文件）
  await page.evaluate(({ id, stem }) => {
    const b = (window.CET6_BANKS || []).filter(x => x.id === '2015-06-1')[0];
    const q = b && b.questions.filter(x => x.id === id)[0];
    if (q) q.stem = stem + ' ' + q.stem;
  }, { id: QID_A, stem: FORMULA.stem });

  await page.locator('nav button[data-p="backup"]').click();
  await page.waitForSelector('#wrongCsvBtn', { state: 'visible' });
  let csv = '', rows = [];
  try {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator('#wrongCsvBtn').click()]);
    const raw = fs.readFileSync(await d.path(), 'utf8');
    csv = raw.replace(/^\uFEFF/, '');
    fs.writeFileSync(path.join(DOCS, 'fix-verify-csv-sample.csv'), csv, 'utf8');
    rows = parseCSV(csv);
  } catch (e) { P('csv', { name: 'D2 导出失败', error: e.message }); log('  ❌ 导出 CSV 失败：' + e.message); }
  const head = rows[0] || [];
  const row = rows[1] || [];
  const d2 = P('csv', {
    name: 'D2 CSV 公式注入防护', rows: rows.length, header: head.length + ' 列',
    stem_field: row[3], answer_field: row[4], due_field: row[8], wrongCount_field: row[7],
    stemQuoted: /^'/.test(row[3] || ''), answerQuoted: /^'/.test(row[4] || ''),
    formulaPrefixLeft: (/^[=+\-@]/.test(row[3] || '') || /^[=+\-@]/.test(row[4] || '') || /^[=+\-@]/.test(row[7] || '') || /^[=+\-@]/.test(row[8] || '')),
  });
  d2.ok = d2.rows === 2 && d2.stemQuoted && d2.answerQuoted && !d2.formulaPrefixLeft;
  log('  ' + (d2.ok ? '✅' : '❌') + ' CSV 行数=' + d2.rows + '（表头+1 行，幽灵行已跳过）' +
    '\n      题干字段=' + JSON.stringify(d2.stem_field) + ' → 以 \' 开头=' + d2.stemQuoted +
    '\n      你的答案字段=' + JSON.stringify(d2.answer_field) + ' → 以 \' 开头=' + d2.answerQuoted +
    '\n      仍存在裸公式前缀=' + d2.formulaPrefixLeft);

  // D3：把某个真实 qid 的 findQ 打回 null，模拟"幽灵 qid 流到导出"——必须不崩且跳过该行（M-3 第二道防线）
  //     两条真实错题，只让其中一条的 findQ 变 null，才真正走"部分跳过"的路径
  await importObj(page, goodState({
    wrongbook: {
      [QID_A]: { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 },
      [IDS.listening]: { addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 },
    },
  }));
  await page.waitForTimeout(400);
  const k = page.__cursor();
  await page.evaluate((qid) => {
    const orig = window.CET6Core.findQ;
    window.CET6Core.findQ = function (banks, id) { return id === qid ? null : orig.apply(this, arguments); };
  }, QID_A);
  let crash = null, rows2 = [];
  try {
    const [d2b] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator('#wrongCsvBtn').click()]);
    rows2 = parseCSV(fs.readFileSync(await d2b.path(), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { crash = e.message; }
  const errs = page.__since(k).errors;
  const d3 = P('csv', {
    name: 'D3 findQ 返回 null 时导出不崩', crash, pageErrors: errs, rows: rows2.length,
    toast: await toastText(page), skippedNullRow: rows2.length === 2,
  });
  d3.ok = !crash && errs.length === 0 && rows2.length === 2;
  log('  ' + (d3.ok ? '✅' : '❌') + ' findQ 返回 null（2 条错题里 1 条取不到题）→ 导出未崩=' + !crash +
    ' 行数=' + rows2.length + '（表头+1，null 行被跳过=' + (rows2.length === 2) + '）页面报错=' + errs.length +
    (errs.length ? ' ⛔ ' + errs[0].slice(0, 140) : ''));
  await ctx.close();
  return [P('csv', { name: 'D1/D2/D3 汇总', ok: d3.ok && d2.ok && pruned.ghostGone })];
}

/* ---------- E. M-5 存储写满 ---------- */
async function partE_quota(browser) {
  log('\n=========== E. M-5 存储写满：save()=false + 常驻横幅 ===========');
  const { ctx, page } = await newPage(browser, 'quota');
  await boot(page, '9504', goodState());
  // 真实填满配额（Chromium 对"等量覆盖已有键"仍可能放行，所以还要做 E2 的确定性注入）
  const fill = await page.evaluate(() => {
    let n = 0, err = '';
    for (const sz of [100 * 1024, 16 * 1024, 1024, 256]) {
      for (let i = 0; i < 6000; i++) { try { localStorage.setItem('__junk_' + (n++), new Array(sz + 1).join('x')); } catch (e) { err = (e && e.name) || 'err'; break; } }
    }
    let canWrite32 = true;
    try { localStorage.setItem('__probe_small', new Array(33).join('y')); } catch (e) { canWrite32 = false; }
    return { n, err, canWrite32 };
  });

  // E1：配额耗尽后点「加练」（state 变大 → 一定写不进）→ 横幅必须出现，界面照常可用
  const k1 = page.__cursor();
  const before1 = await storeGet(page, 'cet6_p1_state_v1_9504');
  await page.evaluate(() => { const b = document.querySelector('#extraBtns button'); if (b) b.click(); });
  await page.waitForTimeout(600);
  const after1 = await storeGet(page, 'cet6_p1_state_v1_9504');
  const b1 = await page.evaluate(() => { const b = document.getElementById('saveWarn'); return { exists: !!b, visible: !!b && getComputedStyle(b).display !== 'none', text: b ? (b.textContent || '').trim() : '' }; });
  const errs1 = page.__since(k1).errors;
  const appAlive1 = await page.evaluate(() => { try { document.querySelector('nav button[data-p="today"]').click(); return document.querySelectorAll('#planList .card').length > 0; } catch (e) { return false; } });

  // E2：确定性注入 QuotaExceededError → 点「忙日打卡」→ 调用方走了失败分支（证明 save() 返回 false）
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(window.localStorage);
    const orig = proto.setItem;
    window.__origSetItem = orig;
    proto.setItem = function () { const e = new Error('QuotaExceededError: simulated'); e.name = 'QuotaExceededError'; throw e; };
  });
  const k2 = page.__cursor();
  const before2 = await storeGet(page, 'cet6_p1_state_v1_9504');
  await page.evaluate(() => { window.prompt = () => '5'; });
  await page.locator('#floorBtn').click().catch(() => { });
  await page.waitForTimeout(900);
  const toast2 = await toastText(page);
  const after2 = await storeGet(page, 'cet6_p1_state_v1_9504');
  const b2 = await page.evaluate(() => { const b = document.getElementById('saveWarn'); return { visible: !!b && getComputedStyle(b).display !== 'none', text: b ? (b.textContent || '').trim() : '' }; });
  const errs2 = page.__since(k2).errors;
  const memoryOk = await page.evaluate((t) => { const el = document.getElementById('todayStatus'); return !!el && /忙日打卡/.test(el.textContent || ''); }, TODAY);

  // E3：恢复写入 → 任一 save 路径 → 横幅撤下
  await page.evaluate(() => { const proto = Object.getPrototypeOf(window.localStorage); proto.setItem = window.__origSetItem; for (const kk of Object.keys(localStorage)) { if (kk.indexOf('__junk_') === 0 || kk === '__probe_small') { try { localStorage.removeItem(kk); } catch (e) { } } } });
  await page.evaluate(() => { const b = document.querySelector('#extraBtns button'); if (b) b.click(); });
  await page.waitForTimeout(600);
  const b3 = await page.evaluate(() => { const b = document.getElementById('saveWarn'); return { visible: !!b && getComputedStyle(b).display !== 'none', text: b ? (b.textContent || '').trim() : '' }; });

  const rec = P('quota', {
    name: 'E 存储写满', filled: fill.n, fillErr: fill.err, canWrite32: fill.canWrite32,
    e1_bannerAfterRealQuota: b1, e1_stateWriteFailed: before1 !== after1 || b1.visible, e1_pageErrors: errs1, e1_appAlive: appAlive1,
    e2_toast: toast2, e2_saveReturnedFalse: /保存失败/.test(toast2), e2_banner: b2,
    e2_stateUnchanged: before2 === after2, e2_pageErrors: errs2, e2_memoryStateApplied: memoryOk,
    e3_bannerHiddenAfterRecovery: !b3.visible,
  });
  rec.ok = b1.visible && errs1.length === 0 && rec.e2_saveReturnedFalse && b2.visible &&
    /保存失败/.test(b2.text) && rec.e2_stateUnchanged && errs2.length === 0 && rec.e3_bannerHiddenAfterRecovery && appAlive1;

  log((rec.ok ? '  ✅ ' : '  ❌ ') + '真实填满 ' + fill.n + ' 块（' + fill.err + '，连 32B 都写不进=' + (fill.canWrite32 === false) + '）' +
    '\n      E1 加练路径：横幅可见=' + b1.visible + ' 文案=' + JSON.stringify(b1.text) + ' 报错=' + errs1.length + ' 界面可用=' + appAlive1 +
    '\n      E2 注入 QuotaExceededError 后点忙日打卡：toast=' + JSON.stringify(toast2) +
    '\n         → save() 返回 false（调用方走失败分支）=' + rec.e2_saveReturnedFalse + ' 常驻横幅可见=' + b2.visible + ' 文案=' + JSON.stringify(b2.text) +
    '\n         存档字节未变=' + rec.e2_stateUnchanged + ' 内存内仍记下打卡=' + memoryOk + ' 页面报错=' + errs2.length +
    '\n      E3 写入恢复后横幅撤下=' + rec.e3_bannerHiddenAfterRecovery);
  if (errs1.length || errs2.length) log('      ⛔ ' + [].concat(errs1, errs2).map(e => e.slice(0, 140)).join(' | '));
  await ctx.close();
  return [rec];
}

/* ---------- F. M-6 localStorage 被禁 ---------- */
async function partF_blocked(browser) {
  log('\n=========== F. M-6 localStorage 被禁用时的启动兜底 ===========');
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage blocked'); } });
  });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const bodyTxt = ((await page.evaluate(() => (document.body ? document.body.textContent : ''))) || '').trim();
  const appChildren = await page.evaluate(() => (document.getElementById('app') || { children: [] }).children.length);
  const banner = await page.evaluate(() => { const b = document.getElementById('saveWarn'); return { exists: !!b, visible: !!b && b.style.display !== 'none', text: b ? (b.textContent || '').trim() : '' }; });
  const loginShown = await page.locator('#loginMask').count();
  const rec = P('blocked', {
    name: 'F localStorage getter 抛异常', pageErrors: errs, bodyTextLen: bodyTxt.length, appChildren,
    blankScreen: appChildren <= 1 && bodyTxt.length < 40, banner, loginMaskRendered: loginShown,
  });
  rec.ok = errs.length === 0 && !rec.blankScreen && banner.exists && banner.visible && /本地存储/.test(banner.text);
  log((rec.ok ? '  ✅ ' : '  ❌ ') + 'localStorage getter 抛异常 → 页面报错=' + errs.length + ' 白屏=' + rec.blankScreen +
    ' 登录层渲染=' + loginShown + ' 可见文本=' + bodyTxt.length + ' 字' +
    '\n      横幅可见=' + banner.visible + ' 文案=' + JSON.stringify(banner.text));
  if (errs.length) log('      ⛔ ' + errs[0].slice(0, 160));
  await ctx.close();
  return [rec];
}

/* ---------- 主流程 ---------- */
(async () => {
  try {
    const okNode = partA_node();
    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });
    // 取真实 qid
    const { ctx: c0, page: p0 } = await newPage(browser, 'probe');
    await p0.goto(URL, { waitUntil: 'load' });
    // 按需加载（架构级）：首屏只加载 meta 骨架，window.CET6_BANKS 是空数组。
    // 旧写法直接读 B[0].questions 会 TypeError: undefined reading 'questions'，
    // 必须先把目标卷脚本注入进来。
    await ensurePaper(p0, '2015-06-1');
    const IDS = await p0.evaluate(() => {
      const B = window.CET6_BANKS || [];
      const b = B.filter(x => x.id === '2015-06-1')[0] || B[0];
      const rd = b.questions.filter(q => q.type === 'reading')[0];
      const ls = b.questions.filter(q => q.type === 'listening')[0];
      return { reading: rd ? rd.id : '', listening: ls ? ls.id : '' };
    });
    await c0.close();
    log('\n真实 qid：reading=' + IDS.reading + ' listening=' + IDS.listening);

    const dirty = await partB_dirty(browser, IDS);
    const rollback = await partC_rollback(browser);
    const csv = await partD_csv(browser, IDS);
    const quota = await partE_quota(browser);
    const blocked = await partF_blocked(browser);
    await browser.close();

    // XSS：读取审计脚本复跑结果（上游产物 docs/security-audit-result.json 由 test_security_audit.js 生成）
    let audit = null;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(DOCS, 'security-audit-result.json'), 'utf8'));
      audit = {
        xssCases: a.summary.xssCases, xssExecuted: a.summary.xssExecuted, xssInjected: a.summary.xssInjected,
        dirtyCases: a.summary.dirtyCases, dirtyWithUncaught: a.summary.dirtyWithUncaught,
        journeySteps: a.summary.journeySteps,
      };
      // 文件在、但字段缺失（旧版产物或审计中途中断）同样算"上游产物不可用"，
      // 否则下面会打印出 "undefined 用例 / 0 / 0"，看起来像通过，实际根本没数据。
      if (audit.xssCases == null || !Array.isArray(audit.xssExecuted)) {
        audit = { error: 'docs/security-audit-result.json 存在但缺少 summary.xssCases / xssExecuted（产物过期或审计未跑完）' };
      }
    } catch (e) {
      audit = { error: '读不到 docs/security-audit-result.json（' + e.message + '）。请先运行：node test_security_audit.js' };
    }

    const groups = { B_dirty: dirty, C_rollback: rollback, D_csv: csv, E_quota: quota, F_blocked: blocked };
    R.groups = groups;
    R.audit = audit;
    R.finishedAt = new Date().toISOString();
    const flat = [].concat(dirty, rollback, csv, quota, blocked);
    R.nodes_ok = okNode;
    R.allOk = okNode && flat.every(x => x.ok === true) && !!audit && audit.xssExecuted && audit.xssExecuted.length === 0;

    fs.writeFileSync(path.join(DOCS, 'fix-verify-result.json'), JSON.stringify(R, null, 2), 'utf8');
    log('\n=========== 汇总 ===========');
    log('A normalizeState( Node )      : ' + (okNode ? 'PASS' : 'FAIL'));
    log('B 脏备份导入 5 类             : ' + dirty.filter(x => x.ok).length + '/' + dirty.length);
    log('C 导入回滚/体积上限           : ' + rollback.filter(x => x.ok).length + '/' + rollback.length);
    log('D CSV 幽灵 qid / 公式注入     : ' + csv.filter(x => x.ok).length + '/' + csv.length);
    log('E 存储写满 save()=false + 横幅: ' + (quota[0].ok ? 'PASS' : 'FAIL'));
    log('F localStorage 被禁启动兜底   : ' + (blocked[0].ok ? 'PASS' : 'FAIL'));
    log('XSS(H-1, test_security_audit) : ' + (audit.error
      ? '⚠ 上游产物不可用 — ' + audit.error
      : audit.xssCases + ' 用例 / 真正执行 ' + (audit.xssExecuted || []).length + ' / 注入成功 ' + (audit.xssInjected || []).length));
    log('脏数据(审计 18 例未捕获异常)  : ' + (audit.dirtyWithUncaught || []).length);
    log('\n总判定：' + (R.allOk ? '✅ 全部通过' : '❌ 存在未通过项'));
    log('明细：docs/fix-verify-result.json');
    process.exit(R.allOk ? 0 : 1);
  } catch (e) {
    console.error('验收脚本异常：', e);
    process.exit(2);
  }
})();
