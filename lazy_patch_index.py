# -*- coding: utf-8 -*-
"""按需加载（架构级）：index.html 批量字面替换补丁（不使用正则，逐字匹配文件原文）"""
import io, sys

p = r'D:\CET6\app\index.html'
raw = open(p, 'rb').read()
has_bom = raw.startswith(b'\xef\xbb\xbf')
s = raw.decode('utf-8-sig')  # 去掉 BOM 后按 UTF-8 严格解码

reps = []

# R1: 76 个卷 script 标签 -> meta.js
reps.append((
'''<script src="core.js"></script>
  <script src="bank/cet6-2015-06-1.js"></script>
  <script src="bank/cet6-2015-06-2.js"></script>
  <script src="bank/cet6-2015-06-3.js"></script>
  <script src="bank/cet6-2015-12-1.js"></script>
  <script src="bank/cet6-2015-12-2.js"></script>
  <script src="bank/cet6-2015-12-3.js"></script>
  <script src="bank/cet6-2016-06-1.js"></script>
  <script src="bank/cet6-2016-06-2.js"></script>
  <script src="bank/cet6-2016-06-3.js"></script>
  <script src="bank/cet6-2016-12-1.js"></script>
  <script src="bank/cet6-2016-12-2.js"></script>
  <script src="bank/cet6-2016-12-3.js"></script>
  <script src="bank/cet6-2017-06-1.js"></script>
  <script src="bank/cet6-2017-06-2.js"></script>
  <script src="bank/cet6-2017-06-3.js"></script>
  <script src="bank/cet6-2017-12-1.js"></script>
  <script src="bank/cet6-2017-12-2.js"></script>
  <script src="bank/cet6-2017-12-3.js"></script>
  <script src="bank/cet6-2018-06-1.js"></script>
  <script src="bank/cet6-2018-06-2.js"></script>
  <script src="bank/cet6-2018-06-3.js"></script>
  <script src="bank/cet6-2018-12-1.js"></script>
  <script src="bank/cet6-2018-12-2.js"></script>
  <script src="bank/cet6-2018-12-3.js"></script>
  <script src="bank/cet6-2019-06-1.js"></script>
  <script src="bank/cet6-2019-06-2.js"></script>
  <script src="bank/cet6-2019-06-3.js"></script>
  <script src="bank/cet6-2019-12-1.js"></script>
  <script src="bank/cet6-2019-12-2.js"></script>
  <script src="bank/cet6-2019-12-3.js"></script>
  <script src="bank/cet6-2020-07-1.js"></script>
  <script src="bank/cet6-2020-09-1.js"></script>
  <script src="bank/cet6-2020-09-2.js"></script>
  <script src="bank/cet6-2020-09-3.js"></script>
  <script src="bank/cet6-2020-12-1.js"></script>
  <script src="bank/cet6-2020-12-2.js"></script>
  <script src="bank/cet6-2020-12-3.js"></script>
  <script src="bank/cet6-2021-06-1.js"></script>
  <script src="bank/cet6-2021-06-2.js"></script>
  <script src="bank/cet6-2021-06-3.js"></script>
  <script src="bank/cet6-2021-12-1.js"></script>
  <script src="bank/cet6-2021-12-2.js"></script>
  <script src="bank/cet6-2021-12-3.js"></script>
  <script src="bank/cet6-2022-06-1.js"></script>
  <script src="bank/cet6-2022-06-2.js"></script>
  <script src="bank/cet6-2022-06-3.js"></script>
  <script src="bank/cet6-2022-09-1.js"></script>
  <script src="bank/cet6-2022-09-2.js"></script>
  <script src="bank/cet6-2022-09-3.js"></script>
  <script src="bank/cet6-2022-12-1.js"></script>
  <script src="bank/cet6-2022-12-2.js"></script>
  <script src="bank/cet6-2022-12-3.js"></script>
  <script src="bank/cet6-2023-03-1.js"></script>
  <script src="bank/cet6-2023-03-2.js"></script>
  <script src="bank/cet6-2023-03-3.js"></script>
  <script src="bank/cet6-2023-06-1.js"></script>
  <script src="bank/cet6-2023-06-2.js"></script>
  <script src="bank/cet6-2023-06-3.js"></script>
  <script src="bank/cet6-2023-12-1.js"></script>
  <script src="bank/cet6-2023-12-2.js"></script>
  <script src="bank/cet6-2023-12-3.js"></script>
  <script src="bank/cet6-2024-06-1.js"></script>
  <script src="bank/cet6-2024-06-2.js"></script>
  <script src="bank/cet6-2024-06-3.js"></script>
  <script src="bank/cet6-2024-12-1.js"></script>
  <script src="bank/cet6-2024-12-2.js"></script>
  <script src="bank/cet6-2024-12-3.js"></script>
  <script src="bank/cet6-2025-06-1.js"></script>
  <script src="bank/cet6-2025-06-2.js"></script>
  <script src="bank/cet6-2025-06-3.js"></script>
  <script src="bank/cet6-2025-12-1.js"></script>
  <script src="bank/cet6-2025-12-2.js"></script>
  <script src="bank/cet6-2025-12-3.js"></script>
  <script src="bank/cet6-2026-06-1.js"></script>
  <script src="bank/cet6-2026-06-2.js"></script>
  <script src="bank/cet6-2026-06-3.js"></script>''',
'''<script src="core.js"></script>
  <!-- 按需加载（架构级）：首屏只带元数据骨架（meta.js 440KB ≈ 全量的 1/20），做题/加练时动态加载对应卷（见 ensurePapers） -->
  <script src="bank/meta.js"></script>'''))

