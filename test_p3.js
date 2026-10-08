// scripts/test_p3.js —— P3 估分与薄弱点闭环：估分卡数值/薄弱考点判定/专项练全流程
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

  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 20000 });

  // 注入做题历史：考点A(reading) 4题错3对1（25%）、考点B(listening) 3题全对（100%）→ 最薄弱应为考点A
  // 新估分公式：客观率=284/390.5=72.7% → 外推客观=0.727*497=361.6 + 写译60%档=127.8 → 489
  // （旧公式 ×710 归一化为 516，新公式消除写译高估约27分）
  const seed = await page.evaluate(() => {
    const C = window.CET6Core;
    const meta = window.CET6_META; // 按需加载：首屏只有元数据骨架，qLite 含 id/type/points
    const today = C.todayStr();
    const all = [];
    Object.keys(meta.papers).forEach((pid) => {
      (meta.papers[pid].qLite || []).forEach((q) => all.push(q));
    });
    const reading = all.filter((q) => q.type === 'reading' && q.points && q.points.length);
    const pts = [...new Set(reading.map((r) => r.points[0]))];
    const A = pts[0];
    const aIds = reading.filter((r) => r.points[0] === A).slice(0, 4);
    // B 用听力考点（reading 题 points 只有共用标签，无法构造独立考点）；3 题全对 → 100% ✓
    const listening = all.filter((q) => q.type === 'listening' && q.points && q.points.length);
    const B = [...new Set(listening.map((r) => r.points[0]))][0];
    const bIds = listening.filter((r) => r.points[0] === B).slice(0, 3);
    const papers = {}, wrongbook = {};
    aIds.forEach((r, i) => {
      const wrong = i < 3; // 前3题错，第4题对
      papers[r.id] = { seen: 1, wrong: wrong ? 1 : 0, right: wrong ? 0 : 1, lastAt: today, lastResult: wrong ? 'wrong' : 'right' };
      if (wrong) wrongbook[r.id] = { addedAt: today, box: 0, wrongCount: 1, due: C.addDays(today, 1), ease: 2.3, iv: 1, streak: 0 };
    });
    bIds.forEach((r) => { papers[r.id] = { seen: 1, wrong: 0, right: 1, lastAt: today, lastResult: 'right' }; });
    return { A, B, aCount: aIds.length, bCount: bIds.length, aIds: aIds.map((r) => r.id), papers, wrongbook };
  });
  await page.evaluate((s) => {
    const C = window.CET6Core;
    const today = C.todayStr();
    const key = C.stateKey('9203');
    localStorage.setItem('cet6_user', '9203');
    localStorage.setItem(key, JSON.stringify({
      version: 1, history: {}, papers: s.papers, wrongbook: s.wrongbook, plan: null, essays: {},
    }));
  }, seed);
  await page.reload();
  await page.waitForSelector('#page-today');
  const ready = await page.evaluate(() => !!document.getElementById('pointTrainBtn') || !!document.querySelector('nav button'));
  await page.waitForTimeout(300);

  // 统计页：估分卡 + 薄弱考点按钮
  await page.locator('nav button[data-p="stat"]').click();
  await page.waitForSelector('#statGrid');
  const estTxt = (await page.locator('#page-stat .card', { hasText: '估算分' }).first().textContent()) || '';
  check('估分卡显示 489/710', /489\s*\/\s*710/.test(estTxt.replace(/\s+/g, ' ')), estTxt.replace(/\s+/g, ' ').slice(0, 60));
  check('估分口径标注基于 2/4 部分', /基于 2\/4 部分/.test(estTxt), estTxt.replace(/\s+/g, ' ').match(/基于 [^；。]{0,20}/)?.[0]);
  check('估分卡含听力/选词/匹配/阅读得分条', /听力|选词填空|信息匹配|仔细阅读/.test(estTxt), '');
  const ptTxt = (await page.locator('#ptTable').textContent()) || '';
  check('考点表 A 标⚠️ B 标✓', ptTxt.indexOf(seed.A) >= 0 && ptTxt.indexOf('⚠️') >= 0 && ptTxt.indexOf(seed.B) >= 0 && ptTxt.indexOf('✓') >= 0, ptTxt.replace(/\s+/g, ' ').slice(0, 60));
  const btn = page.locator('#pointTrainBtn');
  const btnTxt = await btn.textContent();
  check('专项练按钮指向最薄弱考点A', btnTxt.indexOf(seed.A) >= 0 && /25%/.test(btnTxt), btnTxt.replace(/\s+/g, ' '));

  // 点击 → 做题浮层出现专项练组（错题优先、≤6题）
  await btn.click();
  await page.waitForSelector('#quiz.show', { timeout: 20000 });
  const prog = (await page.locator('#quizProg').textContent()) || '';
  check('专项练组提示', /本组 \d 题/.test(prog), prog);
  const qidsShown = await page.evaluate(() => {
    const ids = [];
    document.querySelectorAll('#quizBody .opt').forEach((o) => { const q = o.getAttribute('data-q'); if (ids.indexOf(q) < 0) ids.push(q); });
    return ids;
  });
  // 专项练应只含考点A的题（错题在前），且 ≤6 题
  const aPointIds = await page.evaluate((A) => {
    const out = [];
    window.CET6_BANKS.forEach((b) => b.questions.forEach((q) => {
      if ((q.points || []).indexOf(A) >= 0) out.push(q.id);
    }));
    return out;
  }, seed.A);
  const inPoint = qidsShown.every((id) => aPointIds.indexOf(id) >= 0);
  check('专项练组 ≤6 题且均为考点A的题', qidsShown.length > 0 && qidsShown.length <= 6 && inPoint,
    qidsShown.length + ' 题，均在考点A: ' + inPoint);
  const hasWrong = qidsShown.some((id) => seed.aIds.slice(0, 3).indexOf(id) >= 0);
  check('专项练含在库错题（错题优先）', hasWrong, '');

  // 全对提交 → 完成返回
  await page.evaluate(() => {
    const ids = [];
    document.querySelectorAll('#quizBody .opt').forEach((o) => { const q = o.getAttribute('data-q'); if (ids.indexOf(q) < 0) ids.push(q); });
    ids.forEach((id) => {
      const q = window.CET6Core.findQ(window.CET6_BANKS, id);
      const btns = document.querySelectorAll('.opt[data-q="' + id + '"]');
      btns.forEach((b) => { if (b.getAttribute('data-v') === q.answer) b.click(); });
    });
  });
  await page.locator('#groupSubmit').click();
  await page.waitForSelector('#groupBar');
  const bar = (await page.locator('#groupBar').textContent()) || '';
  check('专项练判分并显示结果', /本组结果：\d\/\d 答对/.test(bar), bar.replace(/\s+/g, ' ').slice(0, 40));
  await page.locator('#groupDone').click();
  await page.waitForSelector('#quiz', { state: 'hidden' });
  check('专项练全程无页面错误', errs.length === 0, errs.join('|') || 'none');

  await page.screenshot({ path: path.join(ROOT, '..', 'docs', 'ui-17-score.png'), fullPage: true });

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== P3 估分与薄弱点: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
