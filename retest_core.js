'use strict';
/* ============================================================================
   CET6 复测轮 A2：normalizeState / core 纯函数复测（Node，无浏览器）
   运行：cd D:\CET6\scripts ; node retest_core.js
   产物：docs/retest-core-result.json / docs/retest-core-log.txt
   只读：require D:\CET6\app\core.js，不修改任何源文件。
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const C = require(path.join(__dirname, '..', 'app', 'core.js'));

const DOCS = path.join(__dirname, '..', 'docs');
const LINES = [];
const log = (...a) => { const s = a.join(' '); console.log(s); LINES.push(s); };
const R = { cases: [], facts: [], summary: {} };
const pad = n => (n < 10 ? '0' + n : '' + n);
const D = new Date();
const TODAY = D.getFullYear() + '-' + pad(D.getMonth() + 1) + '-' + pad(D.getDate());

/* t(name, group, pass, detail) */
function t(name, group, pass, detail) {
  R.cases.push({ name, group, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${group} · ${name}${detail ? '  → ' + detail : ''}`);
  return pass;
}
/* fact(name, value) —— 记录中性事实（不判定对错） */
function fact(name, value) {
  R.facts.push({ name, value });
  log(`  [fact] ${name} = ${JSON.stringify(value)}`);
}

const S = v => JSON.stringify(v);
const isNum = v => typeof v === 'number' && isFinite(v);

log('CET6 复测 A2 · normalizeState / core 复测  ' + new Date().toISOString());
log('core: ' + path.join(__dirname, '..', 'app', 'core.js') + '\n');

/* ------------------------------------------------------------------ 1. 入口健壮性 */
log('=== 1) normalizeState 入口：非对象存档不抛异常 ===');
[null, undefined, 0, '', 'x', [], [1, 2], true, NaN].forEach((v, i) => {
  let out, err = null;
  try { out = C.normalizeState(v); } catch (e) { err = e.message; }
  t('normalizeState(' + (typeof v === 'string' ? S(v) : String(v)) + ') 返回干净空态', '入口',
    !err && out && out.version === 1 && S(out.history) === '{}' && S(out.papers) === '{}' && S(out.wrongbook) === '{}' && out.plan === null,
    err ? 'THROW: ' + err : S({ h: out.history, p: out.papers, w: out.wrongbook, plan: out.plan }));
});

/* ------------------------------------------------------------------ 2. 类型归一化 */
log('\n=== 2) 数字字段注入字符串/数组/null → 必须变数字 ===');
{
  const evil = {
    version: 1,
    history: { [TODAY]: { minutes: '<img src=x onerror=alert(1)>', done: 'yes', floor: 0, qCount: [5], right: null, timed: '3.5', timedWithin: {}, timedSec: NaN } },
    papers: { ['2026-06-1-r-46']: { seen: '7', right: '<svg onload=alert(1)>', wrong: null, lastAt: 12345678901234, lastResult: 'x', lastAnswer: 42 } },
    wrongbook: { ['2026-06-1-r-46']: { addedAt: {}, box: '2', wrongCount: [9], due: 'not-a-date', ease: 'abc', iv: -5, streak: 'x' } },
    essays: { writing: { lastAt: 1, text: 'ok' }, translation: 'not-an-object' },
    hl: { p: 'not-an-array', q: [1, 'a', { b: 1 }, null] },
    plan: null,
  };
  const out = C.normalizeState(evil);
  const h = out.history[TODAY], p = out.papers['2026-06-1-r-46'], w = out.wrongbook['2026-06-1-r-46'];
  t('history.minutes 恶意字符串 → 数字', '类型', isNum(h.minutes) && h.minutes === 0, S(h.minutes));
  t('history.timed "3.5" → 3.5', '类型', h.timed === 3.5, S(h.timed));
  t('history.qCount [5] → 5', '类型', h.qCount === 5, S(h.qCount));
  t('history.right null → 0', '类型', h.right === 0, S(h.right));
  t('history.timedSec NaN → 0', '类型', h.timedSec === 0, S(h.timedSec));
  t('history.done "yes" → true（布尔强转）', '类型', h.done === true, S(h.done));
  t('history.floor 0 → false', '类型', h.floor === false, S(h.floor));
  t('papers.seen "7" → 7', '类型', p.seen === 7, S(p.seen));
  t('papers.right "<svg onload>" → 0', '类型', p.right === 0, S(p.right));
  t('papers.lastAt 数字 → 字符串并截断 10', '类型', typeof p.lastAt === 'string' && p.lastAt.length <= 10, S(p.lastAt));
  t('papers.lastResult 非法值 → "wrong"', '类型', p.lastResult === 'wrong', S(p.lastResult));
  t('papers.lastAnswer 数字 → 字符串', '类型', typeof p.lastAnswer === 'string' && p.lastAnswer === '42', S(p.lastAnswer));
  t('wrongbook.wrongCount [9] → 9', '类型', w.wrongCount === 9, S(w.wrongCount));
  t('wrongbook.box "2" → 2', '类型', w.box === 2, S(w.box));
  t('wrongbook.due 非法日期 → 回落到今天', '类型', w.due === TODAY, S(w.due));
  t('wrongbook.ease "abc" → 默认 2.5（clamp 1.3~2.8）', '类型', w.ease === 2.5, S(w.ease));
  t('wrongbook.iv -5 → 下限 1', '类型', w.iv === 1, S(w.iv));
  t('essays.writing 保留但 lastAt 数字转字符串', '类型', out.essays.writing && typeof out.essays.writing.lastAt === 'string', S(out.essays.writing));
  t('essays.translation 非对象 → 丢弃', '类型', out.essays.translation === undefined, S(out.essays.translation));
  t('hl 非数组值 → 丢弃该 pid', '类型', out.hl.p === undefined, S(out.hl));
  t('hl 数组内非字符串 → 过滤，仅留 "a"', '类型', Array.isArray(out.hl.q) && out.hl.q.length === 1 && out.hl.q[0] === 'a', S(out.hl.q));
}

/* ------------------------------------------------------------------ 3. 越界字段丢弃 */
log('\n=== 3) 结构非法的字段整体丢弃 ===');
{
  const out = C.normalizeState({
    version: 1,
    history: [1, 2, 3],
    papers: 'not-an-object',
    wrongbook: null,
    essays: [],
    hl: 'x',
    plan: { date: TODAY, v: 3, items: 'not-an-array' },
  });
  t('history 是数组 → 清空', '结构', S(out.history) === '{}', S(out.history));
  t('papers 是字符串 → 清空', '结构', S(out.papers) === '{}', S(out.papers));
  t('wrongbook null → 清空', '结构', S(out.wrongbook) === '{}', S(out.wrongbook));
  t('plan.items 非数组 → plan 置 null', '结构', out.plan === null, S(out.plan));
  t('plan.date 非法 → date 空串（index.html 侧会重算）', '结构',
    C.normalizeState({ version: 1, plan: { date: 'x', v: 3, items: [] } }).plan.date === '', '');
}
{
  const out = C.normalizeState({ version: 1, history: { '2026-13-45': { minutes: 9 }, 'garbage': { minutes: 8 }, [TODAY]: { minutes: 7 } } });
  fact('history 非法日期键 "2026-13-45" 是否被保留', Object.keys(out.history));
  t('history 非日期格式键 "garbage" 被丢弃', '结构', out.history['garbage'] === undefined, '');
}

/* ------------------------------------------------------------------ 4. 长度截断 */
log('\n=== 4) 超长文本截断 ===');
{
  const big = 'A'.repeat(50000);
  const out = C.normalizeState({
    version: 1,
    papers: { ['2026-06-1-r-46']: { seen: 1, right: 1, wrong: 0, lastAt: TODAY, lastResult: 'right', lastAnswer: big } },
    essays: { writing: { lastAt: TODAY, text: big } },
    hl: { p: Array.from({ length: 100 }, () => big) },
    plan: { date: TODAY, v: 3, items: [{ key: big, type: big, label: big, paperId: big, qids: Array.from({ length: 100 }, (_, i) => 'q' + i), done: false, minutes: 0, draft: Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, 'ABCDEFGHIJKLMN'])), timerLeft: 5 }] },
  });
  const it = out.plan.items[0];
  t('papers.lastAnswer 截断到 ≤40', '截断', out.papers['2026-06-1-r-46'].lastAnswer.length <= 40, 'len=' + out.papers['2026-06-1-r-46'].lastAnswer.length);
  t('essays.text 截断到 20000', '截断', out.essays.writing.text.length === 20000, 'len=' + out.essays.writing.text.length);
  t('hl 每段最多 50 条、每条 ≤200', '截断', out.hl.p.length <= 50 && out.hl.p.every(x => x.length <= 200), out.hl.p.length + '×' + out.hl.p[0].length);
  t('plan.label ≤120', '截断', it.label.length <= 120, 'len=' + it.label.length);
  t('plan.key ≤120', '截断', it.key.length <= 120, 'len=' + it.key.length);
  t('plan.type ≤24', '截断', it.type.length <= 24, 'len=' + it.type.length);
  t('plan.paperId ≤24', '截断', it.paperId.length <= 24, 'len=' + it.paperId.length);
  t('plan.qids ≤60 条', '截断', it.qids.length <= 60, 'n=' + it.qids.length);
  t('plan.draft 值 ≤8 字符', '截断', Object.values(it.draft).every(v => v.length <= 8), '');
  t('plan.timerLeft 保留为数字', '截断', it.timerLeft === 5, S(it.timerLeft));
}

/* ------------------------------------------------------------------ 5. plan 语义 */
log('\n=== 5) plan 语义字段保留规则 ===');
{
  const out = C.normalizeState({
    version: 1, plan: {
      date: TODAY, v: 3, items: [
        { key: 'a', type: 'reading', qids: ['x'], label: 'L', done: true, minutes: 3, review: 1, extra: 'yes', isWrong: 1, isPoint: 0, timerLeft: 12, draft: { q: 'A' } },
        'not-an-object', null,
      ]
    }
  });
  const a = out.plan.items[0];
  t('done 保留 true', 'plan', a.done === true, S(a.done));
  t('review/extra/isWrong 标记保留', 'plan', a.review === true && a.extra === true && a.isWrong === true, S(a));
  t('isPoint:0 不写入（仅真值写）', 'plan', a.isPoint === undefined, S(a.isPoint));
  t('draft 保留', 'plan', a.draft && a.draft.q === 'A', S(a.draft));
  t('非对象 item 被过滤（2 个脏项）', 'plan', out.plan.items.length === 1, 'n=' + out.plan.items.length);
  const noTimer = C.normalizeState({ version: 1, plan: { date: TODAY, v: 3, items: [{ key: 'a', type: 'reading', qids: [], label: '', done: false, minutes: 0 }] } }).plan.items[0];
  t('timerLeft 缺省时不写入', 'plan', noTimer.timerLeft === undefined, S(noTimer.timerLeft));
}

/* ------------------------------------------------------------------ 6. __proto__ / constructor 键 */
log('\n=== 6) 原型污染键（__proto__ / constructor）===');
{
  const raw = JSON.parse('{"version":1,"papers":{"__proto__":{"seen":9999,"right":9999,"wrong":0}},"history":{"__proto__":{"minutes":9999}},"hl":{"__proto__":["POLLUTED"]},"wrongbook":{"constructor":{"box":0,"wrongCount":1,"due":"2026-01-01"}}}');
  const out = C.normalizeState(raw);
  fact('normalizeState 后 papers 的自有键', Object.keys(out.papers));
  fact('normalizeState 后 papers.seen（继承值）', out.papers.seen);
  fact('normalizeState 后 history 的自有键', Object.keys(out.history));
  fact('normalizeState 后 history.minutes（继承值）', out.history.minutes);
  fact('全局 Object.prototype 是否被污染', ({}).seen === 9999 || ({}).minutes === 9999);
  t('Object.prototype 未被污染（无全局污染）', '原型', ({}).seen === undefined && ({}).minutes === undefined, '');
  t('papers 保留自有键 0 个（__proto__ 不是自有键）', '原型', Object.keys(out.papers).length === 0, S(Object.keys(out.papers)));
  t('history 保留自有键 0 个', '原型', Object.keys(out.history).length === 0, S(Object.keys(out.history)));
  t('constructor 键会被当作普通 qid 保留（交由 pruneGhosts 清理）', '原型', !!out.wrongbook['constructor'], S(Object.keys(out.wrongbook)));
  // 关键：容器原型被改后，统计函数是否仍稳定
  let crash = null, sum = null;
  try { sum = C.wrongSummary(out, TODAY); C.accuracyByType(out); C.heatmap(out.history, TODAY, 84); C.totalMinutesSafe = null; } catch (e) { crash = e.message; }
  t('容器原型被改后 stats 函数不抛异常', '原型', !crash, crash || S(sum));
}

/* ------------------------------------------------------------------ 7. 日期函数边界 */
log('\n=== 7) 日期函数边界（闰日 / 跨年 / 脏输入）===');
{
  t("addDays('2024-02-28',1) = 2024-02-29（闰年）", '日期', C.addDays('2024-02-28', 1) === '2024-02-29', C.addDays('2024-02-28', 1));
  t("addDays('2024-02-29',1) = 2024-03-01", '日期', C.addDays('2024-02-29', 1) === '2024-03-01', C.addDays('2024-02-29', 1));
  t("addDays('2023-02-28',1) = 2023-03-01（平年）", '日期', C.addDays('2023-02-28', 1) === '2023-03-01', C.addDays('2023-02-28', 1));
  t("addDays('2025-12-31',1) = 2026-01-01（跨年）", '日期', C.addDays('2025-12-31', 1) === '2026-01-01', C.addDays('2025-12-31', 1));
  t("addDays('2026-01-01',-1) = 2025-12-31", '日期', C.addDays('2026-01-01', -1) === '2025-12-31', C.addDays('2026-01-01', -1));
  t("dayDiff('2024-02-28','2024-03-01') = 2", '日期', C.dayDiff('2024-02-28', '2024-03-01') === 2, C.dayDiff('2024-02-28', '2024-03-01'));
  t("dayDiff 跨年 = 365（2025 平年）", '日期', C.dayDiff('2025-01-01', '2026-01-01') === 365, C.dayDiff('2025-01-01', '2026-01-01'));
  fact('addDays 脏输入 "not-a-date" 的返回', C.addDays('not-a-date', 1));
  fact('dayDiff 脏输入返回', C.dayDiff('not-a-date', TODAY));
  fact('语义非法但格式合法 2026-99-99 dayDiff(today)', C.dayDiff('2026-99-99', TODAY));
  t('靠 format 白名单拦住 NaN 日期（normalizeState 后 due 不会是非日期串）', '日期',
    C.normalizeState({ version: 1, wrongbook: { q: { due: 'not-a-date', box: 0, wrongCount: 1 } } }).wrongbook.q.due === TODAY, '');
}

/* ------------------------------------------------------------------ 8. streak / heatmap / 遗忘曲线 */
log('\n=== 8) streak / heatmap / 遗忘曲线 ===');
{
  const H = {};
  ['2026-09-25', '2026-09-26', '2026-09-27'].forEach(d => H[d] = { minutes: 10, done: true, floor: false });
  t('连续 3 天 → streak=3', '统计', C.streak(H, '2026-09-27') === 3, C.streak(H, '2026-09-27'));
  t('今天(09-28)未打卡 → 从昨天 09-27 往前数 =3（27/26/25）', '统计', C.streak(H, '2026-09-28') === 3, C.streak(H, '2026-09-28'));
  t('断档后不累计：09-25 有、09-24 无 → 停在 09-25', '统计', C.streak(H, '2026-09-25') === 1, C.streak(H, '2026-09-25'));
  const H2 = { '2026-09-27': { minutes: 1, done: false, floor: true } };
  t('floor 打卡也算连击', '统计', C.streak(H2, '2026-09-27') === 1, '');
  t('0 天历史 streak=0', '统计', C.streak({}, '2026-09-27') === 0, '');
  t('heatmap 返回 84 格且末格=今天、日期严格递增', '统计', (() => { const hm = C.heatmap(H, '2026-09-27', 84); if (hm.length !== 84 || hm[83].date !== '2026-09-27') return false; for (let i = 1; i < hm.length; i++) if (C.dayDiff(hm[i - 1].date, hm[i].date) !== 1) return false; return true; })(), '首格=' + C.heatmap(H, '2026-09-27', 84)[0].date + ' 末格=' + C.heatmap(H, '2026-09-27', 84)[83].date);
  t('heatmap 末 6 格 = 最近 6 天', '统计', S(C.heatmap(H, '2026-09-27', 6).map(x => x.date)) === S(['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']), S(C.heatmap(H, '2026-09-27', 6).map(x => x.date)));
  t('heatmap 空 history 不抛', '统计', Array.isArray(C.heatmap({}, '2026-09-27')), '');
}
{
  const st = C.newState();
  C.recordResult(st, 'q1', false, '2026-09-01');
  t('答错入错题本 due=次日', '遗忘曲线', st.wrongbook.q1.due === '2026-09-02' && st.wrongbook.q1.wrongCount === 1, S(st.wrongbook.q1));
  let box0 = st.wrongbook.q1.box;
  for (let i = 0; i < 5; i++) C.recordResult(st, 'q1', true, '2026-09-0' + (2 + i));
  t('连对 5 次毕业出库', '遗忘曲线', st.wrongbook.q1 === undefined, S(st.wrongbook));
  const st2 = C.newState();
  C.recordResult(st2, 'q2', false, '2026-09-01');
  C.recordResult(st2, 'q2', false, '2026-09-02');
  t('反复答错 wrongCount 累加、ease 下降不低于 1.3', '遗忘曲线', st2.wrongbook.q2.wrongCount === 2 && st2.wrongbook.q2.ease >= 1.3, S(st2.wrongbook.q2));
  t('dueWrongIds 只返回到期题', '遗忘曲线', C.dueWrongIds(st2, '2026-09-03').length === 1 && C.dueWrongIds(st2, '2026-09-01').length === 0, S(C.dueWrongIds(st2, '2026-09-03')));
  t('reviewQueue 空库不抛', '遗忘曲线', C.reviewQueue(C.newState(), [], TODAY).length === 0, '');
  t('wrongSummary 空库全 0', '遗忘曲线', (() => { const s = C.wrongSummary(C.newState(), TODAY); return s.total === 0 && s.due === 0 && s.avgIv === 0; })(), S(C.wrongSummary(C.newState(), TODAY)));
  const st3 = C.newState();
  st3.wrongbook.q3 = null; st3.papers.q3 = null;
  t('空错题条目（null）不参与统计也不抛', '遗忘曲线', (() => { try { return C.wrongSummary(st3, TODAY).total === 0 && C.dueWrongIds(st3, TODAY).length === 0 && C.accuracyByType(st3) && Object.keys(C.accuracyByType(st3)).length === 0; } catch (e) { return false; } })(), '');
}
/* 全对 / 全错 */
{
  /* 注意：这里原来用 'a' / 'b' / 'c' 这种假 qid，并断言它们全部落进 reading——
     那实际上是把 accuracyByType 的"认不出就当阅读"静默误分类当成了预期行为。
     core.js 已改为显式字母映射（l/c/m/r → 题型，其余 → unknown），故：
       ① 本条改用真实形状的 qid，验证"阅读题正确率"这个真实语义；
       ② 下面单独补两条，把字母映射与 unknown 兜底也锁死。              */
  const RQ = ['2015-06-1-r-46', '2015-06-1-r-47', '2015-06-1-r-48'];
  const st = C.newState();
  RQ.forEach(q => C.recordResult(st, q, true, TODAY));
  t('全对：错题本为空、正确率 100%', '边界', C.allWrongIds(st).length === 0 && C.accuracyByType(st).reading.seen === 3 && C.accuracyByType(st).reading.right === 3, S(C.accuracyByType(st)));
  const st2 = C.newState();
  RQ.forEach(q => C.recordResult(st2, q, false, TODAY));
  t('全错：错题本 3 题、正确率 0%', '边界', C.allWrongIds(st2).length === 3 && C.accuracyByType(st2).reading.right === 0, '');

  // 字母 → 题型 一一对应（实测题库：l 听力 / c 选词填空 / m 信息匹配 / r 仔细阅读）
  const st4 = C.newState();
  ['2015-06-1-l-1', '2015-06-1-c-1', '2015-06-1-m-1', '2015-06-1-r-1'].forEach(q => C.recordResult(st4, q, true, TODAY));
  const by4 = C.accuracyByType(st4);
  t('qid 第 4 段字母 → 四类题型映射正确', '边界',
    !!by4.listening && !!by4.cloze && !!by4.match && !!by4.reading &&
    by4.listening.seen === 1 && by4.cloze.seen === 1 && by4.match.seen === 1 && by4.reading.seen === 1 && !by4.unknown, S(by4));

  // 认不出的 qid（导入被篡改的备份即可塞入）必须落 unknown，不得虚增 reading
  const st5 = C.newState();
  ['垃圾key', '2026-06-1-x-9', 'no-dashes'].forEach(q => C.recordResult(st5, q, true, TODAY));
  const by5 = C.accuracyByType(st5);
  t('认不出的 qid 落 unknown，不再静默计入 reading', '边界',
    !!by5.unknown && by5.unknown.seen === 3 && !by5.reading, S(by5));
  t('unknown 不进入 estimateScore 的四类加权（不虚增客观题得分）', '边界',
    (() => { const e = C.estimateScore(st5, []); return e.covered === false && e.score === 0; })(), S(C.estimateScore(st5, [])));
  t('空 state：estimateScore 覆盖 false 不抛', '边界', (() => { const e = C.estimateScore(C.newState(), []); return e.score === 0 && e.covered === false; })(), '');
  t('空 state：weakestPoint 返回 null', '边界', C.weakestPoint(C.newState(), [], 3) === null, '');
  t('accuracyByPoint 空库不抛', '边界', Object.keys(C.accuracyByPoint(C.newState(), [])).length === 0, '');
}
/* 同一天重复打卡 */
{
  const st = C.newState();
  C.recordResult(st, 'q1', false, TODAY);
  C.recordResult(st, 'q1', false, TODAY);
  t('同一天重复作答：seen=2、wrongCount=2（不去重，符合设计）', '边界', st.papers.q1.seen === 2 && st.wrongbook.q1.wrongCount === 2, S({ p: st.papers.q1, w: st.wrongbook.q1 }));
}
/* 负数/极端数值 */
{
  const out = C.normalizeState({ version: 1, history: { [TODAY]: { minutes: -100, qCount: 1e9 } }, papers: { q: { seen: -5, right: 0, wrong: 0 } } });
  fact('负数 minutes 是否被 clamp', out.history[TODAY].minutes);
  fact('负数 seen 是否被 clamp', out.papers.q.seen);
  fact('1e9 qCount 是否被 clamp', out.history[TODAY].qCount);
}

/* ------------------------------------------------------------------ 9. esc 等价性（index.html 内联实现复刻） */
log('\n=== 9) esc() 覆盖范围（与 index.html:440 同实现，验证属性上下文安全性）===');
{
  // B1：从生产源码 index.html 提取 esc 真身并求值，杜绝"测副本"。
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const em = htmlSrc.match(/function\s+esc\s*\([^)]*\)\s*\{[^\n]*\}/);
  let esc;
  if (!em) { t('esc 定义能从 index.html 提取', 'esc', false, '未匹配到 function esc'); }
  else {
    try { esc = eval(em[0] + '; esc'); }
    catch (e) { t('esc 定义可求值', 'esc', false, String(e)); }
  }
  if (!esc) { /* skip */ } else {
  t('esc 转义 & < > "', 'esc', esc('&<>"') === '&amp;&lt;&gt;&quot;', esc('&<>"'));
  t("esc 转义单引号为 &#39;（与 index.html:536 真身一致）", 'esc', esc("'") === '&#39;', esc("'"));
  t('esc 处理 null/undefined/number', 'esc', esc(null) === '' && esc(undefined) === '' && esc(5) === '5', '');
  const sq = "'><img src=x onerror=alert(1)>";
  const attr = '<div data-x="' + esc(sq) + '">';
  t('双引号属性 + esc 后无法逃逸（无裸 > 出现在属性内）', 'esc', !/data-x="[^"]*"[^>]*<img/.test(attr), attr.slice(0, 80));
  }
}

/* ------------------------------------------------------------------ 10. 幽灵 qid（core 不做题库校验） */
log('\n=== 10) 幽灵 qid：core 层不做题库校验，需 index.html 的 pruneGhosts 兜底 ===');
{
  const out = C.normalizeState({ version: 1, wrongbook: { 'does-not-exist-9999': { box: 0, wrongCount: 1, due: TODAY }, '2026-06-1-r-46': { box: 0, wrongCount: 1, due: TODAY } } });
  t('normalizeState 保留题库不存在的 qid（core 不依赖题库）', '幽灵', !!out.wrongbook['does-not-exist-9999'], S(Object.keys(out.wrongbook)));
  t('findQ 对幽灵 qid 返回 null（调用方必须守卫）', '幽灵', C.findQ([], 'does-not-exist-9999') === null, '');
  t('findPaper 对幽灵 qid 返回 null', '幽灵', C.findPaper([], 'does-not-exist-9999') === null, '');
  t('allWrongIds 会带出幽灵 qid（导出前必须再过滤）', '幽灵', C.allWrongIds(out).indexOf('does-not-exist-9999') >= 0, S(C.allWrongIds(out)));
}

/* ------------------------------------------------------------------ 汇总 */
const failed = R.cases.filter(c => !c.pass);
R.summary = { total: R.cases.length, pass: R.cases.length - failed.length, fail: failed.length, failed: failed.map(f => f.group + ' · ' + f.name + ' → ' + f.detail) };
log('\n================ 汇总 ================');
log(`  断言 ${R.summary.total} 条：通过 ${R.summary.pass}，失败 ${R.summary.fail}`);
failed.forEach(f => log('   ✗ ' + f.group + ' · ' + f.name + '  → ' + f.detail));
log(`  中性事实 ${R.facts.length} 条（见 retest-core-result.json）`);

try {
  fs.writeFileSync(path.join(DOCS, 'retest-core-result.json'), JSON.stringify(R, null, 2), 'utf8');
  fs.writeFileSync(path.join(DOCS, 'retest-core-log.txt'), LINES.join('\n'), 'utf8');
  log('\n已写出 docs/retest-core-result.json 与 docs/retest-core-log.txt');
} catch (e) { log('\n(写结果文件失败，不影响断言结论: ' + e.code + ')'); }
process.exitCode = failed.length ? 1 : 0;