# R2: 题库完整性检查区 -> meta 骨架检查 + META_KNOWN
reps.append((
'''  // 题库完整性检查：某个真题卷文件加载失败时不静默缺卷
  var banksComplete = !!window.CET6_BANKS && CET6_BANKS.length >= 76;
  if (!banksComplete) {
    (function () {
      var got = (window.CET6_BANKS || []).length;
      var d = document.createElement('div');
      d.style.cssText = 'background:#fff1f0;border:1px solid #ffa39e;color:#a8071a;padding:8px 12px;font-size:13px';
      d.textContent = '⚠️ 题库只加载了 ' + got + '/76 卷（网络波动），部分考期的卷子暂不可用。刷新页面重试；刷新后仍有此提示请清除浏览器缓存再打开。';
      var first = document.body.firstChild;
      document.body.insertBefore(d, first);
    })();
  }''',
'''  // 题库元数据完整性检查（按需加载）：meta 骨架缺失 = 资源文件加载失败，不让页面带病运行。
  // 卷正文不再随首屏加载（76 卷 → 1 卷 meta），做题时才动态拉取（ensurePapers）。
  var metaComplete = !!window.CET6_META && Array.isArray(window.CET6_META.order) && window.CET6_META.order.length >= 76;
  var META_KNOWN = null;
  if (metaComplete) {
    META_KNOWN = {};
    Object.keys(window.CET6_META.papers || {}).forEach(function (pid) {
      var p = window.CET6_META.papers[pid];
      (p && Array.isArray(p.qLite) ? p.qLite : []).forEach(function (q) { if (q && q.id) META_KNOWN[q.id] = 1; });
    });
  } else {
    (function () {
      var d = document.createElement('div');
      d.style.cssText = 'background:#fff1f0;border:1px solid #ffa39e;color:#a8071a;padding:8px 12px;font-size:13px';
      d.textContent = '⚠️ 题库元数据加载失败（bank/meta.js 缺失或损坏），页面功能不可用。请刷新重试；仍出现请清除浏览器缓存。';
      var first = document.body.firstChild;
      document.body.insertBefore(d, first);
    })();
  }'''))

