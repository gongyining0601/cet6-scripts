'use strict';
/* B5 · 浅色主题对比度断言（Node 侧，无需浏览器）
 * 从 app/index.html 解析浅色主题 CSS 变量，检查关键文本/背景组合的 WCAG 对比度 ≥ 4.5:1。
 * 失败时 process.exitCode=1。
 *
 * 复测：把 --sub 改回 #6b7280 或 .streak-chip 文字色改回 var(--warn)，用例必须 FAIL。 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

// 提取 :root 下的变量定义
function extractVars(scope) {
  const re = new RegExp(scope + '\\s*\\{([^}]+)\\}');
  const m = html.match(re);
  const vars = {};
  if (m) {
    m[1].split(';').forEach(s => {
      const kv = s.match(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/);
      if (kv) vars[kv[1]] = kv[2];
    });
  }
  return vars;
}

const light = extractVars(':root');

// hex → {r,g,b} 0-1
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function lum(c) {
  const f = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function ratio(fg, bg) {
  const l1 = lum(hexToRgb(fg)), l2 = lum(hexToRgb(bg));
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

let nOk = 0, nFail = 0;
function chk(name, fg, bg) {
  const r = ratio(fg, bg);
  const pass = r >= 4.5;
  if (pass) nOk++; else nFail++;
  console.log((pass ? 'ok  ' : 'FAIL') + ' ' + name + ' | fg=' + fg + ' bg=' + bg + ' ratio=' + r.toFixed(2) + (pass ? '' : ' (<4.5)'));
  return pass;
}

// 浅色主题关键组合（来自 index.html 的 CSS 规则）
chk('--sub 文字 on --bg 背景', light.sub, light.bg);
chk('--sub 文字 on --card 背景（nav button）', light.sub, light.card);
chk('.streak-chip 文字 on .streak-chip 背景', '#8a4b06', light.c5);
chk('.date（--sub）on header（--bg）', light.sub, light.bg);
chk('.user-chip（--sub）on --c1', light.sub, light.c1);
chk('nav button（--sub）on nav（--card）', light.sub, light.card);

console.log('\n===== 浅色对比度: ' + nOk + ' ok / ' + nFail + ' fail (阈值 4.5:1) =====');
process.exitCode = nFail ? 1 : 0;
