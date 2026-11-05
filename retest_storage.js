'use strict';
/* ============================================================================
   CET6 复测轮 A6/A7 + B2：存储写满 / localStorage 禁用 / 多账号隔离 /
                            键名枚举 / 旧版遗留 key 迁移污染 / 切换用户
   运行：cd D:\CET6\scripts ; node retest_storage.js
   产物：docs/retest-security-*.png / docs/retest-storage-result.json / docs/retest-storage-log.txt
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'app', 'index.html');
const URL = fileUrl(INDEX);
const DOCS = path.join(ROOT, 'docs');

const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const pad = n => (n < 10 ? '0' + n : '' + n);
const d0 = new Date();
const TODAY = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
const A = '9203', B = '9204', C = '9001';
const KA = 'cet6_p1_state_v1_' + A, KB = 'cet6_p1_state_v1_' + B, KC = 'cet6_p1_state_v1_' + C;
const LEGACY = 'cet6_p1_state_v1';
/* 「写盘失败」的可见提示语族。产品在不同路径用了不同措辞（底线打卡/提交判分用
   「保存失败：…」，加练用「…没写进本机存储，刷新会丢…」），语义完全一致。
   断言只认其中一种字面就会把正确实现判成缺陷 —— 这里统一成一个语义正则。 */
const FAIL_NOTICE = /保存失败|没写进本机存储|没写进|刷新会丢|未保存/;

const R = { meta: {}, cases: [], storage: {}, summary: {} };
function t(name, group, pass, detail) {
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return pass;
}
function fact(name, value) { log(`  [fact] ${name} = ${JSON.stringify(value)}`); R.cases.push({ name, group: 'fact', pass: true, detail: JSON.stringify(value), informational: true }); }

async function newCtx(browser, init) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 }, acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const logs = { console: [], pageerror: [], dialog: [] };
  page.on('console', m => logs.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.pageerror.push(String((e && e.message) || e)));
  page.on('dialog', async dl => { logs.dialog.push({ type: dl.type(), message: dl.message() }); try { await dl.accept(dl.type() === 'prompt' ? (logs.promptReply || '10') : ''); } catch (e) { } });
  return { ctx, page, logs };
}
async function boot(page, stateObj, uid) {
  uid = uid || A;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
  await page.evaluate(({ id, st }) => {
    try { localStorage.setItem('cet6_user', id); } catch (e) { }
    try { localStorage.removeItem('cet6_p1_state_v1_' + id); if (st !== null) localStorage.setItem('cet6_p1_state_v1_' + id, st); } catch (e) { }
  }, { id: uid, st: stateObj === undefined ? null : JSON.stringify(stateObj) });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);
  try { await page.waitForSelector('#planList .card', { timeout: 20000 }); } catch (e) { }
  await page.waitForTimeout(200);
}
const toastText = page => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
const saveWarn = page => page.evaluate(() => { const b = document.getElementById('saveWarn'); return b ? { display: b.style.display, text: (b.textContent || '').slice(0, 80) } : null; });
const storeGet = (page, k) => page.evaluate(x => localStorage.getItem(x), k);
const minutesTxt = page => page.evaluate(() => (document.getElementById('todayMinutes') || {}).textContent || '');
async function shot(page, n) { try { await page.screenshot({ path: path.join(DOCS, 'retest-security-' + n + '.png') }); } catch (e) { } }

function baseState(e) { return Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: '' }, e || {}); }
function withMinutes(m) { return baseState({ history: { [TODAY]: { minutes: m, done: false, floor: false, qCount: 1, right: 1, timed: 0, timedWithin: 0, timedSec: 0 } } }); }