# R3: pruneGhosts -> meta 版（含 plan 幽灵清理与空组删除）
reps.append((
'''  // 幽灵 qid 清理（M-3）：旧备份/跨版本题库里残留、当前题库已不存在的题号，
  // 会让错题本与 CSV 导出取到 null 而崩。题库没加载全时不清理，避免把"暂时缺卷"的错题误删。
  function pruneGhosts(st) {
    if (!banksComplete) return st;
    Object.keys(st.wrongbook || {}).forEach(function (qid) {
      if (!st.wrongbook[qid] || !C.findQ(BANKS, qid)) delete st.wrongbook[qid];
    });
    return st;
  }''',
'''  // 幽灵 qid 清理（M-3）：旧备份/跨版本题库里残留、当前题库已不存在的题号，
  // 会让错题本与 CSV 导出取到 null 而崩。按需加载下用 meta 骨架判定（meta 含全部 qid），
  // 只有 meta 就绪才清理，避免把"暂时没加载的错题"误删；plan 里的幽灵 qid 与空组一并处理。
  function pruneGhosts(st) {
    if (!metaComplete) return st;
    var known = META_KNOWN;
    Object.keys(st.wrongbook || {}).forEach(function (qid) {
      if (!st.wrongbook[qid] || !known[qid]) delete st.wrongbook[qid];
    });
    if (st.plan && Array.isArray(st.plan.items)) {
      st.plan.items.forEach(function (it) {
        if (!it || !Array.isArray(it.qids)) return;
        it.qids = it.qids.filter(function (id) { return known[id]; });
      });
      // 过滤后无题可做的组删除（与 core.normalizeState 同口径；写译组 qids 本来就为空，保留）
      st.plan.items = st.plan.items.filter(function (it) {
        return !!it && (((it.qids && it.qids.length) || it.type === 'writing' || it.type === 'translation'));
      });
    }
    return st;
  }'''))

# R4: loadState 传参
reps.append((
'''    state = pruneGhosts(C.loadState(store, STATE_KEY, banksComplete ? BANKS : null));''',
'''    state = pruneGhosts(C.loadState(store, STATE_KEY, null)); // 幽灵清理统一由 pruneGhosts（meta 版）承担'''))

# R5: ensurePlan genPlan -> META
reps.append((
'''    if (!state.plan || typeof state.plan !== 'object' || !Array.isArray(state.plan.items) ||
        state.plan.date !== today || state.plan.v !== (C.PLAN_VERSION || 2)) {
      state.plan = C.genPlan(state, BANKS, today);
      save();
    }''',
'''    if (!state.plan || typeof state.plan !== 'object' || !Array.isArray(state.plan.items) ||
        state.plan.date !== today || state.plan.v !== (C.PLAN_VERSION || 2)) {
      // 按需加载：清单生成只用元数据骨架（units/qLite 已固化在 meta.js），与卷正文加载状态无关
      state.plan = META ? C.genPlan(state, META, today)
        : { date: today, v: (C.PLAN_VERSION || 2), items: [] };
      save();
    }'''))

# R6: extraGroup -> META
reps.append((
'''        var g = C.extraGroup(state, BANKS, today, t);''',
'''        var g = C.extraGroup(state, META, today, t); // 按需加载：加练抽题只用 meta 骨架'''))

# R7: startItem 异步化（按需加载）
reps.append((
'''    lastFocus = document.activeElement; // P1-b：记住触发浮层的元素，关闭时还回去
    $('quiz').classList.add('show');
    bgInert(true); // P1-b：背景整块 inert + aria-hidden，Tab 不再逃到被浮层遮住的按钮上
    renderGroup();
    quizFocusFirst(); // P1-b：渲染完再把焦点移进浮层（渲染前浮层里还没有可聚焦元素）
    // 已判分的组进来只是回看：不再计时，也不再累计一次限时统计；
    // 其余情况必须照常启动——断点续做（it.timerLeft）也要从剩余秒数继续倒数，否则红灯不会亮
    if (judged) stopTimer(); else startTimer();
  }''',
'''    lastFocus = document.activeElement; // P1-b：记住触发浮层的元素，关闭时还回去
    $('quiz').classList.add('show');
    bgInert(true); // P1-b：背景整块 inert + aria-hidden，Tab 不再逃到被浮层遮住的按钮上
    $('quizProg').textContent = '加载题库…';
    $('quizBody').innerHTML = '<div class="card"><div class="empty">正在加载本组题目所需题库卷…</div></div>';
    // 按需加载（架构级）：先确保本组涉及的卷已动态加载（本地/SW 缓存即拿），再渲染；
    // 加载期间用户退出（session 已置空）则不再继续渲染
    ensureItemReady(it, function () {
      if (session !== s) return;
      renderGroup();
      quizFocusFirst(); // P1-b：渲染完再把焦点移进浮层（渲染前浮层里还没有可聚焦元素）
      // 已判分的组进来只是回看：不再计时，也不再累计一次限时统计；
      // 其余情况必须照常启动——断点续做（it.timerLeft）也要从剩余秒数继续倒数，否则红灯不会亮
      if (judged) stopTimer(); else startTimer();
    });
  }'''))

