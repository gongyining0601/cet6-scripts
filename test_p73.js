/* P7.3 验证：①手机号登录（未登录拦截/非法号/正常登录）②多账号数据隔离与切换 ③旧单账号数据迁移 ④考点正确率表 ⑤积极文案（无躺平/保底） */
const path = require('path');
const { chromium: loadChromium, EXE, ensureAllPapers } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'app/index.html');

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const results = [];
  const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); };

  let dialogResp = null;
  const dialogMsgs = [];
  page.on('dialog', async d => {
    dialogMsgs.push(d.type() + ':' + d.message().slice(0, 30));
    await d.accept(dialogResp === null ? '' : dialogResp).catch(() => {});
  });

  // ===== 1 未登录：只出登录层，应用不初始化 =====
  await page.goto(URL); await page.waitForTimeout(900);
  check('未登录显示登录层', (await page.locator('#loginMask').count()) === 1);
  check('未登录不初始化应用清单', (await page.locator('#planList .card').count()) === 0);
  await page.screenshot({ path: path.join(ROOT, 'docs/ui-12-login.png'), fullPage: true });

  // ===== 2 非法手机号被拒 =====
  await page.locator('#phoneInput').fill('12'); // 位数不足=非法（5 位会被 maxlength 截断致 fill 重试超时）
  await page.locator('#loginBtn').click(); await page.waitForTimeout(500);
  check('非法手机号被拒(弹提示)', dialogMsgs.some(m => m.indexOf('4 位数字编号') >= 0));
  check('被拒后仍在登录层', (await page.locator('#loginMask').count()) === 1);

  // ===== 3 正常登录 =====
  await page.locator('#phoneInput').fill('1001');
  await page.locator('#loginBtn').click();
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  check('登录后进入应用(登录层消失)', (await page.locator('#loginMask').count()) === 0);
  const chip1 = await page.locator('#userChip').textContent();
  check('顶栏显示脱敏手机号: ' + chip1, /1001/.test(chip1));
  check('登录后生成今日清单', (await page.locator('#planList .card').count()) >= 1);
  check('状态 key 按手机号分档', (await page.evaluate(() => localStorage.getItem('cet6_p1_state_v1_1001') !== null)));

  // ===== 4 多账号数据隔离与切换 =====
  await page.evaluate(() => {
    const C = window.CET6Core;
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_1001'));
    st.history[C.todayStr()] = { minutes: 30, done: true, floor: false, qCount: 10, right: 8 };
    localStorage.setItem('cet6_p1_state_v1_1001', JSON.stringify(st));
  });
  dialogResp = '2002';
  await page.locator('#userChip').click();
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  check('切换到 B 账号(139****0002)', /2002/.test(await page.locator('#userChip').textContent()));
  const bStatus = await page.locator('#todayStatus').textContent();
  check('B 账号是全新存档(未打卡)', !/已通关/.test(bStatus));
  check('A 账号数据仍在(未被覆盖)', (await page.evaluate(() => localStorage.getItem('cet6_p1_state_v1_1001') !== null)));
  dialogResp = '1001';
  await page.locator('#userChip').click();
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  const aStatus = await page.locator('#todayStatus').textContent();
  check('切回 A 账号数据完整(已通关)', /已通关/.test(aStatus));
  await page.screenshot({ path: path.join(ROOT, 'docs/ui-13-switch.png'), fullPage: true });

  // ===== 5 旧单账号数据迁移 =====
  await page.evaluate(() => {
    const C = window.CET6Core;
    const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, plan: null };
    st.history[C.todayStr()] = { minutes: 25, done: true, floor: false, qCount: 8, right: 6 };
    localStorage.clear();
    localStorage.setItem('cet6_p1_state_v1', JSON.stringify(st));
    localStorage.setItem('cet6_user', '3003');
  });
  await page.reload(); await page.waitForTimeout(1200);
  check('旧数据迁移到手机号 key', (await page.evaluate(() =>
    localStorage.getItem('cet6_p1_state_v1_3003') !== null && localStorage.getItem('cet6_p1_state_v1') === null)));
  check('迁移后打卡状态可见', /已通关/.test(await page.locator('#todayStatus').textContent()));

  // ===== 6 考点正确率表 =====
  // 按需加载（架构级）：下面要在"全部卷"里找含指定考点的题，首屏 CET6_BANKS 为空，
  // 必须先把所有卷注入（旧写法直接 banks.flatMap 会 TypeError: 读 undefined 的 id）
  await ensureAllPapers(page);
  await page.evaluate(() => {
    const banks = window.CET6_BANKS;
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_3003'));
    const zt = banks.flatMap(b => b.questions).find(q => q.points && q.points.indexOf('主旨题') >= 0);
    const xj = banks.flatMap(b => b.questions).find(q => q.points && q.points.indexOf('细节题') >= 0);
    st.papers[zt.id] = { seen: 4, right: 4, wrong: 0, box: 2, ease: 2.5, iv: 3, streak: 4, last: '2026-09-24' };
    st.papers[xj.id] = { seen: 4, right: 1, wrong: 3, box: 0, ease: 1.3, iv: 1, streak: 0, last: '2026-09-24' };
    localStorage.setItem('cet6_p1_state_v1_3003', JSON.stringify(st));
  });
  await page.reload(); await page.waitForTimeout(1200);
  await page.locator('nav button[data-p="stat"]').click(); await page.waitForTimeout(400);
  const ptHtml = await page.locator('#ptTable').innerHTML();
  check('考点表含薄弱标记', ptHtml.indexOf('⚠️') >= 0);
  check('考点表含优势标记', ptHtml.indexOf('✓') >= 0);
  const iWeak = ptHtml.indexOf('细节题'), iStrong = ptHtml.indexOf('主旨题');
  check('薄弱考点排前(细节题 25% 在主旨题 100% 前)', iWeak >= 0 && iStrong >= 0 && iWeak < iStrong);
  check('考点表显示正确率数字', /25%/.test(ptHtml) && /100%/.test(ptHtml));
  await page.screenshot({ path: path.join(ROOT, 'docs/ui-14-points.png'), fullPage: true });

  // ===== 6.5 备份自动提醒 =====
  await page.evaluate(() => {
    const C = window.CET6Core;
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_3003'));
    // 造 8 天历史且从未备份
    for (let i = 8; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      st.history[d] = { minutes: 25, done: true, floor: false, qCount: 8, right: 6 };
    }
    delete st.lastBackup;
    localStorage.setItem('cet6_p1_state_v1_3003', JSON.stringify(st));
  });
  await page.reload(); await page.waitForTimeout(1200);
  const hintTxt = await page.locator('#backupHint').textContent();
  check('5 天以上未备份出现提醒条', (await page.locator('#backupHint').isVisible()) && /导出一份留底/.test(hintTxt));
  // 模拟导出后提醒消失（不真下载，只验证 lastBackup 逻辑）
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_3003'));
    st.lastBackup = new Date().toISOString().slice(0, 10);
    localStorage.setItem('cet6_p1_state_v1_3003', JSON.stringify(st));
  });
  await page.reload(); await page.waitForTimeout(1200);
  check('刚备份过提醒条隐藏', !(await page.locator('#backupHint').isVisible()));

  // ===== 7 积极文案（无躺平/保底/侥幸话术） =====
  await page.locator('nav button[data-p="today"]').click(); await page.waitForTimeout(300);
  const floorTxt = await page.locator('#floorBtn').textContent();
  check('打卡按钮新文案: ' + floorTxt.trim().slice(0, 24), /每天坚持一下，让习惯不断线/.test(floorTxt) && !/躺平|保底/.test(floorTxt));
  const bodyTxt = await page.evaluate(() => document.body.textContent);
  check('全页面无「躺平」字样', bodyTxt.indexOf('躺平') < 0);
  check('全页面无「保底」字样', bodyTxt.indexOf('保底') < 0);

  console.log(results.join('\n'));
  console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== P7.3 验证: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  // 硬闸门：断言总数缩水（典型腐化：某段异常导致后半段 check 一条都没跑到）也要判失败
  const MIN_ASSERTIONS = 18;
  const bad = [];
  if (results.length === 0) bad.push('0 断言：脚本未做任何校验');
  else if (results.length < MIN_ASSERTIONS) bad.push('断言总数 ' + results.length + ' < 下限 ' + MIN_ASSERTIONS);
  if (fails) bad.push(fails + ' 条断言失败');
  if (bad.length) { console.log('GATE FAIL: ' + bad.join('；')); process.exit(1); }
  console.log('GATE PASS: ' + results.length + ' 条断言全部通过');
  process.exit(0);
})();
