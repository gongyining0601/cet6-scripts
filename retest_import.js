'use strict';
/* ============================================================================
   CET6 复测轮 A3/A4/A5 + B3：导入回滚 / 5MB 上限 / 类型错乱 / CSV 公式注入 /
                              幽灵 qid / CSV 转义 / 导出导入往返一致性
   运行：cd D:\CET6\scripts ; node retest_import.js
   产物：docs/retest-security-*.png / docs/retest-import-result.json / docs/retest-import-log.txt
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'app', 'index.html');
const URL = fileUrl(INDEX);
// 第四轮 R4-L4：从 core.js 动态取 PLAN_VERSION，夹具不再硬编码 v:3（旧版本号会被 ensurePlan 丢弃重算导致假失败）
const PLANV_N = parseInt((fs.readFileSync(path.join(ROOT, 'app', 'core.js'), 'utf8').match(/CORE\.PLAN_VERSION\s*=\s*(\d+)/) || [])[1], 10);
if (!PLANV_N) { throw new Error('无法从 core.js 解析 PLAN_VERSION'); }
const DOCS = path.join(ROOT, 'docs');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
const UID = '9203';
const SKEY = 'cet6_p1_state_v1_' + UID;
const LEGACY = 'cet6_p1_state_v1';
const QID = '2026-06-1-r-46';
const PAPER = '2026-06-1';
const GOOD = 'GOODMARK987';

const R = { meta: {}, cases: [], csv: {}, roundtrip: null, isolation: null, summary: {} };
const S = v => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return String(v); } };
function t(name, group, pass, detail) {
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return pass;
}

async function newCtx(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 430, height: 940 }, acceptDownloads: true }, opts || {}));
  const page = await ctx.newPage();
  const logs = { console: [], pageerror: [], dialog: [] };
  page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.pageerror.push(String((e && e.message) || e)));
  page.on('dialog', async dl => { logs.dialog.push({ type: dl.type(), message: dl.message() }); try { await dl.accept(''); } catch (e) { } });
  return { ctx, page, logs };
}
async function boot(page, stateObj, uid) {
  uid = uid || UID;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try {
      localStorage.removeItem('cet6_p1_state_v1_' + id);
      if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st);
    } catch (e) { }
  }, { id: uid, st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); } catch (e) { }
  await page.waitForTimeout(250);
}
const toastText = page => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
const storeGet = (page, k) => page.evaluate(x => localStorage.getItem(x), k);
async function shot(page, n) { try { await page.screenshot({ path: path.join(DOCS, 'retest-security-' + n + '.png'), fullPage: false }); } catch (e) { } }
const importRaw = async (page, body, filename, mime) => {
  await page.setInputFiles('#importFile', { name: filename || 'cet6-backup-test.json', mimeType: mime || 'application/json', buffer: Buffer.from(body) });
  await page.waitForTimeout(800);
};
const importObj = (page, o, fn) => importRaw(page, JSON.stringify(o), fn);

function goodState(extra) {
  const s = { version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '', __good: GOOD };
  s.history[TODAY] = { minutes: 12, done: false, floor: false, qCount: 8, right: 6, timed: 1, timedWithin: 1, timedSec: 70 };
  // 标记必须放在 normalizeState 会保留的字段里；unknown 顶层字段（__good）会被归一化丢弃
  s.papers[QID] = { seen: 2, right: 2, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: GOOD };
  s.wrongbook[QID] = { addedAt: TODAY, box: 0, wrongCount: 2, due: TODAY, ease: 2.5, iv: 1, streak: 0 };
  return Object.assign(s, extra || {});
}
/* 数据层等价比较：不看 key 顺序，也不把"归一化后重新落盘"误判成数据丢失 */
const DATA_KEYS = ['history', 'papers', 'wrongbook', 'essays', 'hl', 'lastBackup'];
function sameData(a, b) {
  let x, y;
  try { x = JSON.parse(a); y = JSON.parse(b); } catch (e) { return false; }
  return DATA_KEYS.every(k => JSON.stringify(x[k] === undefined ? null : x[k]) === JSON.stringify(y[k] === undefined ? null : y[k]));
}
/* #exportBtn / #wrongCsvBtn 位于 #page-backup（默认 display:none），必须先切页签 */
async function goBackup(page) {
  await page.evaluate(() => { const b = document.querySelector('nav button[data-p="backup"]'); if (b) b.click(); });
  await page.waitForTimeout(350);
}
const baseState = e => Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' }, e || {});
const wrongEntry = (o) => Object.assign({ addedAt: TODAY, box: 0, wrongCount: 1, due: TODAY, ease: 2.5, iv: 1, streak: 0 }, o || {});

