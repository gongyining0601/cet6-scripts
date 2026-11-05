/* scripts/bump_version.js —— 版本号递增（唯一权威实现，CET4 / CET6 两仓字节一致）
 *
 * 为什么必须三处一起改：
 *   app/version.js 是主源，但 app/sw.js 与 app/index.html 各自有一个「importScripts / document.write
 *   失败时的兜底版本串」。只改主源会让离线或弱网下加载到旧版 core.js，且页面不报错。
 *   历史遗留：CET4 主源 cet4-v11，SW 兜底 cet4-v1，页面兜底 '0' —— 三方长期不一致。
 *
 * 用法：node scripts/bump_version.js        （+1）
 *       node scripts/bump_version.js 42     （直接设为 cetN-v42）
 * 也被 gen_meta.js 在每次加卷成功后调用，以及 _bump_ver.py 转发调用。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function appDirOf(root) { return path.join(root, 'app'); }

function readCurrent(appDir) {
  const s = fs.readFileSync(path.join(appDir, 'version.js'), 'utf8');
  const m = /cet[46]-v(\d+)/.exec(s);
  if (!m) throw new Error('version.js 里找不到 cetN-vN 版本号');
  return { text: s, current: m[0], n: Number(m[1]) };
}

/** 把三处版本串统一为 next，返回人类可读的结果行 */
function bumpVersion(root, targetN) {
  const appDir = appDirOf(root);
  const v = readCurrent(appDir);
  const n = (targetN == null) ? v.n + 1 : Number(targetN);
  if (!Number.isFinite(n) || n < 1) throw new Error('目标版本号非法：' + targetN);
  const prefix = v.current.replace(/\d+$/, '');
  const next = prefix + n;

  const files = {
    'version.js': { re: /cet[46]-v\d+/, label: '主源' },
    'sw.js': { re: /(self\.CET[46]_VERSION\s*\|\|\s*['"])[^'"]*(['"])/, label: 'SW 兜底' },
    'index.html': { re: /(window\.CET[46]_VERSION\s*\|\|\s*['"])[^'"]*(['"])/, label: '页面兜底' }
  };

  const results = [];
  Object.keys(files).forEach(function (name) {
    const p = path.join(appDir, name);
    const s = fs.readFileSync(p, 'utf8');
    const spec = files[name];
    if (!spec.re.test(s)) throw new Error(name + ' 里找不到版本串（' + spec.label + '），已中止，避免写出半套版本');
    let out;
    if (name === 'version.js') out = s.replace(spec.re, next);
    else out = s.replace(spec.re, function (_, a, b) { return a + next + b; });
    fs.writeFileSync(p, out, 'utf8');
    results.push(spec.label + ' ' + name);
  });
  return '版本: ' + v.current + ' -> ' + next + ' | 已同步三处（' + results.join(' / ') + '）';
}

/** 供回归用例读取三方版本串，不写盘 */
function inspect(root) {
  const appDir = appDirOf(root);
  const ver = fs.readFileSync(path.join(appDir, 'version.js'), 'utf8');
  const sw = fs.readFileSync(path.join(appDir, 'sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  return {
    main: (/cet[46]-v\d+/.exec(ver) || [])[0] || '',
    sw: (/self\.CET[46]_VERSION\s*\|\|\s*['"]([^'"]+)['"]/.exec(sw) || [])[1] || '',
    html: (/window\.CET[46]_VERSION\s*\|\|\s*['"]([^'"]+)['"]/.exec(html) || [])[1] || '',
    swText: sw,
    htmlText: html
  };
}

module.exports = { bumpVersion: bumpVersion, inspect: inspect };

if (require.main === module) {
  try {
    console.log(bumpVersion(path.resolve(__dirname, '..'), process.argv[2] == null ? undefined : process.argv[2]));
  } catch (e) {
    console.error('版本递增失败：' + e.message);
    process.exit(1);
  }
}
