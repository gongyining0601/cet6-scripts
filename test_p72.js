/* P7.2 新功能验证：①热力图连击数字 ②做题页卷号 ③翻译踩分词自查 ④保底文案 */
const path = require('path');
const { chromium: loadChromium, EXE, bankDigest } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');
// 写作字数及格线是按考试要求写死的（本仓 150 词 / 四级仓 120 词），
// 从题库里该卷 prompt 的 "at least N words" 取，避免跨仓假红。
const DIGEST = bankDigest();
const W_PAPER = '2015-06-1';
const W_NEED = DIGEST.writingWords[W_PAPER] || 0;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const results = [];
  const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); };

  await page.goto('file://' + path.join(ROOT, 'app/index.html'));
  await page.waitForTimeout(800);
  await page.evaluate(() => localStorage.setItem('cet6_user', '1001'));
  await page.reload(); await page.waitForTimeout(800);

  // 注入连续 3 天打卡历史
  await page.evaluate(() => {
    const C = window.CET6Core;
    const t = C.todayStr();
    const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null };
    st.history[C.addDays(t, -2)] = { minutes: 30, done: true, floor: false };
    st.history[C.addDays(t, -1)] = { minutes: 12, done: false, floor: true };
    st.history[t] = { minutes: 28, done: true, floor: false };
    localStorage.setItem('cet6_p1_state_v1_1001', JSON.stringify(st));
  });
  await page.reload(); await page.waitForTimeout(800);

  // ① 统计页热力图数字
  await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(400);
  const heatNums = await page.$$eval('#heatmap i', els => els.map(e => e.textContent).filter(t => t !== ''));
  check('热力图显示连击数字(最近3天: ' + heatNums.slice(-3).join(',') + ')', heatNums.slice(-3).join(',') === '1,2,3');
  const heatLegend = await page.locator('#page-stat .muted').first().textContent();
  check('热力图图例更新(含「连击第几天」)', /连击第几天/.test(heatLegend));

  // ② 今日组做题页卷号
  await page.locator('nav button[data-p="today"]').click(); await page.waitForTimeout(300);
  // 逐题卡的"真题 卷号"标注只存在于客观题（renderOneQ）；选词填空/写作/翻译没有逐题卡，
  // 首卡恰好是选词填空时旧断言必假红。这里优先挑一张含 .opt 的卡。
  const cards = page.locator('#planList .card');
  let pickedCard = null;
  for (let i = 0; i < await cards.count(); i++) {
    const btn = cards.nth(i).locator('button');
    if (((await btn.textContent()) || '').trim() !== '开始') continue;
    const label = ((await cards.nth(i).locator('b').first().textContent()) || '').trim();
    if (/选词填空|写作|翻译/.test(label)) continue;
    await btn.click();
    await page.waitForFunction(() => {
      const q = document.getElementById('quiz');
      return !!q && q.classList.contains('show') && document.querySelectorAll('#quizBody .opt').length > 0;
    }, null, { timeout: 25000 }).catch(() => {});
    pickedCard = label;
    break;
  }
  check('找到含选项的题组（逐题卡才有卷号标注）: ' + pickedCard, !!pickedCard);
  const prog = await page.locator('#quizProg').textContent();
  check('做题页进度条含卷号: ' + prog.slice(0, 30), /20\d\d-\d\d-\d/.test(prog));
  const mutedAll = await page.$$eval('#quizBody .muted', els => els.map(e => (e.textContent || '').trim()));
  const realTags = mutedAll.filter(t => /真题\s*20\d\d-\d\d-\d/.test(t));
  const qN = await page.locator('#quizBody .opt').evaluateAll(els => new Set(els.map(e => e.getAttribute('data-q'))).size);
  check('每道客观题都标注真题卷号(' + realTags.length + '/' + qN + '): ' + (realTags[0] || ''), qN > 0 && realTags.length === qN);
  // 退出做题
  await page.locator('#quizBack, .back, [id*=back]').first().click().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  // ③ 翻译踩分词自查（往今日 plan 注入写译条目，走真实 UI 入口）
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_1001'));
    st.plan.items.push({ key: 'essay-test', type: 'translation', qids: [], paperId: '2015-06-1', done: false, minutes: 0 });
    localStorage.setItem('cet6_p1_state_v1_1001', JSON.stringify(st));
  });
  await page.reload(); await page.waitForTimeout(800);
  await page.locator('#planList .card button', { hasText: '开始' }).last().click();
  await page.waitForTimeout(500);
  const checkBtn = page.locator('#essayCheck');
  check('翻译自查按钮存在(踩分词自查)', (await checkBtn.textContent()).indexOf('踩分词自查') >= 0);
  await page.locator('#essayTa').fill('The year 2011 was a historic moment in China urbanization, when city people outnumbered rural people. Over the next 20 years, about 350 million rural people will move to cities.');
  await checkBtn.click(); await page.waitForTimeout(300);
  const checkBox = await page.locator('#checkBox').textContent();
  check('自查输出覆盖率: ' + (checkBox.match(/覆盖 \d+\/\d+/) || ['(无)'])[0], /踩分词自查/.test(checkBox) && /覆盖 \d+\/\d+/.test(checkBox));
  const missShown = /未覆盖：/.test(checkBox);
  check('未覆盖踩分词列表' + (missShown ? '(有)' : '(全覆盖)'), missShown || /全覆盖/.test(checkBox));
  await page.screenshot({ path: path.join(ROOT, 'docs/ui-11-essay-check.png'), fullPage: true });

  // 写作字数体检（返回今日，注入写作条目）
  await page.evaluate((paperId) => {
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_1001'));
    st.plan.items = st.plan.items.map(it => it.key === 'essay-test' ? Object.assign({}, it, { done: true }) : it);
    st.plan.items.push({ key: 'essay-test2', type: 'writing', qids: [], paperId: paperId, done: false, minutes: 0 });
    localStorage.setItem('cet6_p1_state_v1_1001', JSON.stringify(st));
  }, W_PAPER);
  await page.reload(); await page.waitForTimeout(800);
  await page.locator('#planList .card button', { hasText: '开始' }).last().click();
  await page.waitForTimeout(400);
  const wBtnTxt = await page.locator('#essayCheck').textContent();
  check('写作体检按钮(字数体检)', wBtnTxt.indexOf('字数体检') >= 0);
  await page.locator('#essayTa').fill('Knowledge is power.');
  await page.locator('#essayCheck').click(); await page.waitForTimeout(200);
  const wBox = await page.locator('#checkBox').textContent();
  // 断言"应用给出的及格线 == 该卷题面要求"（不是写死数字）：写 3 词必然落在及格线上方，
  // 输出里会带「离 N 词的及格线还差 …」。N 必须等于卷面 at least N words。
  const mNeed = /离 (\d+) 词的及格线/.exec(wBox);
  check('字数体检输出: ' + wBox.slice(0, 40),
    /词/.test(wBox) && !!mNeed && (!W_NEED || Number(mNeed[1]) === W_NEED),
    '卷面要求=' + (W_NEED || '?') + ' 词 / 输出及格线=' + (mNeed ? mNeed[1] : '(未识别)'));

  // ④ 保底按钮文案
  await page.locator("#quizBack").click().catch(() => {});
  await page.waitForTimeout(300);
  const floorTxt = await page.locator('#floorBtn').textContent();
  const statusTxt = await page.locator('#todayStatus').textContent();
  check('打卡按钮文案(每天坚持一下): ' + floorTxt.slice(0, 22), /每天坚持一下/.test(floorTxt) && !/躺平|保底/.test(floorTxt));
  check('状态文案积极版: ' + statusTxt.slice(0, 22), /坚持|连击/.test(statusTxt) && !/躺平/.test(statusTxt));

  console.log(results.join('\n'));
  console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== P7.2 新功能: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
