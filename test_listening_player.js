// scripts/test_listening_player.js —— 听力组内嵌原生播放器（<audio>）验证
// 更新记录（2026-10-07）：播放器实现已从第三方 iframe → 原生 <audio> 直连 m3u8，
// 且不再引入 hls.js（走媒体元素原生 HLS）。原断言 #1/#5 依据的是旧实现（<video> + window.Hls），
// 属实现漂移导致的失效断言，本次按当前实现重写；分片数改为从 listeningMeta 动态读取，不再硬编码。
const path = require('path');
const { chromium: loadChromium, EXE } = require('./_env');
const { chromium } = loadChromium();
const ROOT = path.join(__dirname, '..', 'app');
const URL = 'file://' + path.join(ROOT, 'index.html');
const results = [];
const check = (name, ok, extra) => results.push((ok ? 'ok' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));

const PAPER = '2020-07-1';
const QIDS = ['2020-07-1-l-1', '2020-07-1-l-2', '2020-07-1-l-3', '2020-07-1-l-4'];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept(''));

  await page.goto(URL);
  await page.waitForSelector('#loginMask', { timeout: 20000 });

  // 注入固定听力组（2020-07-1 卷听力前 4 题），绕过清单随机性；该卷已烘焙进 listeningMeta.js
  await page.evaluate(({ PAPER, QIDS }) => {
    const C = window.CET6Core;
    const today = C.todayStr();
    const key = C.stateKey('9201');
    localStorage.setItem('cet6_user', '9201');
    localStorage.setItem(key, JSON.stringify({
      version: 1, history: {}, papers: {}, wrongbook: {}, essays: {},
      plan: { date: today, v: C.PLAN_VERSION, items: [
        { key: 'listen-1', type: 'listening', qids: QIDS, paperId: PAPER, done: false },
      ] },
    }));
  }, { PAPER, QIDS });
  await page.reload();
  await page.waitForSelector('#planList .card', { timeout: 20000 });
  await page.locator('#planList .card button').first().click();
  await page.waitForSelector('#quiz.show .listen-player', { timeout: 20000 });

  // 1) 播放器块存在：有烘焙分片时为原生 <audio>；无烘焙数据时退回白名单 iframe
  const hasAudio = await page.locator('#quiz .listen-player audio').count();
  const hasIframe = await page.locator('#quiz .listen-player iframe').count();
  check('播放器已渲染（原生 audio 优先）', hasAudio >= 1 || hasIframe >= 1,
    'audio=' + hasAudio + ' iframe=' + hasIframe);

  // 2) 烘焙数据已挂载（CET6_LISTEN_META 覆盖该卷）
  const metaInfo = await page.evaluate((pid) => {
    const M = window.CET6_LISTEN_META || {};
    return { has: !!M[pid], src: (M[pid] && M[pid].src) || '', pieces: ((M[pid] && M[pid].pieces) || []).length };
  }, PAPER);
  check('CET6_LISTEN_META 含该卷 src+pieces', metaInfo.has && /\.m3u8$/.test(metaInfo.src) && metaInfo.pieces > 0,
    JSON.stringify(metaInfo));

  // 3) 篇条带按钮数 = meta 分片数；当前篇唯一高亮
  const stripN = await page.locator('#quiz .lp-piece').count();
  const curN = await page.locator('#quiz .lp-piece.cur').count();
  const curText = (await page.locator('#quiz .lp-piece.cur').first().textContent().catch(() => '')) || '';
  check('篇条带按钮数 = 分片数', stripN === metaInfo.pieces, 'strip=' + stripN + ' meta=' + metaInfo.pieces);
  check('当前篇唯一高亮', curN === 1 && /▶\s*本篇/.test(curText), 'curN=' + curN + ' cur=' + curText.trim());

  // 4) 组提示含题号范围与卷号
  const hint = (await page.locator('#quiz .quiz-wrap').textContent()) || '';
  check('组提示含题号范围与卷号', /第\s*\d+\s*[–-]\s*\d+\s*题/.test(hint) && hint.indexOf(PAPER) >= 0,
    'hint=' + hint.replace(/\s+/g, ' ').slice(0, 80));

  // 5) 音频元素带 controls（可交互）；若走 iframe 兜底则跳过此条语义
  if (hasAudio >= 1) {
    const hasControls = await page.locator('#quiz .listen-player audio[controls]').count();
    check('音频元素带 controls 控件', hasControls >= 1, 'controls=' + hasControls);
  }

  // 6) 连播开关存在且默认勾选
  const autoExists = await page.locator('#quiz .lp-auto input').count();
  const autoChecked = autoExists ? await page.locator('#quiz .lp-auto input').isChecked() : false;
  check('篇间连播开关默认勾选', autoExists >= 1 && autoChecked, 'exists=' + autoExists + ' auto=' + autoChecked);

  check('听力组渲染无页面错误', errs.length === 0, errs.join('|') || 'none');

  await page.screenshot({ path: path.join(ROOT, '..', 'docs', 'ui-15-listening-player.png'), fullPage: true });

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log('=== 听力播放器: ' + (results.length - fails) + ' ok / ' + fails + ' fail ===');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
