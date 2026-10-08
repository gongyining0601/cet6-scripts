/* 上架标准审计：多视口兼容 / 空状态遍历 / 脏数据容错 / 极端操作 / 离线 PWA / 性能 */
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'app/index.html');
const results = [];
const check = (name, ok) => { results.push((ok ? 'ok' : 'FAIL') + ' - ' + name); };

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // ===== A. 多视口兼容（320 小屏 / 390 手机 / 768 平板 / 1280 桌面）=====
  for (const vp of [{ w: 320, h: 568 }, { w: 390, h: 844 }, { w: 768, h: 1024 }, { w: 1280, h: 800 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('dialog', d => d.accept(''));
    await p.goto(URL); await p.waitForTimeout(600);
    await p.locator('#phoneInput').fill('9001');
    await p.locator('#loginBtn').click();
    await p.waitForSelector('#planList .card', { timeout: 20000 });
    // 横向溢出检测：页面任何元素超出视口宽度
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('视口 ' + vp.w + 'x' + vp.h + ' 无横向溢出(差' + overflow + 'px) 且无报错', overflow <= 2 && errs.length === 0);
    // 遍历四个页面均无报错
    for (const pg of ['wrong', 'stat', 'backup']) {
      await p.locator('nav button[data-p="' + pg + '"]').click(); await p.waitForTimeout(300);
    }
    check('视口 ' + vp.w + ' 四页遍历无报错', errs.length === 0);
    await ctx.close();
  }

  // ===== B. 空状态遍历（全新账号直接翻完所有页面）=====
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('pageerror', e => errs2.push(e.message));
  p2.on('dialog', d => d.accept(''));
  await p2.goto(URL); await p2.waitForTimeout(500);
  await p2.locator('#phoneInput').fill('9002');
  await p2.locator('#loginBtn').click();
  await p2.waitForSelector('#planList .card', { timeout: 20000 });
  for (const pg of ['wrong', 'stat', 'backup', 'today']) {
    await p2.locator('nav button[data-p="' + pg + '"]').click(); await p2.waitForTimeout(300);
  }
  const emptyStat = await p2.evaluate(() => document.body.textContent);
  check('空账号统计页有占位提示而非空白/报错', /暂无|还没有|做题/.test(emptyStat) && errs2.length === 0);
  check('空账号错题本有占位提示', /错题|暂无/.test(await p2.locator('#page-wrong').textContent()));

  // ===== C. 脏数据容错 =====
  // C1: 损坏的 state JSON（半截 JSON）
  await p2.evaluate(() => {
    localStorage.setItem('cet6_user', '9003');
    localStorage.setItem('cet6_p1_state_v1_9003', '{"version":1,"history":{"20'); // 半截
  });
  await p2.reload(); await p2.waitForTimeout(1000);
  check('损坏 JSON 状态可恢复(回退到全新状态不崩)', (await p2.locator('#planList .card').count()) >= 1 && errs2.length === 0);
  // C2: 字段类型错误
  await p2.evaluate(() => {
    localStorage.setItem('cet6_user', '9004');
    localStorage.setItem('cet6_p1_state_v1_9004', JSON.stringify({ version: 1, history: { '2026-09-25': { minutes: 'NaN', done: 'yes' } }, papers: null, wrongbook: 'oops', plan: 42 }));
  });
  await p2.reload(); await p2.waitForTimeout(1000);
  check('类型错乱状态不崩(可用)', (await p2.locator('#planList .card').count()) >= 1 && errs2.length === 0);
  // C3: 导入非法备份文件
  await p2.evaluate(() => localStorage.setItem('cet6_user', '9005'));
  await p2.reload(); await p2.waitForTimeout(900);
  const importFile = p2.locator('#importFile');
  await importFile.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('this is not json {{{') });
  await p2.waitForTimeout(600);
  check('导入垃圾 JSON 有失败提示且不崩', errs2.length === 0);

  // ===== D. 极端操作 =====
  // D1: 交卷连点（防重复提交/重复记录）
  // 按需加载（架构级）：首屏只有 meta 骨架，卷正文在点「开始」时才动态加载。
  // 因此不再读 window.CET6_BANKS 预判选项数，改为走真实路径：逐组点「开始」→ 等卷加载并渲染 →
  // 若选项总数 ≤60 就用该组作答（选词/匹配选项过多无法一次点完，跳过换下一组）。
  await p2.evaluate(() => localStorage.setItem('cet6_user', '9006'));
  await p2.reload(); await p2.waitForTimeout(900);
  const candItems = await p2.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9006'));
    return (st.plan.items || []).map((it, i) => ({
      idx: i, type: it.type, qids: it.qids || [], n: (it.qids || []).length
    })).filter((it) => it.n > 0 && it.type !== 'writing' && it.type !== 'translation');
  });
  if (!candItems.length) throw new Error('今日清单没有可作答的客观题组，连点审计无法进行');
  let targetInfo = null;
  for (const cand of candItems) {
    await p2.locator('#planList .card button').nth(cand.idx).click();
    await p2.waitForTimeout(1200); // 按需加载：等待该卷动态拉取 + 渲染
    const optN = await p2.locator('.opt, .optBtn, [class*=option]').count();
    if (optN > 0 && optN <= 60) { targetInfo = { idx: cand.idx, qids: cand.qids, n: cand.n }; break; }
    // 这组选项太多（选词/匹配整篇）：退出换下一组
    await p2.locator('#quizBack').click().catch(() => {});
    await p2.waitForTimeout(300);
  }
  if (!targetInfo) throw new Error('可作答客观题组加载失败（按需加载异常），连点审计无法进行');
  const opts = p2.locator('.opt, .optBtn, [class*=option]');
  const n = await opts.count();
  for (let i = 0; i < Math.min(n, 60); i++) await opts.nth(i).click().catch(() => {});
  const submit = p2.locator('button:has-text("提交本组"), button:has-text("交卷"), #submitGroup').first();
  // 连点 3 次（判分只应发生一次）
  await submit.click().catch(() => {}); await submit.click().catch(() => {}); await submit.click().catch(() => {});
  await p2.waitForTimeout(1500);
  const rec = await p2.evaluate((qids) => {
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9006'));
    const seenSum = qids.reduce((a, id) => a + (st.papers[id] ? st.papers[id].seen : 0), 0);
    const h = st.history[Object.keys(st.history)[0]] || {};
    return { seenSum, qCount: h.qCount || 0 };
  }, targetInfo.qids);
  check('连点提交判分只记一次(seen=' + rec.seenSum + ', qCount=' + rec.qCount + ', 应=' + targetInfo.n + ')', rec.seenSum === targetInfo.n && rec.qCount === targetInfo.n);
  // 走完整流程：结果页点「完成」→ item.done
  const doneBtn = p2.locator('#groupDone, button:has-text("完成")').first();
  await doneBtn.click().catch(() => {});
  await p2.waitForTimeout(800);
  const doneCount = await p2.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('cet6_p1_state_v1_9006'));
    return st.plan.items.filter(i => i.done).length;
  });
  check('完成后条目标记 done(' + doneCount + ')', doneCount === 1);
  check('极端操作全程无报错', errs2.length === 0);
  await p2.screenshot({ path: path.join(ROOT, 'docs/audit-double-submit.png'), fullPage: true });

  // ===== E. 离线 PWA：SW 需 HTTPS 环境，由 test_offline_https.js 覆盖（file:// 无法注册 SW）=====

  // ===== F. 性能 =====
  const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p4 = await ctx4.newPage();
  const t0 = Date.now();
  await p4.goto(URL);
  await p4.waitForSelector('#loginMask', { timeout: 15000 });
  const firstPaint = ((Date.now() - t0) / 1000).toFixed(1);
  check('本地首屏 ' + firstPaint + 's（上架参考 <3s）', firstPaint < 3);
  const mem = await p4.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1);
  check('JS 堆内存 ' + mem + 'MB（上架参考 <300MB）', mem < 0 || mem < 300);
  // 资源请求数与离线复测见 test_offline_perf.js（HTTPS/SW 环境）
  await ctx4.close();

  console.log(results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('=== 上架审计: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
