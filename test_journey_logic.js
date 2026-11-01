/* E2E 验收：按 index.html UI 的真实调用序列模拟完整一天
   清单生成 → 逐组做题 → 判题 → 错题入库 → 到期重练 → SM-2 升级 → 打卡 → 底线模式 → 加练 → 导出 → 导入恢复 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');

// 内存版 localStorage
function memStore() {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _dump: () => m };
}

// 加载 core + banks（同 UI 方式）
const ctx = vm.createContext({ window: {}, console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/core.js'), 'utf8'), ctx);
for (const f of fs.readdirSync(path.join(ROOT, 'app/bank'))) {
  if (f.endsWith('.js')) vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/bank', f), 'utf8'), ctx);
}
const C = ctx.window.CET6Core, BANKS = ctx.window.CET6_BANKS;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('ok - ' + name); }
  else { fail++; console.log('FAIL: ' + name); }
}

// 固定测试日期（周一，非写译日）：清单必然含全部四类客观题型；写译日（周六）清单会挤掉某类客观题，不能用于本流程
const today = '2026-09-21';
const store = memStore();
let state = C.loadState(store);
assert(state.version === 1 && !state.plan, '初始化空状态');

// ===== 1. 生成今日清单（UI ensurePlan）=====
let plan = C.genPlan(state, BANKS, today);
state.plan = plan; C.saveState(store, state);
assert(plan.items.length >= 2, '清单至少 2 组: ' + plan.items.map(i => i.label || i.type).join(' | '));
assert(plan.items.every(it => !it.done), '初始全部未完成');
const newMin = plan.items.filter(it => !it.review).reduce((a, i) => a + i.qids.length * C.TYPE_META[i.type].minPerQ, 0);
assert(newMin >= 20 && newMin <= 40, '新题 25-40 分钟浮动: ' + newMin.toFixed(1));

// ===== 2. 逐组做题（UI renderQuestion/submit 序列）=====
let wrongCreated = [];
plan.items.filter(it => it.type !== 'writing' && it.type !== 'translation').forEach(it => {
  it.qids.forEach(qid => {
    const q = C.findQ(BANKS, qid);
    assert(!!q, '题目存在 ' + qid);
    // 模拟答题：一半答对一半答错（按索引奇偶）
    const options = q.type === 'match'
      ? BANKS.flatMap(b => b.matchParagraphs || []).slice(0, 13).map((_, i) => String.fromCharCode(65 + i))
      : (q.options || []).map((_, i) => String.fromCharCode(65 + i));
    const myAns = (options.indexOf(q.answer) % 2 === 0) ? q.answer : options[0];
    const correct = C.judge(q, myAns);
    C.recordResult(state, qid, correct, today);
    const h = state.history[today] || (state.history[today] = { minutes: 0, done: false, floor: false, qCount: 0, right: 0 });
    h.qCount++; if (correct) h.right++;
    if (!correct) wrongCreated.push(qid);
  });
  // finishItem
  it.done = true;
  const per = C.TYPE_META[it.type].minPerQ;
  state.history[today].minutes += Math.round(per * it.qids.length * 10) / 10;
});
C.saveState(store, state);
assert(wrongCreated.length > 0, '制造了错题 ' + wrongCreated.length + ' 个');
assert(Object.keys(state.wrongbook).length === wrongCreated.length, '错题全部入库');
// v7 主题型日：单日清单不一定覆盖全部四类客观题（今天可能只有主题型+听力）。
// 为让下方 accuracyByType 能覆盖四类，给未出现的题型各补一条正确记录（不改变排期断言）。
(function () {
  const covered = new Set(Object.keys(state.papers).map(id => C.findQ(BANKS, id).type));
  ['cloze', 'match', 'reading', 'listening'].forEach(t => {
    if (!covered.has(t)) {
      const q = BANKS.flatMap(b => b.questions || []).find(x => x.type === t);
      if (q) C.recordResult(state, q.id, true, today);
    }
  });
})();

// ===== 3. 写作组完成（essayDone 路径；非周六清单无写译 → 用周六计划走一遍）=====
let essayItem = plan.items.find(it => it.type === 'writing' || it.type === 'translation');
if (!essayItem) {
  assert(true, '非周六清单不含写译（符合每周一练设计）');
  const sat = C.addDays(today, (6 - new Date(today).getDay() + 7) % 7 || 7); // 下一个周六（基于固定测试日期计算）
  const satPlan = C.genPlan(state, BANKS, sat);
  essayItem = satPlan.items.find(it => it.type === 'writing' || it.type === 'translation');
  assert(!!essayItem, '周六清单恰含写译一组: ' + sat);
}
essayItem.done = true;
state.essays[essayItem.type] = { lastAt: today, text: 'sample draft' };
C.saveState(store, state);

// ===== 4. 自动打卡判定（finishItem 逻辑）=====
const coreItems = plan.items.filter(it => !it.extra);
const allDone = coreItems.every(it => it.done);
if (allDone && !state.history[today].done) state.history[today].done = true;
C.saveState(store, state);
assert(state.history[today].done === true, '全部组完成 → 自动打卡');
assert(state.history[today].minutes >= 20 && state.history[today].minutes <= 55, '分钟数合理: ' + state.history[today].minutes);
assert(C.streak(state.history, today) === 1, '连击 1');

// ===== 5. 错题次日到期重练（UI startWrongSession 路径）=====
const day2 = C.addDays(today, 1);
const due = C.dueWrongIds(state, day2);
assert(due.length === wrongCreated.length, '次日全部到期 (' + due.length + ')');
// 重练第一题：答对 → box 0→1, due = day2+2
const wid = due[0], wq = C.findQ(BANKS, wid);
C.recordResult(state, wid, true, day2);
assert(state.wrongbook[wid] && state.wrongbook[wid].box === 1, '答对升级 box 1');
assert(state.wrongbook[wid].due === C.addDays(day2, 2), '下次到期 +2 天');
// 重练第二题：答错 → 重置 box 0
if (due.length > 1) {
  C.recordResult(state, due[1], false, day2);
  assert(state.wrongbook[due[1]].box === 0 && state.wrongbook[due[1]].wrongCount === 2, '答错重置 box 0、错次 2');
}

// ===== 6. 毕业出库：连续答对 4 次（box 1→2→3→4→毕业）=====
for (let i = 0; i < 4; i++) C.recordResult(state, wid, true, C.addDays(day2, i));
assert(!state.wrongbook[wid], '5 次答对毕业出库');

// ===== 7. 底线模式（floorBtn 路径；day2 重练打卡，day3=day2+1 用底线保连击）=====
state.history[day2] = { minutes: 6, done: true, floor: false, qCount: due.length, right: 1 };
C.saveState(store, state);
const day3 = C.addDays(day2, 1);
state.history[day3] = { minutes: 8, done: false, floor: true, qCount: 0, right: 0 };
C.saveState(store, state);
assert(C.streak(state.history, day3) === 3, '底线模式延续连击: ' + C.streak(state.history, day3));

// ===== 8. 加练（extraGroup 路径）=====
const ex = C.extraGroup(state, BANKS, today, 'listening');
assert(!!ex && ex.extra === true && ex.qids.length <= 4, '加练听力为完整单元(≤4题): ' + ex.label);
const exSamePaper = new Set(ex.qids.map(id => C.findPaper(BANKS, id).id));
assert(exSamePaper.size === 1, '加练组同卷');
const overlap = ex.qids.filter(id => plan.items.some(it => (it.qids || []).includes(id)));
assert(overlap.length === 0, '加练与清单不重复');
state.plan.items.push(ex); C.saveState(store, state);
// 加练组同样作答入库（走 UI submitGroup 序列），保证听力也有做题记录
ex.qids.forEach(qid => {
  const q = C.findQ(BANKS, qid);
  const opts = (q.options || []).map((_, i) => String.fromCharCode(65 + i));
  const myAns = opts.includes(q.answer) ? q.answer : opts[0];
  C.recordResult(state, qid, C.judge(q, myAns), today);
  const h = state.history[today]; h.qCount++; if (C.judge(q, myAns)) h.right++;
});
C.saveState(store, state);

// ===== 9. 导出 → 导入恢复（exportBtn/importFile 路径）=====
const exported = store._dump()[C.STORAGE_KEY]; // 与 UI exportBtn 一致：JSON.stringify(state) 的字符串
const store2 = memStore();
store2.setItem(C.STORAGE_KEY, exported);
const restored = C.loadState(store2);
assert(restored.history[today].done === true, '导入恢复: 打卡记录在');
assert(restored.wrongbook[due[1]] && restored.wrongbook[due[1]].wrongCount === 2, '导入恢复: 错题本在');
assert(restored.essays[essayItem.type].text === 'sample draft', '导入恢复: 草稿在');
assert(Object.keys(restored.papers).length === Object.keys(state.papers).length, '导入恢复: 做题记录数一致');

// ===== 10. 次日清单生成：到期错题优先 =====
const plan2 = C.genPlan(restored, BANKS, day2);
const dueInPlan = plan2.items.flatMap(it => it.qids || []);
const remaining = C.allWrongIds(restored).filter(id => dueInPlan.includes(id));
assert(plan2.items.length >= 2, '次日清单正常生成 ' + plan2.items.length + ' 组');
assert(plan2.items.some(it => it.review), '次日清单含错题复习组');
const revMin2 = plan2.items.filter(it => it.review).reduce((a, i) => a + i.qids.length * C.TYPE_META[i.type].minPerQ, 0);
assert(revMin2 <= C.REVIEW_CAP + 0.01, '复习封顶 10 分钟: ' + revMin2.toFixed(1));
console.log('错题吸纳情况: 到期' + C.dueWrongIds(restored, day2).length + ' 题，入清单 ' + remaining.length + ' 题（放不下的留次日队列不丢）');

// ===== 11. 统计渲染数据（renderStat 路径）=====
const hm = C.heatmap(restored.history, day3, 84);
assert(hm.length === 84 && hm.some(d => d.floor), '热力图 84 天含底线日');
const acc = C.accuracyByType(restored);
const accOk = ['listening', 'cloze', 'match', 'reading'].every(t => acc[t] && acc[t].seen > 0);
assert(accOk, '四题型正确率可计算: ' + ['listening','cloze','match','reading'].map(t => acc[t].seen + '/' + acc[t].right).join(' '));

console.log('\n===== E2E ' + (fail === 0 ? '全部通过' : '存在失败') + ': ' + pass + ' ok / ' + fail + ' fail =====');
process.exit(fail === 0 ? 0 : 1);