# R8: paperForItem null 兜底
reps.append((
'''    if (it.qids && it.qids.length) return C.findPaper(BANKS, it.qids[0]);
    return BANKS[0];
  }''',
'''    if (it.qids && it.qids.length) return C.findPaper(BANKS, it.qids[0]);
    return BANKS[0] || null;
  }'''))

# R9: renderWrong 异步化
reps.append((
'''  // ---------- 错题本（遗忘曲线智能调度）----------
  function renderWrong() {
    var due = C.reviewQueue(state, BANKS, today); // 智能排序：逾期越久、错次越多、记忆越弱越靠前
    var all = C.allWrongIds(state);
    var sum = C.wrongSummary(state, today);
    var overTxt = sum.overdue ? '，其中逾期 ' + sum.overdue + ' 题（最久 ' + sum.maxOverdue + ' 天）' : '';
    $('wrongSummary').textContent = '共 ' + sum.total + ' 题在库 · 今日到期 ' + sum.due + ' 题' + overTxt +
      (sum.total ? ' · 平均复习间隔 ' + sum.avgIv + ' 天' : '');
    var dl = $('dueList');''',
'''  // ---------- 错题本（遗忘曲线智能调度）----------
  function renderWrong() {
    // 按需加载：错题行渲染需要题干（卷正文），先把涉及卷拉齐再画；已加载的卷直接同步完成
    ensurePapers(papersOfQids(C.allWrongIds(state)), function () { renderWrongInner(); });
  }
  function renderWrongInner() {
    var due = C.reviewQueue(state, BANKS, today); // 智能排序：逾期越久、错次越多、记忆越弱越靠前
    var all = C.allWrongIds(state);
    var sum = C.wrongSummary(state, today);
    var overTxt = sum.overdue ? '，其中逾期 ' + sum.overdue + ' 题（最久 ' + sum.maxOverdue + ' 天）' : '';
    $('wrongSummary').textContent = '共 ' + sum.total + ' 题在库 · 今日到期 ' + sum.due + ' 题' + overTxt +
      (sum.total ? ' · 平均复习间隔 ' + sum.avgIv + ' 天' : '');
    var dl = $('dueList');'''))

