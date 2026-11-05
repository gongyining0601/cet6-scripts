/* scripts/test_version_sync.js —— 版本与外壳一致性闸门（CET4 / CET6 共用，两仓字节一致）
 *
 * 版本串散落三处：app/version.js（主源）、app/sw.js（SW 兜底）、app/index.html（页面兜底）。
 * 任意一处不一致 → 离线可能加载到旧版 core.js，且页面不报错。
 * 顺带盯住外壳：SW 预缓存清单必须包含同步层两个脚本，CSP 必须是静态 meta。
 *
 * 复测：把 sw.js 的兜底改成旧版本，本用例必须 FAIL。
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { inspect } = require(path.join(__dirname, 'bump_version.js'));

let ok = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { ok++; console.log('ok   ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

const v = inspect(ROOT);
chk('version.js 含版本串', /^cet[46]-v\d+$/.test(v.main), 'main=' + v.main);
chk('sw.js 兜底版本串可提取', !!v.sw, 'sw=' + v.sw);
chk('index.html 兜底版本串可提取', !!v.html, 'html=' + v.html);
chk('主源 === SW 兜底', v.main === v.sw, v.main + ' vs ' + v.sw);
chk('主源 === 页面兜底', v.main === v.html, v.main + ' vs ' + v.html);

const shellMatch = /SHELL\s*=\s*\[([\s\S]*?)\];/.exec(v.swText);
chk('SW SHELL 数组可提取', !!shellMatch, '');
if (shellMatch) {
  const shell = shellMatch[1];
  chk('SHELL 中 core.js 带 ?v= 参数', /core\.js\?v=/.test(shell), '');
  chk('SHELL 预缓存 sync-config.js（否则离线启用不了同步）', shell.includes("'./sync-config.js'"), '');
  chk('SHELL 预缓存 sync.js', shell.includes("'./sync.js'"), '');
}
chk('CSP 为静态 meta（file:// 与 https 同时生效）',
  /<meta\s+http-equiv="Content-Security-Policy"/.test(v.htmlText), '');
chk('页面引用同步层两个脚本',
  /<script src="sync-config\.js"><\/script>/.test(v.htmlText) && /<script src="sync\.js"><\/script>/.test(v.htmlText), '');

console.log('\n===== 版本与外壳一致性: ' + ok + ' ok / ' + fail + ' fail =====');
process.exit(fail ? 1 : 0);
