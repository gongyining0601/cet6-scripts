/* scripts/test_id_isolation.js —— 4 位学习编号隔离风险声明用例（S3）
 *
 * 方案：不加口令（避免改动登录流程与存储键），改为在登录界面 + README 如实声明
 * "4 位编号仅 1 万种组合，共用设备可能撞号"的风险，并用本用例固化。
 *
 * 断言：
 *   1. 登录浮层 HTML 含撞号风险提示
 *   2. README 含撞号风险说明
 *   3. 不同编号 → 不同存储键（物理隔离）
 *   4. 同编号 → 同存储键（共享数据）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../app/core.js');

let ok = 0, fail = 0;
function chk(name, cond, detail) {
  cond = !!cond; cond ? ok++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''));
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// 1. 登录界面含风险提示
const hasWarn = /1\s*万种组合|撞号|他人的记录/.test(html);
chk('登录界面含 4 位编号撞号风险提示', hasWarn, hasWarn ? 'found' : 'missing');

// 2. README 含风险说明
const hasReadmeWarn = /1\s*万种组合|撞号/.test(readme);
chk('README 含编号隔离风险说明', hasReadmeWarn, hasReadmeWarn ? 'found' : 'missing');

// 3 & 4. 存储键隔离
const keyA = C.stateKey('1001');
const keyB = C.stateKey('2026');
const keyA2 = C.stateKey('1001');
chk('不同编号映射不同存储键（物理隔离）', keyA !== keyB, keyA + ' vs ' + keyB);
chk('同编号映射相同存储键（同号共享）', keyA === keyA2, keyA);
chk('存储键包含编号', keyA.indexOf('1001') >= 0 && keyB.indexOf('2026') >= 0);

// 5. 实测隔离：两个编号写不同数据，互不污染
const store = {};
const memStore = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const s1 = C.newState(); s1.history['2026-01-01'] = { minutes: 30, done: true };
C.saveState(memStore, s1, keyA);
const s2 = C.newState(); s2.history['2026-06-01'] = { minutes: 45, done: true };
C.saveState(memStore, s2, keyB);
const loadedA = C.loadState(memStore, keyA);
const loadedB = C.loadState(memStore, keyB);
chk('编号 A 的记录只含 A 的数据', '2026-01-01' in loadedA.history && !('2026-06-01' in loadedA.history));
chk('编号 B 的记录只含 B 的数据', '2026-06-01' in loadedB.history && !('2026-01-01' in loadedB.history));

console.log('\n===== 编号隔离: ' + ok + ' ok / ' + fail + ' fail =====');
process.exit(fail ? 1 : 0);
