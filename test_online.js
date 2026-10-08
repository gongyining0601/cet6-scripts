// 线上冒烟：打开 Pages，验证今日清单 + 整组同屏做题 + 判分
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('https://gongyining0601.github.io/cet6-trainer/', { waitUntil: 'load', timeout: 60000 });
  // 注册 service worker + 题库加载完成后重新加载进入主界面
  await page.waitForTimeout(4000);
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  const summary = await page.textContent('#planSummary').catch(() => '(none)');
  console.log('[1] planSummary:', (summary || '').trim());

  const cards = await page.$$eval('#planList .card, #planList [class*=card]', (els) =>
    els.slice(0, 6).map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
  ).catch(() => []);
  if (cards.length) console.log('[2] 今日清单卡片:', JSON.stringify(cards, null, 1));

  // 开始第一组，验证整组同屏
  const firstBtn = await page.$('#planList .card button, #planList button');
  if (firstBtn) {
    await firstBtn.click();
    await page.waitForTimeout(2000);
    const quizTitle = await page.textContent('#quizTitle').catch(() => '(none)');
    console.log('[3] 进入组:', (quizTitle || '').trim());
    const qCount = await page.$$eval('.q-card, [id^=q_], .question', (els) => els.length).catch(() => -1);
    console.log('[4] 同屏题块数(选择器探测):', qCount);
    const bodyText = await page.textContent('body');
    const answered = (bodyText.match(/已答/g) || []).length;
    console.log('[5] 页面含“已答”标记:', answered > 0);
    // 截图
    await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'online-p7.png'), fullPage: false });
    console.log('[6] 截图已保存');
  } else {
    console.log('[3] 未找到开始按钮');
  }
  console.log('[7] JS错误:', errors.length === 0 ? '无' : errors.slice(0, 5));
  await browser.close();
})();
