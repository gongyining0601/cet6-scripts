/* 线上冒烟：打开 Pages → 版本一致性 → 登录 → 今日清单 → 进组作答判分。
   2026-11-06 重写：
   · 旧版假设"无登录层 + 全量加载 76 卷"，按需加载时代全部失效（NO-ASSERT）。
   · 新增「线上版本 == 本地版本」断言——此前线上停在 P7.6 快照长达多个版本无人察觉，
     net 组全红却只当环境问题，根源就是没有这把尺子。
   · 题库按需注入：不再等 CET6_BANKS 全量，点卡后等题面挂载即可。 */
const path = require('path');
const fs = require('fs');
const { chromium: loadChromium, EXE, answerAllInQuiz } = require('./_env');
const { chromium } = loadChromium();
const URL = 'https://gongyining0601.github.io/cet6-trainer/';

// 本地唯一版本号来源（app/version.js），与线上 window.CET6_VERSION 比对
function localVersion() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'version.js'), 'utf8');
  const m = src.match(/CET6_VERSION\s*=\s*'(cet6-v\d+)'/);
  return m ? m[1] : null;
}

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
  check('线上可打开且出登录层', true);

  const onlineVer = await page.evaluate(() => window.CET6_VERSION || null);
  const localVer = localVersion();
  check('线上版本与本地一致（部署未滞后）: 线上=' + onlineVer + ' 本地=' + localVer, onlineVer === localVer && !!onlineVer);

  // 部署树洁净度：bank/json/ 是本地开发用的原始素材（77 个 / 9MB），
  // app/.gitignore 已排除，不该随站点发布。若哪天整树同步误带，这条会立刻报红。
  const jsonProbe = await page.request.get(URL + 'bank/json/2015-06-1.json', { timeout: 20000 });
  check('部署树未暴露原始 JSON 素材（HTTP ' + jsonProbe.status() + '）', jsonProbe.status() === 404);

  // 登录（4 位编号）
  await page.locator('#phoneInput').fill('9203');
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 30000 });
  const cards = await page.locator('#planList .card').count();
  const summary = ((await page.textContent('#planSummary').catch(() => '')) || '').trim();
  console.log('    planSummary:', summary);
  check('登录后生成今日清单（' + cards + ' 组）', cards >= 1);

  // 点开第一张卡，等题面真正挂载（按需加载：.opt/.cloze-slot/#essayTa 三类题面之一）
  await page.locator('#planList .card button').first().click();
  try { await page.waitForSelector('#quizBody .opt, #quizBody .cloze-slot, #essayTa', { timeout: 30000 }); } catch (e) { }
  const opened = await page.evaluate(() => document.querySelectorAll('#quizBody .opt, #quizBody .cloze-slot, #essayTa').length > 0);
  check('进入第一组且题面渲染（按需注入完成）', opened);

  if (opened) {
    const n = await answerAllInQuiz(page);
    check('组内可作答（' + n + ' 题）', n > 0);
    let enabled = false;
    try { await page.waitForSelector('#groupSubmit:not([disabled])', { timeout: 8000 }); enabled = true; } catch (e) { }
    if (enabled) {
      await page.locator('#groupSubmit').click();
      try { await page.waitForSelector('#groupDone', { timeout: 8000 }); } catch (e) { }
      const judged = await page.evaluate(() => !!document.getElementById('groupDone') || /答对/.test((document.getElementById('groupBar') || {}).innerText || ''));
      check('提交判分出结果', judged);
    } else {
      check('提交按钮在答满后可用', false);
    }
  }

  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'online-p7.png'), fullPage: false });
  check('全程无 JS 错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''), errors.length === 0);

  await browser.close();
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== P7 线上冒烟: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  process.exit(fails ? 1 : 0);
})();
