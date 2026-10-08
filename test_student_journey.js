/* 学生视角实测：完整一天学习流程 + 体验数据采集（本地文件，排除网络变量） */
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'app/index.html');

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // 手机尺寸
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept(''));
  const results = [];
  const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); };

  const t0 = Date.now();
  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 15000 });
  await page.locator('#phoneInput').fill('2026');
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 30000 });
  const loadSec = ((Date.now() - t0) / 1000).toFixed(1);

  // ---- 今日清单：学生看到什么 ----
  const cards = await page.locator('#planList .card').count();
  const planTxt = await page.locator('#planList').textContent();
  const totalMin = (planTxt.match(/(\d+)\s*分钟/g) || []).join(',');
  check('今日清单 ' + cards + ' 组、时长标注: ' + totalMin, cards >= 1);
  check('卷号可查（含年份标注）', /20\d\d[-.年]/.test(planTxt));
  await page.screenshot({ path: path.join(ROOT, 'docs/student-1-today.png'), fullPage: true });

  // ---- 做题：挑一张含选项的组（整组同屏）----
  // 计划首卡可能是选词填空（UI 是「词库 .wb-chip + 段落空格 .cloze-slot」，没有 .opt），
  // 旧写法无脑点第一张卡再数 .opt，必然得到 0 项 → 假红。这里显式挑一张客观题卡。
  const cardsLoc = page.locator('#planList .card');
  let openedLabel = null;
  for (let i = 0; i < await cardsLoc.count(); i++) {
    const btn = cardsLoc.nth(i).locator('button');
    if (((await btn.textContent()) || '').trim() !== '开始') continue;
    const label = ((await cardsLoc.nth(i).locator('b').first().textContent()) || '').trim();
    if (/选词填空|写作|翻译/.test(label)) continue;
    await btn.click();
    await page.waitForFunction(() => {
      const q = document.getElementById('quiz');
      return !!q && q.classList.contains('show') && document.querySelectorAll('#quizBody .opt').length > 0;
    }, null, { timeout: 25000 }).catch(() => {});
    openedLabel = label;
    break;
  }
  // 旧选择器 .quiz-body / #quizPage / [id*=quiz] 都已被 #quiz / #quizBody 取代
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(ROOT, 'docs/student-2-quiz.png'), fullPage: true });
  const qN = await page.locator('#quizBody .opt').evaluateAll(els => new Set(els.map(e => e.getAttribute('data-q'))).size);
  const optCount = await page.locator('#quizBody .opt').count();
  check('打开客观题组（' + openedLabel + '）并渲染选项', qN >= 1 && optCount >= qN, '题数=' + qN + ' 选项数=' + optCount);

  // 逐题选择（每题点第一个选项；用 data-q 去重，别重复点同一题的其他选项）
  const answeredQ = new Set();
  for (const o of await page.locator('#quizBody .opt').all()) {
    const q = await o.getAttribute('data-q');
    if (answeredQ.has(q)) continue;
    await o.click().catch(() => {});
    answeredQ.add(q);
  }
  check('每题都记下答案（' + answeredQ.size + '/' + qN + '）', answeredQ.size === qN);
  // 提交整组（旧写法找的是「交卷/提交」文案按钮，实际 id 是 #groupSubmit）
  const submitBtn = page.locator('#groupSubmit');
  const canSubmit = await submitBtn.isEnabled();
  if (canSubmit) { await submitBtn.click(); }
  await page.waitForFunction(() => {
    const a = document.querySelectorAll('#quizBody .analysis').length;
    const d = document.getElementById('groupDone');
    return a > 0 && !!d && getComputedStyle(d).display !== 'none';
  }, null, { timeout: 20000 }).catch(() => {});
  await page.screenshot({ path: path.join(ROOT, 'docs/student-3-result.png'), fullPage: true });
  const judged = await page.evaluate(() => ({
    analysis: document.querySelectorAll('#quizBody .analysis').length,
    bar: ((document.getElementById('groupBar') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    verdicts: document.querySelectorAll('#quizBody .verdict').length,
  }));
  // 旧断言用"整页 body 里出现『解析|正确|得分|答案』"判定，页面底部说明文案里本来就有这些词 → 恒真。
  // 收紧为"逐题解析块数量 === 本组题数"，并附结果条文案作为证据。
  check('交卷后逐题解析在屏（' + judged.analysis + '/' + qN + '）| ' + judged.bar,
    canSubmit && judged.analysis === qN && /本组结果/.test(judged.bar));
  // 返回今日（真实入口是 #groupDone / #quizBack）
  await page.evaluate(() => {
    const d = document.getElementById('groupDone');
    if (d && getComputedStyle(d).display !== 'none') d.click(); else { const b = document.getElementById('quizBack'); if (b) b.click(); }
  });
  await page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  check('完成本组后回到今日页', await page.evaluate(() => !document.getElementById('quiz').classList.contains('show')));

  // ---- 错题本 ----
  await page.locator('nav button[data-p="wrong"], [data-p="wrong"]').first().click();
  await page.waitForTimeout(600);
  // 旧断言在整页 body 上匹配 /重练|错题|到期/，而导航栏就写着"错题本"→ 恒真。
  // 收紧为"错题本真的收录了刚做错的题"：摘要含在库题数 + 列表行数 ≥ 1。
  const wrong = await page.evaluate(() => ({
    summary: ((document.getElementById('wrongSummary') || {}).textContent || '').trim(),
    rows: document.querySelectorAll('#dueList .wb-item, #allWrongList .wb-item').length,
  }));
  check('错题本收录错题（' + wrong.rows + ' 行）| ' + wrong.summary,
    /共 \d+ 题在库/.test(wrong.summary) && wrong.rows >= 1);
  await page.screenshot({ path: path.join(ROOT, 'docs/student-4-wrong.png'), fullPage: true });

  // ---- 统计 ----
  await page.locator('nav button[data-p="stat"]').first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(ROOT, 'docs/student-5-stat.png'), fullPage: true });
  check('统计页含题型/考点正确率', (await page.locator('#accTable').count()) === 1 && (await page.locator('#ptTable').count()) === 1);

  // ---- 备份提醒（新学生无 5 天记录，不应打扰）----
  await page.locator('nav button[data-p="today"]').first().click();
  await page.waitForTimeout(400);
  check('新用户不被备份提醒打扰', !(await page.locator('#backupHint').isVisible()));

  console.log(results.join('\n'));
  console.log('首屏到可用(本地): ' + loadSec + 's | console/page errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== 学生实测: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
