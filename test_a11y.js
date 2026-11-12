#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_a11y.js · 无障碍取证（非 axe，纯 DOM 走查，离线可跑）

   背景：2026-11-12 严苛测评里第 14 类判为「真缺口」——
   125KB 的 index.html 只有 1 个 <label>，5 处 aria-* 全用在模态框的 inert 上，
   没有任何自动化 a11y 用例。本脚本补上可复算的取证口径。

   检查口径（每个页面分别统计可见交互控件）：
     · 可访问名 = aria-label / aria-labelledby / label[for] / 包裹 label /
                  textContent / title / placeholder，全空即记缺失
     · 图片必须有 alt
     · 统计 landmark（role / main / nav / header / footer）
     · 键盘 Tab 可达的控件数（自然 tabindex 顺序，未被 tabindex=-1 排除）

   注意：本脚本**不接入 run_all 门禁**（接了必红，会掩盖其它回归），
   只产出诊断结果。等 a11y 补齐、本脚本 0 critical 后再挂进 browser 组。
   用法：node test_a11y.js      产物：docs/a11y-result.json
   退出码：0 = 无缺失，1 = 有缺失（取证如实报红）
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { chromium: loadChromium, EXE, fileUrl } = require('./_env');
const { chromium } = loadChromium();

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const URL = fileUrl(path.join(ROOT, 'app', 'index.html'));
const PAGES = ['today', 'wrong', 'stat', 'backup'];

const R = {
  ts: new Date().toISOString(),
  tool: 'DOM walk (no axe / no lighthouse)',
  scope: '本机 file:// + Chromium；仅静态可访问名，未覆盖读屏器实测与全部 WCAG 条款',
  pages: [], totals: { controls: 0, missing: 0, imgsNoAlt: 0, landmarks: 0, tabbable: 0 },
  verdict: '', note: ''
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => localStorage.setItem('cet6_user', '1001'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#planList .card', { timeout: 20000 });

    for (const p of PAGES) {
      const btn = page.locator('nav button[data-p="' + p + '"]');
      if (await btn.count()) { await btn.click(); await page.waitForTimeout(350); }
      const found = await page.evaluate(() => {
        const out = { controls: 0, missing: [], imgsNoAlt: 0, landmarks: 0, tabbable: 0 };
        const vis = (el) => {
          if (el.closest('[hidden]') || el.getAttribute('aria-hidden') === 'true') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        document.querySelectorAll('button, input, select, textarea, a[href], [role="button"]').forEach(el => {
          if (!vis(el)) return;
          out.controls++;
          const labelledby = el.getAttribute('aria-labelledby');
          const forLabel = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
          const name = (el.getAttribute('aria-label') || '')
            || (labelledby && (document.getElementById(labelledby) || {}).textContent)
            || (forLabel && forLabel.textContent)
            || (el.closest('label') && el.closest('label').textContent)
            || (el.textContent || '').trim()
            || el.getAttribute('title') || el.getAttribute('placeholder') || '';
          if (!String(name).trim()) out.missing.push({
            tag: el.tagName.toLowerCase(), id: el.id || '',
            html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 140)
          });
        });
        document.querySelectorAll('img').forEach(im => { if (!im.getAttribute('alt')) out.imgsNoAlt++; });
        out.landmarks = document.querySelectorAll('[role], main, nav, header, footer').length;
        out.tabbable = Array.from(document.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'))
          .filter(el => vis(el) && el.getAttribute('tabindex') !== '-1' && !el.disabled).length;
        return out;
      });
      R.pages.push(Object.assign({ page: p }, found));
      R.totals.controls += found.controls;
      R.totals.missing += found.missing.length;
      R.totals.imgsNoAlt += found.imgsNoAlt;
      R.totals.landmarks = Math.max(R.totals.landmarks, found.landmarks);
      R.totals.tabbable = Math.max(R.totals.tabbable, found.tabbable);
      console.log((found.missing.length ? 'FAIL' : 'ok  ') + ' - ' + p + ' 页：' + found.controls +
        ' 个交互控件，' + found.missing.length + ' 个无访问名，img 无 alt ' + found.imgsNoAlt +
        '，landmark ' + found.landmarks + '，可 Tab ' + found.tabbable);
    }
    R.pageErrors = errs;
    R.verdict = R.totals.missing === 0 && R.totals.imgsNoAlt === 0 && errs.length === 0 ? '通过' : '不通过';
    R.note = '可访问名为空即无法被读屏器正确播报；本结果不计入 run_all 门禁，仅作缺口取证。';
  } catch (e) {
    R.fatal = e.message;
    R.verdict = '未实测';
    console.log('FAIL - 页面走查中断 | ' + e.message);
  } finally {
    await browser.close();
  }

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'a11y-result.json'), JSON.stringify(R, null, 2), 'utf8');
  console.log('\n=== 无障碍取证: ' + R.totals.controls + ' 控件 / ' + R.totals.missing +
    ' 无访问名 / 判定 ' + R.verdict + ' ===');
  console.log('产物 -> docs/a11y-result.json');
  process.exit(R.verdict === '通过' ? 0 : 1);
})();