# R10: startWrongSession 异步化
reps.append((
'''  function startWrongSession(ids) {
    // 做题顺序按（卷从近到远，卷内题号升序）排：同卷同材料相邻，
    // 整组同屏渲染时材料/音频只出现一次；选题本身仍由「智能复习」按薄弱优先决定
    ids = ids.slice().sort(function (a, b) {
      var pa = C.findPaper(BANKS, a), pb = C.findPaper(BANKS, b);
      if (!pa || !pb) return 0;
      if (pa.id !== pb.id) return pa.id < pb.id ? 1 : -1;
      return C.findQ(BANKS, a).qno - C.findQ(BANKS, b).qno;
    });
    var byType = {};
    ids.forEach(function (id) { var t = C.findQ(BANKS, id).type; (byType[t] = byType[t] || []).push(id); });
    // 混合题型组：renderGroup 会按题型/材料自动分段渲染
    var first = Object.keys(byType)[0];
    var item = { key: 'wrong-review', type: first, qids: byType[first], done: false, minutes: 0, isWrong: true };
    Object.keys(byType).forEach(function (t) { if (t !== first) item.qids = item.qids.concat(byType[t]); });
    startItem(item);
  }''',
'''  function startWrongSession(ids) {
    // 按需加载：先确保错题所在卷已加载（排序/分组需要卷与题数据），再开练
    ensurePapers(papersOfQids(ids), function (ok) {
      if (!ok) { toast('题库卷加载失败，请检查网络后重试'); return; }
      // 做题顺序按（卷从近到远，卷内题号升序）排：同卷同材料相邻，
      // 整组同屏渲染时材料/音频只出现一次；选题本身仍由「智能复习」按薄弱优先决定
      ids = ids.slice().sort(function (a, b) {
        var pa = C.findPaper(BANKS, a), pb = C.findPaper(BANKS, b);
        if (!pa || !pb) return 0;
        if (pa.id !== pb.id) return pa.id < pb.id ? 1 : -1;
        return C.findQ(BANKS, a).qno - C.findQ(BANKS, b).qno;
      });
      var byType = {};
      ids.forEach(function (id) { var t = C.findQ(BANKS, id).type; (byType[t] = byType[t] || []).push(id); });
      // 混合题型组：renderGroup 会按题型/材料自动分段渲染
      var first = Object.keys(byType)[0];
      var item = { key: 'wrong-review', type: first, qids: byType[first], done: false, minutes: 0, isWrong: true };
      Object.keys(byType).forEach(function (t) { if (t !== first) item.qids = item.qids.concat(byType[t]); });
      startItem(item);
    });
  }'''))

# R11: startPointSession -> META + ensure
reps.append((
'''  // P3 薄弱考点专项练：错题优先 + 新题补充，最多 6 题一组，直接开练（不入今日清单）
  function startPointSession(pt) {
    var ids = C.pointIds(BANKS, pt).filter(function (id) {
      return state.wrongbook[id] || !state.papers[id]; // 在库错题或从未做过的题；做对并出库的不再重复练
    });
    if (!ids.length) { toast('该考点可练的题都做完了，去练别的考点吧'); return; }
    ids.sort(function (a, b) {
      var wa = state.wrongbook[a] ? 1 : 0, wb = state.wrongbook[b] ? 1 : 0;
      if (wa !== wb) return wb - wa; // 错题排最前
      var pa = C.findPaper(BANKS, a), pb = C.findPaper(BANKS, b);
      if (pa.id !== pb.id) return pa.id < pb.id ? 1 : -1;
      return C.findQ(BANKS, a).qno - C.findQ(BANKS, b).qno;
    });
    ids = ids.slice(0, 6);
    var types = {};
    ids.forEach(function (id) { var t = C.findQ(BANKS, id).type; types[t] = (types[t] || 0) + 1; });
    var type = Object.keys(types).sort(function (a, b) { return types[b] - types[a]; })[0];
    startItem({ key: 'point-' + pt, type: type, qids: ids, done: false, minutes: 0, isPoint: true, label: '薄弱点专项·' + pt });
  }''',
'''  // P3 薄弱考点专项练：错题优先 + 新题补充，最多 6 题一组，直接开练（不入今日清单）
  function startPointSession(pt) {
    var ids = C.pointIds(META, pt).filter(function (id) { // 按需加载：选题只用 meta 骨架
      return state.wrongbook[id] || !state.papers[id]; // 在库错题或从未做过的题；做对并出库的不再重复练
    });
    if (!ids.length) { toast('该考点可练的题都做完了，去练别的考点吧'); return; }
    ids = ids.slice(0, 6);
    ensurePapers(papersOfQids(ids), function (ok) {
      if (!ok) { toast('题库卷加载失败，请检查网络后重试'); return; }
      ids.sort(function (a, b) {
        var wa = state.wrongbook[a] ? 1 : 0, wb = state.wrongbook[b] ? 1 : 0;
        if (wa !== wb) return wb - wa; // 错题排最前
        var pa = C.findPaper(BANKS, a), pb = C.findPaper(BANKS, b);
        if (pa.id !== pb.id) return pa.id < pb.id ? 1 : -1;
        return C.findQ(BANKS, a).qno - C.findQ(BANKS, b).qno;
      });
      var types = {};
      ids.forEach(function (id) { var t = C.findQ(BANKS, id).type; types[t] = (types[t] || 0) + 1; });
      var type = Object.keys(types).sort(function (a, b) { return types[b] - types[a]; })[0];
      startItem({ key: 'point-' + pt, type: type, qids: ids, done: false, minutes: 0, isPoint: true, label: '薄弱点专项·' + pt });
    });
  }'''))

