/* 线上 P7.1 冒烟：注入 P6 旧 plan，验证迁移重算（旧 plan 被丢弃、按新规则重排）。
   2026-11-06 改造：
   · 登录是前置（新版必须先登录才有清单），localStorage key 带编号后缀
   · 按需加载：CET6_BANKS 首屏为空，取 qid 前用 ensurePaper 只注入 2015-06-1 一卷
   · 加断言（原先只 console.log，run_all 判 NO-ASSERT） */
const path = require('path');
const { chromium: loadChromium, EXE, ensurePaper } = require('./_env');
const { chromium } = loadChromium();
const URL = 'https://gongyining0601.github.io/cet6-trainer/';
const UID = '9101';
const KEY = 'cet6_p1_state_v1_' + UID;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const results = [];
  const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); console.log((ok ? 'ok  ' : 'FAIL') + ' - ' + name); };

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#loginMask', { timeout: 30000 });
  await page.locator('#phoneInput').fill(UID);
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 30000 });
  check('登录并生成今日清单', (await page.locator('#planList .card').count()) >= 1);

  // 只注入 2015-06-1 一卷（按需加载：拿到旧卷 qid 即可，不必全量 76 卷）
  const got = await ensurePaper(page, '2015-06-1');
  check('按需注入 2015-06-1 卷', got);

  const injected = await page.evaluate(({ key }) => {
    const banks = window.CET6_BANKS || [];
    const p1 = banks.find(b => b.id === '2015-06-1');
    if (!p1) return { ok: false, why: 'no-paper' };
    const rIds = p1.questions.filter(q => q.type === 'reading' && q.qno >= 46 && q.qno <= 50).map(q => q.id);
    const lq = [20, 19, 23, 5].map(n => (p1.questions.find(x => x.type === 'listening' && x.qno === n) || {}).id).filter(Boolean);
    const d = window.CET6Core.todayStr();
    // 故意注入 P6 时代结构（无 v 字段），验证载入时整份丢弃重算
    localStorage.setItem(key, JSON.stringify({
      version: 1, history: {}, papers: {}, wrongbook: {}, essays: {},
      plan: { date: d, items: [
        { key: 'listening', type: 'listening', qids: lq, done: false, minutes: 0 },
        { key: 'reading', type: 'reading', qids: rIds, paperId: '2015-06-1', done: false, minutes: 0 },
        { key: 'translation', type: 'translation', qids: [], paperId: '2015-06-1', done: false, minutes: 0 },
      ] },
    }));
    return { ok: true, lq: lq.length, rIds: rIds.length };
  }, { key: KEY });
  check('写入旧版 plan（听 ' + (injected.lq || 0) + ' 题 / 读 ' + (injected.rIds || 0) + ' 题）', injected.ok);

  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#planList .card', { timeout: 30000 });
  await page.waitForTimeout(800);

  const cards = await page.$$eval('#planList .card', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('    清单:', JSON.stringify(cards.map(c => c.slice(0, 40))));
  const hasEssay = cards.some(t => t.indexOf('翻译') >= 0 || t.indexOf('写作') >= 0);
  const has2026 = cards.some(t => t.indexOf('2026-06-3') >= 0);
  const has2015 = cards.some(t => t.indexOf('2015-06-1') >= 0);

  check('旧 plan 被丢弃：清单里不再出现 2015-06-1 旧卷', !has2015);
  check('重算后从最新卷 2026-06-3 起排', has2026);
  check('周五不排写译（今日 ' + new Date().toLocaleDateString('zh-CN') + '）', !hasEssay);
  check('全程无 JS 错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''), errors.length === 0);

  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'online-p71.png') });
  await browser.close();
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== P7.1 线上冒烟: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  process.exit(fails ? 1 : 0);
})();