/* ========================================================================== */
(async () => {
  try {
    R.meta = { url: URL, browser: EXE, today: TODAY, node: process.version, startedAt: new Date().toISOString() };
    log('CET6 复测 A3/A4/A5 · 导入导出复测  ' + R.meta.startedAt + '\n页面：' + URL + '\n');

    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });

    /* ---------------- 1) 导入损坏 JSON：旧数据必须存活 ---------------- */
    log('=== 1) 导入损坏 JSON → 回滚 + 提示「导入失败」 ===');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, goodState());
      const before = await storeGet(page, SKEY);
      const planBefore = await page.locator('#planList .card').count();
      await importRaw(page, '{"version":1,"history":{' + '"' + TODAY + '":{"minutes":9}, BROKEN', 'broken.json');
      const after = await storeGet(page, SKEY);
      const toast = await toastText(page);
      const alive = await page.evaluate(() => {
        const el = document.getElementById('planList');
        return { cards: document.querySelectorAll('#planList .card').length, bodyChildren: document.body.children.length, blank: document.body.innerText.trim().length < 20 };
      });
      t('损坏 JSON 被拒（提示含「导入失败」）', '导入回滚', /导入失败/.test(toast), S(toast));
      t('旧数据未被覆盖（数据层等价）', '导入回滚', sameData(before, after), 'raw-equal=' + (before === after));
      t('旧数据含标记仍在', '导入回滚', !!after && after.indexOf(GOOD) >= 0, '');
      t('页面未白屏（清单仍有 ' + alive.cards + ' 张卡）', '导入回滚', !alive.blank && alive.cards > 0 && alive.cards === planBefore, S(alive));
      t('无 JS 报错', '导入回滚', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await shot(page, 'import-rollback-broken');
      await ctx.close();
    }

    /* ---------------- 2) 5MB 上限 ---------------- */
    log('\n=== 2) 导入 5MB+ 大文件 → 拒绝且保留旧数据 ===');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, goodState());
      // 构造 > 5MB 的真实合法 JSON（papers 里塞大量唯一键），确保被"体积"这一条拦住而不是 JSON 语法
      const big = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} };
      for (let i = 0; i < 70000; i++) big.papers['2026-06-1-r-' + (1000 + i)] = { seen: 1, right: 1, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: 'A' };
      const body = JSON.stringify(big);
      log('   （构造文件 ' + (body.length / 1048576).toFixed(2) + ' MB，JSON 语法合法）');
      const before = await storeGet(page, SKEY);
      await importRaw(page, body, 'huge.json');
      const after = await storeGet(page, SKEY);
      const toast = await toastText(page);
      t('>5MB 被拒且提示明确', '体积上限', /导入失败/.test(toast) && /5MB/.test(toast), S(toast));
      t('旧数据保留（数据层等价 + 标记仍在）', '体积上限', sameData(before, after) && !!after && after.indexOf(GOOD) >= 0,
        'raw-equal=' + (before === after) + ' hasMark=' + (!!after && after.indexOf(GOOD) >= 0));
      t('无 JS 报错', '体积上限', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await shot(page, 'import-too-large');
      await ctx.close();
    }

    /* ---------------- 3) 类型错乱数据 → 清洗后不白屏 ---------------- */
    log('\n=== 3) 导入类型错乱数据 → normalizeState 清洗后不白屏 ===');
    const BAD_IMPORT = {
      version: 1,
      history: { [TODAY]: 'not-an-object', '2026-13-45': { minutes: 'abc' }, 'garbage': { minutes: 1 } },
      papers: { [QID]: 123, 'zzz': null, '2026-06-1-r-47': { seen: 'x', right: [], lastResult: 5 } },
      wrongbook: { [QID]: 'string', 'ghost-9999': { box: 'NaN', wrongCount: {}, due: 'illegal' } },
      essays: { writing: { text: 12345 } },
      hl: 'not-an-object',
      plan: { date: TODAY, v: PLANV_N, items: ['x', null, { key: 'k', type: 'reading', qids: ['ghost-9999', null, 5], label: null, done: 'yes', minutes: 'x' }] },
      lastBackup: 123,
    };
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, goodState());
      await importObj(page, BAD_IMPORT);
      const toast = await toastText(page);
      const st = await page.evaluate(() => {
        const el = document.getElementById('planList');
        return { blank: document.body.innerText.trim().length < 20, cards: document.querySelectorAll('#planList .card').length };
      });
      const saved = await storeGet(page, SKEY);
      let parsed = null; try { parsed = JSON.parse(saved); } catch (e) { }
      // 遍历 4 个页签，确保渲染不崩
      const crash = [];
      for (const p of ['wrong', 'stat', 'backup', 'today']) {
        const b = page.locator(`nav button[data-p="${p}"]`);
        if (await b.count()) { await b.first().click(); await page.waitForTimeout(250); }
        if (logs.pageerror.length) crash.push(p + ':' + logs.pageerror.join('|'));
      }
      t('导入成功（类型错乱数据被清洗而非报错）', '脏数据导入', /导入成功/.test(toast), S(toast));
      t('页面未白屏', '脏数据导入', !st.blank, S(st));
      t('4 个页签切换均无 JS 报错', '脏数据导入', crash.length === 0 && logs.pageerror.length === 0, crash.join(' ; '));
      t('落盘数据里 history 只有合法日期键', '脏数据导入', !!parsed && Object.keys(parsed.history).every(k => /^\d{4}-\d{2}-\d{2}$/.test(k)), parsed ? S(Object.keys(parsed.history)) : 'parse-fail');
      t('落盘 papers 里非法条目被丢弃', '脏数据导入', !!parsed && parsed.papers['zzz'] === undefined && parsed.papers[QID] === undefined, parsed ? S(Object.keys(parsed.papers)) : '');
      t('落盘 wrongbook 幽灵 qid 被 pruneGhosts 清掉', '脏数据导入', !!parsed && parsed.wrongbook['ghost-9999'] === undefined, parsed ? S(Object.keys(parsed.wrongbook)) : '');
      t('落盘 plan.items 非法项被过滤', '脏数据导入', !!parsed && parsed.plan && Array.isArray(parsed.plan.items) && parsed.plan.items.every(x => x && typeof x === 'object'), parsed && parsed.plan ? S(parsed.plan.items) : '');
      await shot(page, 'import-dirty-state');
      await ctx.close();
    }
    /* 3b) 缺少必需字段 → 拒绝 */
    {
      const { ctx, page } = await newCtx(browser);
      await boot(page, goodState());
      await importObj(page, { version: 1 });
      const toast = await toastText(page);
      const after = await storeGet(page, SKEY);
      t('缺 history/papers 的 JSON 被拒且旧数据保留', '脏数据导入', /导入失败/.test(toast) && !!after && after.indexOf(GOOD) >= 0 && sameData(after, await storeGet(page, SKEY)), S(toast));
      await ctx.close();
    }
    /* 3c) 顶层是数组/字符串 → 拒绝 */
    {
      const { ctx, page } = await newCtx(browser);
      await boot(page, goodState());
      await importRaw(page, '[1,2,3]');
      const t1 = await toastText(page);
      await importRaw(page, '"just a string"');
      const t2 = await toastText(page);
      const after = await storeGet(page, SKEY);
      t('顶层数组被拒', '脏数据导入', /导入失败/.test(t1), S(t1));
      t('顶层字符串被拒', '脏数据导入', /导入失败/.test(t2), S(t2));
      t('两种情况下旧数据都保留', '脏数据导入', !!after && after.indexOf(GOOD) >= 0, '');
      await ctx.close();
    }
    /* 3d) accept=".json" 之外的扩展名也能被读入 → 记录事实 */
    {
      const { ctx, page } = await newCtx(browser);
      await boot(page, goodState());
      await importRaw(page, JSON.stringify(goodState({ history: { [TODAY]: { minutes: 99, done: true, floor: false, qCount: 1, right: 1, timed: 0, timedWithin: 0, timedSec: 0 } } })), 'actually-a-json-but-named.txt', 'text/plain');
      const toast = await toastText(page);
      const after = await storeGet(page, SKEY);
      const ok = /导入成功/.test(toast) && /99/.test(after || '');
      R.cases.push({ name: 'accept=".json" 只是前端筛选，任意扩展名文件仍会被 FileReader 读入并按内容判断', group: '导入文件类型', pass: true, detail: 'toast=' + toast, informational: true });
      log('  [fact] 上传 .txt（内容为合法 JSON）→ 结果：' + toast + '（说明只看内容，不看扩展名）');
      await importRaw(page, 'not json at all', 'x.json');
      t('.json 名但内容不是 JSON → 被拒', '导入文件类型', /导入失败/.test(await toastText(page)), '');
      await ctx.close();
    }

    /* ---------------- 4) 同名账号导入覆盖 ---------------- */
    log('\n=== 4) 导入同名账号备份 → 应正确覆盖 ===');
    {
      const { ctx, page } = await newCtx(browser);
      await boot(page, goodState());
      const incoming = goodState({
        history: { [TODAY]: { minutes: 55, done: true, floor: false, qCount: 4, right: 4, timed: 0, timedWithin: 0, timedSec: 0 } },
        papers: { [QID]: { seen: 1, right: 1, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: 'IMPORTED' } },
      });
      await importObj(page, incoming);
      const st = await page.evaluate(() => {
        const t = document.getElementById('todayMinutes');
        return { minTxt: t ? t.textContent : '', cards: document.querySelectorAll('#planList .card').length };
      });
      const saved = await storeGet(page, SKEY);
      t('导入后界面显示新数据 55 分钟', '覆盖导入', /55/.test(st.minTxt), S(st));
      t('落盘被新数据替换（含 IMPORTED 标记）', '覆盖导入', !!saved && saved.indexOf('IMPORTED') >= 0, 'mark=' + (!!saved && saved.indexOf('IMPORTED') >= 0));
      await ctx.close();
    }

    /* ---------------- 5) 导出 → 导入 往返一致性 ---------------- */
    log('\n=== 5) 导出 JSON → 再导入 → 往返一致性 ===');
    {
      const { ctx, page } = await newCtx(browser);
      const st = baseState({
        history: { [TODAY]: { minutes: 33, done: true, floor: false, qCount: 10, right: 7, timed: 2, timedWithin: 1, timedSec: 150 } },
        papers: { [QID]: { seen: 3, right: 2, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: 'C' } },
        wrongbook: { [QID]: wrongEntry({ wrongCount: 2 }) },
        essays: { writing: { lastAt: TODAY, text: 'my draft' } },
        hl: { [PAPER + '#reading#read0']: ['social media'] },
        plan: { date: TODAY, v: PLANV_N, items: [{ key: 'k', type: 'reading', qids: [QID], paperId: PAPER, label: 'L', done: true, minutes: 0, timerLeft: 42, draft: { [QID]: 'B' } }] },
      });
      await boot(page, st);
      const before = JSON.parse(await storeGet(page, SKEY));
      await goBackup(page);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBtn').click()]);
      const p1 = await dl.path();
      const text = fs.readFileSync(p1, 'utf8');
      fs.writeFileSync(path.join(DOCS, 'retest-security-export-roundtrip.json'), text, 'utf8');
      // 清空后再导入同一份
      await page.evaluate(() => localStorage.removeItem('cet6_p1_state_v1_9203'));
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(600);
      await importRaw(page, text, 'roundtrip.json');
      const after = JSON.parse(await storeGet(page, SKEY));
      const keys = ['history', 'papers', 'wrongbook', 'essays', 'hl', 'lastBackup'];
      const diff = [];
      keys.forEach(k => { if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff.push(k); });
      R.roundtrip = { before, after, diffKeys: diff };
      t('导出文件是合法 JSON', '往返一致', !!before, '导出 ' + text.length + ' 字节');
      t('history/papers/wrongbook/essays/hl/lastBackup 往返无损', '往返一致', diff.length === 0, '不一致字段：' + S(diff));
      t('plan 的 done/draft/timerLeft 往返保留', '往返一致',
        after.plan && after.plan.items[0] && after.plan.items[0].done === true && after.plan.items[0].draft && after.plan.items[0].draft[QID] === 'B' && after.plan.items[0].timerLeft === 42,
        after.plan ? S(after.plan.items[0]) : 'no-plan');
      log('   （before 里有的字段：' + Object.keys(before).join(',') + '）');
      await ctx.close();
    }

    /* ---------------- 6) CSV：公式注入 + 转义 + 幽灵 qid ---------------- */
    log('\n=== 6) CSV 导出：公式注入中和 / 特殊字符转义 / 幽灵 qid ===');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const Q2 = '2026-06-1-r-47';  // 逗号/引号/换行 转义压力
      const Q3 = '2026-06-1-r-48';  // 裸 \r 转义压力
      const st = baseState({
        papers: {
          [QID]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: '-2+3' },   // 状态侧公式前缀
          [Q2]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: 'a,"b"\nc' },
          [Q3]: { seen: 1, right: 0, wrong: 1, lastAt: TODAY, lastResult: 'wrong', lastAnswer: 'X\rY' },
        },
        wrongbook: {
          [QID]: wrongEntry({}),
          [Q2]: wrongEntry({}),
          [Q3]: wrongEntry({}),
          ['ghost-9999-r-1']: wrongEntry({}),   // 幽灵 qid
        },
      });
      await boot(page, st);
      // 内存篡改题库字段，验证"题干/考点/答案"三列的公式中和
      const mutated = await page.evaluate(() => {
        const b = (window.CET6_BANKS || []).find(x => x.id === '2026-06-1');
        const q = b.questions.find(x => x.id === '2026-06-1-r-46');
        const q2 = b.questions.find(x => x.id === '2026-06-1-r-47');
        q.stem = '=1+1'; q.points = ['@SUM(A1:A9)']; q.answer = '+cmd|/c calc';
        q2.stem = 'plain, with "quotes" and comma';
        return { q: q.stem, q2: q2.stem };
      });
      await goBackup(page);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#wrongCsvBtn').click()]);      const p1 = await dl.path();
      const buf = fs.readFileSync(p1);
      const csv = buf.toString('utf8');
      fs.writeFileSync(path.join(DOCS, 'retest-security-csv-formula.csv'), csv, 'utf8');
      const rows = csv.replace(/^\uFEFF/, '').split('\r\n');
      R.csv = { header: rows[0], rows: rows.slice(1), mutated, rawHead: csv.slice(0, 1200) };
      const header = rows[0];
      const line1 = rows.find(r => r.indexOf('2026-06-1,46,') === 0) || '';
      const line2 = rows.find(r => r.indexOf('2026-06-1,47,') === 0) || '';
      const line3 = rows.find(r => r.indexOf('2026-06-1,48,') === 0) || '';
      const bareCR = (csv.match(/\r(?!\n)/g) || []).length;
      const bareLF = (csv.match(/(?<!\r)\n/g) || []).length;
      R.csv.bareCRCount = bareCR;
      R.csv.bareLFCount = bareLF;
      t('CSV 带 UTF-8 BOM（Excel 中文不乱码）', 'CSV 公式注入', csv.charCodeAt(0) === 0xFEFF, 'first=U+' + csv.charCodeAt(0).toString(16).toUpperCase());
      t('表头 10 列正确', 'CSV 公式注入', header === '卷号,题号,题型,题干,你的答案,正确答案,考点,错次,下次复习,稳固度', S(header));
      t('题干 "=1+1" 被中和为 \'=1+1', 'CSV 公式注入', line1.indexOf("'=1+1") >= 0, S(line1.slice(0, 46)));
      t('考点 "@SUM(A1:A9)" 被中和', 'CSV 公式注入', line1.indexOf("'@SUM(A1:A9)") >= 0, '');
      t('正确答案 "+cmd|/c calc" 被中和', 'CSV 公式注入', line1.indexOf("'+cmd|/c calc") >= 0, '');
      t('你的答案 "-2+3" 被中和', 'CSV 公式注入', line1.indexOf("'-2+3") >= 0, '');
      t('幽灵 qid 行被跳过（3 条数据行，无幽灵行）', 'CSV 幽灵 qid', rows.slice(1).filter(r => r.trim()).length === 3 && csv.indexOf('ghost-9999') < 0, 'rows=' + S(rows.slice(1)));
      t('导出不崩、无 JS 报错', 'CSV 幽灵 qid', logs.pageerror.length === 0, logs.pageerror.join('|'));
      t('含逗号/引号的题干被正确引用并双重引号', 'CSV 转义', /"plain, with ""quotes"" and comma"/.test(line2), S(line2.slice(0, 130)));
      t('含换行(\\n)的字段被替换为空格并正确引用（换行不会撑破行）', 'CSV 转义', line2.indexOf('"a,""b"" c"') >= 0 && line2.indexOf('\n') < 0, S(line2.slice(0, 130)));
      t('CSV 里不存在裸换行（\\r 或 \\n，否则 Excel 会把它当行结束符而撑破行）', 'CSV 转义', bareCR === 0 && bareLF === 0,
        bareCR + " 个裸 \\r、" + bareLF + " 个裸 \\n；你的答案 'X\\rY' 落到第 48 题行 → " + S(line3.slice(0, 60)) + '，csvEsc 的 /[",\\n]/ 未覆盖 \\r');
      await shot(page, 'csv-formula-injection');
      await ctx.close();
    }

    /* ---------------- 7) 错题本为空时导出 CSV ---------------- */
    log('\n=== 7) 0 错题时导出 CSV ===');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      await goBackup(page);
      await page.locator('#wrongCsvBtn').click();
      await page.waitForTimeout(600);
      const toast = await toastText(page);
      t('空错题本提示且不生成空文件、不报错', 'CSV 边界', /空的/.test(toast) && logs.pageerror.length === 0, S(toast));
      await ctx.close();
    }
    /* ---------------- 8) 路由：答题会话中导出/退出 ---------------- */
    log('\n=== 8) 答题会话中作答后再导出（序列化健壮性，查循环引用）===');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, baseState());
      const b = page.locator('#planList .card button').first();
      if (await b.count()) { await b.click(); await page.waitForTimeout(350); }
      const opt = page.locator('#quizBody .opt').first();
      if (await opt.count()) { await opt.click(); await page.waitForTimeout(250); }
      await page.screenshot({ path: path.join(DOCS, 'retest-security-draft-inprogress.png') });
      await page.locator('#quizBack').click();
      await page.waitForTimeout(300);
      await goBackup(page);
      const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBtn').click()]);
      const p2 = await dl2.path();
      const txt = fs.readFileSync(p2, 'utf8');
      let parseOk = true, obj = null; try { obj = JSON.parse(txt); } catch (e) { parseOk = false; }
      t('作答+退出后导出 JSON 可解析（无循环引用）', '序列化', parseOk, 'len=' + txt.length);
      t('草稿已写入 plan.items[].draft', '序列化',
        !!obj && !!obj.plan && obj.plan.items.some(it => it.draft && Object.keys(it.draft).length > 0),
        obj && obj.plan ? S(obj.plan.items.map(it => it.draft)) : 'no-plan');
      t('无 JS 报错', '序列化', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    const failed = R.cases.filter(c => !c.pass);
    R.summary = { total: R.cases.length, pass: R.cases.length - failed.length, fail: failed.length, failed: failed.map(f => f.group + ' · ' + f.name + ' → ' + f.detail) };
    log('\n================ 汇总 ================');
    log(`  断言 ${R.summary.total} 条：通过 ${R.summary.pass}，失败 ${R.summary.fail}`);
    failed.forEach(f => log('   ✗ ' + f.group + ' · ' + f.name + ' → ' + f.detail));

    fs.writeFileSync(path.join(DOCS, 'retest-import-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-import-log.txt'), LINES.join('\n'), 'utf8');
    await browser.close();
    log('\n已写出 docs/retest-import-result.json 与 docs/retest-import-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-import-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  }
})();