# R12: renderStat 三处
reps.append((
'''    var est = C.estimateScore(state, BANKS);''',
'''    var est = C.estimateScore(state, META); // 估分只依赖 state + 题型权重，与加载状态无关'''))
reps.append((
'''    var byPt = C.accuracyByPoint(state, BANKS);''',
'''    var byPt = C.accuracyByPoint(state, BANKS, META); // 快照优先；旧存档回退 meta 骨架'''))
reps.append((
'''    var wp = C.weakestPoint(state, BANKS, 3);''',
'''    var wp = C.weakestPoint(state, META, 3);'''))

# R13: wrongCsvBtn 异步化
reps.append((
'''  $('wrongCsvBtn').onclick = function () {
    var ids = C.allWrongIds(state).filter(function (id) { return !!C.findQ(BANKS, id) && !!state.wrongbook[id]; });
    if (!ids.length) { toast('错题本是空的，做错题后再来导出'); return; }
    ids.sort(function (a, b) {
      var pa = C.findPaper(BANKS, a), pb = C.findPaper(BANKS, b);
      if (!pa || !pb) return 0; // 幽灵 qid：拿不到卷信息就不比，跳过（M-3）
      if (pa.id !== pb.id) return pa.id < pb.id ? -1 : 1;
      var qa = C.findQ(BANKS, a), qb = C.findQ(BANKS, b);
      if (!qa || !qb) return 0;
      return qa.qno - qb.qno;
    });
    var lines = ['卷号,题号,题型,题干,你的答案,正确答案,考点,错次,下次复习,稳固度'];''',
'''  $('wrongCsvBtn').onclick = function () {
    var ids = C.allWrongIds(state).filter(function (id) { return !!state.wrongbook[id]; });
    if (!ids.length) { toast('错题本是空的，做错题后再来导出'); return; }
    // 按需加载：导出需要题干/答案（卷正文），先确保错题所在卷已加载
    ensurePapers(papersOfQids(ids), function (ok) {
      if (!ok) { toast('题库卷加载失败，无法导出，请检查网络后重试'); return; }
      exportWrongCsv(ids);
    });
  };
  function exportWrongCsv(ids) {
    ids.sort(function (a, b) {
      var pa = C.findPaper(BANKS, a), pb = C.findPaper(BANKS, b);
      if (!pa || !pb) return 0; // 幽灵 qid：拿不到卷信息就不比，跳过（M-3）
      if (pa.id !== pb.id) return pa.id < pb.id ? -1 : 1;
      var qa = C.findQ(BANKS, a), qb = C.findQ(BANKS, b);
      if (!qa || !qb) return 0;
      return qa.qno - qb.qno;
    });
    var lines = ['卷号,题号,题型,题干,你的答案,正确答案,考点,错次,下次复习,稳固度'];'''))

