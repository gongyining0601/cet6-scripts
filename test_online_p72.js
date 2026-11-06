/* 线上 P7.2 冒烟：写译页踩分词自查 + 卷号显示 + 热力图。
   2026-11-06 改造：
   · 登录前置 + localStorage key 带编号后缀（旧写法写 'cet6_p1_state_v1' 无后缀，
     新版读不到 → 注入的写译 plan 根本没生效，清单首张是选词填空，
     点开后没有 #essayTa，整个脚本崩在 fill()）
   · 按需加载：不再等 76 卷全量，等清单卡片即可；写译卡按标签定位而非"第一张"
   · 加断言（原先只 console.log，run_all 判 NO-ASSERT） */
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const URL = 'https://gongyining0601.github.io/cet6-trainer/';
const UID = '9102';
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

  // 注入 3 天打卡 + 一条写译条目（v 用当前 PLAN_VERSION，才不会被迁移丢弃）
  const injected = await page.evaluate(({ key }) => {
    const C = window.CET6Core;
    if (!C) return { ok: false };
    const t = C.todayStr();
    const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null };
    st.history[C.addDays(t, -2)] = { minutes: 30, done: true, floor: false };
    st.history[C.addDays(t, -1)] = { minutes: 12, done: false, floor: true };
    st.history[t] = { minutes: 28, done: true, floor: false };
    st.plan = { date: t, v: C.PLAN_VERSION, items: [
      { key: 'essay-test', type: 'translation', qids: [], paperId: '2015-06-1', done: false, minutes: 0 },
    ] };
    localStorage.setItem(key, JSON.stringify(st));
    return { ok: true, pv: C.PLAN_VERSION };
  }, { key: KEY });
  check('写入今日状态（3 天打卡 + 写译条目，PLAN_VERSION=' + injected.pv + '）', injected.ok);

  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#planList .card', { timeout: 30000 });
  await page.waitForTimeout(800);

  // 热力图
  await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(600);
  const nums = await page.$$eval('#heatmap i', els => els.map(e => e.textContent).filter(t => t !== ''));
  console.log('    热力图末 3 格:', nums.slice(-3).join(','));
  check('热力图显示近期打卡数字（' + nums.slice(-3).join('/') + '）', nums.length > 0);

  // 写译页
  await page.locator('nav button[data-p="today"]').click(); await page.waitForTimeout(500);
  const essayCard = page.locator('#planList .card').filter({ hasText: /翻译|写作/ }).first();
  const hasEssayCard = (await essayCard.count()) > 0;
  check('今日清单里有写译卡（注入生效）', hasEssayCard);
  if (hasEssayCard) {
    await essayCard.locator('button').first().click();
    try { await page.waitForSelector('#essayTa', { timeout: 20000 }); } catch (e) { }
    const taOk = (await page.locator('#essayTa').count()) > 0;
    check('写译答题区渲染', taOk);
    if (taOk) {
      await page.locator('#essayTa').fill('The year 2011 was a historic moment in China urbanization. Over the next two decades, some 350 million rural people will move to cities.');
      await page.locator('#essayCheck').click(); await page.waitForTimeout(600);
      const box = (await page.locator('#checkBox').textContent()) || '';
      const m = box.match(/覆盖 (\d+)\/(\d+)（(\d+)%）/);
      console.log('    踩分词自查:', m ? m[0] : '(无)');
      check('踩分词自查有实际覆盖统计', !!m);
      const prog = ((await page.locator('#quizProg').textContent()) || '').trim();
      console.log('    写译页卷号:', prog);
      check('写译页显示卷号且为注入的 2015-06-1: ' + prog.slice(0, 30), /2015-06-1/.test(prog));
    }
  }

  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'online-p72.png') });
  check('全程无 JS 错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''), errors.length === 0);

  await browser.close();
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== P7.2 线上冒烟: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  process.exit(fails ? 1 : 0);
})();
