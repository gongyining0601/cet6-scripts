// scripts/test_cloze.js —— R5 选词方案2：词库点选填空（wb-chip + cloze-slot），替换原每空 15 词全宽按钮
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..', 'app');
const URL = 'file://' + path.join(ROOT, 'index.html');
const results = [];
const check = (name, ok) => results.push((ok ? 'ok' : 'FAIL') + ' - ' + name);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept(''));

  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 20000 });

  // 注入固定选词组（2020-07-1 卷 cloze 26-35），绕过清单随机性
  const qids = [];
  for (let n = 26; n <= 35; n++) qids.push('2020-07-1-c-' + n);
  await page.evaluate((qids) => {
    const C = window.CET6Core;
    const today = C.todayStr();
    const key = C.stateKey('9201');
    localStorage.setItem('cet6_user', '9201');
    localStorage.setItem(key, JSON.stringify({
      version: 1, history: {}, papers: {}, wrongbook: {}, essays: {},
      plan: { date: today, v: C.PLAN_VERSION, items: [
        { key: 'cloze-1', type: 'cloze', qids: qids, done: false },
      ] },
    }));
  }, qids);
  await page.reload();
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  await page.locator('#planList .card button').first().click();
  await page.waitForSelector('#quiz.show .cloze-slot', { timeout: 20000 });

  // 1) 词库 = 15 个可点词块
  const chips = await page.locator('#quiz .wb-chip').count();
  check('词库 15 个词块（A-O）', chips === 15, 'chips=' + chips);

  // 2) 段落内 10 个填空位（qno 26-35）
  const slots = await page.locator('#quiz .cloze-slot').count();
  check('段落内 10 个填空位', slots === 10, 'slots=' + slots);

  // 3) 选词组不再有每空全宽 .opt 选项按钮（renderOneQ 对 cloze 早退）
  const optCount = await page.locator('#quiz .card .opt').count();
  check('选词组不再渲染 .opt 选项按钮', optCount === 0, 'opts=' + optCount);

  // 4) 交互：点空格选中（focus）→ 点词块填入
  const slot26 = page.locator('#quiz .cloze-slot[data-qno="26"]');
  await slot26.click();
  const focused = await slot26.evaluate((el) => el.classList.contains('focus'));
  check('点空格进入选中态（focus）', focused, 'focus=' + focused);

  const chipA = page.locator('#quiz .wb-chip[data-w="A"]');
  const chipAtext = (await chipA.textContent()) || '';
  await chipA.click();
  const filled = (await slot26.textContent()) || '';
  const pickedA = await slot26.getAttribute('data-picked');
  check('点词块填入该空并选中为 A', pickedA === 'A' && filled.trim() !== '', 'picked=' + pickedA + ' text=' + filled.trim());

  // 5) 再点已填空位清除
  await slot26.click();
  const cleared = await slot26.getAttribute('data-picked');
  check('再点已填空位可清除', cleared === '' , 'cleared=' + cleared);

  // 6) 提交判分（需填满全部空）：填空位显示所填词并标 right/wrongpick，词库禁用
  const slot27 = page.locator('#quiz .cloze-slot[data-qno="27"]');
  await slot27.click();
  await chipA.click();
  // 填满其余 9 个空（选 A 即可，判分只看对错标记）
  for (let n = 26; n <= 35; n++) {
    const s = page.locator('#quiz .cloze-slot[data-qno="' + n + '"]');
    if (!(await s.getAttribute('data-picked'))) { await s.click(); await chipA.click(); }
  }
  await page.locator('#groupSubmit').click();
  await page.waitForSelector('#quiz.show .cloze-slot.right, #quiz.show .cloze-slot.wrongpick', { timeout: 15000 });
  const slotClass = await slot27.getAttribute('class');
  const chipDisabled = await chipA.isDisabled();
  const bankDisabledCount = await page.locator('#quiz .wb-chip:disabled').count();
  check('判分后填空位标记 right/wrongpick', /right|wrongpick/.test(slotClass), 'cls=' + slotClass);
  check('判分后词库全部禁用', bankDisabledCount === 15, 'disabled=' + bankDisabledCount);

  check('选词组渲染无页面错误', errs.length === 0, errs.join('|') || 'none');

  await page.screenshot({ path: path.join(ROOT, '..', 'docs', 'ui-16-cloze-wordbank.png'), fullPage: true });

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== 选词方案2: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
