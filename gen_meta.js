// scripts/gen_meta.js —— 生成 app/bank/meta.js（题库元数据骨架，供按需加载）
// 用法：node scripts/gen_meta.js（在 D:\CET6 根目录或任意位置均可，内部用绝对路径）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const APP = path.join(__dirname, '..', 'app');
const C = require(path.join(APP, 'core.js'));

// 1) 用与 test_core 相同的方式加载全部卷（vm 沙箱 + window.CET6_BANKS.push）
const sandbox = { window: { CET6_BANKS: [] } };
sandbox.window.window = sandbox.window;
sandbox.window.self = sandbox.window;
const ctx = vm.createContext(sandbox);
const files = fs.readdirSync(path.join(APP, 'bank')).filter((f) => /^cet6-.+\.js$/.test(f)).sort();
files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(APP, 'bank', f), 'utf8'), ctx, { filename: f }));
const banks = sandbox.window.CET6_BANKS;
if (!banks.length || banks.length < 76) { console.error('bank 加载异常:', banks.length); process.exit(1); }

// 1.5) 加载实测听力分片（listeningMeta.js）供 core.unitList 的"篇对齐"切组使用——
// 排期单元必须与播放器「播放本篇」同源，否则篇边界与音频错位
vm.runInContext(fs.readFileSync(path.join(APP, 'bank', 'listeningMeta.js'), 'utf8'), ctx, { filename: 'listeningMeta.js' });
global.CET6_LISTEN_META = sandbox.window.CET6_LISTEN_META || null;

// 2) 提取每卷元数据
const papers = {};
banks.forEach((p) => {
  const qLite = (p.questions || []).map((q) => ({ id: q.id, type: q.type, qno: q.qno, points: q.points || [] }));
  let units;
  try { units = C.unitList([p]); } catch (e) { units = []; }
  papers[p.id] = {
    id: p.id,
    source: p.source || '',
    writing: !!p.writing,
    translation: !!p.translation,
    listeningUrl: p.listeningUrl || '',
    listeningSharedWith: p.listeningSharedWith || '',
    clozeSharedWith: p.clozeSharedWith || '',
    matchSharedWith: p.matchSharedWith || '',
    readingSharedWith: p.readingSharedWith || '',
    matchIntro: p.matchIntro || '',
    qLite: qLite,
    units: units.map((u) => ({ paperId: u.paperId, type: u.type, label: u.label, qids: u.qids, qnos: u.qnos, min: u.min })),
  };
});
const order = banks.slice().sort((a, b) => (a.id < b.id ? 1 : -1)).map((p) => p.id);

const out =
  '(function(){var M=' + JSON.stringify({ v: 1, order: order, papers: papers }) +
  ';(typeof window!==\'undefined\'?window:self).CET6_META=M;})();\n';
// 3) 自检：meta 与全量数据一致性（抽查关键字段）——必须先于写盘，坏骨架绝不落盘
let okQ = 0, okU = 0, totalU = 0;
const totalQ = Object.keys(papers).reduce((a, k) => a + papers[k].qLite.length, 0);
banks.forEach((p) => {
  const m = papers[p.id];
  p.questions.forEach((q) => { const qm = m.qLite.find((x) => x.id === q.id); if (qm && qm.type === q.type && qm.qno === q.qno && JSON.stringify(qm.points) === JSON.stringify(q.points || [])) okQ++; });
  const fullUnits = C.unitList([p]);
  totalU += fullUnits.length;
  if (JSON.stringify(fullUnits.map((u) => u.qids)) === JSON.stringify(m.units.map((u) => u.qids))) okU++;
});
console.log('自检: 题目元数据一致', okQ + '/' + totalQ, '| 单元一致', okU + '/' + banks.length, '(单元总数 ' + totalU + ')');
if (okQ !== totalQ || okU !== banks.length) {
  console.error('自检未通过：已中止，未写盘、未递增版本。请检查题库转录后再跑一次。');
  process.exit(1);
}

// 4) 写盘
const target = path.join(APP, 'bank', 'meta.js');
fs.writeFileSync(target, out, 'utf8');
console.log('meta.js 生成:', target);
console.log('卷数:', order.length, '| qLite 题数:', totalQ, '| 单元数:', Object.keys(papers).reduce((a, k) => a + papers[k].units.length, 0));
console.log('体积:', Math.round(fs.statSync(target).size / 1024) + ' KB (原 76 卷全量约 ' + Math.round(files.length * 120 / 1024 * 1024 / 1024 * 10) / 10 + ' MB)');

// 5) 自动递增版本号（S1）：meta.js 属于 /bank/，SW 走缓存优先。不换缓存桶的话，
//    线上老用户会永远读旧骨架，新增卷静默不可见且页面不报任何错。
//    以前靠人工记得跑 _bump_ver.py，这一步把「加卷」和「换桶」绑成一次原子操作。
//    版本递增统一交给 bump_version.js：主源 + SW 兜底 + 页面兜底三处一起更新，
//    否则离线/弱网时可能加载到旧版 core.js，且页面不报错。
try {
  console.log(require(path.join(__dirname, 'bump_version.js')).bumpVersion(path.join(__dirname, '..')));
} catch (e) {
  console.error('meta.js 已写盘，但版本递增失败：' + e.message + ' —— 请手动检查后重跑。');
  process.exit(1);
}
