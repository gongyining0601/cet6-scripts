// scripts/test_timer.js —— P2 考场限时：倒计时/断点续做/达标记录/统计/写译计时/超时红灯
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..', 'app');
const URL = 'file://' + path.join(ROOT, 'index.html');
const results = [];
const check = (name, ok, extra) => results.push((ok ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  // 注入一组计划：听力组（进入后真实点选 4 题答案）+ 写作组（限时 30 分钟）+ 超时用写作组（timerLeft=3）
  // 按需加载：首屏无题库正文，听力答案不预填（meta 无 answer），进入做题、卷加载后再从页面点选正确答案
  async function seedPlan(items) {
    await page.evaluate((its) => {
      const C = window.CET6Core;
      const today = C.todayStr();
      const key = C.stateKey('9202');
      localStorage.setItem('cet6_user', '9202');
      const planItems = its.map((x) => {
        if (x.type === 'listening') {
          return { key: 'listen-1', type: 'listening', qids: x.qids, done: false };
        }
        return { key: 'w' + Math.random().toString(36).slice(2, 7), type: 'writing', paperId: '2020-07-1', done: false, ...(x.timerLeft != null ? { timerLeft: x.timerLeft } : {}) };
      });
      localStorage.setItem(key, JSON.stringify({
        version: 1, history: {}, papers: {}, wrongbook: {}, essays: {},
        plan: { date: today, v: C.PLAN_VERSION, items: planItems },
      }));
    }, items);
    await page.reload();
    await page.waitForSelector('#planList .card', { timeout: 20000 });
  }

  // --- 场景 A：听力组计时 + 达标 + 统计 ---
  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 20000 });
  await seedPlan([{ type: 'listening', qids: ['2020-07-1-l-1', '2020-07-1-l-2', '2020-07-1-l-3', '2020-07-1-l-4'] }]);
  const cardsA = page.locator('#planList .card');
  await cardsA.nth(0).locator('button').click();
  await page.waitForSelector('#quiz.show', { timeout: 20000 });
  const t0 = await page.locator('#quizTimer').textContent();
  check('听力组初始倒计时 04:48（4题×72s）', t0.trim() === '⏱ 04:48', t0.trim());
  await page.waitForTimeout(2600);
  await page.screenshot({ path: path.join(ROOT, '..', 'docs', 'ui-16-timer.png'), fullPage: true });
  const t1 = await page.locator('#quizTimer').textContent();
  const m1 = /⏱ 04:(\d\d)/.exec(t1.trim());
  check('倒计时随时间递减', !!m1 && Number(m1[1]) < 48, t1.trim());
  // 断点续做：退出 → 重进 → 剩余时间延续（应小于 04:48）
  await page.locator('#quizBack').click();
  await page.waitForSelector('#quiz', { state: 'hidden' });
  await cardsA.nth(0).locator('button').click();
  await page.waitForSelector('#quiz.show');
  const t2 = await page.locator('#quizTimer').textContent();
  check('断点续做保留剩余时间', /⏱ 04:4[0-7]/.test(t2.trim()), t2.trim());
  // 已答 4/4 → 提交 → 结果卡用时与达标
  // 按需加载：卷动态加载完成后渲染选项，等选项出现再从页面点选正确答案作答
  await page.waitForSelector('#quizBody .opt', { timeout: 20000 });
  await page.evaluate(() => {
    const ids = [];
    document.querySelectorAll('#quizBody .opt').forEach((o) => { const q = o.getAttribute('data-q'); if (ids.indexOf(q) < 0) ids.push(q); });
    ids.forEach((id) => {
      const q = window.CET6Core.findQ(window.CET6_BANKS, id);
      document.querySelectorAll('.opt[data-q="' + id + '"]').forEach((b) => { if (b.getAttribute('data-v') === q.answer) b.click(); });
    });
  });
  await page.locator('#groupSubmit').click();
  await page.waitForSelector('#groupBar');
  const barA = (await page.locator('#groupBar').textContent()) || '';
  check('结果卡显示用时与达标', /用时 00:0\d|00:0\d \/ 标准 04:48/.test(barA) && /✓ 达标/.test(barA), barA.replace(/\s+/g, ' '));
  await page.locator('#groupDone').click();
  // 统计页限时达标卡
  await page.locator('nav button[data-p="stat"]').click();
  await page.waitForSelector('#statGrid');
  const gridA = (await page.locator('#statGrid').textContent()) || '';
  check('统计页限时达标 1/1 与平均用时', /1\/1 组\s*限时达标/.test(gridA) && /00:0\d\s*平均每组用时/.test(gridA), gridA.replace(/\s+/g, ' '));

  // --- 场景 B：写作组计时 30 分钟 ---
  await seedPlan([{ type: 'writing' }]);
  const cardsB = page.locator('#planList .card');
  await cardsB.nth(0).locator('button').click();
  await page.waitForSelector('#essayTa', { timeout: 20000 }); // 按需加载：写作卷（2020-07-1）动态加载后渲染题面
  const tW = await page.locator('#quizTimer').textContent();
  check('写作组倒计时 30:00', tW.trim() === '⏱ 30:00', tW.trim());
  // 写作组完成也记录用时
  await page.locator('#essayTa').fill('A practice essay for the timer test, long enough to save a draft.');
  await page.locator('#essayDone').click();
  await page.waitForSelector('#quiz', { state: 'hidden' });
  await page.locator('nav button[data-p="stat"]').click();
  const gridB = (await page.locator('#statGrid').textContent()) || '';
  check('写作组计入限时统计（1/1）', /1\/1 组\s*限时达标/.test(gridB), gridB.replace(/\s+/g, ' ').match(/1\/1 组\s*限时达标/)?.[0] || gridB.replace(/\s+/g, ' ').slice(0, 60));

  // --- 场景 C：超时红灯（timerLeft=3 秒）---
  await seedPlan([{ type: 'writing', timerLeft: 3 }]);
  const cardsC = page.locator('#planList .card');
  await cardsC.nth(0).locator('button').click();
  await page.waitForSelector('#essayTa', { timeout: 20000 });
  const tC0 = await page.locator('#quizTimer').textContent();
  check('恢复剩余时间 00:03', tC0.trim() === '⏱ 00:03', tC0.trim());
  await page.waitForTimeout(5200);
  const cls = await page.locator('#quizTimer').getAttribute('class');
  const tC1 = await page.locator('#quizTimer').textContent();
  check('超时后标红闪烁且显示 00:00', /overtime/.test(cls) && /00:00/.test(tC1), cls + ' ' + tC1.trim());
  check('全程无页面错误', errs.length === 0, errs.join('|') || 'none');

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== 考场限时: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
