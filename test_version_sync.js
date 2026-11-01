'use strict';
/* S5 · 三方版本号一致性断言
 * 版本号散落三处：app/version.js（主源）、app/sw.js（SW 兜底）、app/index.html（页面兜底）。
 * 任意一处不一致 → 离线可能加载不到 core.js。本用例秒级、纯 fs+正则，进 core 组。
 *
 * 复测：把 sw.js 的兜底改成 cet6-v20，用例必须 FAIL。 */
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const versionJs = fs.readFileSync(path.join(APP, 'version.js'), 'utf8');
const swJs = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');

let nOk = 0, nFail = 0;
function chk(name, cond, detail) {
  if (cond) { nOk++; console.log('ok   ' + name + (detail ? ' | ' + detail : '')); }
  else { nFail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

// 提取三处版本串
const v1 = (versionJs.match(/CET6_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
const v2 = (swJs.match(/VERSION\s*=\s*self\.CET6_VERSION\s*\|\|\s*['"]([^'"]+)['"]/) || [])[1];
const v3 = (indexHtml.match(/CET6_VERSION\s*\|\|\s*['"]([^'"]+)['"]/) || [])[1];

chk('version.js 含版本串', !!v1, 'v1=' + v1);
chk('sw.js 兜底版本串可提取', !!v2, 'v2=' + v2);
chk('index.html 兜底版本串可提取', !!v3, 'v3=' + v3);

// 三方必须全等（兜底值与主源一致，避免离线加载到错误版本的 core.js）
chk('version.js === sw.js 兜底', v1 === v2, v1 + ' vs ' + v2);
chk('version.js === index.html 兜底', v1 === v3, v1 + ' vs ' + v3);

// SW SHELL 中 core.js 必须带 ?v= 缓存穿透参数
const shellMatch = swJs.match(/SHELL\s*=\s*\[([\s\S]*?)\];/);
chk('SW SHELL 数组可提取', !!shellMatch, '');
if (shellMatch) {
  const hasCoreV = /core\.js\?v=/.test(shellMatch[1]);
  chk('SW SHELL 中 core.js 带 ?v= 参数', hasCoreV, shellMatch[1].slice(0, 200));
}

console.log('\n===== 版本一致性: ' + nOk + ' ok / ' + nFail + ' fail =====');
process.exitCode = nFail ? 1 : 0;