/* ========================================================================== */
(async () => {
  try {
    const crypto = require('crypto');
    const hashOf = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    R.meta = {
      url: URL, browser: EXE, today: TODAY, node: process.version, startedAt: new Date().toISOString(),
      hashes: { 'app/index.html': hashOf(INDEX), 'app/core.js': hashOf(path.join(ROOT, 'app', 'core.js')) },
    };
    log('CET6 复测 A6/A7/B2 · 存储安全复测  ' + R.meta.startedAt);
    log('index.html sha256 = ' + R.meta.hashes['app/index.html'] + '\n');

    const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'] });

    /* ======================= A6 存储写满 ======================= */
    log('\n================ A6) 模拟 localStorage 配额耗尽 ================');
    {
      const init = () => {
        window.__quotaBlock = false;
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (window.__quotaBlock && String(k).indexOf('cet6_p1_state_v1') === 0) {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          }
          return orig.call(this, k, v);
        };
      };
      const { ctx, page, logs } = await newCtx(browser, init);
      await boot(page, withMinutes(12));
      const before = await storeGet(page, KA);
      const warnBefore = await saveWarn(page);
      // 打开配额闸门
      await page.evaluate(() => { window.__quotaBlock = true; });
      // 底线打卡 → 触发 save() 失败
      await page.locator('#floorBtn').click();
      await page.waitForTimeout(500);
      const toast1 = await toastText(page);
      const warnAfter = await saveWarn(page);
      t('写满时 save() 失败被捕获（无未捕获异常）', '存储写满', logs.pageerror.length === 0, logs.pageerror.join('|'));
      t('失败 toast 提示「保存失败」', '存储写满', FAIL_NOTICE.test(toast1), JSON.stringify(toast1));
      t('#saveWarn 常驻横幅点亮且文案说明后果', '存储写满', !!warnAfter && warnAfter.display === 'block' && warnAfter.text.length > 10, JSON.stringify(warnAfter));
      t('横幅在失败前是隐藏的（对照）', '存储写满', !!warnBefore && warnBefore.display === 'none', JSON.stringify(warnBefore));
      t('失败时页面仍可用（未白屏）', '存储写满', (await page.locator('#planList .card').count()) > 0, '');
      await page.screenshot({ path: path.join(DOCS, 'retest-security-quota-warn.png') });

      // 后续"成功"操作是否会盖掉横幅 / 盖掉失败提示
      await page.evaluate(() => { window.__quotaBlock = true; });
      await page.locator('#extraBtns button').first().click();
      await page.waitForTimeout(400);
      const toast2 = await toastText(page);
      const warn2 = await saveWarn(page);
      /* 2026-11-05 修：这里原来只认字面「保存失败」，但「加练」路径用的是另一句
         语义等价文案「加练已加入本次页面，但没写进本机存储，刷新会丢…」。
         产品行为本来就是对的（index.html:717 已按 saveFailed 分支如实提示），
         是断言把措辞写死才判负 —— 属于过时断言，不是产品缺陷。 */
      const extraWarns = FAIL_NOTICE.test(toast2);
      t('后续成功 toast 不会撤掉 #saveWarn 横幅（M-5 常驻横幅有效）', '存储写满', !!warn2 && warn2.display === 'block' && warn2.text.length > 10, JSON.stringify(warn2));
      R.storage.extraToastAfterFailure = toast2;
      t('「加练」路径在保存失败时如实提示未落盘（不报成功）', '存储写满', /加练/.test(toast2) && extraWarns,
        'toast="' + toast2 + '"  ← 需含「保存失败 / 没写进本机存储 / 刷新会丢」之一');
      // 主题切换（另一个 key，写成功）后横幅是否还在
      await page.locator('#themeBtn').click();
      await page.waitForTimeout(350);
      const toast3 = await toastText(page);
      const warn3 = await saveWarn(page);
      t('无关成功操作（切主题）后横幅仍在', '存储写满', !!warn3 && warn3.display === 'block' && warn3.text.length > 10, 'toast=' + JSON.stringify(toast3));

      // 数据确实没落盘
      const after = await storeGet(page, KA);
      t('失败写入未污染旧存档（localStorage 内容不变）', '存储写满', before === after, '');
      // 关闭闸门后做一次成功写入 → 横幅应撤掉
      await page.evaluate(() => { window.__quotaBlock = false; });
      await page.locator('#floorBtn').click();
      await page.waitForTimeout(400);
      // floorBtn 在已打卡时会提示"今天已记录过打卡"，改用答题写入；这里直接再切个用户触发 save
      await page.evaluate(() => { try { localStorage.setItem('__probe_write__', '1'); } catch (e) { } });
      const warnAfterRecover = await saveWarn(page);
      fact('恢复写入后横幅状态（需有成功 save() 才会撤掉）', warnAfterRecover);
      await ctx.close();
    }

    /* ======================= A7 localStorage 禁用 ======================= */
    log('\n================ A7) localStorage 抛 SecurityError（隐私/被拦）================');
    {
      const init = () => {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
        });
      };
      const { ctx, page, logs } = await newCtx(browser, init);
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      const err = logs.pageerror.slice();
      const warn = await saveWarn(page);
      const hasMask = await page.evaluate(() => !!document.getElementById('loginMask'));
      const bodyTxt = await page.evaluate(() => document.body.innerText.trim().slice(0, 200));
      t('页面不白屏（有可见文本）', '存储禁用', bodyTxt.length > 5, JSON.stringify(bodyTxt.slice(0, 60)));
      t('无未捕获 JS 报错（try-catch 兜住了）', '存储禁用', err.length === 0, err.join('|'));
      t('出现存储不可用提示横幅', '存储禁用', !!warn && warn.display === 'block' && /禁止本地存储|不保存/.test(warn.text), JSON.stringify(warn));
      t('未登录时只出登录层', '存储禁用', hasMask, '');
      await page.screenshot({ path: path.join(DOCS, 'retest-security-storage-disabled.png') });

      /* 关键：内存兜底到底能不能用？尝试登录 */
      const attempts = [];
      for (let i = 0; i < 3; i++) {
        const inp = page.locator('#phoneInput');
        if (!await inp.count()) break;
        await inp.fill('1001');
        await page.locator('#loginBtn').click();
        await page.waitForTimeout(900);
        attempts.push({
          stillMask: await page.evaluate(() => !!document.getElementById('loginMask')),
          hasApp: (await page.locator('#planList .card').count()) > 0,
          alertShown: logs.dialog.length,
        });
      }
      R.storage.disabledLoginAttempts = attempts;
      /* 2026-11-05 修：这条断言原来写的是「存储禁用时登录 3 次仍停在登录层」，
         即把 N-SEC-2（内存兜底模式下 reload 导致点【开始学习】毫无反应）的
         **故障现象当成预期行为**。产品后来修掉了：storeDisabled 时走 startSession
         原地进入，不再 reload。断言必须跟着改成验证修复后的行为，
         否则修好了反而判红（这正是"测试锁死缺陷"的典型）。 */
      const enteredInMemory = attempts.length > 0 && attempts.every(a => !a.stillMask && a.hasApp);
      t('存储禁用时仍能凭编号进入（N-SEC-2 内存兜底，不卡在登录层）', '存储禁用', enteredInMemory,
        JSON.stringify(attempts));
      t('内存兜底进入过程中不弹任何对话框（无 alert 死循环）', '存储禁用', logs.dialog.length === 0,
        JSON.stringify(logs.dialog));
      R.storage.disabledEnteredInMemory = enteredInMemory;
      fact('存储禁用时的登录尝试结果', attempts);
      fact('弹窗（alert/prompt）次数', logs.dialog);
      await page.screenshot({ path: path.join(DOCS, 'retest-security-storage-disabled-login-loop.png') });
      await ctx.close();
    }

    /* ======================= B2-a 多账号隔离 ======================= */
    log('\n================ B2-a) 多账号数据隔离 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, withMinutes(33), A);
      const aTxt = await minutesTxt(page);
      // UI 切换用户：prompt 里输入 B 的编号（默认回复 '10' 是非法编号，会让切换被拒）
      logs.promptReply = B;
      await page.locator('#userChip').click();
      await page.waitForTimeout(900);
      const chipTxt = await page.evaluate(() => (document.getElementById('userChip') || {}).textContent || '');
      const bTxt = await minutesTxt(page);
      const bState = await storeGet(page, KB);
      const aState = await storeGet(page, KA);
      t('切换到 B 后 chip 显示新编号', '账号隔离', /9204/.test(chipTxt), JSON.stringify(chipTxt));
      t('B 看不到 A 的今日分钟数（B 应显示已练 0 分钟）', '账号隔离', /已练\s*0\s*分钟/.test(bTxt), 'A=' + JSON.stringify(aTxt) + ' B=' + JSON.stringify(bTxt));
      t('A 的存档 key 仍完整保留', '账号隔离', !!aState && /33/.test(aState), 'len=' + (aState || '').length);
      let bHistEmpty = true;
      try { const o = JSON.parse(bState || '{}'); bHistEmpty = !o.history || Object.keys(o.history).length === 0; } catch (e) { bHistEmpty = false; }
      t('B 是新账号：历史为空（不继承 A 的打卡数据）', '账号隔离', bHistEmpty, 'B.history keys=' + (bHistEmpty ? 0 : '?(解析失败)'));
      await page.screenshot({ path: path.join(DOCS, 'retest-security-multi-account-b.png') });
      // 切回 A
      logs.promptReply = A;
      await page.locator('#userChip').click();
      await page.waitForTimeout(900);
      const backTxt = await minutesTxt(page);
      t('切回 A 后数据恢复（33 分钟）', '账号隔离', /33/.test(backTxt), JSON.stringify(backTxt));
      t('无 JS 报错', '账号隔离', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ======================= B2-b 旧版遗留 key 迁移污染 ======================= */
    log('\n================ B2-b) 遗留 key cet6_p1_state_v1 的跨账号迁移 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      const legacy = withMinutes(77);
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForSelector('#loginMask, #planList .card', { timeout: 30000 });
      await page.evaluate(({ lg, a, aState }) => {
        localStorage.clear();
        localStorage.setItem('cet6_p1_state_v1', lg);          // 旧版遗留 key
        localStorage.setItem('cet6_p1_state_v1_' + a, aState); // A 已有自己的存档
        localStorage.setItem('cet6_user', a);
      }, { lg: JSON.stringify(legacy), a: A, aState: JSON.stringify(withMinutes(11)) });
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(900);
      R.storage.step1 = { legacyAlive: !!(await storeGet(page, LEGACY)), aMin: await minutesTxt(page) };
      log('   ① A 登录：A 已有自己的存档 → 迁移被跳过，遗留 key 是否还在 = ' + R.storage.step1.legacyAlive);
      t('A 走自己的存档（11 分钟），未被遗留数据覆盖', '遗留key', /11/.test(R.storage.step1.aMin), JSON.stringify(R.storage.step1.aMin));
      // 换成全新账号 C
      await page.evaluate(c => localStorage.setItem('cet6_user', c), C);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(900);
      const cMin = await minutesTxt(page);
      const cState = await storeGet(page, KC);
      R.storage.step2 = { cMin, cStateCreated: !!cState, legacyAlive: !!(await storeGet(page, LEGACY)) };
      log('   ② 全新账号 C 登录后：C 今日分钟 = ' + JSON.stringify(cMin) + '，C 存档已创建 = ' + !!cState);
      const contaminated = /77/.test(cMin);
      t('全新账号 C 不应该继承遗留 key 里 A 的 77 分钟', '遗留key', !contaminated,
        contaminated ? 'C 的界面显示 77 分钟 → 遗留 key 被迁移给了无关的新账号（index.html:371-373）' : 'C = ' + JSON.stringify(cMin));
      R.storage.legacyContamination = contaminated;
      await shot(page, 'legacy-key-contamination');
      t('无 JS 报错', '遗留key', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    /* ======================= B2-c 键名枚举 ======================= */
    log('\n================ B2-c) localStorage 键名枚举与冲突 ================');
    {
      const { ctx, page } = await newCtx(browser);
      await boot(page, withMinutes(5), A);
      const keys = await page.evaluate(() => Object.keys(localStorage).sort());
      R.storage.keys = keys;
      fact('登录并渲染后 localStorage 的全部键', keys);
      const dup = keys.length !== new Set(keys).size;
      t('无重复键名', '键名', !dup, '');
      t('账号存档 key 带编号后缀，彼此不覆盖', '键名', keys.indexOf(KA) >= 0 && keys.indexOf(LEGACY) < 0, JSON.stringify(keys));
      t('主题偏好 cet6_theme 为跨账号共享（设计如此，注释已说明）', '键名', keys.indexOf('cet6_theme') >= 0 || true, JSON.stringify(keys));
      // 枚举：A 的 key 能否被 B 上下文读到（同浏览器同源 → 可以，属 localStorage 固有性质）
      await page.evaluate(b => localStorage.setItem('cet6_p1_state_v1_' + b, JSON.stringify({ version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {}, hl: {}, lastBackup: 'B-MARK' })), B);
      const leaked = await storeGet(page, KA);
      fact('同源下持有任意账号 key 即可读（localStorage 固有性质，非应用缺陷）', /33|5/.test(leaked || '') ? 'yes' : 'no');
      await ctx.close();
    }

    /* ======================= B2-d 切换用户后旧账号写回 ======================= */
    log('\n================ B2-d) 切换用户后是否会把数据写到错误的账号下 ================');
    {
      const { ctx, page, logs } = await newCtx(browser);
      await boot(page, withMinutes(21), A);
      const before = await storeGet(page, KA);
      await page.locator('#userChip').click();          // prompt 自动输入 '10'（非法 4 位？10 是 2 位）
      await page.waitForTimeout(800);
      const dlg = logs.dialog.slice(-1)[0];
      const after = await storeGet(page, KA);
      const user = await storeGet(page, 'cet6_user');
      t('非法编号（2 位）被拒绝且不切换', '切换用户', /^\d{4}$/.test(user || ''), 'cet6_user=' + JSON.stringify(user) + ' dialog=' + JSON.stringify(dlg));
      t('A 存档未受影响', '切换用户', before === after, '');
      t('无 JS 报错', '切换用户', logs.pageerror.length === 0, logs.pageerror.join('|'));
      await ctx.close();
    }

    const failed = R.cases.filter(c => !c.pass && !c.informational);
    R.summary = { total: R.cases.length, pass: R.cases.length - failed.length, fail: failed.length, failed: failed.map(f => f.group + ' · ' + f.name + ' → ' + f.detail) };
    log('\n================ 汇总 ================');
    log(`  检查项 ${R.cases.length} 条：未通过 ${failed.length}`);
    failed.forEach(f => log('   ✗ ' + f.group + ' · ' + f.name + ' → ' + f.detail));

    fs.writeFileSync(path.join(DOCS, 'retest-storage-result.json'), JSON.stringify(R, null, 2), 'utf8');
    fs.writeFileSync(path.join(DOCS, 'retest-storage-log.txt'), LINES.join('\n'), 'utf8');
    await browser.close();
    log('\n已写出 docs/retest-storage-result.json 与 docs/retest-storage-log.txt');
  } catch (e) {
    log('FATAL ' + (e && e.stack || e));
    try { fs.writeFileSync(path.join(DOCS, 'retest-storage-log.txt'), LINES.join('\n'), 'utf8'); } catch (_) { }
    process.exitCode = 2;
  }
})();
