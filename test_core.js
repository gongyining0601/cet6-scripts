// core.js 逻辑测试（node test_core.js）
var C = require('../app/core.js');
var fs = require('fs'), path = require('path'), vm = require('vm');

// 加载题库（按 app/bank 目录实际内容，不依赖特定套数）
var sandbox = { window: {} };
vm.createContext(sandbox);
fs.readdirSync(path.join(__dirname, '../app/bank')).forEach(function (f) {
  if (f.endsWith('.js')) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/bank', f), 'utf8'), sandbox);
  }
});
var banks = sandbox.window.CET6_BANKS;
// v8：把实测听力分片交给 core（unitList 的"篇对齐"与播放器同源）
global.CET6_LISTEN_META = sandbox.window.CET6_LISTEN_META || null;
console.log('banks:', banks.length, 'questions:', banks.reduce((a, b) => a + b.questions.length, 0));


var assert = function (cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

// 日期
assert(C.todayStr(new Date(2026, 8, 25)) === '2026-09-25', 'todayStr');
assert(C.addDays('2026-09-25', 7) === '2026-10-02', 'addDays 跨月');
assert(C.dayDiff('2026-09-25', '2026-10-02') === 7, 'dayDiff');

// SM-2（题号从已加载题库动态取，不依赖特定套数）
var allQs = banks.reduce(function (a, b) { return a.concat(b.questions); }, []);
var lq = allQs.filter(function (q) { return q.type === 'listening'; });
var qidL1 = lq[0].id, qidL2 = lq[1] ? lq[1].id : lq[0].id;
var qidR = allQs.filter(function (q) { return q.type === 'reading'; })[0].id;
var st = C.newState();
C.recordResult(st, qidL1, false, '2026-09-25');
assert(st.wrongbook[qidL1].due === '2026-09-26', '错题次日到期');
C.recordResult(st, qidL1, true, '2026-09-26');
assert(st.wrongbook[qidL1].box === 1 && st.wrongbook[qidL1].due === '2026-09-28', '答对升级 2 天');
// 毕业出库
var qid2 = qidL2;
for (var i = 0; i < 5; i++) C.recordResult(st, qid2, true, '2026-09-25');
assert(!st.wrongbook[qid2], '连续答对毕业出库(未入过库)');
C.recordResult(st, qid2, false, '2026-09-25');
assert(st.wrongbook[qid2] && st.wrongbook[qid2].wrongCount === 1, '入库');
var box = 0;
['09-26','09-28','10-02','10-09','10-24'].forEach(function (d) {
  C.recordResult(st, qid2, true, '2026-' + d);
});
assert(!st.wrongbook[qid2], '5 次答对后毕业出库');

// 计划生成（P7 预算制：完整单元 + 25-40 分钟浮动 + 最近考期优先 + 块间轮换）
var st2 = C.newState();
var plan = C.genPlan(st2, banks, '2026-09-25');
st2.plan = plan; // 与应用一致：plan 须写回 state，extraGroup 依赖 state.plan 排除当日清单
console.log('plan items:', plan.items.map(i => (i.review ? 'R:' : '') + (i.label || i.type)).join(' | '));
assert(plan.items.length >= 2, '清单至少 2 组');
var newItems = plan.items.filter(function (i) { return !i.review; });
var objMin = newItems.reduce(function (a, i) { return a + i.qids.length * C.TYPE_META[i.type].minPerQ; }, 0);
console.log('客观题新题分钟:', objMin.toFixed(1));
assert(objMin >= 20 && objMin <= 40, '新题时长 25~40 分钟浮动（含收尾溢出）');
// 完整性：每组同卷、同题型、题号连续升序
newItems.forEach(function (it) {
  var qs = it.qids.map(function (id) { return C.findQ(banks, id); });
  var paperIds = {};
  qs.forEach(function (q) { paperIds[C.findPaper(banks, q.id).id] = 1; });
  assert(Object.keys(paperIds).length === 1, '组内同卷: ' + it.label);
  for (var k = 1; k < qs.length; k++) {
    assert(qs[k].qno === qs[k - 1].qno + 1, '组内题号连续升序: ' + it.label);
    assert(qs[k].type === qs[0].type, '组内同题型: ' + it.label);
  }
  if (it.type === 'reading') assert(it.qids.length === 5, '阅读整篇 5 题');
  if (it.type === 'cloze') assert(it.qids.length === 10, '选词填空整篇 10 空');
  if (it.type === 'match') assert(it.qids.length === 10, '信息匹配整篇 10 题');
  if (it.type === 'listening') {
    // v8：听力组按"音频篇"整组（篇对齐），篇边界取该卷实测烘焙分片（listeningMeta），
    // 与原生播放器「播放本篇」1:1 对应；烘焙未覆盖的尾题允许独立成"补充篇"。
    var paper = C.findPaper(banks, it.qids[0]);
    var pcs = C.listenPiecesFor(paper);
    var pieceOk = pcs.some(function (pc) {
      return qs.every(function (q) { return q.qno >= pc[0] && q.qno <= pc[1]; });
    });
    var leftoverOk = qs.every(function (q) {
      return !pcs.some(function (pc) { return q.qno >= pc[0] && q.qno <= pc[1]; });
    });
    assert(pieceOk || leftoverOk, '听力组按音频篇整组(篇对齐): ' + it.label);
  }
});
// 最近考期优先：新题第一组来自最近含该题型的卷
var pOrder = C.paperOrder(banks);
var firstNew = newItems[0];
var expectPaper = null;
for (var pi = 0; pi < pOrder.length; pi++) {
  if (pOrder[pi].questions.some(function (q) { return q.type === firstNew.type; })) { expectPaper = pOrder[pi].id; break; }
}
assert(firstNew.paperId === expectPaper, '最近考期优先: ' + firstNew.paperId);
// 主题型日（v7）：每天至少 1 个主题型；听力每天保底出现，且每日 ≥2 题型（听力保底 + 主题型/辅题型）
var types = {};
newItems.forEach(function (it) { types[it.type] = 1; });
assert(Object.keys(types).length >= 2, '每日至少 2 种题型（听力保底 + 主题型）');
// 主题型（剩余最多）至少占当日 1 个完整单元；当日确有一个"主题型"组
var themeGroup = newItems.filter(function (it) { return it.type === (types.listening ? 'listening' : Object.keys(types)[0]); });
assert(themeGroup.length >= 1, '每日有主题型组');
// 非周六无写译
assert(!plan.items.some(function (i) { return i.type === 'writing' || i.type === 'translation'; }), '非周六不排写译');
// 周六恰一篇写译，隔周轮换
var sat1 = C.genPlan(st2, banks, '2026-09-26');
var essays1 = sat1.items.filter(function (i) { return i.type === 'writing' || i.type === 'translation'; });
assert(essays1.length === 1, '周六恰一篇写译');
var sat2 = C.genPlan(st2, banks, '2026-10-03');
var essays2 = sat2.items.filter(function (i) { return i.type === 'writing' || i.type === 'translation'; });
assert(essays2.length === 1 && essays2[0].type !== essays1[0].type, '写译隔周轮换');
// 写译选卷 = 新题推进主卷（最近考期优先），不再是取模乱跳
var essayPaper = essays1[0].paperId;
var firstUnitPaper = null;
var allUnits = C.unitList(banks);
for (var ui = 0; ui < allUnits.length; ui++) {
  if (!allUnits[ui].qids.every(function (id) { return st2.papers[id]; })) { firstUnitPaper = allUnits[ui].paperId; break; }
}
assert(essayPaper === firstUnitPaper, '写译与新题同卷(最近考期优先): ' + essayPaper + ' vs ' + firstUnitPaper);
// plan 带结构版本号（ensurePlan 据此丢弃旧版 plan）
assert(sat1.v === C.PLAN_VERSION, 'plan.v 版本号存在且等于 PLAN_VERSION');

// 错题复习组：进清单、封顶 10 分钟、同卷同题型打包
var st3 = C.newState();
var rQs = banks.filter(function (b) { return b.questions.some(function (q) { return q.type === 'reading'; }); })[0].questions.filter(function (q) { return q.type === 'reading'; });
C.recordResult(st3, rQs[0].id, false, '2026-09-24');
C.recordResult(st3, rQs[1].id, false, '2026-09-24');
C.recordResult(st3, rQs[2].id, false, '2026-09-24');
var plan3 = C.genPlan(st3, banks, '2026-09-25');
var revs = plan3.items.filter(function (i) { return i.review; });
assert(revs.length >= 1 && revs.some(function (i) { return i.qids.indexOf(rQs[0].id) >= 0; }), '到期错题进入复习组');
assert(revs.some(function (i) { return i.qids.indexOf(rQs[1].id) >= 0 && i.qids.indexOf(rQs[2].id) >= 0; }), '同卷同题型错题打包成组');
var revMin = revs.reduce(function (a, i) { return a + i.qids.length * C.TYPE_META[i.type].minPerQ; }, 0);
assert(revMin <= C.REVIEW_CAP + 0.01, '复习封顶 ' + C.REVIEW_CAP + ' 分钟: ' + revMin.toFixed(1));
// 复习组题号升序
revs.forEach(function (rv) {
  var nos = rv.qids.map(function (id) { return C.findQ(banks, id).qno; });
  for (var k = 1; k < nos.length; k++) assert(nos[k] > nos[k - 1], '复习组题号升序');
});

// 连续多日模拟：不重复排期、持续推进、全库客观题可排完
var stSim = C.newState();
var scheduled = {};
var d = '2026-09-25', days = 0, dupFound = false;
while (days < 600) {
  var p = C.genPlan(stSim, banks, d);
  stSim.plan = p;
  var hasQ = false;
  p.items.forEach(function (it) {
    it.qids.forEach(function (id) {
      if (scheduled[id]) dupFound = true;
      scheduled[id] = 1; hasQ = true;
    });
  });
  assert(!dupFound, '第 ' + days + ' 天无重复排期');
  p.items.forEach(function (it) { it.qids.forEach(function (id) { C.recordResult(stSim, id, true, d); }); });
  if (!p.items.some(function (it) { return it.qids && it.qids.length; })) break;
  d = C.addDays(d, 1); days++;
}
var allObjIds = [];
banks.forEach(function (b) { b.questions.forEach(function (q) { allObjIds.push(q.id); }); });
var covered = allObjIds.filter(function (id) { return scheduled[id]; }).length;
console.log('模拟天数:', days, '覆盖:', covered + '/' + allObjIds.length);
assert(covered === allObjIds.length, '全库客观题全部排期完成（' + covered + '/' + allObjIds.length + '）');
/* 排期效率（原为"硬约束：≤154 天"，2026-10-07 改为按 core 自身常量推导）
   为什么不写死天数：天数 = f(题库题量, 单元切分粒度, PLAN_TARGET)，是**项目数据**不是算法不变量。
   实测两个仓都健康、但天数不同：
     · 本仓（3315 题，听力篇边界读 listeningMeta）            → 151 天
     · 四级仓（3325 题，听力按官方烘焙分片，单元切分更细）      → 155 天
   scripts/ 靠"改名镜像"保持两边一致，写死一个 154 会把本仓的产品目标变成四级仓的硬约束
   （实测直接把四级仓判 FAIL），且题库/分片一变就会误报。
   现在断言的是算法不变量：平均每日实际消化时长必须贴近 PLAN_TARGET（排期没有浪费产能、
   不会无限拖长）。这等价于 天数 ≤ 总耗时 / (PLAN_TARGET - 1)，对任意题库规模都成立。 */
var totalMin = C.unitsOf(banks).reduce(function (a, u) { return a + (u.min || 0); }, 0);
var dayCeil = Math.ceil(totalMin / (C.PLAN_TARGET - 1));
var avgMinPerDay = Math.round((totalMin / days) * 10) / 10;
console.log('排期效率: 总耗时 ' + Math.round(totalMin) + ' 分钟 / ' + days + ' 天 = 平均 ' + avgMinPerDay + ' 分钟/天（PLAN_TARGET=' + C.PLAN_TARGET + '，天数上限 ' + dayCeil + '）');
assert(avgMinPerDay >= C.PLAN_TARGET - 1, '排期效率：平均每日消化 ' + avgMinPerDay + ' 分钟 ≥ PLAN_TARGET-1（' + (C.PLAN_TARGET - 1) + '）');
assert(days <= dayCeil, '排期总天数 ≤ ' + dayCeil + ' 天（按 PLAN_TARGET 推导；实际 ' + days + ' 天）');


// streak
var st4 = C.newState();
st4.history['2026-09-23'] = { minutes: 30, done: true };
st4.history['2026-09-24'] = { minutes: 30, done: true };
assert(C.streak(st4.history, '2026-09-24') === 2, '连击 2');
assert(C.streak(st4.history, '2026-09-25') === 2, '今天未打卡不断连击');
st4.history['2026-09-25'] = { minutes: 10, floor: true };
assert(C.streak(st4.history, '2026-09-25') === 3, '底线模式保连击');

// heatmap
var hm = C.heatmap(st4.history, '2026-09-25', 84);
assert(hm.length === 84 && hm[83].done, '热力图 84 天');

// 加练：完整单元、同卷、不与今日清单重复
var ex = C.extraGroup(st2, banks, '2026-09-25', 'listening');
// v7：加练听力取一个完整"音频篇"（篇对齐），≤4 题
assert(ex && ex.qids.length >= 1 && ex.qids.length <= 4, '加练听力为完整音频篇(≤4题)');
var exPaper = {};
ex.qids.forEach(function (id) { exPaper[C.findPaper(banks, id).id] = 1; });
assert(Object.keys(exPaper).length === 1, '加练组同卷');
var planIds = {};
plan.items.forEach(function (it) { it.qids.forEach(function (id) { planIds[id] = 1; }); });
assert(!ex.qids.some(function (id) { return planIds[id]; }), '加练不与今日清单重复');
var exQs = ex.qids.map(function (id) { return C.findQ(banks, id); });
for (var ek = 1; ek < exQs.length; ek++) assert(exQs[ek].qno === exQs[ek - 1].qno + 1, '加练组题号连续');

// 判题
var q1 = banks[0].questions[0];
assert(C.judge(q1, q1.answer) === true && C.judge(q1, 'C') === (q1.answer === 'C'), '判题正确');

// 持久化
var store = { m: {}, getItem(k) { return this.m[k] || null; }, setItem(k, v) { this.m[k] = v; } };
C.saveState(store, st4);
var loaded = C.loadState(store);
assert(loaded.history['2026-09-23'].done === true, '导出导入状态');

console.log(process.exitCode ? '== 有失败 ==' : '== 全部通过 ==');

// 自适应遗忘曲线（P5）：间隔随表现伸缩
var qA = lq[2] ? lq[2].id : qidL1;
var stA = C.newState();
C.recordResult(stA, qA, false, '2026-09-25');
assert(stA.wrongbook[qA].iv === 1 && stA.wrongbook[qA].due === '2026-09-26', '答错入库 iv=1 次日到期');
C.recordResult(stA, qA, true, '2026-09-26');
var iv1 = stA.wrongbook[qA].iv;
assert(iv1 === 2, '首次答对 iv 提升到 2');
C.recordResult(stA, qA, true, '2026-09-28');
var iv2 = stA.wrongbook[qA].iv;
assert(iv2 > iv1, '连续答对间隔进一步拉长 (' + iv1 + '->' + iv2 + ')');
// 答错惩罚：ease 下降、间隔重置
var easeBefore = stA.wrongbook[qA].ease;
C.recordResult(stA, qA, false, '2026-09-28');
assert(stA.wrongbook[qA].ease < easeBefore && stA.wrongbook[qA].iv === 1, '答错降低稳固度并重置间隔');
// reviewQueue 排序：逾期久者在前
var stQ = C.newState();
C.recordResult(stQ, qidL1, false, '2026-09-20'); // 逾期 5 天
C.recordResult(stQ, qidL1, true, '2026-09-21');  // 升级后到期 ~09-23，仍逾期
C.recordResult(stQ, qidR, false, '2026-09-24');  // 到期 09-25，今日到期
var q = C.reviewQueue(stQ, banks, '2026-09-25');
assert(q[0] === qidL1, '逾期更久的题排在复习队列最前');
assert(q.indexOf(qidR) >= 0, '今日到期题也在队列中');
// wrongSummary 统计
var sum = C.wrongSummary(stQ, '2026-09-25');
assert(sum.total === 2 && sum.due === 2 && sum.overdue === 1 && sum.maxOverdue === 2, '错题统计正确 ' + JSON.stringify(sum));
// 旧 state 迁移：无 ease/iv 字段的条目自动补齐
var legacy = { version: 1, history: {}, papers: {}, plan: null, essays: {},
  wrongbook: { 'x': { addedAt: '2026-09-01', box: 2, wrongCount: 1, due: '2026-09-10' } } };
global.__store = { getItem: function () { return JSON.stringify(legacy); }, setItem: function () {} };
var mig = C.loadState(global.__store);
assert(mig.wrongbook.x.ease === 2.5 && mig.wrongbook.x.iv === 4 && mig.wrongbook.x.streak === 0, '旧记录迁移补自适应字段');
console.log('自适应遗忘曲线测试通过');

// P3 估分与薄弱点：estimateScore / weakestPoint / pointIds
var stP3 = C.newState();
var rdP3 = banks.filter(function (b) { return b.questions.some(function (q) { return q.type === 'reading' && q.points && q.points.length; }); })[0].questions.filter(function (q) { return q.type === 'reading' && q.points && q.points.length; });
var ptA = rdP3[0].points[0];
var idsA = rdP3.filter(function (q) { return q.points.indexOf(ptA) >= 0; }).slice(0, 4);
idsA.forEach(function (q, i) { C.recordResult(stP3, q.id, i >= 1, '2026-09-25'); }); // 错1对3 → 75%
var est1 = C.estimateScore(stP3, banks);
assert(est1.covered && est1.parts.length === 1, '估分覆盖已练部分(1/4)');
// P0-b（第三轮）：估分改成"客观题得分 + 写译估分"两段分开返回，不再把整体归一化到 710。
// 下面几条同时守住旧口径的高估：75% 客观正确率下旧式子给 533，新式子必须明显更低。
assert(est1.objMax === C.SCORE_OBJ_MAX && Math.abs(est1.objScore - 0.75 * C.SCORE_OBJ_MAX) < 0.11, '客观题得分 = 正确率×497: ' + est1.objScore + '/' + est1.objMax);
assert(est1.writeTransEstimate && est1.writeTransEstimate.conservative === true && est1.writeTransEstimate.rate === 0.60, '无写译记录时走保守档(75%→60%): ' + (est1.writeTransEstimate && est1.writeTransEstimate.rate));
assert(est1.score === Math.round(est1.objScore + est1.writeTransEstimate.score), '总分 = 客观题得分 + 写译估分: ' + est1.score);
assert(est1.score < Math.round(0.75 * 710), 'P0-b 不再高估：75% 客观正确率下 ' + est1.score + ' < 旧式子 ' + Math.round(0.75 * 710));
// 多题型：加听力全对 → 估分应上升
var lstP3 = banks.filter(function (b) { return b.questions.some(function (q) { return q.type === 'listening' && q.points && q.points.length; }); })[0].questions.filter(function (q) { return q.type === 'listening' && q.points && q.points.length; });
lstP3.slice(0, 3).forEach(function (q) { C.recordResult(stP3, q.id, true, '2026-09-25'); });
var est2 = C.estimateScore(stP3, banks);
assert(est2.parts.length === 2 && est2.score > est1.score, '多题型估分上升: ' + est1.score + '->' + est2.score);
// P0-b 验收锚点：客观题正确率 70% → 497×0.7 + 213×0.6 = 476（旧式子约 497）
var st70 = C.newState();
for (var i70 = 0; i70 < 10; i70++) C.recordResult(st70, '2026-09-25-l-' + (i70 + 1), i70 < 7, '2026-09-25');
var est70 = C.estimateScore(st70);
assert(est70.score === 476, 'P0-b 验收锚点：客观 70% → ' + est70.score + '（期望 476，旧式子约 497）');
// 有写译评分记录时不再走保守档（essays[].rate，0~1）
st70.essays.writing = { lastAt: '2026-09-25', text: 'x', rate: 0.9 };
var estRec = C.estimateScore(st70);
assert(estRec.writeTransEstimate.conservative === false && Math.abs(estRec.writeTransEstimate.rate - 0.9) < 1e-9, '有写译评分记录时按记录估算: ' + estRec.writeTransEstimate.rate);
assert(estRec.score > est70.score, '写译记录更好时总分更高: ' + est70.score + '->' + estRec.score);
// 旧数据兜底：只有写译记录、没有任何客观题记录时不出分，也不崩
var stOnlyEssay = C.newState();
stOnlyEssay.essays.writing = { lastAt: '2026-09-25', text: 'x', rate: 0.5 };
var estOnly = C.estimateScore(stOnlyEssay);
assert(estOnly.covered === false && estOnly.score === 0, '无客观题记录时估分为 0 且 covered=false');
// 边界：满正确率不再等于 710（写译按保守档 → 646），零正确率仍有写译保底（40% 档 → 85）
var stFull = C.newState();
for (var iF = 0; iF < 10; iF++) C.recordResult(stFull, '2026-09-25-r-' + (iF + 1), true, '2026-09-25');
assert(C.estimateScore(stFull).score === 646, '满正确率 → 646（旧式子 710）: ' + C.estimateScore(stFull).score);
var stZero = C.newState();
for (var iZ = 0; iZ < 10; iZ++) C.recordResult(stZero, '2026-09-25-r-' + (iZ + 1), false, '2026-09-25');
assert(C.estimateScore(stZero).score === 85, '零正确率 → 写译 40% 档保底 85: ' + C.estimateScore(stZero).score);
// weakestPoint：正确率最低且练过 ≥3 题
var wp1 = C.weakestPoint(stP3, banks, 3);
assert(wp1 && wp1.pt === ptA, '最薄弱考点为练过的低正确率考点: ' + (wp1 && wp1.pt));
var wp0 = C.weakestPoint(C.newState(), banks, 3);
assert(wp0 === null, '无足够练习量时最薄弱考点为空');
// pointIds：含指定考点且数量正确
var idsA2 = C.pointIds(banks, ptA);
assert(idsA2.length >= 4 && idsA2.every(function (id) { return C.findQ(banks, id).points.indexOf(ptA) >= 0; }), 'pointIds 返回该考点全部题: ' + idsA2.length + ' 题');
console.log('P3 估分与薄弱点测试通过');
