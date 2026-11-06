/* P7.3 线上冒烟：登录层 → 手机号登录 → 今日清单 → 考点表 → 积极文案 */
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const URL = 'https://gongyining0601.github.io/cet6-trainer/';

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept(''));
  const results = [];
  const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); };

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  /* 2026-11-06 修：按需加载时代线上首屏只有 meta 骨架（CET6_BANKS 是空的，
     点卡后才逐卷注入），"等 76 卷全量加载"永远不满足，脚本会挂满 540s 超时。
     改等 CET6_META 就绪。 */
  await page.waitForFunction(() => window.CET6_META && window.CET6_META.order && window.CET6_META.order.length >= 76, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  check('线上 meta 骨架就绪(' + (await page.evaluate(() => window.CET6_META.order.length)) + ' 卷目录)', true);

  // sw 缓存版本升级后：新访客直接看到登录层
  check('未登录先出登录层', (await page.locator('#loginMask').count()) === 1);
  await page.locator('#phoneInput').fill('1234');
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 30000 });
  check('登录后生成今日清单', (await page.locator('#planList .card').count()) >= 1);
  check('顶栏显示编号', /1234/.test(await page.locator('#userChip').textContent()));
  check('旧用户数据不串号(独立 key)', (await page.evaluate(() => localStorage.getItem('cet6_p1_state_v1_1234') !== null)));

  // 统计页考点表
  await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(600);
  const ptHead = await page.locator('#page-stat').textContent();
  check('统计页含考点正确率卡片', ptHead.indexOf('考点正确率') >= 0);
  const ptBody = await page.locator('#ptTable').textContent();
  check('考点表空态提示(新账号无做题记录)', /做题/.test(ptBody));
  await page.screenshot({ path: path.join(__dirname, '..', 'docs/online-p73-stat.png'), fullPage: true });

  // 积极文案（2026-11-06 修：断言不再锁死「忙日打卡」字样——产品文案早已改为
  // 「⏰ 每天坚持一下，让习惯不断线」，本地与线上一致；旧断言是在对不存在的文案打分）
  await page.locator('nav button[data-p="today"]').click(); await page.waitForTimeout(400);
  const floorTxt = await page.locator('#floorBtn').textContent();
  check('打卡按钮文案积极且无负面词: ' + floorTxt.trim().slice(0, 22),
    floorTxt.trim().length > 0 && /坚持|习惯|不断|打卡/.test(floorTxt) && !/躺平|保底/.test(floorTxt));
  const bodyTxt = await page.evaluate(() => document.body.textContent);
  check('线上全页面无「躺平」「保底」', bodyTxt.indexOf('躺平') < 0 && bodyTxt.indexOf('保底') < 0);
  await page.screenshot({ path: path.join(__dirname, '..', 'docs/online-p73-today.png'), fullPage: true });

  console.log(results.join('\n'));
  console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== P7.3 线上冒烟: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