# R14: bankInfo -> META 版
reps.append((
'''  $('bankInfo').innerHTML = BANKS.map(function (b) {
    var qs = b.questions || []; // N-5：缺 questions 字段的脏卷文件不能让整个脚本在启动/备份页就崩
    var cnt = {};
    qs.forEach(function (q) { cnt[q.type] = (cnt[q.type] || 0) + 1; });
    var dist = Object.keys(cnt).map(function (t) { return esc(TYPE_ZH[t] || t) + cnt[t]; }).join(' · ');
    var shared = Object.keys(SHARE_ZH).filter(function (k) { return b[k]; })
      .map(function (k) { return SHARE_ZH[k] + '与 ' + esc(b[k]) + ' 共用'; }).join('，');
    var extra = shared ? '，' + shared + '，未重复收录' : '';
    var head = qs.length ? qs.length + ' 题（' + dist + ' · 写作/翻译各1' + extra + '）'
      : '纯共用卷（客观题全共用：' + (shared || '见同考期第1套') + '，仅写作/翻译独立）';
    return '<div>📦 ' + esc(b.id) + ' — ' + head + '</div>';
  }).join('') + '<div class="muted" style="margin-top:6px">以后新增真题卷：把生成的 bank JS 放入 bank/ 目录，并在本文件末尾加一行 &lt;script src="..."&gt; 即可。</div>';''',
'''  $('bankInfo').innerHTML = (function () {
    if (!META || !META.papers) return '<div class="muted">题库元数据未就绪</div>';
    var papers = META.papers, out = [];
    (META.order || []).forEach(function (id) {
      var p = papers[id];
      if (!p) return;
      var qL = (p.qLite || []).length;
      var cnt = {};
      (p.qLite || []).forEach(function (q) { cnt[q.type] = (cnt[q.type] || 0) + 1; });
      var dist = Object.keys(cnt).map(function (t) { return esc(TYPE_ZH[t] || t) + cnt[t]; }).join(' · ');
      var head = qL ? qL + ' 题（' + dist + ' · 写作/翻译各1）' : '纯共用卷（仅写作/翻译独立）';
      out.push('<div>📦 ' + esc(id) + ' — ' + head + '</div>');
    });
    return out.join('') + '<div class="muted" style="margin-top:6px">共 ' + (META.order || []).length + ' 套真题 · 按需加载：做题时才下载对应卷，首屏体积约为全量的 1/20</div>';
  })();'''))

# R15: 加载器函数（插在 bankInfo 块之后、导航块之前）
reps.append((
'''  // ---------- 导航 ----------
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {''',
'''  // ---------- 按需加载（架构级）：meta 骨架常驻；卷正文按需动态加载 ----------
  var loadedPapers = {};
  function loadPaperScript(pid, cb, onErr) {
    var s = document.createElement('script');
    s.src = 'bank/cet6-' + pid + '.js';
    s.onload = function () { loadedPapers[pid] = 1; cb && cb(); };
    s.onerror = function () { onErr && onErr(pid); };
    document.head.appendChild(s);
  }
  function papersOfQids(qids) {
    var out = {};
    (qids || []).forEach(function (id) { var pid = C.paperIdOf(id); if (pid) out[pid] = 1; });
    return Object.keys(out);
  }
  // 确保一批卷已加载：缺失的按需拉取（本地 file:// 或 SW 缓存即拿）；全部就绪后回调
  function ensurePapers(pids, cb) {
    var need = [];
    pids.forEach(function (pid) { if (pid && !loadedPapers[pid] && need.indexOf(pid) < 0) need.push(pid); });
    if (!need.length) { cb && cb(true); return; }
    var left = need.length, failed = 0;
    toast('正在加载题库卷…');
    need.forEach(function (pid) {
      loadPaperScript(pid, function () { left--; if (!left) cb && cb(failed === 0); },
        function (p2) { failed++; left--; if (!left) cb && cb(false); });
    });
  }
  // 做题前确保本组涉及的卷就绪（客观题组按 qid 求卷；写译/复习组带上 paperId）
  function ensureItemReady(it, cb) {
    var pids = papersOfQids(it.qids || []);
    if (it.paperId) pids.push(it.paperId);
    ensurePapers(pids, function (ok) {
      if (!ok) { toast('题库卷加载失败，请检查网络后重试'); quizExit(); return; }
      cb();
    });
  }

  // ---------- 导航 ----------
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {'''))

# 应用替换（逐字、全部、不区分第几次）
applied = 0
for old, new in reps:
    if old not in s:
        print('MISS: ' + old[:60].replace('\n', '\\n'))
        continue
    cnt = s.count(old)
    s = s.replace(old, new)
    applied += 1
    print('OK(%dx): ' % cnt + old[:50].replace('\n', '\\n'))

out = raw[:3] if has_bom else b''
out += s.encode('utf-8')
open(p, 'wb').write(out)
print('DONE applied=%d/%d bom=%s size=%d' % (applied, len(reps), has_bom, len(out)))
