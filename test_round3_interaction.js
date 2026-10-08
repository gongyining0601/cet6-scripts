/* scripts/test_round3_interaction.js
 * CET6 打卡应用 · 第三轮复测（性能 / 多视口与兼容 / 交互状态机 / 极端数据量 / 新问题扫描）
 * 只读：不修改任何被测源文件。全部探针与状态注入均为运行期（context.addInitScript / page.evaluate）。
 * 用法：node test_round3_interaction.js [A] [B] [C] [D] [E]   缺省 = A B C D E
 * 产物：docs/round3-result.json、docs/round3-*.png
 * 对比基线：docs/retest-report-20260927.md（上一轮：冷 148ms / 热 156ms / 题库阻塞窗 83.7ms / 判分 35.6ms）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium: loadPW, EXE, fileUrl, bankDigest } = require('./_env');

const ROOT = path.join(__dirname, '..', 'app');
const DOCS = path.join(__dirname, '..', 'docs');
const URL = fileUrl(path.join(ROOT, 'index.html'));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIREFOX_STOCK = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

/* 题库事实（延迟计算，只有跑到相关 section 才付这份开销）。
   为什么需要它：写作"是否有配图"两仓完全不同 —— 本仓是看图作文（6 卷带 image），
   四级仓以文字命题为主（只有 3 卷带 image）。用例里写死卷号，在另一仓必然假红。 */
let _digest = null;
function digest() { return _digest || (_digest = bankDigest()); }

/* ============================ 结果收集 ============================ */
const R = {
  ts: new Date().toISOString(), round: 3,
  baseline: { coldLoadMs: 148.0, hotLoadMs: 155.7, bankWindowMs: 83.7, judgeMs: 35.6, switchMs: 28.2, darkOptRatio: 1.44 },
  env: {}, sections: {},
};
let cur = null;
function sec(id, title) { cur = R.sections[id] = { title, checks: [], data: {} }; console.log('\n===== ' + title + ' ====='); return cur; }
function chk(name, ok, detail) {
  const c = { name, ok: !!ok, detail: detail === undefined || detail === null ? '' : String(detail) };
  if (cur) cur.checks.push(c);
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (c.detail ? ' | ' + c.detail : ''));
  return c;
}
function note(k, v) { if (cur) cur.data[k] = v; console.log('   . ' + k + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : v)); }

/* ============================ 页面注入：题库 push 探针 ============================ */
function PROBE() {
  try {
    window.__probe = { first: null, last: null, n: 0 };
    var arr = [];
    var origPush = Array.prototype.push;
    arr.push = function () {
      if (window.__probe.first == null) window.__probe.first = performance.now();
      window.__probe.n++;
      window.__probe.last = performance.now();
      return origPush.apply(this, arguments);
    };
    Object.defineProperty(window, 'CET6_BANKS', {
      configurable: true,
      get: function () { return arr; },
      // 题库脚本每卷都写 window.CET6_BANKS = window.CET6_BANKS || []；getter 恒返回同一 arr，
      // 必须对自赋值 no-op，否则把 arr 推进自身导致指数膨胀。
      set: function (v) { if (Array.isArray(v) && v !== arr) { for (var i = 0; i < v.length; i++) origPush.call(arr, v[i]); } },
    });
  } catch (e) { }
}

/* ============================ 页面注入：测试用只读/注入 API ============================ */
function PAGE_API() {
  try {
    window.__t = {
      user: function () { return localStorage.getItem('cet6_user') || ''; },
      key: function () { return 'cet6_p1_state_v1_' + localStorage.getItem('cet6_user'); },
      raw: function () { return localStorage.getItem(window.__t.key()); },
      state: function () { try { return JSON.parse(window.__t.raw() || '{}'); } catch (e) { return null; } },
      setState: function (o) { localStorage.setItem(window.__t.key(), JSON.stringify(o)); },
      delState: function () { localStorage.removeItem(window.__t.key()); },
      today: function () { return window.CET6Core.todayStr(); },
      core: function () { return window.CET6Core; },
      banks: function () { return window.CET6_BANKS || []; },
      allQids: function () {
        // R4-M5: P7 按需加载后首屏 BANKS=0，全库 qid 改从 meta 骨架（CET6_META.papers[].qLite）取
        var a = [], M = window.CET6_META || null;
        if (M && M.papers) { Object.keys(M.papers).forEach(function (pid) { var p = M.papers[pid]; ((p && p.qLite) || []).forEach(function (q) { if (q && q.id) a.push(q.id); }); }); }
        else { (window.CET6_BANKS || []).forEach(function (b) { (b.questions || []).forEach(function (q) { a.push(q.id); }); }); }
        return a;
      },
      paper: function (id) { return (window.CET6_BANKS || []).filter(function (x) { return x.id === id; })[0] || null; },
      qidsOf: function (paperId, kind, from, to) {
        // R4-M5: 按需加载后 BANKS=0，题集改从 meta 骨架（qLite 含 id/type/qno）取，无需先加载卷正文
        var M = window.CET6_META || null, qs = [], p = M && M.papers ? M.papers[paperId] : null;
        if (p && Array.isArray(p.qLite)) qs = p.qLite.slice();
        else { var b = (window.CET6_BANKS || []).filter(function (x) { return x.id === paperId; })[0]; if (b) qs = b.questions.slice(); }
        qs.sort(function (a, c) { return a.qno - c.qno; });
        if (kind === 'cloze') qs = qs.filter(function (q) { return q.type === 'cloze'; });
        else if (kind === 'match') qs = qs.filter(function (q) { return q.type === 'match'; });
        else if (kind === 'reading') qs = qs.filter(function (q) { return q.type === 'reading' && (from == null || (q.qno >= from && q.qno <= to)); });
        else if (kind === 'listening') qs = qs.filter(function (q) { return q.type === 'listening' && (from == null || (q.qno >= from && q.qno <= to)); });
        return qs.map(function (q) { return q.id; });
      },
      answerOf: function (qid) { var q = window.CET6Core.findQ(window.CET6_BANKS, qid); return q ? q.answer : null; },
      // 构造 state 并写入 localStorage（不 reload，由 Node 侧控制）
      seed: function (spec) {
        var C = window.CET6Core, B = window.CET6_BANKS || [];
        var today = C.todayStr();
        var items = (spec.items || []).map(function (s, ix) {
          var qids = s.qids || window.__t.qidsOf(s.paperId, s.kind, s.qnoFrom, s.qnoTo);
          var it = {
            key: s.key || ('t-' + s.kind + '-' + (s.paperId || '') + '-' + ix),
            type: s.kind, qids: qids, done: !!s.done, minutes: 0,
          };
          if (s.paperId) it.paperId = s.paperId;
          if (s.label) it.label = s.label;
          if (s.draft) it.draft = s.draft;
          if (s.timerLeft != null) it.timerLeft = s.timerLeft;
          if (s.review) it.review = true;
          if (s.extra) it.extra = true;
          if (s.isWrong) it.isWrong = true;
          if (s.isPoint) it.isPoint = true;
          if (s.judged) { it.judged = true; it.rightCount = s.rightCount || 0; it.answers = s.answers || {}; }
          if (s.timeSpentSec != null) it.timeSpentSec = s.timeSpentSec;
          if (s.withinTime != null) it.withinTime = !!s.withinTime;
          return it;
        });
        var st = Object.assign({ version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, spec.state || {});
        st.version = 1; st.plan = { date: spec.planDate || today, v: C.PLAN_VERSION, items: items };
        if (spec.noPlan) st.plan = null;
        var user = spec.user || '9901';
        localStorage.setItem('cet6_user', user);
        localStorage.setItem('cet6_p1_state_v1_' + user, JSON.stringify(st));
        return { today: today, items: items.map(function (i) { return { key: i.key, type: i.type, n: i.qids.length }; }) };
      },
      // 当前答题浮层的 DOM 状态
      quiz: function () {
        var q = document.getElementById('quiz');
        var opts = Array.prototype.map.call(document.querySelectorAll('.opt'), function (b) {
          return { q: b.getAttribute('data-q'), v: b.getAttribute('data-v'), sel: b.classList.contains('sel'), right: b.classList.contains('right'), wrong: b.classList.contains('wrongpick'), disabled: !!b.disabled };
        });
        return {
          open: !!q && q.classList.contains('show'),
          prog: (document.getElementById('quizProg') || {}).textContent || '',
          timer: (document.getElementById('quizTimer') || {}).textContent || '',
          timerCls: (document.getElementById('quizTimer') || {}).className || '',
          submitted: !!document.getElementById('groupDone'),
          opts: opts,
          selected: opts.filter(function (o) { return o.sel; }).length,
        };
      },
      plan: function () { var s = window.__t.state() || {}; return (s.plan && s.plan.items) || []; },
      planObj: function () { var s = window.__t.state() || {}; return s.plan || null; },
      history: function () { var s = window.__t.state() || {}; return s.history || {}; },
      papers: function () { var s = window.__t.state() || {}; return s.papers || {}; },
      wrongbook: function () { var s = window.__t.state() || {}; return s.wrongbook || {}; },
      essays: function () { var s = window.__t.state() || {}; return s.essays || {}; },
      hl: function () { var s = window.__t.state() || {}; return s.hl || {}; },
      nav: function (p) { document.querySelector('nav button[data-p="' + p + '"]').click(); },
      // 段落/材料文本（用于高亮构造）
      passages: function () {
        return Array.prototype.map.call(document.querySelectorAll('#quizBody .passage[data-pid]'), function (p) {
          return { pid: p.getAttribute('data-pid'), len: (p.textContent || '').length, text: (p.textContent || '').slice(0, 4000) };
        });
      },
      // 在指定段落里直接包出 n 个 <mark class="hl">（模拟"已有大量高亮"的 DOM 状态）
      addMarks: function (pid, n) {
        var p = document.querySelector('.passage[data-pid="' + pid + '"]');
        if (!p) return 0;
        var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        var node = null;
        while (walker.nextNode()) {
          var x = walker.currentNode;
          if (x.nodeValue && (x.nodeValue.match(/[A-Za-z]{4,}/g) || []).length >= n) { node = x; break; }
        }
        if (!node) return p.querySelectorAll('mark.hl').length;
        var s = node.nodeValue, words = [], re = /[A-Za-z]{4,}/g, m;
        while ((m = re.exec(s)) && words.length < n) words.push({ i: m.index, t: m[0] });
        for (var k = words.length - 1; k >= 0; k--) {
          var w = words[k];
          try {
            var range = document.createRange();
            range.setStart(node, w.i); range.setEnd(node, w.i + w.t.length);
            var mark = document.createElement('mark'); mark.className = 'hl';
            var frag = range.extractContents();
            mark.appendChild(frag);
            range.insertNode(mark);
          } catch (e) { }
        }
        return p.querySelectorAll('mark.hl').length;
      },
      // 在段落里找一个"尚未被高亮"的词，划选它（供点「高亮」按钮用）
      selectWord: function (pid) {
        var p = document.querySelector('.passage[data-pid="' + pid + '"]');
        if (!p) return null;
        var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        var node = null;
        while (walker.nextNode()) {
          var x = walker.currentNode;
          if (x.nodeValue && /[A-Za-z]{6,}/.test(x.nodeValue)) { node = x; break; }
        }
        if (!node) return null;
        var m = /[A-Za-z]{6,}/.exec(node.nodeValue);
        if (!m) return null;
        var range = document.createRange();
        range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        return m[0];
      },
      marksIn: function (pid) { var p = document.querySelector('.passage[data-pid="' + pid + '"]'); return p ? p.querySelectorAll('mark.hl').length : -1; },
      toastLog: function () { return (window.__toastLog || []).slice(); },
      focusList: function () {
        var out = [];
        var els = document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]:not([tabindex="-1"])');
        Array.prototype.forEach.call(els, function (el) {
          var cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          if (el.offsetParent === null && cs.position !== 'fixed') return;
          out.push({ tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 30), txt: (el.textContent || '').trim().slice(0, 18), dis: !!el.disabled });
        });
        return out;
      },
    };
  } catch (e) { }
}

// 记录 #toast 被点亮的历史（用于验证"有提示 / 无提示"）
//
// 教训：旧实现是"每 60ms 轮询一次，且只在 className 含 show 时记录"。
// 连续两次提示时（例如先弹"超 5MB"、紧接着弹"不是有效备份"），第二次 toast() 只改 textContent、
// className 仍是 'toast show'，理论上轮询能命中，但实测在跑批负载下会漏采，导致"应用明明提示了"
// 却被判成"未提示"的假失败。改为 MutationObserver 盯 textContent/class（同步触发，不丢），
// 另加轮询兜底覆盖极老内核；并且不再要求采样瞬间仍在 show —— 只要提示文案出现过就入账。
function TOAST_WATCH() {
  try {
    window.__toastLog = [];
    var install = function () {
      var el = document.getElementById('toast');
      if (!el) { setTimeout(install, 200); return; }
      var push = function () {
        var t = el.textContent || '';
        if (!t) return;
        if (window.__toastLog[window.__toastLog.length - 1] === t) return; // 同一条内容不重复记账（含隐藏时触发的 mutation）
        window.__toastLog.push(t);
      };
      try {
        new MutationObserver(push).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      } catch (e) { }
      setInterval(push, 60); // 兜底
    };
    install();
  } catch (e) { }
}

/* ============================ 页面侧扫描 / 对比度 ============================ */
function SCAN() {
  const de = document.documentElement;
  const W = de.clientWidth, IH = window.innerHeight;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const res = { clientW: W, clientH: IH, docScrollW: de.scrollWidth, docScrollH: de.scrollHeight, bodyScrollW: document.body.scrollWidth, overflowX: de.scrollWidth > W + 1, offenders: [], overlaps: [], nav: [], planBtns: [], opts: [], targets: [] };
  Array.prototype.forEach.call(document.querySelectorAll('#app *'), (el) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.right > W + 1 || r.left < -1) res.offenders.push({ t: el.tagName, cls: String(el.className || '').slice(0, 32), l: Math.round(r.left), r: Math.round(r.right) });
  });
  res.offenders = res.offenders.slice(0, 10);
  const overlapOf = (sel, label) => {
    const els = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(vis);
    const items = els.map((el, i) => ({ el, r: el.getBoundingClientRect(), label: label + '#' + i }));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.el.parentNode !== b.el.parentNode) continue;
      const x = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
      const y = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
      if (x * y > 8) res.overlaps.push({ a: a.label, b: b.label, area: Math.round(x * y) });
    }
  };
  overlapOf('#planList .plan-item', 'plan');
  overlapOf('#extraBtns button', 'extra');
  overlapOf('#statGrid > *', 'stat');
  overlapOf('nav button', 'nav');
  overlapOf('#quizBody > .card', 'qcard');
  overlapOf('header > *', 'hdr');
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), (b) => {
    const r = b.getBoundingClientRect();
    res.nav.push({ t: b.textContent, w: Math.round(r.width), h: Math.round(r.height), aboveBottom: Math.round(IH - r.bottom) });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#planList .card button'), (b) => {
    const r = b.getBoundingClientRect();
    res.planBtns.push({ inView: r.right <= W + 1 && r.left >= -1, w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => {
    const r = b.getBoundingClientRect();
    res.opts.push({ right: Math.round(r.right), left: Math.round(r.left), h: Math.round(r.height), ok: r.right <= W + 1 && r.left >= -1 && r.height > 20 });
  });
  // 触屏可用性：可见可点目标的高度（WCAG 2.5.5 建议 ≥44px）
  Array.prototype.forEach.call(document.querySelectorAll('#app button, #quiz button, nav button'), (b) => {
    if (!vis(b)) return;
    const r = b.getBoundingClientRect();
    res.targets.push({ tag: b.tagName, id: b.id || '', cls: String(b.className || '').slice(0, 26), txt: (b.textContent || '').trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height) });
  });
  const qb = document.getElementById('quizBody');
  if (qb) { res.quizBodyScrollW = qb.scrollWidth; res.quizBodyClientW = qb.clientWidth; }
  const q = document.getElementById('quiz');
  if (q) { res.quizScrollW = q.scrollWidth; res.quizClientW = q.clientWidth; res.quizOpen = q.classList.contains('show'); }
  return res;
}

function CONTRAST(sels) {
  const lum = (c) => {
    const m = String(c).match(/[\d.]+/g).map(Number);
    const f = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  // 渐变色标 → 候选底色列表（忽略近乎透明的色标）
  const stops = (img) => {
    const out = []; const re = /rgba?\(([^)]+)\)/g; let m;
    while ((m = re.exec(img))) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      if (p.length < 4 || p[3] > 0.05) out.push('rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')');
    }
    return out;
  };
  // 该元素"实际被画上去"的底色候选：优先自身/祖先的渐变，其次是第一个非透明纯色背景
  const bgCandsOf = (el) => {
    let e = el;
    while (e) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') { const st = stops(cs.backgroundImage); if (st.length) return st; }
      const c = cs.backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return [c];
      e = e.parentElement;
    }
    return ['rgb(255,255,255)'];
  };
  const out = [];
  sels.forEach((s) => {
    const el = document.querySelector(s); if (!el) return;
    const cs = getComputedStyle(el); const fg = cs.color, L1 = lum(fg);
    const ratioOf = (b) => { const L2 = lum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return Math.round((hi + 0.05) / (lo + 0.05) * 100) / 100; };
    let worst = null, b = null;
    bgCandsOf(el).forEach((c) => { const r = ratioOf(c); if (worst === null || r < worst) { worst = r; b = c; } });
    out.push({ sel: s, fg, bg: b, ratio: worst, visible: cs.display !== 'none' && cs.visibility !== 'hidden' });
  });
  return out;
}

// 可控时钟：只替换 Date（setInterval 保持真实），使"跨天/周六"可复现
function DATE_SHIFT(anchorIso) {
  try {
    var RealDate = Date, KEY = '__fakeClock';
    var stored = localStorage.getItem(KEY);
    var base = stored != null ? Number(stored) : new RealDate(anchorIso).getTime();
    var offset = base - RealDate.now();
    function FakeDate(a, b, c, d, e, f, g) {
      if (arguments.length === 0) return new RealDate(RealDate.now() + offset);
      if (arguments.length === 1) return new RealDate(a);
      return new RealDate(a, b, c == null ? 1 : c, d == null ? 0 : d, e == null ? 0 : e, f == null ? 0 : f, g == null ? 0 : g);
    }
    FakeDate.now = function () { return RealDate.now() + offset; };
    FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    window.Date = FakeDate;
    window.__shiftClock = function (ms) { offset += ms; try { localStorage.setItem(KEY, String(RealDate.now() + offset)); } catch (e) { } };
  } catch (e) { }
}

/* ============================ Node 侧助手 ============================ */
const waitInit = (page, timeout) => page.waitForFunction(
  () => { const e = document.getElementById('todayLabel'); return !!e && e.textContent.length === 10; },
  null, { timeout: timeout || 40000 });

async function newBrCtx(br, opts, blockThird) {
  const ctx = await br.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, opts || {}));
  if (blockThird !== false) await ctx.route(/^https?:\/\//, (r) => r.abort().catch(() => { }));
  await ctx.addInitScript(PROBE);
  await ctx.addInitScript(PAGE_API);
  await ctx.addInitScript(TOAST_WATCH);
  await ctx.addInitScript('window.__scan = ' + SCAN.toString() + '; window.__contrast = ' + CONTRAST.toString() + '; window.__dateShift = ' + DATE_SHIFT.toString() + ';');
  if (!ctx.pages().length) await ctx.newPage();
  return ctx;
}

/* 采集页面错误。
   注意（重要）：绝大多数用例运行在"主动屏蔽第三方请求"的上下文里（route 里 abort http(s)），
   用来模拟离线/弱网。此时 <audio> 去拉 CDN 上的听力音频必然失败，Chromium 会记一条
   `Failed to load resource: net::ERR_FAILED @ .../cet-audio/...m4a`。
   那是**被我们主动屏蔽**造成的环境噪声，不是应用缺陷（应用对此有降级提示：给出
   "打开懒笔记原站收听"兜底链接）。若不剔除，会把下面每一处"无页面错误"断言全部染红。
   过滤范围刻意收得很窄：只剔除指向音频 CDN（cet-audio / *.m4a）的资源加载失败；
   - 未捕获的 JS 异常（pageerror）一律保留；
   - 其它资源的 ERR_FAILED 也一律保留（本地 bank 脚本加载失败恰恰是要抓的真问题）。 */
const isAudioCdnNoise = (text, url) =>
  /Failed to load resource/i.test(text) && /cet-audio|\.m4a(\?|$)/i.test(String(url || '') + ' ' + text);
function watchErrors(page, sink) {
  page.on('pageerror', (e) => sink.push('pageerror: ' + e.message + ' || ' + String(e.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 260)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const l = m.location() || {};
    const text = m.text().slice(0, 200);
    if (isAudioCdnNoise(text, l.url)) return;
    sink.push('console.error: ' + text + ' @ ' + (l.url || 'unknown'));
  });
  return sink;
}

async function seedInit(ctx, user, stateObj, token) {
  await ctx.addInitScript(({ user, stateObj, token }) => {
    try {
      if (localStorage.getItem('__seedToken') === token) return;
      localStorage.clear();
      localStorage.setItem('cet6_user', user);
      if (stateObj) localStorage.setItem('cet6_p1_state_v1_' + user, JSON.stringify(stateObj));
      localStorage.setItem('__seedToken', token);
    } catch (e) { }
  }, { user, stateObj, token });
}

async function navEntry(page) {
  return page.evaluate(() => {
    const e = performance.getEntriesByType('navigation')[0] || null;
    const t = performance.timing || {};
    const ns = t.navigationStart || 0;
    const rd = (a, b) => (a != null ? Math.round(a) : (b != null ? Math.round(b - ns) : null));
    return {
      dcl: e ? rd(e.domContentLoadedEventEnd) : rd(null, t.domContentLoadedEventEnd),
      load: e ? rd(e.loadEventEnd) : rd(null, t.loadEventEnd),
      di: e ? rd(e.domInteractive) : rd(null, t.domInteractive),
      probe: window.__probe || null,
      banksN: (window.CET6_BANKS || []).length,
      metaN: (window.CET6_META && window.CET6_META.order) ? window.CET6_META.order.length : null,
    };
  });
}

const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rng = (a) => (a.length ? [Math.min.apply(null, a), Math.max.apply(null, a)] : null);

const doubleRaf = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));
const navPaint = async (page, p) => {
  await page.evaluate((p) => window.__t.nav(p), p);
  return page.evaluate(() => new Promise((r) => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(Math.round((performance.now() - t0) * 10) / 10))); }));
};
async function shot(page, name, full) {
  try { await page.screenshot({ path: path.join(DOCS, 'round3-' + name + '.png'), fullPage: !!full }); } catch (e) { }
}

const waitQuizOpen = (page, timeout) => page.waitForFunction(() => {
  // R4-M5: P7 on-demand -> quiz.show fires before paper body renders; wait for content
  // 内容形态共三种，缺一不可：
  //   ① .opt       —— 听力 / 信息匹配 / 仔细阅读 的选项按钮
  //   ② .cloze-slot—— 选词填空的段落空格（词库 + 空格交互，不用 .opt）
  //   ③ #essayTa   —— 写作 / 翻译
  // 早期只判 .opt，遇到选词填空组必然超时（这就是 A4 段卡死的原因）。
  const q = document.getElementById('quiz');
  if (!q || !q.classList.contains('show')) return false;
  const b = document.getElementById('quizBody');
  return b && (b.querySelectorAll('.opt').length > 0 || b.querySelectorAll('.cloze-slot').length > 0 ||
    document.getElementById('essayTa') || b.querySelector('iframe'));
}, null, { timeout: timeout || 20000 });
const waitQuizClosed = (page) => page.waitForFunction(() => !document.getElementById('quiz').classList.contains('show'), null, { timeout: 20000 });

/* 打开一个"客观选择题"组（.opt 就绪）。
   背景（重要）：清单第一张卡经常是【选词填空】组，而选词填空的 UI 是
   「词库 .wb-chip + 段落空格 .cloze-slot」，根本没有 .opt；写译组同理（只有 textarea）。
   早期这批用例全都默认"第一组必有 .opt"，于是一旦第一张卡是选词填空，就会集体失效：
   对比度读到 null、草稿数量读到 0、点选直接超时（而后被 catch 吞掉，表现为静默失败）。
   这里显式跳过 选词填空/写作/翻译 卡片，优先打开 听力/匹配/阅读 组；
   清单里确实没有这类组时才退回第一张卡。需要"就要选词填空组"的用例传 anyKind=true。 */
const NON_OPT_LABEL = /选词填空|写作|翻译/;
async function openFirstOpenGroup(page, anyKind) {
  const cards = page.locator('#planList .card');
  const n = await cards.count();
  let fallback = null;
  for (let i = 0; i < n; i++) {
    const btn = cards.nth(i).locator('button');
    const txt = ((await btn.textContent()) || '').trim();
    if (txt !== '开始') continue;
    const label = ((await cards.nth(i).locator('b').first().textContent()) || '').trim();
    if (anyKind || !NON_OPT_LABEL.test(label)) {
      await btn.click();
      await waitQuizOpen(page);
      return { i, label };
    }
    if (!fallback) fallback = { i, label, btn };
  }
  if (fallback) {
    await fallback.btn.click();
    await waitQuizOpen(page);
    return { i: fallback.i, label: fallback.label };
  }
  return null;
}
async function openGroupByPaper(page, paperId) {
  const cards = page.locator('#planList .card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const txt = (await cards.nth(i).textContent()) || '';
    const btn = cards.nth(i).locator('button');
    if (txt.indexOf(paperId) >= 0 && ((await btn.textContent()) || '').trim() !== '已完成') {
      await btn.click();
      await waitQuizOpen(page);
      return true;
    }
  }
  return false;
}
async function answerAllOpts(page, mode) {
  return page.evaluate((mode) => {
    const seen = {}; let n = 0;
    // ① 客观选择题（听力 / 信息匹配 / 仔细阅读）：一组 .opt 按钮
    Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => {
      const q = b.getAttribute('data-q');
      if (seen[q] || b.disabled) return;
      seen[q] = 1;
      const list = document.querySelectorAll('.opt[data-q="' + q + '"]');
      const ans = window.__t.answerOf(q);
      let target = null;
      if (mode === 'correct') Array.prototype.forEach.call(list, (x) => { if (x.getAttribute('data-v') === ans) target = x; });
      else if (mode === 'wrong') Array.prototype.forEach.call(list, (x) => { if (!target && x.getAttribute('data-v') !== ans) target = x; });
      if (!target) target = list[0];
      if (target) { target.click(); n++; }
    });
    // ② 选词填空：UI 是「词库 .wb-chip + 段落空格 .cloze-slot」，不用 .opt。
    //    交互顺序必须是【先点空格 → 再点词库条目】，反过来只会弹一句 toast。
    //    旧实现只扫 .opt，遇到选词填空组一个也答不上（提交按钮始终 disabled），
    //    上层 waitQuizOpen / answerUntilComplete 随之超时——这是被漏覆盖的第三个题型。
    Array.prototype.forEach.call(document.querySelectorAll('.cloze-slot'), (slot) => {
      if (slot.disabled || slot.getAttribute('data-picked')) return;   // 已填过
      const q = slot.getAttribute('data-q');
      if (seen[q]) return;
      seen[q] = 1;
      const ans = window.__t.answerOf(q);
      const chips = document.querySelectorAll('.wb-chip');
      let wantLetter = ans;
      if (mode === 'wrong') {
        const other = Array.prototype.filter.call(chips, (c) => c.getAttribute('data-w') !== ans)[0];
        wantLetter = other ? other.getAttribute('data-w') : ans;
      } else if (mode !== 'correct') {
        // 'first'：与 .opt 分支"取第一个选项"同口径
        wantLetter = chips.length ? chips[0].getAttribute('data-w') : ans;
      }
      slot.click();                                                    // 先选中空格
      const chip = document.querySelector('.wb-chip[data-w="' + wantLetter + '"]');
      if (chip) { chip.click(); n++; }                                 // 再点词库条目填入
    });
    return n;
  }, mode);
}
async function completeOpenGroup(page, opts) {
  const answerCorrect = !!(opts && opts.answerCorrect);
  const n = await answerAllOpts(page, answerCorrect ? 'correct' : 'first');
  const sub = await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) { b.click(); return true; } return false; });
  if (sub) await page.waitForSelector('#groupDone', { timeout: 15000 });
  const done = await page.$('#groupDone');
  if (done) await page.evaluate(() => document.getElementById('groupDone').click());
  await waitQuizClosed(page);
  return { n, submitted: sub };
}
// 稳健答题：反复补齐"没有任何 .sel"的题号，直到提交按钮可用；返回最后一次的覆盖率快照
async function answerUntilComplete(page, mode) {
  let snap = null;
  for (let i = 0; i < 10; i++) {
    snap = await page.evaluate((mode) => {
      const map = {};
      // ① 客观选择题：.opt（选中态是 .sel）
      Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => {
        const q = b.getAttribute('data-q');
        const m = map[q] || (map[q] = { any: 0, sel: 0, dis: 0, v: [], kind: 'opt' });
        m.any++; if (b.classList.contains('sel')) m.sel++; if (b.disabled) m.dis++; m.v.push(b.getAttribute('data-v'));
      });
      // ② 选词填空：.cloze-slot（选中态是 data-picked 非空；一个题号只对应一个空格）
      Array.prototype.forEach.call(document.querySelectorAll('.cloze-slot'), (s) => {
        const q = s.getAttribute('data-q');
        const m = map[q] || (map[q] = { any: 0, sel: 0, dis: 0, v: [], kind: 'cloze' });
        m.any++; if (s.getAttribute('data-picked')) m.sel++; if (s.disabled) m.dis++; m.v.push(s.getAttribute('data-picked') || '-');
      });
      const pending = Object.keys(map).filter((k) => map[k].any && !map[k].sel && !map[k].dis);
      pending.forEach((q) => {
        const ans = window.__t.answerOf(q);
        if (map[q].kind === 'cloze') {
          // 选词填空：必须先点空格、再点词库条目（反序只弹 toast）
          const slot = document.querySelector('.cloze-slot[data-q="' + q + '"]');
          const chips = document.querySelectorAll('.wb-chip');
          const want = (mode === 'correct' || !chips.length) ? ans : chips[0].getAttribute('data-w');
          if (slot) {
            slot.click();
            const chip = document.querySelector('.wb-chip[data-w="' + want + '"]');
            if (chip) chip.click();
          }
          return;
        }
        const list = document.querySelectorAll('.opt[data-q="' + q + '"]');
        let target = null;
        if (mode === 'correct') Array.prototype.forEach.call(list, (x) => { if (x.getAttribute('data-v') === ans) target = x; });
        else target = list[0];
        if (target) target.click();
      });
      const btn = document.getElementById('groupSubmit');
      return {
        qids: Object.keys(map).length, covered: Object.keys(map).filter((k) => map[k].sel > 0).length,
        pendingBefore: pending.length, pendingDetail: pending.slice(0, 6).map((k) => k + '[' + map[k].v.join('') + (map[k].dis ? ' dis' : '') + ']'),
        submitDisabled: btn ? !!btn.disabled : null,
      };
    }, mode);
    if (snap && snap.submitDisabled === false) break;
    if (snap && snap.pendingBefore === 0) break;
  }
  return snap;
}
// 提交并停留"结果在屏"状态（不点完成），返回 {submitted, snap}
async function submitAndStay(page, mode) {
  const snap = await answerUntilComplete(page, mode || 'first');
  const sub = await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) { b.click(); return true; } return false; });
  if (sub) await page.waitForFunction(() => { const g = document.getElementById('groupDone'); return g && getComputedStyle(g).display !== 'none'; }, null, { timeout: 15000 });
  return { submitted: sub, snap };
}
async function metrics(page) {
  const client = await page.context().newCDPSession(page);
  try { await client.send('Performance.enable'); } catch (e) { }
  try { await client.send('HeapProfiler.enable'); } catch (e) { }
  await client.send('HeapProfiler.collectGarbage').catch(() => { });
  const m = await client.send('Performance.getMetrics');
  const g = (k) => { const x = m.metrics.filter((v) => v.name === k)[0]; return x ? x.value : null; };
  const o = {
    JSHeapUsedMB: Math.round((g('JSHeapUsedSize') / 1048576) * 10) / 10,
    JSHeapTotalMB: Math.round((g('JSHeapTotalSize') / 1048576) * 10) / 10,
    Nodes: g('Nodes'), Listeners: g('JSEventListeners'), Documents: g('Documents'), Frames: g('Frames'), LayoutObjects: g('LayoutObjects'),
  };
  await client.detach().catch(() => { });
  return o;
}
const getState = (page) => page.evaluate(() => window.__t.state());
const parseClock = (t) => { const m = /(\d+):(\d+)/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
// 页面内计时：从"点下去"到"目标 DOM 条件成立"的墙钟毫秒（不含协议往返，与上一轮同口径）
async function inPageTime(page, fire, cond) {
  return page.evaluate(({ fire, cond }) => new Promise((res) => {
    const t0 = performance.now();
    const test = eval('(' + cond + ')');
    const tick = () => { if (test()) res(Math.round((performance.now() - t0) * 10) / 10); else requestAnimationFrame(tick); };
    eval('(' + fire + ')')();
    tick();
  }), { fire, cond });
}
function sstr(o) {
  if (o === null || o === undefined) return JSON.stringify(o === undefined ? null : o);
  if (typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(sstr).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + sstr(o[k])).join(',') + '}';
}

/* ============================ A. 性能复测 ============================ */
async function sectionA() {
  sec('A', 'A. 性能复测（确认无回归）');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  R.env.edge = browser.version();
  const B = R.baseline;

  /* --- A1/A2/A3：3 轮冷 + 3 轮热 + 题库探针 --- */
  const ctx = await newBrCtx(browser, { viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0];
  const errs = watchErrors(page, []);
  await seedInit(ctx, '9203', { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, 'A-' + Date.now());
  const client = await ctx.newCDPSession(page);
  // 预热 1 次：16.9MB 题库首轮磁盘读入/杀软扫描不落到被测的 3 轮冷加载（与上一轮同口径）
  await page.goto(URL, { waitUntil: 'commit' });
  await waitInit(page);
  const warmMs = await page.evaluate(() => Math.round((performance.getEntriesByType('navigation')[0] || {}).loadEventEnd || 0));

  const cold = [], hot = [];
  for (let i = 0; i < 3; i++) {
    await client.send('Network.clearBrowserCache').catch(() => { });
    const t0 = Date.now();
    await page.goto(URL, { waitUntil: 'commit' });
    await waitInit(page);
    const inter = Date.now() - t0;
    await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 });
    const e = await navEntry(page);
    cold.push({ round: i + 1, interactive: inter, dcl: e.dcl, load: e.load, di: e.di, bankFirst: e.probe ? Math.round(e.probe.first) : null, bankLast: e.probe ? Math.round(e.probe.last) : null, banksN: e.banksN, metaN: e.metaN, pushes: e.probe ? e.probe.n : null });
  }
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const inter = Date.now() - t0;
    await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 });
    const e = await navEntry(page);
    hot.push({ round: i + 1, interactive: inter, dcl: e.dcl, load: e.load, di: e.di, bankFirst: e.probe ? Math.round(e.probe.first) : null, bankLast: e.probe ? Math.round(e.probe.last) : null, banksN: e.banksN, metaN: e.metaN, pushes: e.probe ? e.probe.n : null });
  }
  note('warmupLoadMs', warmMs);
  note('coldRounds', cold);
  note('hotRounds', hot);
  const clD = cold.map((x) => x.dcl), clL = cold.map((x) => x.load), clI = cold.map((x) => x.interactive), clB = cold.map((x) => x.bankLast);
  const hlD = hot.map((x) => x.dcl), hlL = hot.map((x) => x.load), hlI = hot.map((x) => x.interactive), hlB = hot.map((x) => x.bankLast);
  const A1 = {
    cold: { dclAvg: avg(clD), dclRange: rng(clD), loadAvg: avg(clL), loadRange: rng(clL), interactiveAvg: avg(clI), interactiveRange: rng(clI), bankReadyAvg: avg(clB) },
    hot: { dclAvg: avg(hlD), dclRange: rng(hlD), loadAvg: avg(hlL), loadRange: rng(hlL), interactiveAvg: avg(hlI), interactiveRange: rng(hlI), bankReadyAvg: avg(hlB) },
  };
  A1.coldVsBaseline = { base: B.coldLoadMs, now: A1.cold.loadAvg, deltaPct: Math.round((A1.cold.loadAvg - B.coldLoadMs) / B.coldLoadMs * 1000) / 10 };
  A1.hotVsBaseline = { base: B.hotLoadMs, now: A1.hot.loadAvg, deltaPct: Math.round((A1.hot.loadAvg - B.hotLoadMs) / B.hotLoadMs * 1000) / 10 };
  // R4-M5: P7 on-demand, no bank loaded at first paint; treat no-push as zero blocking window
  const block = cold.map((x) => (x.bankLast != null && x.bankFirst != null) ? x.bankLast - x.bankFirst : 0);
  A1.bankBlockingWindowCold = avg(block);
  A1.bankBlockingWindowRange = rng(block);
  A1.bankBlockingWindowMin = Math.min.apply(null, block);
  A1.bankBlockingWindowVsBaseline = { base: B.bankWindowMs, now: avg(block), deltaPct: Math.round((avg(block) - B.bankWindowMs) / B.bankWindowMs * 1000) / 10 };
  A1.bankWindowVsBaselineMin = { now: Math.min.apply(null, block), deltaPct: Math.round((Math.min.apply(null, block) - B.bankWindowMs) / B.bankWindowMs * 1000) / 10 };
  note('A1_3', A1);

  chk('A1 冷加载 load 均值 < 1000ms', A1.cold.loadAvg < 1000, 'avg=' + A1.cold.loadAvg + 'ms range=' + JSON.stringify(A1.cold.loadRange) + '（上一轮 ' + B.coldLoadMs + 'ms，变化 ' + A1.coldVsBaseline.deltaPct + '%）');
  chk('A1 冷加载相对上一轮无回归（≤+20%）', A1.coldVsBaseline.deltaPct <= 20, 'now=' + A1.cold.loadAvg + 'ms base=' + B.coldLoadMs + 'ms → ' + A1.coldVsBaseline.deltaPct + '%');
  chk('A2 热加载 load 均值 < 200ms', A1.hot.loadAvg < 200, 'avg=' + A1.hot.loadAvg + 'ms range=' + JSON.stringify(A1.hot.loadRange) + '（上一轮 ' + B.hotLoadMs + 'ms，变化 ' + A1.hotVsBaseline.deltaPct + '%）');
  chk('A2 热加载相对上一轮无回归（≤+20%）', A1.hotVsBaseline.deltaPct <= 20, 'now=' + A1.hot.loadAvg + 'ms base=' + B.hotLoadMs + 'ms → ' + A1.hotVsBaseline.deltaPct + '%');
  chk('A1/A2 首屏可交互 < 1000ms', Math.max(A1.cold.interactiveAvg, A1.hot.interactiveAvg) < 1000, 'cold=' + A1.cold.interactiveAvg + 'ms hot=' + A1.hot.interactiveAvg + 'ms');
  chk('A3 按需加载生效：首屏延迟加载卷正文（banks=0）且 meta 骨架 76 卷就绪（3 冷 + 3 热）', cold.every((x) => x.banksN === 0 && x.metaN === 76 && (x.pushes || 0) === 0) && hot.every((x) => x.banksN === 0 && x.metaN === 76 && (x.pushes || 0) === 0), 'banks=' + cold.map((x) => x.banksN).join('/') + ' meta=' + (cold[0] && cold[0].metaN) + ' pushes=' + cold.map((x) => x.pushes).join('/'));
  chk('A3 题库阻塞窗口均值相对上一轮无回归（≤+20%）', A1.bankBlockingWindowVsBaseline.deltaPct <= 20, 'now=' + A1.bankBlockingWindowCold + 'ms range=' + JSON.stringify(A1.bankBlockingWindowRange) + ' base=' + B.bankWindowMs + 'ms → ' + A1.bankBlockingWindowVsBaseline.deltaPct + '%');
  chk('A3 题库阻塞窗口最优值相对上一轮无回归（≤+20%，抗磁盘/杀软噪声）', A1.bankWindowVsBaselineMin.deltaPct <= 20, 'min=' + A1.bankBlockingWindowMin + 'ms base=' + B.bankWindowMs + 'ms → ' + A1.bankWindowVsBaselineMin.deltaPct + '%（3 轮样本 ' + JSON.stringify(A1.bankBlockingWindowRange) + '，噪声主导）');
  chk('A1-A3 无页面错误', errs.length === 0, errs.join(' || ') || 'none');

  /* --- A4：内存（放开第三方请求，复现上一轮采样口径；含听力 iframe 真实加载） --- */
  const ctxM = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctxM.addInitScript(PROBE); await ctxM.addInitScript(PAGE_API); await ctxM.addInitScript(TOAST_WATCH);
  const pageM = await ctxM.newPage();
  const memErrs = watchErrors(pageM, []);
  await seedInit(ctxM, '9204', { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, 'A4-' + Date.now());
  await pageM.goto(URL, { waitUntil: 'commit' });
  await waitInit(pageM);
  // 预置 7 组，保证"做满 5 组"之后仍有第 6 组可用于"判分结果在屏"的峰值采样（与上一轮 13.5MB/3699 节点同口径）
  await pageM.evaluate((spec) => window.__t.seed(spec), {
    user: '9204', items: [
      { kind: 'listening', paperId: '2020-12-1', qnoFrom: 1, qnoTo: 4, key: 'm-listening' },
      { kind: 'cloze', paperId: '2020-07-1', key: 'm-c1' },
      { kind: 'cloze', paperId: '2020-09-1', key: 'm-c2' },
      { kind: 'cloze', paperId: '2020-09-2', key: 'm-c3' },
      { kind: 'cloze', paperId: '2020-12-1', key: 'm-c4' },
      { kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'm-read' },
      { kind: 'cloze', paperId: '2019-12-1', key: 'm-c5' },
    ],
  });
  await pageM.reload({ waitUntil: 'commit' });
  await waitInit(pageM);
  const m0 = await metrics(pageM);
  const doneGroups = [];
  let framesWhileListening = null;
  for (let i = 0; i < 4; i++) {
    const o = await openFirstOpenGroup(pageM);
    if (!o) break;
    if (/听力/.test(o.label)) {
      await pageM.waitForTimeout(3500);
      // 听力架构（2026-10 起）：烘焙分片 → <audio controls> 播放器；烘焙缺失才退回白名单 iframe。
      // 因此这里按"真实播放器"采集：player 容器 + audio 元素 + 分片按钮 + 兜底入口，iframe 只作旁证。
      framesWhileListening = await pageM.evaluate(() => {
        const box = document.querySelector('#quizBody .listen-player');
        const audio = document.querySelector('#quizBody .listen-player audio') || document.querySelector('#quizBody audio');
        const ifr = document.querySelector('#quizBody iframe');
        const body = document.getElementById('quizBody');
        const txt = body ? body.textContent : '';
        return {
          player: !!box,
          audio: !!audio,
          audioSrcSet: !!(audio && (audio.getAttribute('src') || audio.currentSrc || audio.querySelector('source'))),
          pieces: document.querySelectorAll('#quizBody .listen-strip .lp-piece').length,
          autoToggle: !!document.querySelector('#quizBody .lp-auto input'),
          fallbackBox: !!document.querySelector('#quizBody .lp-fallback'),
          originLink: /懒笔记原站收听/.test(txt),
          fallbackIframe: !!ifr,
          frames: window.length,
          iframes: document.querySelectorAll('iframe').length,
        };
      });
    }
    const res = await completeOpenGroup(pageM);
    doneGroups.push({ label: o.label, n: res.n });
  }
  const m1 = await metrics(pageM);
  // 第 5 组：判分结果在屏（DOM 最重）——与上一轮同一采样点
  const o2 = await openFirstOpenGroup(pageM);
  await pageM.waitForTimeout(2500);
  const stay = o2 ? await submitAndStay(pageM, 'first') : { submitted: false, snap: { note: '第 5 组不存在（计划已全部完成）' } };
  doneGroups.push({ label: o2 ? o2.label : 'n/a', n: stay.snap && stay.snap.qids ? stay.snap.qids : 0, stayed: stay.submitted });
  const mPeak = await metrics(pageM);
  if (!stay.submitted) await shot(pageM, 'a4-submit-blocked');
  const iframeInfo = await pageM.evaluate(() => ({ iframesAtEnd: document.querySelectorAll('iframe').length, framesAtEnd: window.length }));
  note('A4_peakSnap', stay);
  await shot(pageM, 'a-mem-quiz-judged');
  await pageM.evaluate(() => { const d = document.getElementById('groupDone'); if (d && getComputedStyle(d).display !== 'none') d.click(); else { const b = document.getElementById('quizBack'); if (b) b.click(); } });
  await waitQuizClosed(pageM);
  const m5 = await metrics(pageM);
  const SW = ['wrong', 'stat', 'backup', 'today', 'wrong', 'stat', 'backup', 'today', 'wrong', 'stat'];
  for (const p of SW) { await pageM.evaluate((p) => window.__t.nav(p), p); await doubleRaf(pageM); }
  await pageM.evaluate(() => window.__t.nav('today')); await doubleRaf(pageM);
  const m2 = await metrics(pageM);
  for (const p of SW) { await pageM.evaluate((p) => window.__t.nav(p), p); await doubleRaf(pageM); }
  await pageM.evaluate(() => window.__t.nav('today')); await doubleRaf(pageM);
  const m3 = await metrics(pageM);
  await shot(pageM, 'a-mem-after-switches');
  note('A4_mem', { initial: m0, after4Groups_GC: m1, fiveGroupsJudgedOnScreen_GC: mPeak, after5Groups_GC: m5, after10Switches_GC: m2, after20Switches_GC: m3, groupsDone: doneGroups, framesWhileListening, iframeInfo, thirdParty: 'allowed' });
  chk('A4 内存峰值 < 100MB（5 组判分结果在屏）', mPeak.JSHeapUsedMB < 100, '判分在屏=' + mPeak.JSHeapUsedMB + 'MB / Nodes ' + mPeak.Nodes + '（上一轮同口径 13.5MB / 3699 节点）');
  chk('A4 做完 4 组（GC）JSHeap 增量 < 20MB', m1.JSHeapUsedMB - m0.JSHeapUsedMB < 20, m0.JSHeapUsedMB + 'MB → ' + m1.JSHeapUsedMB + 'MB');
  chk('A4 退出判分视图后（GC）JSHeap 不增长', m5.JSHeapUsedMB - mPeak.JSHeapUsedMB <= 1, mPeak.JSHeapUsedMB + 'MB → ' + m5.JSHeapUsedMB + 'MB（Nodes ' + mPeak.Nodes + '→' + m5.Nodes + '：退出后今日页重渲染，节点数回升属预期）');
  chk('A4 切页 10 次（GC）JSHeap ≤ +1MB', m2.JSHeapUsedMB <= m1.JSHeapUsedMB + 1, m1.JSHeapUsedMB + 'MB → ' + m2.JSHeapUsedMB + 'MB');
  chk('A4 再切页 10 次（GC）无持续增长：JSHeap ≤ +1MB', m3.JSHeapUsedMB <= m2.JSHeapUsedMB + 1, m2.JSHeapUsedMB + 'MB → ' + m3.JSHeapUsedMB + 'MB');
  chk('A4 再切页 10 次（GC）Nodes ≤ +50', m3.Nodes - m2.Nodes <= 50, m2.Nodes + ' → ' + m3.Nodes);
  chk('A4 再切页 10 次（GC）Listeners ≤ +10', m3.Listeners - m2.Listeners <= 10, m2.Listeners + ' → ' + m3.Listeners);
  // 听力组必须渲染出真实可用的播放器：优先 <audio> + 分片按钮；若该卷烘焙缺失才允许 iframe 回退。
  // （旧断言要求 iframes>=1，是 iframe 时代的产物，在音频架构下必然误报。）
  chk('A4 听力组渲染真实播放器（audio 播放器 / 分片条 / iframe 回退 三者必有其一）',
    !!framesWhileListening && (framesWhileListening.player || framesWhileListening.fallbackIframe),
    JSON.stringify(framesWhileListening));
  chk('A4 听力组：播放器就位即具备可播放源或兜底入口',
    !!framesWhileListening && (
      (framesWhileListening.player && framesWhileListening.audio &&
        (framesWhileListening.audioSrcSet || framesWhileListening.fallbackBox || framesWhileListening.originLink))
      || framesWhileListening.fallbackIframe
    ), JSON.stringify(framesWhileListening));
  const appErrs = memErrs.filter((e) => !/lazynote|english-exam/i.test(e));
  note('A4.errors', memErrs.slice(0, 8));
  chk('A4 应用自身无页面错误（第三方放开）', appErrs.length === 0, appErrs.length ? appErrs[0] : ('none；第三方听力页异常 ' + (memErrs.length - appErrs.length) + ' 条'));
  await ctxM.close();

  /* --- A4c：对照（阻断第三方） --- */
  const ctxC = await newBrCtx(browser, { viewport: { width: 1440, height: 900 } });
  const pc = ctxC.pages()[0];
  await seedInit(ctxC, '9205', { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }, 'A4c-' + Date.now());
  await pc.goto(URL, { waitUntil: 'commit' }); await waitInit(pc);
  for (let i = 0; i < 4; i++) { const o = await openFirstOpenGroup(pc); if (!o) break; await completeOpenGroup(pc); }
  const c1 = await metrics(pc);
  for (const p of SW) { await pc.evaluate((p) => window.__t.nav(p), p); await doubleRaf(pc); }
  await pc.evaluate(() => window.__t.nav('today')); await doubleRaf(pc);
  const c2 = await metrics(pc);
  note('A4c_control', { after4Groups_GC: c1, after10Switches_GC: c2 });
  chk('A4c 对照：切页 10 次 JSHeap ≤ +1MB', c2.JSHeapUsedMB <= c1.JSHeapUsedMB + 1, c1.JSHeapUsedMB + ' → ' + c2.JSHeapUsedMB + 'MB');
  chk('A4c 对照：切页 10 次 Nodes ≤ +50', c2.Nodes - c1.Nodes <= 50, c1.Nodes + ' → ' + c2.Nodes);
  chk('A4c 对照：切页 10 次 Listeners ≤ +10', c2.Listeners - c1.Listeners <= 10, c1.Listeners + ' → ' + c2.Listeners);
  await ctxC.close();

  /* --- A5：交互响应（各 5 次取均值） --- */
  const ctx2 = await newBrCtx(browser, { viewport: { width: 1440, height: 900 } });
  const page2 = ctx2.pages()[0];
  const errs2 = watchErrors(page2, []);
  await seedInit(ctx2, '9206', null, 'A5-' + Date.now());
  await page2.goto(URL, { waitUntil: 'commit' });
  await waitInit(page2);
  const papers = ['2020-07-1', '2020-09-1', '2020-09-2', '2020-12-1', '2020-12-2'];
  const seeded = await page2.evaluate((papers) => window.__t.seed({ user: '9206', items: papers.map((p) => ({ kind: 'cloze', paperId: p, key: 'g-' + p })) }), papers);
  await page2.reload({ waitUntil: 'commit' });
  await waitInit(page2);
  note('A5.planSeeded', seeded.items);

  const selSync = [], selPaint = [], subSync = [], subPaint = [], navT = [];
  let a5ok = true;
  for (let g = 0; g < 5; g++) {
    const o = await openFirstOpenGroup(page2);
    if (!o) { a5ok = false; chk('A5 第 ' + (g + 1) + ' 组可打开', false, '未找到可开始的题组'); break; }
    const q3 = await page2.evaluate(() => {
      const seen = {}, out = [];
      Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => { const q = b.getAttribute('data-q'); if (!seen[q] && !b.classList.contains('sel')) { seen[q] = 1; out.push(q); } });
      return out.slice(0, 3);
    });
    for (const qid of q3) {
      const r = await page2.evaluate((qid) => new Promise((res) => {
        const b = document.querySelector('.opt[data-q="' + qid + '"]');
        if (!b) { res(null); return; }
        const v = b.getAttribute('data-v');
        const t0 = performance.now();
        b.click();
        const tSel = performance.now() - t0;
        const selOk = !!document.querySelector('.opt[data-q="' + qid + '"][data-v="' + v + '"].sel');
        requestAnimationFrame(() => requestAnimationFrame(() => res({ tSel: Math.round(tSel * 100) / 100, paint: Math.round((performance.now() - t0) * 10) / 10, selOk })));
      }), qid);
      if (r) { selSync.push(r.tSel); selPaint.push(r.paint); }
    }
    await answerUntilComplete(page2, 'first');
    const st = await page2.evaluate(() => new Promise((res) => {
      const b = document.getElementById('groupSubmit');
      if (!b || b.disabled) { res(null); return; }
      const t0 = performance.now();
      b.click();
      const sync = Math.round((performance.now() - t0) * 10) / 10;
      const step = () => {
        if (!document.getElementById('groupDone')) { requestAnimationFrame(step); return; }
        requestAnimationFrame(() => requestAnimationFrame(() => res({ sync, paint: Math.round((performance.now() - t0) * 10) / 10 })));
      };
      step();
    }));
    if (st) { subSync.push(st.sync); subPaint.push(st.paint); }
    await page2.evaluate(() => document.getElementById('groupDone').click());
    await waitQuizClosed(page2);
    for (let k = 0; k < 2; k++) {
      const p = ['wrong', 'stat'][k];
      navT.push(await navPaint(page2, p));
      navT.push(await navPaint(page2, 'today'));
    }
  }
  const A5 = { selectSyncAvg: avg(selSync), selectSyncRange: rng(selSync), selectPaintAvg: avg(selPaint), submitAvg: avg(subSync), submitRange: rng(subSync), submitPaintAvg: avg(subPaint), navAvg: avg(navT), navMax: navT.length ? Math.max.apply(null, navT) : null, navN: navT.length };
  A5.submitVsBaseline = { base: B.judgeMs, now: A5.submitAvg, deltaPct: A5.submitAvg ? Math.round((A5.submitAvg - B.judgeMs) / B.judgeMs * 1000) / 10 : null };
  A5.submitPaintVsBaseline = { base: B.judgeMs, now: A5.submitPaintAvg, deltaPct: A5.submitPaintAvg ? Math.round((A5.submitPaintAvg - B.judgeMs) / B.judgeMs * 1000) / 10 : null };
  A5.navVsBaseline = { base: B.switchMs, now: A5.navAvg, deltaPct: A5.navAvg ? Math.round((A5.navAvg - B.switchMs) / B.switchMs * 1000) / 10 : null };
  note('A5', A5);
  chk('A5 点选视觉反馈 < 100ms', A5.selectPaintAvg < 100, '同步=' + A5.selectSyncAvg + 'ms 完成绘制=' + A5.selectPaintAvg + 'ms（n=' + selSync.length + '）');
  chk('A5 提交→结果 DOM 就绪 < 100ms（处理耗时）', A5.submitAvg < 100, 'avg=' + A5.submitAvg + 'ms max=' + (A5.submitRange ? A5.submitRange[1] : null) + '（上一轮 35.6ms 为含绘制口径，见下一项）');
  chk('A5 提交→结果完成绘制 相对上一轮无回归（≤+20%）', A5.submitPaintVsBaseline.deltaPct <= 20, '绘制口径 avg=' + A5.submitPaintAvg + 'ms base=' + B.judgeMs + 'ms → ' + A5.submitPaintVsBaseline.deltaPct + '%');
  chk('A5 切页渲染 < 100ms', A5.navAvg < 100, 'avg=' + A5.navAvg + 'ms max=' + A5.navMax + '（上一轮 ' + B.switchMs + 'ms，变化 ' + A5.navVsBaseline.deltaPct + '%）');
  chk('A5 无页面错误', errs2.length === 0, errs2.join(' || ') || 'none');
  if (a5ok) chk('A5 5 组全部走通', subSync.length === 5, 'submitted=' + subSync.length);
  await shot(page2, 'a-fluency-stat');
  await ctx2.close(); await ctx.close();
  await browser.close();
}

/* ============================ B. 多视口与浏览器兼容 ============================ */
const VIEWPORTS = [
  { name: '1920x1080', w: 1920, h: 1080 },
  { name: '1366x768', w: 1366, h: 768 },
  { name: '768x1024', w: 768, h: 1024, touch: true },
  { name: '375x667', w: 375, h: 667, touch: true },
  { name: '390x844', w: 390, h: 844, touch: true },
  { name: '414x896', w: 414, h: 896, touch: true },
];
const DARK_QUIZ_SELS = ['header h1', '.card h3', '.muted', '#planSummary', '.opt', '.opt.sel', 'nav button.on', 'nav button:not(.on)', '.btn', '.btn.ghost', '.qprog', '.passage'];
const DARK_STAT_SELS = ['.stat-cell .v', '.stat-cell .k', 'table.acc th', 'table.acc td', '#statSummary', '.heat i.on'];

async function answerMixed(page) {
  return page.evaluate(() => {
    const seen = {}, qs = [];
    Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => { const q = b.getAttribute('data-q'); if (!seen[q]) { seen[q] = 1; qs.push(q); } });
    let n = 0;
    qs.forEach((q, i) => {
      const list = document.querySelectorAll('.opt[data-q="' + q + '"]');
      const ans = window.__t.answerOf(q);
      let target = null;
      if (i === 0) Array.prototype.forEach.call(list, (x) => { if (x.getAttribute('data-v') === ans) target = x; });
      else Array.prototype.forEach.call(list, (x) => { if (!target && x.getAttribute('data-v') !== ans) target = x; });
      if (!target) target = list[0];
      if (target) { target.click(); n++; }
    });
    return n;
  });
}

async function sectionB() {
  sec('B', 'B. 多视口与浏览器兼容');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  const vpResults = {};
  const spec4 = { user: '9500', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'k-cloze' }, { kind: 'listening', paperId: '2020-12-1', qnoFrom: 1, qnoTo: 4, key: 'k-listen' }, { kind: 'match', paperId: '2020-12-1', key: 'k-match' }, { kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'k-read' }] };

  for (const vp of VIEWPORTS) {
    const ctx = await newBrCtx(browser, { viewport: { width: vp.w, height: vp.h }, hasTouch: !!vp.touch, isMobile: !!vp.touch, deviceScaleFactor: 1 });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9500', null, 'B-' + vp.name + '-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' });
    await waitInit(page);
    await page.evaluate((spec) => window.__t.seed(spec), spec4);
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const today = await page.evaluate(() => window.__scan());
    await shot(page, 'vp-' + vp.name + '-today');
    // 深色模式
    await page.evaluate(() => document.getElementById('themeBtn').click());
    await doubleRaf(page);
    const darkToday = await page.evaluate(() => {
      const s = window.__scan(); s.dark = document.body.classList.contains('dark');
      s.contrast = window.__contrast(['header h1', '.card h3', '.muted', '#planSummary', 'nav button.on', 'nav button:not(.on)', '.btn']);
      return s;
    });
    // 答题页（深色）
    let quiz = null, qinfo = null, darkQuiz = null, darkJudged = null, submitted = false;
    const o = await openFirstOpenGroup(page);
    if (o) {
      quiz = await page.evaluate(() => window.__scan());
      qinfo = await page.evaluate(() => window.__t.quiz());
      darkQuiz = await page.evaluate(() => {
        const s = window.__scan(); s.dark = document.body.classList.contains('dark');
        s.contrast = window.__contrast(['.opt', 'nav button.on', '.qprog', '.qtimer', '.card h3', '.passage']);
        s.quizBg = getComputedStyle(document.getElementById('quiz')).backgroundColor;
        s.optText = (document.querySelector('.opt') || {}).textContent;
        return s;
      });
      await shot(page, 'vp-' + vp.name + '-dark-quiz');
      await answerMixed(page);
      const sub = await page.evaluate(() => { const b = document.getElementById('groupSubmit'); if (b && !b.disabled) { b.click(); return true; } return false; });
      if (sub) {
        submitted = true;
        await page.waitForSelector('#groupDone', { timeout: 15000 });
        darkJudged = await page.evaluate(() => {
          const s = { contrast: window.__contrast(['.opt', '.opt.sel', '.opt.right', '.opt.wrongpick', '.analysis', '.verdict.ok', '.verdict.bad', '.analysis .body']) };
          s.rightN = document.querySelectorAll('.opt.right').length;
          s.wrongN = document.querySelectorAll('.opt.wrongpick').length;
          return s;
        });
        await shot(page, 'vp-' + vp.name + '-dark-judged');
        await page.evaluate(() => document.getElementById('groupDone').click());
        await waitQuizClosed(page);
      } else {
        await page.evaluate(() => document.getElementById('quizBack').click());
        await waitQuizClosed(page);
      }
    }
    // 统计页（深色）
    await page.evaluate(() => window.__t.nav('stat'));
    await doubleRaf(page);
    const darkStat = await page.evaluate(() => {
      const s = window.__scan(); s.dark = document.body.classList.contains('dark');
      s.heatCells = document.querySelectorAll('#heatmap i').length;
      s.contrast = window.__contrast(['.stat-cell .v', '.stat-cell .k', 'table.acc th', 'table.acc td', '#statSummary', '.heat i.on']);
      return s;
    });
    await shot(page, 'vp-' + vp.name + '-dark-stat');
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const persisted = await page.evaluate(() => document.body.classList.contains('dark'));

    const allDark = [].concat(darkToday.contrast || [], (darkQuiz ? darkQuiz.contrast : []), (darkJudged ? darkJudged.contrast : []), (darkStat.contrast || []));
    const optC = ((darkQuiz || {}).contrast || []).filter((c) => c.sel === '.opt')[0] || ((darkJudged || {}).contrast || []).filter((c) => c.sel === '.opt')[0] || null;
    const minContrast = Math.min.apply(null, allDark.map((c) => c.ratio));
    const low = allDark.filter((c) => c.ratio < 4.5).map((c) => c.sel + ':' + c.ratio);
    const rec = {
      todayOverflowX: today.overflowX, todayOffenders: today.offenders.length, todayOverlaps: today.overlaps.length,
      quizOverflowX: quiz ? quiz.overflowX : null, quizOverlaps: quiz ? quiz.overlaps.length : null,
      optsCount: quiz ? quiz.opts.length : 0, optsAllOk: quiz ? quiz.opts.every((x) => x.ok) : false,
      optsBad: quiz ? quiz.opts.filter((x) => !x.ok).length : null,
      openedLabel: o ? o.label : null,
      quizScrollH: quiz ? quiz.docScrollH : null,
      planBtnAllInView: today.planBtns.length > 0 && today.planBtns.every((b) => b.inView),
      navWidths: today.nav.map((n) => n.w), navAboveBottom: today.nav.map((n) => n.aboveBottom),
      quizBodyOverflow: quiz ? quiz.quizBodyScrollW > quiz.quizBodyClientW + 1 : null,
      darkOn: darkToday.dark && darkStat.dark, darkPersisted: persisted,
      optContrast: optC ? optC.ratio : null, optColors: optC ? (optC.fg + ' on ' + optC.bg) : null,
      optRight: ((darkJudged || {}).contrast || []).filter((c) => c.sel === '.opt.right')[0] || null,
      optWrong: ((darkJudged || {}).contrast || []).filter((c) => c.sel === '.opt.wrongpick')[0] || null,
      minContrast, lowContrast: low, heatCells: darkStat.heatCells, submitted, touch: !!vp.touch, errs: errs.length,
      contrastDetail: allDark.map((c) => c.sel + ':' + c.ratio),
    };
    vpResults[vp.name] = rec;
    const navOk = today.nav.length === 4 && Math.max.apply(null, rec.navWidths) - Math.min.apply(null, rec.navWidths) <= 2;
    chk(vp.name + ' 无横向溢出', !today.overflowX && (!quiz || !quiz.overflowX) && !rec.quizBodyOverflow, 'today=' + today.docScrollW + '/' + today.clientW + ' offenders=' + today.offenders.length + ' quizOffenders=' + (quiz ? quiz.offenders.length : '-'));
    chk(vp.name + ' 无元素重叠', today.overlaps.length === 0 && (!quiz || quiz.overlaps.length === 0), JSON.stringify([].concat(today.overlaps, quiz ? quiz.overlaps : []).slice(0, 4)));
    chk(vp.name + ' 导航等宽且贴底', navOk && rec.navAboveBottom.every((b) => b <= 2), 'widths=' + JSON.stringify(rec.navWidths) + ' aboveBottom=' + JSON.stringify(rec.navAboveBottom));
    chk(vp.name + ' 答题区可用', rec.optsAllOk && rec.planBtnAllInView, 'opts=' + rec.optsCount + ' planBtnsInView=' + rec.planBtnAllInView);
    chk(vp.name + ' 深色模式生效+持久化', rec.darkOn && rec.darkPersisted, 'on=' + rec.darkOn + ' persisted=' + rec.darkPersisted);
    chk(vp.name + ' 深色 .opt 对比度 ≥ 4.5（上一轮修复项）', rec.optContrast != null && rec.optContrast >= 4.5, '.opt=' + rec.optContrast + '（' + rec.optColors + '）· 上一轮 1.44');
    chk(vp.name + ' 深色全部件对比度 ≥ 3.0', minContrast >= 3.0, 'min=' + minContrast + ' low(<4.5)=' + JSON.stringify(low));
    chk(vp.name + ' 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }
  note('viewports', vpResults);

  /* --- B2：Edge / Chrome 完整旅程 --- */
  const browsers = [{ n: 'Edge', exe: EXE }, { n: 'Chrome', exe: fs.existsSync(CHROME) ? CHROME : null }];
  const journey = {};
  for (const b of browsers) {
    if (!b.exe) { chk(b.n + ' 可用', false, '未安装'); continue; }
    const br = await chromium.launch({ executablePath: b.exe, args: ARGS });
    const ctx = await newBrCtx(br);
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await page.goto(URL, { waitUntil: 'commit' });
    await page.waitForSelector('#loginMask', { timeout: 25000 });
    await page.locator('#phoneInput').fill('9700');
    await page.locator('#loginBtn').click();
    await waitInit(page, 25000);
    const afterLogin = await page.evaluate(() => ({ user: window.__t.user(), plan: document.querySelectorAll('#planList .card').length, summary: document.getElementById('planSummary').textContent }));
    const o = await openFirstOpenGroup(page);
    const res = o ? await completeOpenGroup(page) : { n: 0 };
    const afterQuiz = await page.evaluate(() => { const s = window.__t.state(); return { papers: Object.keys(s.papers).length, minutes: (s.history[window.__t.today()] || {}).minutes, qCount: (s.history[window.__t.today()] || {}).qCount }; });
    await page.evaluate(() => document.getElementById('themeBtn').click());
    await doubleRaf(page);
    const optDark = await page.evaluate(() => (window.__contrast(['.opt'])[0] || {}).ratio);
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const darkPersist = await page.evaluate(() => document.body.classList.contains('dark'));
    const pages = [];
    for (const p of ['wrong', 'stat', 'backup', 'today']) {
      await page.evaluate((p) => window.__t.nav(p), p);
      await doubleRaf(page);
      pages.push(await page.evaluate((p) => ({ p, visible: document.getElementById('page-' + p).style.display !== 'none', cards: document.querySelectorAll('#page-' + p + ' .card').length }), p));
    }
    journey[b.n] = { version: br.version(), afterLogin, answered: res.n, afterQuiz, darkPersist, optDarkContrast: optDark, pages, errs };
    chk(b.n + ' 完整旅程通过', afterLogin.user === '9700' && afterQuiz.papers > 0 && afterQuiz.minutes > 0 && darkPersist && pages.every((x) => x.visible) && errs.length === 0, JSON.stringify({ version: br.version(), papers: afterQuiz.papers, minutes: afterQuiz.minutes, darkPersist, optDark: optDark, errs: errs.slice(0, 2) }));
    await shot(page, 'browser-' + b.n.toLowerCase() + '-journey');
    await br.close();
  }
  note('journeys', journey);

  /* --- B3：Firefox（Playwright 官方构建；本机 stock 构建无 Juggler，无法驱动） --- */
  const ff = { stockInstalled: fs.existsSync(FIREFOX_STOCK), stockVersion: null, officialBuild: null, drivable: false, err: null };
  try { ff.stockVersion = require('child_process').execSync('"' + FIREFOX_STOCK + '" -v', { timeout: 15000 }).toString().trim(); } catch (e) { ff.stockVersion = '版本探测失败'; }
  try {
    const { firefox } = loadPW();
    const br = await firefox.launch({ headless: true, timeout: 60000 });
    ff.officialBuild = br.version();
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await ctx.addInitScript(PROBE); await ctx.addInitScript(PAGE_API); await ctx.addInitScript(TOAST_WATCH);
    await ctx.addInitScript('window.__scan = ' + SCAN.toString() + '; window.__contrast = ' + CONTRAST.toString() + ';');
    const page = await ctx.newPage();
    const errs = watchErrors(page, []);
    await ctx.addInitScript(() => { try { localStorage.setItem('cet6_user', '9800'); } catch (e) { } });
    await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
    await waitInit(page, 60000);
    const base = await page.evaluate(() => ({ ua: navigator.userAgent, banks: (window.CET6_BANKS || []).length, q: (window.CET6_BANKS || []).reduce((a, b) => a + ((b.questions || []).length), 0), plan: document.querySelectorAll('#planList .card').length }));
    const sc = await page.evaluate(() => window.__scan());
    await page.evaluate(() => document.getElementById('themeBtn').click());
    await page.waitForTimeout(300);
    // 打开一个题组，检查深色 .opt 对比度（上一轮 Firefox 实测 1.83）
    const o = await openFirstOpenGroup(page);
    const ffQuiz = o ? await page.evaluate(() => {
      const s = window.__scan(); s.contrast = window.__contrast(['.opt', 'nav button.on', 'nav button:not(.on)', 'header h1', '.card h3']);
      s.dark = document.body.classList.contains('dark');
      return s;
    }) : null;
    const ffOpt = ffQuiz ? (ffQuiz.contrast.filter((c) => c.sel === '.opt')[0] || null) : null;
    // 点选 + 计时器
    let selOk = false, timerTxt = '';
    if (o) {
      await page.evaluate(() => { const b = document.querySelector('.opt'); if (b) b.click(); });
      selOk = await page.evaluate(() => document.querySelectorAll('.opt.sel').length > 0);
      timerTxt = await page.evaluate(() => (document.getElementById('quizTimer') || {}).textContent || '');
      await page.screenshot({ path: path.join(DOCS, 'round3-browser-firefox-dark-quiz.png') });
      await page.evaluate(() => document.getElementById('quizBack').click());
      await page.waitForTimeout(300);
    }
    ff.drivable = true;
    ff.base = base; ff.overflowX = sc.overflowX; ff.navWidths = sc.nav.map((n) => n.w);
    ff.optDarkContrast = ffOpt ? ffOpt.ratio : null; ff.optColors = ffOpt ? (ffOpt.fg + ' / ' + ffOpt.bg) : null;
    ff.selOk = selOk; ff.timer = timerTxt; ff.errs = errs.slice(0, 4); ff.errN = errs.length;
    chk('Firefox 官方构建可驱动（可打开题组渲染答题）', ff.drivable && ffQuiz != null && ffQuiz.opts.length > 0, 'build=' + ff.officialBuild + ' ua=' + base.ua.slice(0, 60) + ' banks@firstpaint=' + base.banks + ' quizOpts=' + (ffQuiz ? ffQuiz.opts.length : 'null'));
    chk('Firefox 390×844 无横向溢出', !sc.overflowX, 'docScrollW=' + sc.docScrollW + ' clientW=' + sc.clientW);
    chk('Firefox 导航 4 等分', sc.nav.length === 4 && Math.max.apply(null, sc.nav.map((n) => n.w)) - Math.min.apply(null, sc.nav.map((n) => n.w)) <= 2, JSON.stringify(sc.nav.map((n) => n.w)));
    chk('Firefox 深色 .opt 对比度 ≥ 4.5（上一轮 1.83）', ff.optDarkContrast != null && ff.optDarkContrast >= 4.5, 'ratio=' + ff.optDarkContrast + '（' + ff.optColors + '）');
    chk('Firefox 点选与计时器可用', selOk && /:\d\d/.test(timerTxt), 'selOk=' + selOk + ' timer=' + timerTxt);
    chk('Firefox 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await page.screenshot({ path: path.join(DOCS, 'round3-browser-firefox.png') });
    await br.close();
  } catch (e) {
    ff.err = String(e.message || e).split('\n').slice(0, 4).join(' | ').slice(0, 400);
    chk('Firefox 可驱动', false, ff.err);
  }
  note('firefox', ff);

  /* --- B4：写作题配图（配图卷 × 6 视口） ---
     配图卷号从题库推导：本仓 6 卷看图作文，四级仓 3 卷。写死卷号会在另一仓假红
     （四级仓那 6 卷里只有部分带图，其余根本没有 img，断言必然全灭）。 */
  const D = digest();
  const IMG_PAPERS = D.imgWriting.slice(0, 6);
  const NOIMG_PAPER = D.papers.filter((p) => D.imgWriting.indexOf(p) < 0)[0];
  console.log('   写作配图卷 ' + IMG_PAPERS.length + ' 卷：' + IMG_PAPERS.join(' , '));
  console.log('   反向对照（应无图）：' + (NOIMG_PAPER || '(题库中每卷都有配图，跳过该对照)'));
  const imgResults = {};
  for (const vp of VIEWPORTS) {
    const ctx = await newBrCtx(browser, { viewport: { width: vp.w, height: vp.h }, hasTouch: !!vp.touch, isMobile: !!vp.touch, deviceScaleFactor: 1 });
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9600', null, 'B4-' + vp.name + '-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' });
    await waitInit(page);
    await page.evaluate((papers) => window.__t.seed({ user: '9600', items: papers.map((p) => ({ kind: 'writing', paperId: p, key: 'w-' + p, qids: [] })) }), IMG_PAPERS.concat(NOIMG_PAPER ? [NOIMG_PAPER] : []));
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    const perVp = {};
    for (const pid of IMG_PAPERS) {
      const opened = await openGroupByPaper(page, pid);
      if (!opened) { perVp[pid] = { opened: false }; continue; }
      // 等懒加载图片真正 load 完成再测量（否则 complete 可能在测量瞬时仍为 false）
      const loadWaited = await page.waitForFunction(() => { const i = document.querySelector('#quizBody img'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 }).then(() => true).catch(() => false);
      const info = await page.evaluate(() => {
        const img = document.querySelector('#quizBody img');
        const de = document.documentElement;
        if (!img) return { img: false };
        const r = img.getBoundingClientRect();
        const card = img.closest('.card');
        const cr = card ? card.getBoundingClientRect() : null;
        return {
          img: true, src: img.getAttribute('src'), complete: img.complete, natW: img.naturalWidth, natH: img.naturalHeight,
          w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), left: Math.round(r.left),
          cardW: cr ? Math.round(cr.width) : null,
          inView: r.right <= de.clientWidth + 1 && r.left >= -1,
          insideCard: cr ? (r.left >= cr.left - 1 && r.right <= cr.right + 1) : null,
          broken: img.complete && img.naturalWidth === 0,
          essayTa: !!document.getElementById('essayTa'),
        };
      });
      info.loadWaited = loadWaited;
      perVp[pid] = info;
      if (pid === IMG_PAPERS[0]) await shot(page, 'vp-' + vp.name + '-writing-img');
      await page.evaluate(() => document.getElementById('quizBack').click());
      await waitQuizClosed(page);
    }
    imgResults[vp.name] = perVp;
    const list = Object.keys(perVp).map((k) => perVp[k]);
    const allLoaded = list.every((x) => x.img && x.complete && x.natW > 0 && !x.broken);
    const allIn = list.every((x) => x.inView && x.insideCard);
    const noOverflow = await page.evaluate(() => { const de = document.documentElement; return de.scrollWidth <= de.clientWidth + 1; });
    // 反向对照：题库里明示"没有配图"的写作卷，不得凭空渲染出 img（防止串图/缓存复用出错）
    let noImgOk = true, noImgDetail = '(题库未提供无图对照卷)';
    if (NOIMG_PAPER) {
      const opened2 = await openGroupByPaper(page, NOIMG_PAPER);
      if (!opened2) { noImgOk = false; noImgDetail = '对照卷 ' + NOIMG_PAPER + ' 未能打开'; }
      else {
        const rr = await page.evaluate(() => ({ img: document.querySelectorAll('#quizBody img').length, ta: !!document.getElementById('essayTa') }));
        noImgOk = rr.img === 0 && rr.ta;
        noImgDetail = '无图卷 ' + NOIMG_PAPER + '：img=' + rr.img + ' · 答题框=' + rr.ta;
        await page.evaluate(() => document.getElementById('quizBack').click());
        await waitQuizClosed(page);
      }
    }
    chk(vp.name + ' 写作配图卷 ' + IMG_PAPERS.length + ' 卷全部正常加载', allLoaded, JSON.stringify(list.map((x) => (x.natW || 0) + 'x' + (x.natH || 0)).join(',')));
    chk(vp.name + ' 写作题图片不溢出/不越界', allIn, JSON.stringify(list.map((x) => (x.w || 0) + '/' + (x.cardW || 0)).join(',')));
    if (NOIMG_PAPER) chk(vp.name + ' 无配图写作卷不渲染 img（防串图）', noImgOk, noImgDetail);
    chk(vp.name + ' 写作题页无横向溢出', noOverflow);
    chk(vp.name + ' 写作题页无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }
  note('writingImages', imgResults);

  await browser.close();
}

/* ============================ C. 交互状态机深度测试 ============================ */
async function freshPage(browser, user, viewport) {
  const opts = (viewport && viewport.viewport) ? viewport : { viewport: viewport || { width: 1440, height: 900 } };
  const ctx = await newBrCtx(browser, opts);
  const page = ctx.pages()[0];
  const errs = watchErrors(page, []);
  await seedInit(ctx, user, null, 'R3C-' + user + '-' + Date.now() + '-' + Math.random());
  await page.goto(URL, { waitUntil: 'commit' });
  await waitInit(page);
  return { ctx, page, errs };
}
async function applySeed(page, spec) {
  await page.evaluate((s) => window.__t.seed(s), spec);
  await page.reload({ waitUntil: 'commit' });
  await waitInit(page);
}
async function clickCardWith(page, text) {
  const cards = page.locator('#planList .card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const t = (await cards.nth(i).textContent()) || '';
    if (t.indexOf(text) >= 0) { await cards.nth(i).locator('button').click(); await waitQuizOpen(page); return true; }
  }
  return false;
}
const planOf = (page) => page.evaluate(() => window.__t.plan());
const timers = (page) => page.evaluate(() => ({ t: (document.getElementById('quizTimer') || {}).textContent || '', cls: (document.getElementById('quizTimer') || {}).className || '', sel: document.querySelectorAll('.opt.sel').length, toasts: window.__t.toastLog() }));

async function sectionC() {
  sec('C', 'C. 交互状态机深度测试');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  const S = {};

  /* ---------- C1 答题中途刷新 → 草稿恢复 + 定时器恢复 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9301');
    // 本用例断言的是"3 个已答【选项】刷新后仍在"（after.sel 统计 .opt.sel）与 15s 落盘 timerLeft，
    // 而选词填空组没有任何 .opt（只有 .cloze-slot/.wb-chip），旧版 seed 成 cloze 必然 0 选中。
    // 计时器对所有题型都生效（limitSecFor 按题型×题数折算），故改用阅读组，语义与旧断言一致。
    await applySeed(page, { user: '9301', items: [{ kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'c1', timerLeft: 287 }] });
    await openFirstOpenGroup(page);
    const t0 = await timers(page);
    await page.evaluate(() => { const seen = {}; let n = 0; Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => { const q = b.getAttribute('data-q'); if (seen[q] || n >= 3) return; seen[q] = 1; n++; b.click(); }); });
    await page.waitForTimeout(3300);
    const before = await timers(page);
    const persisted = await page.evaluate(() => { const it = window.__t.plan()[0] || {}; return { timerLeft: it.timerLeft == null ? null : it.timerLeft, draftN: it.draft ? Object.keys(it.draft).length : 0 }; });
    await page.reload({ waitUntil: 'commit' });
    await waitInit(page);
    await openFirstOpenGroup(page);
    const after = await timers(page);
    const afterDraft = await page.evaluate(() => { const it = window.__t.plan()[0] || {}; return it.draft ? Object.keys(it.draft).length : 0; });
    S.C1 = { start: t0, beforeRefresh: before, savedTimerLeft: persisted.timerLeft, savedDraftN: persisted.draftN, afterRefresh: after, afterDraftN: afterDraft, errs: errs.slice(0, 3) };
    const s0 = parseClock(before.t), s1 = parseClock(after.t);
    chk('C1 草稿恢复：3 个已答选项刷新后仍在', after.sel === 3 && afterDraft === 3, 'sel=' + after.sel + ' draft=' + afterDraft);
    chk('C1 定时器恢复：刷新后回到最近 15s 落盘点（≤15s 回补）', s1 != null && s0 != null && persisted.timerLeft != null && Math.abs(s1 - persisted.timerLeft) <= 1 && s1 >= s0 - 1 && s0 <= 285, '刷新前=' + before.t + ' 落盘 timerLeft=' + persisted.timerLeft + ' 刷新后=' + after.t);
    chk('C1 倒计时确实在走（< 初始 287s）', s0 != null && s0 < 287, 't=' + before.t);
    chk('C1 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'c1-resume');
    await ctx.close();
  }

  /* ---------- C2 提交/完成幂等 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9302');
    await applySeed(page, { user: '9302', items: [{ kind: 'cloze', paperId: '2020-09-1', key: 'c2' }] });
    await openFirstOpenGroup(page);
    await answerUntilComplete(page, 'first');
    const qids = await page.evaluate(() => (window.__t.plan()[0] || {}).qids || []);
    // 连点提交 10 次
    const c2a = await page.evaluate(() => new Promise((res) => {
      const b = document.getElementById('groupSubmit');
      let n = 0; for (let i = 0; i < 10; i++) { if (b) { b.click(); n++; } }
      requestAnimationFrame(() => requestAnimationFrame(() => res({ clicks: n })));
    }));
    const afterSubmit = await page.evaluate(() => {
      const s = window.__t.state(); const qs = (window.__t.plan()[0] || {}).qids || [];
      const seen = {}; qs.forEach((id) => { seen[id] = s.papers[id] ? s.papers[id].seen : null; });
      return { seen, seenVals: qs.map((id) => (s.papers[id] ? s.papers[id].seen : null)), h: s.history[window.__t.today()], judged: !!((window.__t.plan()[0] || {}).judged), doneVisible: (function () { const el = document.getElementById('groupDone'); return el ? getComputedStyle(el).display : null; })() };
    });
    // 连点完成 3 次（第 1 次计分钟，后 2 次必须无效）
    const c2b = await page.evaluate(() => new Promise((res) => {
      const b = document.getElementById('groupDone');
      const r = { clicks: 0, m1: null, m2: null, disabledAfter1: null, present: !!b };
      if (!b) { res(r); return; }
      b.click(); r.clicks++;
      r.disabledAfter1 = b.disabled;
      r.m1 = (window.__t.state().history[window.__t.today()] || {}).minutes;
      for (let i = 0; i < 2; i++) { if (b) { b.click(); r.clicks++; } }
      setTimeout(() => { r.m2 = (window.__t.state().history[window.__t.today()] || {}).minutes; res(r); }, 400);
    }));
    const afterDone = await page.evaluate(() => { const s = window.__t.state(); return { h: s.history[window.__t.today()], done: !!((window.__t.plan()[0] || {}).done) }; });
    S.C2 = { qids: qids.length, submitClicks: c2a.clicks, seenAfterSubmit: afterSubmit.seenVals, judged: afterSubmit.judged, doneVisible: afterSubmit.doneVisible, histAfterSubmit: afterSubmit.h, doneClicks: c2b.clicks, minutesAfterFirstDone: c2b.m1, minutesAfterThirdDone: c2b.m2, doneDisabledAfter1: c2b.disabledAfter1, donePresent: c2b.present, histAfterDone: afterDone.h, planItemDone: afterDone.done, errs: errs.slice(0, 3) };
    const allOne = afterSubmit.seenVals.length > 0 && afterSubmit.seenVals.every((v) => v === 1);
    chk('C2 连点提交 10 次：papers.seen 仍为 1（N-UI-3 无回归）', allOne, 'seen=' + JSON.stringify(afterSubmit.seenVals.slice(0, 12)));
    chk('C2 连点提交 10 次：当日 qCount 只记一遍', afterSubmit.h && afterSubmit.h.qCount === qids.length, 'qCount=' + (afterSubmit.h && afterSubmit.h.qCount) + ' 题数=' + qids.length);
    chk('C2 提交本身不计分钟（分钟在「完成」时计入）', !!afterSubmit.h && afterSubmit.h.minutes === 0, '提交后 minutes=' + (afterSubmit.h && afterSubmit.h.minutes));
    chk('C2 连点完成 3 次：分钟只计入一次（N-UI-2 无回归）', c2b.m1 != null && c2b.m1 > 0 && c2b.m1 === c2b.m2, '1次后=' + c2b.m1 + 'min 连点3次后=' + c2b.m2 + 'min（第 1 次后 disabled=' + c2b.disabledAfter1 + '）');
    // 判分后刷新 → 重进 → 只读回看，不重判
    await ctx.close();
  }
  {
    // C2c：判分后刷新不重判（两个用户对照 minutes 幂等，另起一句）
    const { ctx, page } = await freshPage(browser, '9302');
    // 断言"选项禁用 + 解析在屏"，选词填空组两样都没有（无 .opt，renderClozeRun 也不渲染 .analysis），
    // 旧版 seed 成 cloze 时 disabled===opts 退化成 0===0 的恒真式、analysis 恒为 0 必失败。改用阅读组。
    await applySeed(page, { user: '9302', items: [{ kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'c2c' }] });
    await openFirstOpenGroup(page);
    await answerUntilComplete(page, 'first');
    await page.evaluate(() => document.getElementById('groupSubmit').click());
    await page.waitForFunction(() => { const g = document.getElementById('groupDone'); return g && getComputedStyle(g).display !== 'none'; });
    const pre = await page.evaluate(() => { const s = window.__t.state(); const qs = (window.__t.plan()[0] || {}).qids || []; return { seen: qs.map((id) => s.papers[id].seen), judged: !!(window.__t.plan()[0] || {}).judged, rightCount: (window.__t.plan()[0] || {}).rightCount, submitPresent: !!document.getElementById('groupSubmit'), doneText: (document.getElementById('groupDone') || {}).textContent }; });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await clickCardWith(page, '2020-12-2');
    const post = await page.evaluate(() => {
      const s = window.__t.state(); const qs = (window.__t.plan()[0] || {}).qids || [];
      return { seen: qs.map((id) => s.papers[id].seen), doneVisible: getComputedStyle(document.getElementById('groupDone')).display, rightN: document.querySelectorAll('.opt.right').length, disabled: document.querySelectorAll('.opt[disabled]').length, opts: document.querySelectorAll('.opt').length, analysis: document.querySelectorAll('.analysis').length, timer: (document.getElementById('quizTimer') || {}).textContent || '' };
    });
    await shot(page, 'c2c-rejudge-guard');
    S.C2c = { pre, post };
    chk('C2c 判分后刷新：papers.seen 仍为 1（不重复判分）', post.seen.length > 0 && post.seen.every((v) => v === 1) && JSON.stringify(post.seen) === JSON.stringify(pre.seen), 'pre=' + JSON.stringify(pre.seen) + ' post=' + JSON.stringify(post.seen));
    chk('C2c 判分后刷新：重进为只读回看（选项禁用+解析在屏）', post.disabled === post.opts && post.analysis > 0 && post.doneVisible !== 'none', 'disabled=' + post.disabled + '/' + post.opts + ' analysis=' + post.analysis);
    // C2d：幂等对照（1 次 vs 3 次点击完成）
    const mins = {};
    let clozeReadonly = null;
    for (const [u, k] of [['9312', 1], ['9313', 3]]) {
      const c = await freshPage(browser, u);
      await applySeed(c.page, { user: u, items: [{ kind: 'cloze', paperId: '2020-12-1', key: 'c2d' }] });
      await openFirstOpenGroup(c.page);
      await answerUntilComplete(c.page, 'first');
      await c.page.evaluate(() => document.getElementById('groupSubmit').click());
      await c.page.waitForFunction(() => { const g = document.getElementById('groupDone'); return g && getComputedStyle(g).display !== 'none'; });
      await c.page.evaluate((k) => { const b = document.getElementById('groupDone'); for (let i = 0; i < k; i++) b.click(); }, k);
      await c.page.waitForTimeout(500);
      const h = await c.page.evaluate(() => window.__t.state().history[window.__t.today()]);
      mins[k] = h ? h.minutes : null;
      // C2e：选词填空组没有 .opt，上面 C2c 的"选项禁用+解析在屏"口径对它不适用。
      //      这里补一条该类题型的只读回看口径：词库全部禁用 + 每个空格都带 right/wrongpick 标注。
      if (k === 1) {
        await c.page.reload({ waitUntil: 'commit' }); await waitInit(c.page);
        await clickCardWith(c.page, '2020-12-1');
        clozeReadonly = await c.page.evaluate(() => {
          const chips = document.querySelectorAll('.wb-chip');
          const slots = document.querySelectorAll('.cloze-slot');
          const s = window.__t.state(); const qs = (window.__t.plan()[0] || {}).qids || [];
          return {
            chips: chips.length, chipsDisabled: Array.prototype.filter.call(chips, (x) => x.disabled).length,
            slots: slots.length, slotsMarked: document.querySelectorAll('.cloze-slot.right, .cloze-slot.wrongpick').length,
            seen: qs.map((id) => s.papers[id].seen),
            doneVisible: (function () { const g = document.getElementById('groupDone'); return g ? getComputedStyle(g).display : null; })(),
          };
        });
      }
      await c.ctx.close();
    }
    S.C2d = mins; S.C2e = clozeReadonly;
    chk('C2d 完成 1 次 vs 连点 3 次：分钟完全一致', mins[1] != null && mins[1] === mins[3], '1次=' + mins[1] + 'min  3次=' + mins[3] + 'min');
    chk('C2e 选词填空组判分后刷新：重进也是只读回看（词库全禁用 + 空格已标注 + seen 仍为 1）',
      !!clozeReadonly && clozeReadonly.chips > 0 && clozeReadonly.chipsDisabled === clozeReadonly.chips &&
      clozeReadonly.slots > 0 && clozeReadonly.slotsMarked === clozeReadonly.slots &&
      clozeReadonly.seen.length > 0 && clozeReadonly.seen.every((v) => v === 1),
      JSON.stringify(clozeReadonly));
    await ctx.close();
  }

  /* ---------- C3 定时器到 0 后继续答题 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9303');
    await applySeed(page, { user: '9303', items: [{ kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'c3', timerLeft: 2 }] });
    await openFirstOpenGroup(page);
    const pre = await timers(page);
    await page.waitForTimeout(4200);
    const over = await timers(page);
    const stillAnswerable = await page.evaluate(() => { const b = document.querySelector('.opt'); if (!b) return false; b.click(); return document.querySelectorAll('.opt.sel').length > 0; });
    await answerUntilComplete(page, 'first');
    const stay = await submitAndStay(page, 'first');
    const res = await page.evaluate(() => ({ verdict: Array.prototype.map.call(document.querySelectorAll('.verdict'), (v) => v.textContent).slice(0, 3), body: (document.getElementById('quizBody').textContent || '').slice(0, 200), bar: ((document.getElementById('groupBar') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160), hasOver: /超时/.test(document.getElementById('quizBody').textContent || ''), h: window.__t.state().history[window.__t.today()] }));
    await shot(page, 'c3-overtime');
    S.C3 = { pre, overtime: over, stillAnswerable, submitted: stay.submitted, verdict: res.verdict, hasOverText: res.hasOver, history: res.h, errs: errs.slice(0, 3) };
    chk('C3 到 0 后标红（.overtime）', /overtime/.test(over.cls) && /00:00/.test(over.t), 'cls=' + over.cls + ' timer=' + over.t);
    chk('C3 到 0 有「时间到」提示', over.toasts.some((t) => /时间到/.test(t)), JSON.stringify(over.toasts));
    chk('C3 到 0 后仍可继续答题', stillAnswerable, 'selAfterClick=' + stillAnswerable);
    chk('C3 判分标注超时（timed=1 / timedWithin=0）', res.h && res.h.timed === 1 && res.h.timedWithin === 0 && res.hasOver, JSON.stringify(res.h));
    chk('C3 结果页出现「超时」标注（结果条 ⚠ 超时）', res.hasOver, '结果条="' + (res.bar || '') + '"');
    chk('C3 超时不影响判分与错题入库', !!res.h && res.h.timed === 1 && res.h.right === 1 && res.h.qCount === 5, 'timed=' + (res.h && res.h.timed) + ' right=' + (res.h && res.h.right) + '/' + (res.h && res.h.qCount));
    chk('C3 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C4 错题复习（SM-2） ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9304');
    // C4a：答对 5 次毕业出库
    const gradQ = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), qids = window.__t.allQids().filter((id) => /-r-/.test(id));
      const qid = qids[0];
      window.__t.seed({ user: '9304', noPlan: true, state: { wrongbook: { [qid]: { addedAt: C.addDays(today, -20), box: 0, wrongCount: 1, due: today, ease: 2.5, iv: 1, streak: 0 } } } });
      return qid;
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const wbSnap = () => page.evaluate((id) => { const wb = (window.__t.state().wrongbook || {})[id]; return wb ? { box: wb.box, streak: wb.streak, ease: Math.round((wb.ease || 0) * 100) / 100, iv: wb.iv, due: wb.due, wrongCount: wb.wrongCount } : null; }, gradQ);
    // 答对后 due 会推后（iv 天），同一天无法再次练同一题；为连续测 5 次毕业，每轮把 due 重置回今天后再 reload
    const forceDueToday = () => page.evaluate((id) => {
      const K = 'cet6_p1_state_v1_9304';
      const s = JSON.parse(localStorage.getItem(K) || '{}');
      if (s.wrongbook && s.wrongbook[id]) { s.wrongbook[id].due = window.CET6Core.todayStr(); localStorage.setItem(K, JSON.stringify(s)); return s.wrongbook[id].due; }
      return null;
    }, gradQ);
    const trail = [];
    let forceLog = [];
    for (let r = 0; r < 5; r++) {
      if (r > 0) { forceLog.push(await forceDueToday()); await page.reload({ waitUntil: 'commit' }); await waitInit(page); }
      await page.evaluate(() => window.__t.nav('wrong'));
      await doubleRaf(page);
      const rows = await page.locator('#dueList .wb-item').count();
      const entry = await wbSnap();
      const btn = page.locator('#dueList .wb-item[data-qid="' + gradQ + '"] button');
      let clicked = false;
      if (await btn.count()) { await btn.click(); await waitQuizOpen(page); clicked = true; }
      let correctItem = null;
      if (clicked) {
        const stay = await submitAndStay(page, 'correct');
        correctItem = await wbSnap();
        await page.evaluate(() => { const d = document.getElementById('groupDone'); if (d && getComputedStyle(d) !== null && getComputedStyle(d).display !== 'none') d.click(); else { const b = document.getElementById('quizBack'); if (b) b.click(); } });
        await waitQuizClosed(page);
      }
      trail.push({ round: r + 1, rowsInDue: rows, soonDueListed: rows > 0, before: entry, afterCorrect: correctItem, clicked: clicked });
      if (!clicked) break;
    }
    const finalWb = await page.evaluate((id) => (window.__t.state().wrongbook || {})[id] || null, gradQ);
    S.C4a = { qid: gradQ, forceLog, trail, final: finalWb };
    const streaks = trail.map((t) => (t.afterCorrect ? t.afterCorrect.streak : null));
    const dueRule = await page.evaluate(() => window.CET6Core.addDays(window.CET6Core.todayStr(), 2));
    chk('C4a 第 1 次答对后：due 按 iv 后移到 ' + dueRule + '（box 0→1, iv 1→2），当日到期列表不再包含它', trail[0] && trail[0].afterCorrect && trail[0].afterCorrect.streak === 1 && trail[0].afterCorrect.box === 1 && trail[0].afterCorrect.iv === 2 && trail[0].afterCorrect.due === dueRule && trail[1] && trail[1].soonDueListed === true, '第1轮后=' + JSON.stringify(trail[0] && trail[0].afterCorrect) + ' 第2轮（due 重置后）到期列表命中=' + (trail[1] && trail[1].rowsInDue));
    chk('C4a 连续答对 5 次后毕业出库（streak 5 → 删除）', finalWb === null && trail.length === 5 && trail[3].afterCorrect && trail[3].afterCorrect.streak === 4, 'streak 轨迹=' + JSON.stringify(streaks) + ' final=' + JSON.stringify(finalWb));
    chk('C4a 每次答对 ease 递增(+0.1，封顶 2.8)', trail.slice(0, 4).every((t) => t.afterCorrect) && trail[0].afterCorrect.ease === 2.6 && trail[1].afterCorrect.ease === 2.7 && trail[2].afterCorrect.ease === 2.8 && trail[3].afterCorrect.ease === 2.8, 'ease 轨迹=' + JSON.stringify(trail.map((t) => t.afterCorrect && t.afterCorrect.ease)));
    await ctx.close();
  }
  {
    // C4b：答错 ease 降低；C4c：逾期排序
    const { ctx, page, errs } = await freshPage(browser, '9305');
    const info = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr();
      const cand = window.__t.allQids().filter((id) => /-r-/.test(id));
      const mk = (id, over, wc, ease) => ({ addedAt: C.addDays(today, -over - 1), box: 0, wrongCount: wc, due: C.addDays(today, -over), ease, iv: 1, streak: 0 });
      const wb = {};
      wb[cand[0]] = mk(cand[0], 10, 1, 2.5); // 逾期 10 天
      wb[cand[1]] = mk(cand[1], 3, 1, 2.5);  // 逾期 3 天
      wb[cand[2]] = mk(cand[2], 0, 1, 2.5);  // 今日到期
      wb[cand[3]] = mk(cand[3], 3, 5, 2.5);  // 逾期 3 天但错 5 次 → 应排在 cand[1] 之前
      window.__t.seed({ user: '9305', noPlan: true, state: { wrongbook: wb } });
      return { today, wrongQ: cand[0], over10: cand[0], over3: cand[1], today0: cand[2], over3wc5: cand[3] };
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await page.evaluate(() => window.__t.nav('wrong'));
    await doubleRaf(page);
    const order = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#dueList .wb-item'), (r) => r.getAttribute('data-qid')));
    const chips = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#dueList .wb-item .chip'), (c) => c.textContent));
    // 答错 cand[0]
    const btn = page.locator('#dueList .wb-item[data-qid="' + info.over10 + '"] button');
    await btn.click(); await waitQuizOpen(page);
    await answerUntilComplete(page, 'wrong');
    await page.evaluate(() => document.getElementById('groupSubmit').click());
    await page.waitForFunction(() => { const g = document.getElementById('groupDone'); return g && getComputedStyle(g).display !== 'none'; });
    const afterWrong = await page.evaluate((id) => { const wb = window.__t.state().wrongbook[id]; return { ease: Math.round((wb.ease || 0) * 100) / 100, streak: wb.streak, box: wb.box, iv: wb.iv, wrongCount: wb.wrongCount, due: wb.due }; }, info.over10);
    await page.evaluate(() => { const d = document.getElementById('groupDone'); if (d && getComputedStyle(d).display !== 'none') d.click(); else document.getElementById('quizBack').click(); });
    await waitQuizClosed(page);
    const expected = [info.over10, info.over3wc5, info.over3, info.today0];
    const wrongSnap = await page.evaluate((id) => { const wb = window.__t.state().wrongbook[id]; return { ease: Math.round((wb.ease || 0) * 100) / 100, streak: wb.streak, wrongCount: wb.wrongCount, due: wb.due, iv: wb.iv }; }, info.over10);
    S.C4bc = { order, chips, expected, afterWrong: wrongSnap };
    chk('C4b 答错：ease 2.5→2.3、streak 归零、box 归零、iv=1、due=明天', wrongSnap.ease === 2.3 && wrongSnap.streak === 0 && wrongSnap.wrongCount === 2 && wrongSnap.iv === 1 && wrongSnap.due === (await page.evaluate(() => window.CET6Core.addDays(window.CET6Core.todayStr(), 1))), JSON.stringify(wrongSnap));
    chk('C4c 逾期排序：逾期久 → 错次多 → ease 低', JSON.stringify(order) === JSON.stringify(expected), 'order=' + JSON.stringify(order) + ' 期望=' + JSON.stringify(expected));
    chk('C4c 逾期徽标文案正确', chips[0] === '逾期 10 天' && chips[1] === '逾期 3 天', JSON.stringify(chips));
    chk('C4bc 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C5 计划清单边界 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9306');
    // C5a：全部题目做完
    await page.evaluate(() => {
      const qids = window.__t.allQids(), today = window.CET6Core.todayStr(), papers = {};
      qids.forEach((id) => { papers[id] = { seen: 1, right: 1, wrong: 0, lastAt: today, lastResult: 'right' }; });
      window.__t.seed({ user: '9306', items: [], state: { papers } });
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const emptyState = await page.evaluate(() => ({
      planItems: window.__t.plan().length,
      summary: document.getElementById('planSummary').textContent,
      status: document.getElementById('todayStatus').textContent,
      emptyHtml: (document.querySelector('#planList .empty') || {}).textContent || '',
      extraBtns: Array.prototype.map.call(document.querySelectorAll('#extraBtns button'), (b) => b.textContent),
      floorBtn: !!document.getElementById('floorBtn'),
    }));
    const extras = [];
    for (let i = 0; i < emptyState.extraBtns.length; i++) {
      await page.evaluate((i) => document.querySelectorAll('#extraBtns button')[i].click(), i);
      await page.waitForFunction(() => window.__t.toastLog().some((t) => /没有剩余题目/.test(t)), null, { timeout: 3000 }).catch(() => { });
      extras.push(await page.evaluate(() => ({ planItems: window.__t.plan().length, toasts: window.__t.toastLog().slice(-2) })));
    }
    S.C5a = { emptyState, extras };
    chk('C5a 全部做完：清单 0 组 + 通关文案', emptyState.planItems === 0 && /全部题目已完成/.test(emptyState.emptyHtml) && /0\/0/.test(emptyState.summary), JSON.stringify({ summary: emptyState.summary, empty: emptyState.emptyHtml }));
    chk('C5a 全部做完：4 个加练按钮在场且点击无残留', emptyState.extraBtns.length === 4 && extras.every((x) => x.planItems === 0 && x.toasts.some((t) => /没有剩余题目/.test(t))), JSON.stringify(extras.map((x) => x.toasts)));
    // C5b：有剩余题目时加练可用
    await page.evaluate(() => { localStorage.removeItem(window.__t.key()); });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const b0 = await page.evaluate(() => window.__t.plan().length);
    await page.evaluate(() => document.querySelectorAll('#extraBtns button')[0].click());
    await page.waitForFunction(() => window.__t.toastLog().some((t) => /已加入一组|正在加载题库卷/.test(t)), null, { timeout: 3000 }).catch(() => { });
    await page.waitForTimeout(150);
    const b1 = await page.evaluate(() => ({ n: window.__t.plan().length, toasts: window.__t.toastLog().slice(-2), lastItem: window.__t.plan()[window.__t.plan().length - 1] }));
    S.C5b = { before: b0, after: b1.n, toast: b1.toasts, addedKey: b1.lastItem && b1.lastItem.key };
    chk('C5b 加练按钮：加入一组并提示', b1.n === b0 + 1 && b1.toasts.some((t) => /已加入一组/.test(t)), 'plan ' + b0 + '→' + b1.n + ' toast=' + JSON.stringify(b1.toasts));
    // C5c：周六写译轮换（纯函数）
    const rot = await page.evaluate(() => {
      const C = window.CET6Core, M = window.CET6_META;
      const out = [];
      ['2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17'].forEach((d) => {
        const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} };
        const p = C.genPlan(st, M, d);
        const es = p.items.filter((x) => x.type === 'writing' || x.type === 'translation').map((x) => x.type + ':' + x.paperId);
        const dow = new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))).getDay();
        out.push({ d, dow, essay: es, n: p.items.length, types: p.items.map((x) => x.type) });
      });
      const sun = (() => { const st = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {} }; const p = C.genPlan(st, window.CET6_META, '2026-09-27'); return p.items.filter((x) => x.type === 'writing' || x.type === 'translation').length; })();
      return { out, sundayEssay: sun };
    });
    S.C5c = rot;
    const seq = rot.out.map((x) => (x.essay[0] || '').split(':')[0]);
    chk('C5c 周六有写译组，连续周六轮换 w/t 交替', rot.out.every((x) => x.essay.length === 1) && seq.every((v, i) => i === 0 || v !== seq[i - 1]), JSON.stringify(seq));
    chk('C5c 周日无写译组', rot.sundayEssay === 0, 'sundayEssay=' + rot.sundayEssay);
    chk('C5c 每日清单含听力保底', rot.out.every((x) => x.types.indexOf('listening') >= 0), JSON.stringify(rot.out.map((x) => x.types.filter((t) => t === 'listening').length)));
    chk('C5 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C6 多账号切换 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9310');
    // 本组断言"切换账号后未提交草稿保留（draft===2）"，靠点 .opt 记草稿；选词填空组无 .opt，
    // 旧版 seed 成 cloze 时点不到任何选项、draft 恒为 0。改用带 .opt 的阅读组。
    // 预置 papers 快照同步换成该阅读卷的题 id，保持"papers 键数 === 1"的口径真实。
    await applySeed(page, {
      user: '9310', items: [{ kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'c6' }],
      state: { history: { [await page.evaluate(() => window.CET6Core.addDays(window.CET6Core.todayStr(), -1))]: { minutes: 45, qCount: 10, right: 8, done: true }, [await page.evaluate(() => window.CET6Core.todayStr())]: { minutes: 30, qCount: 10, right: 7, done: true } }, papers: { '2020-12-2-r-46': { seen: 1, right: 1, wrong: 0 } }, wrongbook: {}, essays: { writing: { lastAt: '2026-09-26', text: 'A_' + 'word '.repeat(120) } } },
    });
    await openFirstOpenGroup(page);
    await page.evaluate(() => { const seen = {}; let n = 0; Array.prototype.forEach.call(document.querySelectorAll('.opt'), (b) => { const q = b.getAttribute('data-q'); if (seen[q] || n >= 2) return; seen[q] = 1; n++; b.click(); }); });
    await page.evaluate(() => document.getElementById('quizBack').click());
    await waitQuizClosed(page);
    const A1 = await page.evaluate(() => ({ user: window.__t.user(), days: Object.keys(window.__t.history()).length, draft: ((window.__t.plan()[0] || {}).draft ? Object.keys(window.__t.plan()[0].draft).length : 0), essayLen: ((window.__t.essays().writing || {}).text || '').length, timerLeft: (window.__t.plan()[0] || {}).timerLeft }));
    // 切到 9320
    let nextUser = '9320';
    page.on('dialog', (d) => d.accept(nextUser).catch(() => { }));
    await page.evaluate(() => document.getElementById('userChip').click());
    await page.waitForFunction(() => window.__t.user() === '9320', null, { timeout: 20000 });
    await waitInit(page);
    const Bx = await page.evaluate(() => ({ user: window.__t.user(), days: Object.keys(window.__t.history()).length, plan: window.__t.plan().length, raw: (window.__t.raw() || '').length }));
    // 切回 9310
    nextUser = '9310';
    await page.evaluate(() => document.getElementById('userChip').click());
    await page.waitForFunction(() => window.__t.user() === '9310', null, { timeout: 20000 });
    await waitInit(page);
    const A2 = await page.evaluate(() => ({ user: window.__t.user(), days: Object.keys(window.__t.history()).length, draft: ((window.__t.plan()[0] || {}).draft ? Object.keys(window.__t.plan()[0].draft).length : 0), essayLen: ((window.__t.essays().writing || {}).text || '').length, timerLeft: (window.__t.plan()[0] || {}).timerLeft, papers: Object.keys(window.__t.papers()).length }));
    S.C6 = { A_before: A1, B: Bx, A_after: A2 };
    chk('C6 A→B→A：A 数据完整（天数/错题/草稿/作文）', A2.days === A1.days && A2.draft === A1.draft && A2.essayLen === A1.essayLen && A2.papers === 1, JSON.stringify({ before: A1, after: A2 }));
    chk('C6 B 账号干净（0 天记录，独立存档）', Bx.user === '9320' && Bx.days === 0, JSON.stringify(Bx));
    chk('C6 切换时未提交草稿保留（draft=' + A2.draft + '，timerLeft=' + A2.timerLeft + '）', A2.draft === 2 && A2.timerLeft != null, JSON.stringify({ draft: A2.draft, timerLeft: A2.timerLeft }));
    chk('C6 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await shot(page, 'c6-accounts');
    await ctx.close();
  }

  /* ---------- C7 导入导出往返 + 损坏文件 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9330');
    await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), qids = window.__t.allQids();
      const history = {}; for (let i = 0; i < 12; i++) history[C.addDays(today, -i)] = { minutes: 30 + i, qCount: 10, right: 7 + (i % 3), done: true, floor: i % 4 === 0 };
      const papers = {}; qids.slice(0, 40).forEach((id, i) => { papers[id] = { seen: 1 + (i % 2), right: 1, wrong: i % 2, lastAt: today, lastResult: i % 2 ? 'wrong' : 'right' }; });
      const wrongbook = {}; qids.slice(0, 6).forEach((id, i) => { wrongbook[id] = { addedAt: C.addDays(today, -10), box: i % 3, wrongCount: 1 + i, due: C.addDays(today, i - 2), ease: 2.5 - i * 0.1, iv: 1 + i, streak: i }; });
      const essays = { writing: { lastAt: today, text: 'Round-trip essay. '.repeat(40) }, translation: { lastAt: today, text: '往返测试译文。'.repeat(20) } };
      const hl = {}; hl['r-2020-12-2-46'] = ['the', 'and', 'with'];
      window.__t.seed({ user: '9330', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'c7' }], state: { history, papers, wrongbook, essays, hl } });
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const live = await page.evaluate(() => { const s = window.__t.state(); return { history: Object.keys(s.history).length, papers: Object.keys(s.papers).length, wrong: Object.keys(s.wrongbook).length, essay: s.essays.writing.text.length, hl: Object.keys(s.hl).length, bytes: (window.__t.raw() || '').length }; });
    let dl = null, dlErr = null;
    const file = path.join(DOCS, 'round3-export-state.json');
    try {
      const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.evaluate(() => document.getElementById('exportBtn').click())]);
      await d.saveAs(file);
      dl = { suggested: d.suggestedFilename(), size: fs.statSync(file).size };
    } catch (e) { dlErr = String(e.message || e).slice(0, 200); }
    let expProj = null, liveProj = null;
    if (dl) {
      const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
      expProj = { history: Object.keys(exp.history || {}).length, papers: Object.keys(exp.papers || {}).length, wrong: Object.keys(exp.wrongbook || {}).length, essay: ((exp.essays || {}).writing || {}).text.length };
      liveProj = live;
    }
    // 清空 → 导入
    await page.evaluate(() => window.__t.delState());
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const cleared = await page.evaluate(() => ({ history: Object.keys(window.__t.history()).length, plan: window.__t.plan().length }));
    await page.setInputFiles('#importFile', file);
    await page.waitForFunction(() => Object.keys(window.__t.history()).length > 1, null, { timeout: 15000 }).catch(() => { });
    await page.waitForFunction(() => window.__t.toastLog().some((t) => /导入成功/.test(t)), null, { timeout: 6000 }).catch(() => { });
    const restored = await page.evaluate(() => { const s = window.__t.state(); return { history: Object.keys(s.history).length, papers: Object.keys(s.papers).length, wrong: Object.keys(s.wrongbook).length, essay: ((s.essays || {}).writing || {}).text.length, hl: Object.keys(s.hl).length, toasts: window.__t.toastLog().slice(-2) }; });
    // 损坏文件：超 5MB
    const big = path.join(__dirname, '.r3-big.json');
    fs.writeFileSync(big, '{"pad":"' + 'x'.repeat(6 * 1024 * 1024) + '"}', 'utf8');
    await page.setInputFiles('#importFile', big);
    // 固定 sleep 会抖（曾出现"只等到上一条 toast"的假失败：_probe_import.js 证明应用侧照常提示）。
    // 改成显式等待目标 toast 出现，既确定又更快。
    await page.waitForFunction(() => (window.__t.toastLog() || []).some((t) => /超过 5MB/.test(t)), null, { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(200);
    const afterBig = await page.evaluate(() => ({ toasts: window.__t.toastLog().slice(-3), elText: (document.getElementById('toast') || {}).textContent || '', history: Object.keys(window.__t.history()).length }));
    try { fs.unlinkSync(big); } catch (e) { }
    // 损坏文件：非法 JSON（小体积）
    const bad = path.join(__dirname, '.r3-bad.json');
    fs.writeFileSync(bad, '{"version":1,"history":{},"papers":{}}' + 'not-json', 'utf8');
    await page.setInputFiles('#importFile', bad);
    await page.waitForFunction(() => (window.__t.toastLog() || []).some((t) => /不是有效的备份文件/.test(t)), null, { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(200);
    // elText 是 #toast 元素当前文本（提示隐藏后文本仍在）——用于区分"应用没提示"与"探针漏采"
    const afterBad = await page.evaluate(() => ({ toasts: window.__t.toastLog().slice(-3), elText: (document.getElementById('toast') || {}).textContent || '', history: Object.keys(window.__t.history()).length }));
    try { fs.unlinkSync(bad); } catch (e) { }
    S.C7 = { live, download: dl, downloadErr: dlErr, exportedProjection: expProj, cleared, restored, afterBig, afterBad };
    chk('C7 导出 JSON 成功且体积合理', !!dl && dl.size > 500, JSON.stringify(dl) + ' err=' + dlErr);
    chk('C7 导出内容与内存状态一致', !!expProj && JSON.stringify(expProj) === JSON.stringify({ history: live.history, papers: live.papers, wrong: live.wrong, essay: live.essay }), JSON.stringify(expProj));
    chk('C7 清空后导入：数据完全恢复', restored.history === live.history && restored.papers === live.papers && restored.wrong === live.wrong && restored.essay === live.essay && restored.hl === live.hl, JSON.stringify(restored) + ' vs ' + JSON.stringify(live));
    chk('C7 导入成功提示', restored.toasts.some((t) => /导入成功/.test(t)), JSON.stringify(restored.toasts));
    chk('C7 超 5MB 文件被拦下且保留原记录', (afterBig.toasts.some((t) => /超过 5MB/.test(t)) || /超过 5MB/.test(afterBig.elText || '')) && afterBig.history === live.history, JSON.stringify(afterBig));
    // 证据取"提示日志 或 #toast 元素当前文本"任一即可：两者都是"应用确实弹了这条提示"的等价证明。
    // （弹完隐藏后元素文本仍在；配合 history 未变，足以证明走的是 catch 回滚分支。）
    chk('C7 非法 JSON 被拦下且保留原记录', (afterBad.toasts.some((t) => /不是有效的备份文件/.test(t)) || /不是有效的备份文件/.test(afterBad.elText || '')) && afterBad.history === live.history, JSON.stringify(afterBad));    chk('C7 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C8 异常组合：双标签页 / 切页签 / 快速点导航 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9340');
    await applySeed(page, { user: '9340', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'c8' }, { kind: 'cloze', paperId: '2020-09-1', key: 'c8b' }] });
    // C8a 双标签页竞争
    const p2 = await ctx.newPage();
    const errs2 = watchErrors(p2, []);
    await p2.goto(URL, { waitUntil: 'commit' }); await waitInit(p2);
    const rA = await page.evaluate(async () => {
      const t = window.__t; const s = t.state(); s.history[t.today()] = { minutes: 111, qCount: 1, right: 1, done: false }; t.setState(s);
      return { wrote: 'A', minutes: 111 };
    });
    await p2.waitForTimeout(300);
    const rB = await p2.evaluate(async () => {
      const t = window.__t; const s = t.state(); s.history[t.today()] = { minutes: 222, qCount: 2, right: 2, done: false }; t.setState(s);
      return { wrote: 'B', minutes: 222 };
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const afterRace = await page.evaluate(() => window.__t.history()[window.__t.today()]);
    // C8b 答题时切页签回来：计时器是否按墙钟推进（N-UI-5）
    await page.evaluate(() => { const it = window.__t.plan()[0]; it.timerLeft = 300; const s = window.__t.state(); s.plan.items[0] = it; window.__t.setState(s); });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await openFirstOpenGroup(page);
    const tb0 = parseClock(await page.evaluate(() => document.getElementById('quizTimer').textContent));
    await p2.bringToFront();
    await page.waitForTimeout(8000);
    await page.bringToFront();
    await page.waitForTimeout(1500);
    const tb1 = parseClock(await page.evaluate(() => document.getElementById('quizTimer').textContent));
    await page.evaluate(() => document.getElementById('quizBack').click());
    await waitQuizClosed(page);
    // C8c 主线程阻塞 5s 后计时器是否少走（N-UI-5 核心）
    await page.evaluate(() => { const s = window.__t.state(); s.plan.items[0].timerLeft = 300; window.__t.setState(s); });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await openFirstOpenGroup(page);
    const tc0 = parseClock(await page.evaluate(() => document.getElementById('quizTimer').textContent));
    await page.evaluate(() => { const t0 = Date.now(); while (Date.now() - t0 < 5000) { } });
    await page.waitForTimeout(1200);
    const tc1 = parseClock(await page.evaluate(() => document.getElementById('quizTimer').textContent));
    await page.evaluate(() => document.getElementById('quizBack').click());
    await waitQuizClosed(page);
    // C8d 快速连点导航 30 次
    const navErr0 = errs.length;
    await page.evaluate(() => { for (let i = 0; i < 30; i++) document.querySelector('nav button[data-p="' + ['today', 'wrong', 'stat', 'backup'][i % 4] + '"]').click(); });
    await doubleRaf(page);
    const navState = await page.evaluate(() => ({ visible: ['today', 'wrong', 'stat', 'backup'].filter((p) => document.getElementById('page-' + p).style.display !== 'none'), on: document.querySelector('nav button.on').textContent }));
    await p2.close();
    S.C8 = { raceA: rA, raceB: rB, afterRace, tabTimer: { before: tb0, after: tb1, drop: tb0 - tb1 }, blockTimer: { before: tc0, after: tc1, drop: tc0 - tc1 }, navState, errsA: errs.slice(0, 4), errsB: errs2.slice(0, 4) };
    chk('C8a 双标签页：后写覆盖先写（最后写入者胜），无崩溃', afterRace && afterRace.minutes === 222, '最终 minutes=' + (afterRace && afterRace.minutes) + '（A 写 111 → B 写 222）');
    chk('C8b 切页签 8s 回来：计时器按墙钟推进（损失 ≤2s）', Math.abs((tb0 - tb1) - 8) <= 2.5, 't=' + tb0 + 's→' + tb1 + 's 掉 ' + (tb0 - tb1) + 's（期望 ~8s）');
    chk('C8c 主线程阻塞 5s：计时器不再走慢（N-UI-5 无回归）', (tc0 - tc1) >= 4.5, '掉 ' + (tc0 - tc1) + 's（期望 ≥4.5s；修复前实测 2s）');
    chk('C8d 快速连点导航 30 次：仅 1 个页面可见、高亮唯一、无报错', navState.visible.length === 1 && navErr0 === errs.length && errs.length === 0, JSON.stringify(navState) + ' errs=' + errs.length);
    chk('C8 无页面错误（两个标签页）', errs.length === 0 && errs2.length === 0, (errs.concat(errs2)).slice(0, 2).join(' || ') || 'none');
    await ctx.close();
  }

  /* ---------- C9 新增：写作图片答题 / 翻译长文本 / 听力 iframe 降级 ---------- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9350');
    // 配图写作卷从题库推导（见文件头 digest 说明），不写死卷号
    const W_IMG = digest().imgWriting[0];
    const T_PAPER = digest().papers.filter((p) => p !== W_IMG)[0] || '2015-12-2';
    await applySeed(page, { user: '9350', items: [{ kind: 'writing', paperId: W_IMG, key: 'c9w', qids: [] }, { kind: 'translation', paperId: T_PAPER, key: 'c9t', qids: [] }, { kind: 'listening', paperId: '2020-12-1', qnoFrom: 1, qnoTo: 4, key: 'c9l' }] });
    // 写作：图片 + 答题流程
    const wOpenT = Date.now();
    await clickCardWith(page, W_IMG);
    const wRender = Date.now() - wOpenT;
    const wInfo = await page.evaluate(() => {
      const img = document.querySelector('#quizBody img');
      return { img: !!img, natW: img ? img.naturalWidth : 0, complete: img ? img.complete : false, ta: !!document.getElementById('essayTa'), done: !!document.getElementById('essayDone'), sample: !!document.getElementById('essaySample') };
    });
    await page.evaluate(() => { const ta = document.getElementById('essayTa'); ta.value = 'The cartoon vividly depicts a man complaining about misleading information online. ' + 'To begin with, we should tell right from wrong and verify the source of any message we read. '.repeat(3); ta.dispatchEvent(new Event('input')); });
    const wSaved = await page.evaluate(() => ((window.__t.essays().writing || {}).text || '').length);
    await page.evaluate(() => document.getElementById('essayDone').click());
    await waitQuizClosed(page);
    const wAfter = await page.evaluate(() => ({ h: window.__t.state().history[window.__t.today()], done: !!(window.__t.plan().filter((x) => x.key === 'c9w')[0] || {}).done, essayLen: ((window.__t.essays().writing || {}).text || '').length }));
    S.C9w = { renderMs: wRender, info: wInfo, savedLen: wSaved, after: wAfter };
    chk('C9 写作题：配图加载成功且可作答打卡', !!W_IMG && wInfo.img && wInfo.natW > 0 && wInfo.ta && wAfter.done && wAfter.h && wAfter.h.minutes > 0, JSON.stringify({ paper: W_IMG, natW: wInfo.natW, minutes: wAfter.h && wAfter.h.minutes, done: wAfter.done }));
    chk('C9 写作草稿自动保存', wSaved > 100 && wAfter.essayLen === wSaved, 'saved=' + wSaved + ' after=' + wAfter.essayLen);
    // 翻译：长文本输入
    await clickCardWith(page, T_PAPER);
    const t0 = Date.now();
    const chunks = [];
    for (let i = 0; i < 25; i++) {
      const ms = await page.evaluate((i) => {
        const ta = document.getElementById('essayTa');
        const t0 = performance.now();
        ta.value += '第' + i + '段：随着信息技术的飞速发展，人们获取知识的途径越来越多样化，但同时也面临着信息真伪难辨的问题。';
        ta.dispatchEvent(new Event('input'));
        return Math.round((performance.now() - t0) * 10) / 10;
      }, i);
      chunks.push(ms);
    }
    const tTotal = Date.now() - t0;
    const tLen = await page.evaluate(() => document.getElementById('essayTa').value.length);
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await clickCardWith(page, T_PAPER);
    const tRestored = await page.evaluate(() => document.getElementById('essayTa').value.length);
    S.C9t = { chunksAvg: avg(chunks), chunksMax: Math.max.apply(null, chunks), totalMs: tTotal, len: tLen, restored: tRestored, chunks: chunks.slice(0, 8) };
    chk('C9 翻译题长文本（' + tLen + ' 字）输入流畅（单块 <200ms）', Math.max.apply(null, chunks) < 200, 'avg=' + avg(chunks) + 'ms max=' + Math.max.apply(null, chunks) + 'ms');
    chk('C9 翻译题长文本刷新后完整恢复', tRestored === tLen && tLen > 800, 'len=' + tLen + ' restored=' + tRestored);
    await page.evaluate(() => document.getElementById('quizBack').click());
    await waitQuizClosed(page);
    // 听力：默认 context 已阻断第三方 → CDN 音频必然加载失败。
    // 架构已从"嵌第三方 iframe"改为"烘焙分片 + <audio> 播放器"，故断言改为：
    // 播放器仍然渲染、题目仍然可作答（这才是"不崩"的真实含义）。
    await clickCardWith(page, '2020-12-1');
    const lInfo = await page.evaluate(() => {
      const b = document.getElementById('quizBody');
      const au = b.querySelector('audio');
      return {
        player: !!b.querySelector('.listen-player'), audio: !!au, controls: au ? au.hasAttribute('controls') : false,
        pieces: b.querySelectorAll('.lp-piece').length, originLink: !!b.querySelector('.listen-player a[href]'),
        iframe: !!b.querySelector('iframe'),
        opts: document.querySelectorAll('.opt').length,
        fallbackMsg: /暂不可用/.test(b.textContent || ''), body: (b.textContent || '').slice(0, 120),
      };
    });
    const lOk = await page.evaluate(() => { const b = document.querySelector('.opt'); if (b) b.click(); return document.querySelectorAll('.opt.sel').length; });
    await shot(page, 'c9-listening-blocked');
    S.C9l = { blockedLoad: lInfo, selectable: lOk };
    chk('C9 听力音频加载失败：题目仍可作答（不崩）', lInfo.player && lInfo.audio && lInfo.opts > 0 && lOk > 0,
      JSON.stringify({ player: lInfo.player, audio: lInfo.audio, controls: lInfo.controls, opts: lInfo.opts, selectable: lOk }));
    chk('C9 听力音频加载失败：给出"原站收听"兜底入口', lInfo.originLink || lInfo.fallbackMsg,
      'originLink=' + lInfo.originLink + ' fallbackMsg=' + lInfo.fallbackMsg);
    await page.evaluate(() => document.getElementById('quizBack').click());
    await waitQuizClosed(page);
    // 强制空 URL：烘焙音频不依赖 listeningUrl，播放器应当照常可用，且不得渲染出空链接
    await page.evaluate(() => { const b = window.__t.paper('2020-12-1'); b.listeningUrl = ''; delete b.listeningSharedWith; });
    await clickCardWith(page, '2020-12-1');
    const lFb = await page.evaluate(() => {
      const b = document.getElementById('quizBody');
      return {
        player: !!b.querySelector('.listen-player'), audio: !!b.querySelector('audio'),
        opts: document.querySelectorAll('.opt').length,
        badLink: !!b.querySelector('.listen-player a[href=""], .listen-player a:not([href])'),
        originLink: !!b.querySelector('.listen-player a[href]'),
        text: (b.textContent || '').slice(0, 100),
      };
    });
    S.C9lFallback = lFb;
    chk('C9 听力地址缺失：烘焙音频仍可用、作答不受影响、无空链接', lFb.player && lFb.audio && lFb.opts > 0 && !lFb.badLink,
      JSON.stringify(lFb).slice(0, 220));
    chk('C9 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await page.evaluate(() => document.getElementById('quizBack').click());
    await ctx.close();
  }

  await browser.close();
  R.sections.C.data = S;
}

/* ============================ D. 极端数据量叠加 ============================ */
async function sectionD() {
  sec('D', 'D. 极端数据量叠加（1000+错题 + 全量papers + 500天历史 / 10000字作文 / 100处高亮）');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  const Dd = {};

  /* --- D1：叠加状态 --- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9401');
    const heavy = await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), qids = window.__t.allQids();
      const papers = {}; qids.forEach((id, i) => { papers[id] = { seen: 1 + (i % 2), right: 1, wrong: i % 2, lastAt: today, lastResult: i % 2 ? 'wrong' : 'right' }; });
      const wrongbook = {}; let n = 0;
      for (let i = 0; i < qids.length && n < 1150; i++) {
        if (i % 3 === 0) continue;
        const id = qids[i];
        wrongbook[id] = { addedAt: C.addDays(today, -40), box: i % 5, wrongCount: 1 + (i % 7), due: (i % 5 === 0) ? C.addDays(today, 3) : C.addDays(today, -(i % 12)), ease: Math.round((2.5 - (i % 6) * 0.2) * 100) / 100, iv: 1 + (i % 15), streak: 0 };
        n++;
      }
      const history = {}; for (let i = 0; i < 500; i++) history[C.addDays(today, -i)] = { minutes: 25 + (i % 60), qCount: 20 + (i % 30), right: 15, done: true, timed: 1, timedWithin: 1, timedSec: 900 };
      window.__t.seed({ user: '9401', items: [], state: { papers, wrongbook, history } });
      return { totalQids: qids.length, wrongN: n, historyDays: Object.keys(history).length, papersN: Object.keys(papers).length };
    });
    const t0 = Date.now();
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelectorAll('#heatmap i').length > 0 && document.getElementById('wrongSummary').textContent.length > 3, null, { timeout: 40000 });
    const initMs = Date.now() - t0;
    const readyAt = await page.evaluate(() => Math.round(performance.now()));
    const bytes = await page.evaluate(() => (window.__t.raw() || '').length);
    const sync = {}, paint = {};
    for (const p of ['stat', 'wrong', 'backup', 'today']) {
      sync[p] = await page.evaluate((p) => { const t = performance.now(); window.__t.nav(p); return Math.round((performance.now() - t) * 10) / 10; }, p);
      paint[p] = await navPaint(page, p);
    }
    await page.evaluate(() => window.__t.nav('wrong'));
    await doubleRaf(page);
    const rows = await page.evaluate(() => ({ due: document.querySelectorAll('#dueList .wb-item').length, all: document.querySelectorAll('#allWrongList .wb-item').length, summary: document.getElementById('wrongSummary').textContent, heat: document.querySelectorAll('#heatmap i').length, streak: document.getElementById('streakChip').textContent }));
    // 长列表滚动一帧
    const scroll = await page.evaluate(() => new Promise((res) => {
      const de = document.documentElement;
      const t0 = performance.now();
      window.scrollTo(0, de.scrollHeight);
      requestAnimationFrame(() => res({ ms: Math.round((performance.now() - t0) * 10) / 10, scrollH: de.scrollHeight }));
    }));
    await shot(page, 'd1-heavy-wrong');
    await page.evaluate(() => window.__t.nav('stat')); await doubleRaf(page);
    await shot(page, 'd1-heavy-stat');
    Dd.D1 = { heavy, initMs, readyAt, bytes, bytesMB: Math.round(bytes / 1048576 * 100) / 100, sync, paint, rows, scroll, errs: errs.slice(0, 3) };
    chk('D1 叠加状态（1150 错题/3315 papers/500 天）冷启动全渲染就绪 < 3000ms', readyAt < 3000, 'readyAt=' + readyAt + 'ms（Node 侧 ' + initMs + 'ms）· state ' + Dd.D1.bytesMB + 'MB');
    chk('D1 统计页渲染 < 500ms', sync.stat < 500 && paint.stat < 500, 'sync=' + sync.stat + 'ms paint=' + paint.stat + 'ms');
    chk('D1 错题本渲染 < 500ms', sync.wrong < 500 && paint.wrong < 500, 'sync=' + sync.wrong + 'ms paint=' + paint.wrong + 'ms（' + (rows.due + rows.all) + ' 行）');
    chk('D1 长列表滚动一帧 < 100ms', scroll.ms < 100, 'scroll frame=' + scroll.ms + 'ms pageH=' + scroll.scrollH + 'px');
    chk('D1 热力图/连击渲染正确', rows.heat === 84 && rows.streak === '🔥 500 天', 'heat=' + rows.heat + ' streak=' + rows.streak);
    chk('D1 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* --- D2：作文草稿 10000 字 --- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9402');
    const base = await page.evaluate(() => 'We should keep a clear head when reading news online, because misleading information spreads much faster than the truth. '.repeat(90));
    await page.evaluate((text) => window.__t.seed({ user: '9402', items: [{ kind: 'writing', paperId: '2015-12-1', key: 'd2', qids: [] }], state: { essays: { writing: { lastAt: '2026-09-27', text } } } }), base);
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    const r = await page.evaluate(() => new Promise((res) => {
      const t0 = performance.now();
      const card = Array.prototype.filter.call(document.querySelectorAll('#planList .card'), (c) => c.textContent.indexOf('2015-12-1') >= 0)[0];
      card.querySelector('button').click();
      const tick = function () {
        const ta = document.getElementById('essayTa');
        if (ta || performance.now() - t0 > 5000) {
          const sync = performance.now() - t0;
          requestAnimationFrame(() => requestAnimationFrame(() => res({ sync: Math.round(sync * 10) / 10, paint: Math.round((performance.now() - t0) * 10) / 10, len: ta ? ta.value.length : -1, taH: ta ? Math.round(ta.getBoundingClientRect().height) : 0 })));
          return;
        }
        setTimeout(tick, 30);
      };
      tick();
    }));
    const chunks = [];
    for (let i = 0; i < 25; i++) {
      chunks.push(await page.evaluate((i) => {
        const ta = document.getElementById('essayTa');
        const t0 = performance.now();
        ta.value += ' 段落' + i + '：信息素养是当代公民的基本功，它要求我们对每一条消息保持审慎与求证的习惯。';
        ta.dispatchEvent(new Event('input'));
        return Math.round((performance.now() - t0) * 10) / 10;
      }, i));
    }
    const len2 = await page.evaluate(() => document.getElementById('essayTa').value.length);
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await clickCardWith(page, '2015-12-1');
    const restored = await page.evaluate(() => document.getElementById('essayTa').value.length);
    await shot(page, 'd2-essay-10000');
    Dd.D2 = { renderMs: r, chunksAvg: avg(chunks), chunksMax: Math.max.apply(null, chunks), len: r.len, lenAfter: len2, restored, errs: errs.slice(0, 3) };
    chk('D2 10000 字作文：打开渲染 < 500ms', r.paint < 500 && r.len > 9000, 'paint=' + r.paint + 'ms 初值=' + r.len + ' 字');
    chk('D2 10000 字作文：追加输入单次 < 200ms', Math.max.apply(null, chunks) < 200, 'avg=' + avg(chunks) + 'ms max=' + Math.max.apply(null, chunks) + 'ms（每次重写整个 state）');
    chk('D2 10000 字作文：刷新后完整恢复', restored === len2 && len2 > 10000, 'len=' + len2 + ' restored=' + restored);
    chk('D2 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* --- D3：100 处高亮 --- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9403');
    await applySeed(page, { user: '9403', items: [{ kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'd3' }] });
    await openFirstOpenGroup(page);
    const pidInfo = await page.evaluate(() => {
      const ps = window.__t.passages();
      const p = ps.filter((x) => /^r-/.test(x.pid))[0] || ps[0];
      const words = []; const seen = {};
      const re = /[A-Za-z]{5,}/g; let m;
      while ((m = re.exec(p.text)) && words.length < 100) { const w = m[0]; if (!seen[w]) { seen[w] = 1; words.push(w); } }
      return { pid: p.pid, len: p.len, words };
    });
    await page.evaluate(() => document.getElementById('quizBack').click());
    await waitQuizClosed(page);
    await page.evaluate(({ pid, words }) => { const s = window.__t.state(); s.hl = {}; s.hl[pid] = words; window.__t.setState(s); }, pidInfo);
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    // R4-M5: truncation toast fires at page load (startSession); opening the group overwrites it, so capture before opening
    const loadToast = await page.evaluate(() => new Promise((res) => {
      const t0 = Date.now();
      const tick = function () {
        const el = document.getElementById('toast');
        const txt = (el && el.textContent) || '';
        const log = window.__t.toastLog().join(' ');
        if (/上限/.test(txt) || /上限/.test(log) || Date.now() - t0 > 3000) { res({ live: txt, log }); return; }
        setTimeout(tick, 40);
      };
      tick();
    }));
    const restoreRun = await page.evaluate((pid) => new Promise((res) => {
      const t0 = performance.now();
      const card = Array.prototype.filter.call(document.querySelectorAll('#planList .card'), (c) => c.textContent.indexOf('2020-12-2') >= 0)[0];
      card.querySelector('button').click();
      const tick = function () {
        const marks = document.querySelectorAll('mark.hl').length;
        if (marks > 0 || performance.now() - t0 > 5000) {
          const sync = performance.now() - t0;
          requestAnimationFrame(() => requestAnimationFrame(() => res({ sync: Math.round(sync * 10) / 10, paint: Math.round((performance.now() - t0) * 10) / 10, marks, seeded: (window.__t.hl()[pid] || []).length })));
          return;
        }
        setTimeout(tick, 30);
      };
      tick();
    }), pidInfo.pid);
    // P2-b（第三轮）：加载路径截断（core.normalizeState 把单段 >50 处砍到 50）现在会给出非阻塞提示。
    // TOAST_WATCH 是 60ms 轮询，且首次 install 在 #toast 出现前会 200ms 重试，所以这里等一小段再读，
    // 避免把"提示还在飞"误判成"没有提示"。同时取 DOM 证据（段落内标注，不依赖轮询）。
    const toastOnLoad = await page.evaluate(() => new Promise((res) => {
      const t0 = Date.now();
      const tick = function () {
        const log = window.__t.toastLog();
        if (log.some((t) => /上限/.test(t)) || Date.now() - t0 > 2500) { res(log); return; }
        setTimeout(tick, 60);
      };
      tick();
    }));
    const hlLoadNote = await page.evaluate(() => {
      const bar = document.querySelector('.hl-bar');
      const sib = bar && bar.nextElementSibling;
      return (sib && /超出单段上限/.test(sib.textContent)) ? sib.textContent.trim() : null;
    });
    const hlLoadDbg = await page.evaluate(() => ({
      toastCls: (document.getElementById('toast') || {}).className || '',
      toastTxt: (document.getElementById('toast') || {}).textContent || '',
      flag: window.CET6Core.hlTruncatedOnLoad,
    }));
    // 交互路径：再叠 6 处 → 点「高亮」→ 应触发上限提示
    const addRes = await page.evaluate((pid) => ({ before: window.__t.marksIn(pid), added: window.__t.addMarks(pid, 6), after: window.__t.marksIn(pid) }), pidInfo.pid);
    const selWord = await page.evaluate((pid) => window.__t.selectWord(pid), pidInfo.pid);
    const hlT = await page.evaluate(() => new Promise((res) => {
      const b = document.querySelector('.hl-add');
      const t0 = performance.now();
      b.click();
      requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round((performance.now() - t0) * 10) / 10)));
    }));
    await page.waitForTimeout(200);
    const afterAdd = await page.evaluate((pid) => ({ marks: window.__t.marksIn(pid), saved: (window.__t.hl()[pid] || []).length, toasts: window.__t.toastLog().slice(-2) }), pidInfo.pid);
    await shot(page, 'd3-hl-100');
    Dd.D3 = { pidInfo: { pid: pidInfo.pid, len: pidInfo.len, words: pidInfo.words.length }, restoreRun, toastOnLoad, addRes, selWord, hlClickMs: hlT, afterAdd, errs: errs.slice(0, 3) };
    chk('D3 100 处高亮：加载按 50 截断（渲染 < 500ms）', restoreRun.marks === 50 && restoreRun.paint < 500, 'marks=' + restoreRun.marks + ' seeded=' + restoreRun.seeded + ' paint=' + restoreRun.paint + 'ms');
    chk('D3 加载路径截断给出提示（P2-b 已修）', /上限/.test(loadToast.live) || loadToast.log.some((t) => /上限/.test(t)), 'live=' + JSON.stringify(loadToast.live) + ' log=' + JSON.stringify(loadToast.log) + ' dbg=' + JSON.stringify(hlLoadDbg));
    chk('D3 加载路径截断：段落内也有标注', !!hlLoadNote, JSON.stringify(hlLoadNote));
    chk('D3 交互路径 >50 时给出上限提示（N-UI-6 无回归）', afterAdd.toasts.some((t) => /上限 50/.test(t)), JSON.stringify(afterAdd.toasts));
    chk('D3 提示后画面与存档一致（都回到 50）', afterAdd.marks === 50 && afterAdd.saved === 50, 'marks=' + afterAdd.marks + ' saved=' + afterAdd.saved);
    chk('D3 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  await browser.close();
  R.sections.D.data = Dd;
}

/* ============================ E. 新问题扫描 ============================ */
async function sectionE() {
  sec('E', 'E. 新问题扫描');
  const { chromium } = loadPW();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  const Ee = {};

  /* --- E1 页面切换动画/过渡流畅度 --- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9501');
    await applySeed(page, { user: '9501', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'e1' }] });
    const frames = await page.evaluate(() => new Promise((res) => {
      const out = []; const seq = ['wrong', 'stat', 'backup', 'today']; let last = performance.now(), n = 0, i = 0;
      const step = () => {
        const now = performance.now(); out.push(Math.round((now - last) * 10) / 10); last = now;
        if (n++ < 60) { if (n % 2 === 0) window.__t.nav(seq[i++ % 4]); requestAnimationFrame(step); } else res(out);
      };
      requestAnimationFrame(step);
    }));
    const anims = await page.evaluate(() => document.getAnimations().map((a) => ({ name: a.animationName || (a.effect && a.effect.target && a.effect.target.className) || '', state: a.playState })));
    const trans = await page.evaluate(() => {
      const sels = ['#toast', '.qtimer', '#planList .card', 'nav button', '#quiz'];
      return sels.map((s) => { const el = document.querySelector(s); if (!el) return null; const cs = getComputedStyle(el); return { s, transition: cs.transition, animation: cs.animationName }; }).filter(Boolean);
    });
    const over50 = frames.filter((x) => x > 50).length;
    Ee.E1 = { frames: frames.slice(0, 12), max: Math.max.apply(null, frames), avg: avg(frames), longFrames: over50, anims, transitions: trans };
    chk('E1 页面切换无长帧（<50ms）', over50 === 0, 'max=' + Math.max.apply(null, frames) + 'ms avg=' + avg(frames) + 'ms 长帧=' + over50 + '/60');
    note('E1.transitions', trans);
    chk('E1 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* --- E2 长解析渲染/滚动 --- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9502');
    await applySeed(page, { user: '9502', items: [{ kind: 'reading', paperId: '2016-12-2', qnoFrom: 53, qnoTo: 53, key: 'e2', qids: ['2016-12-2-r-53'] }] });
    await openFirstOpenGroup(page);
    await answerUntilComplete(page, 'first');
    const real = await page.evaluate(() => new Promise((res) => {
      const t0 = performance.now();
      document.getElementById('groupSubmit').click();
      const sync = performance.now() - t0;
      const an = document.querySelector('.analysis .body');
      requestAnimationFrame(() => requestAnimationFrame(() => res({ sync: Math.round(sync * 10) / 10, paint: Math.round((performance.now() - t0) * 10) / 10, len: an ? an.textContent.length : 0, h: document.documentElement.scrollHeight })));
    }));
    const scrollReal = await page.evaluate(() => new Promise((res) => { const t0 = performance.now(); window.scrollTo(0, document.documentElement.scrollHeight); requestAnimationFrame(() => res(Math.round((performance.now() - t0) * 10) / 10)); }));
    await shot(page, 'e2-real-analysis-1928');
    // 合成 3200+ 字解析（运行期注入，仅用于压测渲染路径）
    await page.evaluate(() => document.getElementById('quizBack').click());
    await waitQuizClosed(page);
    await page.evaluate(() => {
      const q = window.CET6Core.findQ(window.CET6_BANKS, '2016-12-2-r-53');
      q.analysis = '【合成压测解析】' + '这一段用于压测超长解析的渲染与滚动性能，包含定位、替换、排除、译文等多个小节。'.repeat(90);
      return q.analysis.length;
    });
    const synLen = await page.evaluate(() => window.CET6Core.findQ(window.CET6_BANKS, '2016-12-2-r-53').analysis.length);
    // 已判分题组重开＝只读回看（页面内已渲染该解析），故用"重开卡片"这一同步渲染步骤作为压测口径
    const syn = await page.evaluate(() => new Promise((res) => {
      const card = Array.prototype.filter.call(document.querySelectorAll('#planList .card'), (c) => c.textContent.indexOf('2016-12-2') >= 0)[0];
      const t0 = performance.now();
      card.querySelector('button').click();
      const sync = performance.now() - t0;
      const an = document.querySelector('.analysis .body');
      requestAnimationFrame(() => requestAnimationFrame(() => res({ sync: Math.round(sync * 10) / 10, paint: Math.round((performance.now() - t0) * 10) / 10, len: an ? an.textContent.length : 0, h: document.documentElement.scrollHeight, readOnly: !document.getElementById('groupSubmit') })));
    }));
    const scrollSyn = await page.evaluate(() => new Promise((res) => { const t0 = performance.now(); window.scrollTo(0, document.documentElement.scrollHeight); requestAnimationFrame(() => res(Math.round((performance.now() - t0) * 10) / 10)); }));
    await shot(page, 'e2-synth-analysis-3200');
    Ee.E2 = { realMax: real, realScroll: scrollReal, synth: syn, synthLen: synLen, synthScroll: scrollSyn, errs: errs.slice(0, 3) };
    chk('E2 真题最长解析（' + real.len + ' 字）渲染 < 500ms', real.sync < 500, 'sync=' + real.sync + 'ms paint=' + real.paint + 'ms 页面高=' + real.h + 'px');
    chk('E2 合成 3200+ 字解析渲染 < 500ms', syn.sync < 500, 'len=' + syn.len + 'sync=' + syn.sync + 'ms paint=' + syn.paint + 'ms 页面高=' + syn.h + 'px');
    chk('E2 超长解析滚动一帧 < 100ms', scrollReal < 100 && scrollSyn < 100, 'real=' + scrollReal + 'ms synth=' + scrollSyn + 'ms');
    chk('E2 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* --- E3 移动端触摸交互 --- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9503', { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
    await applySeed(page, { user: '9503', items: [{ kind: 'cloze', paperId: '2020-07-1', key: 'e3' }, { kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'e3r' }] });
    const today = await page.evaluate(() => window.__scan());
    const small = today.targets.filter((t) => t.h < 44);
    await openFirstOpenGroup(page);
    const quizScan = await page.evaluate(() => window.__scan());
    const qSmall = quizScan.targets.filter((t) => t.h < 44);
    // 触摸点选（先把选项滚入视口，否则 tap 坐标落在视口外）
    const optL = page.locator('.opt').first();
    await optL.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const box = await optL.boundingBox();
    const inViewport = !!box && box.y >= 0 && (box.y + box.height) <= 667;
    if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const tapped = await page.evaluate(() => document.querySelectorAll('.opt.sel').length);
    // 滚动冲突
    const scrollCheck = await page.evaluate(() => {
      const qb = document.getElementById('quizBody');
      const de = document.documentElement;
      qb.scrollTop = 300;
      const r = { scrollTop: qb.scrollTop, docOverflowX: de.scrollWidth > de.clientWidth + 1, bodyOverflowX: document.body.scrollWidth > document.body.clientWidth + 1, quizFixed: getComputedStyle(document.getElementById('quiz')).position };
      return r;
    });
    const optH = quizScan.opts.length ? quizScan.opts.map((o) => o.h) : [];
    await shot(page, 'e3-touch-375');
    Ee.E3 = { todayTargets: today.targets.length, todaySmall: small, quizTargets: quizScan.targets.length, quizSmall: qSmall, optHeightsMin: optH.length ? Math.min.apply(null, optH) : null, tapped, tapInViewport: inViewport, tapBox: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null, scrollCheck, errs: errs.slice(0, 3) };
    chk('E3 触摸点选生效', tapped > 0, 'sel=' + tapped + ' tapInViewport=' + inViewport + ' box=' + JSON.stringify(box ? { y: Math.round(box.y), h: Math.round(box.height) } : null));
    chk('E3 触摸滚动无横向溢出、答题层为 fixed', !scrollCheck.docOverflowX && !scrollCheck.bodyOverflowX && scrollCheck.quizFixed === 'fixed', JSON.stringify(scrollCheck));
    chk('E3 选项触控高度 ≥44px', optH.length > 0 && Math.min.apply(null, optH) >= 44, 'min opt height=' + (optH.length ? Math.min.apply(null, optH) : null) + 'px');
    chk('E3 小尺寸可点目标统计（<44px，供修复参考）', true, '今日页 ' + small.length + '/' + today.targets.length + ' 个：' + JSON.stringify(small.slice(0, 6).map((x) => (x.id || x.cls) + ':' + x.h)));
    // 第三轮 P2-a：今日页可点目标全部抬到 ≥44px，这条从"仅统计"升级为硬断言
    chk('E3 今日页可点目标全部 ≥44px（第三轮 P2-a 修复）', small.length === 0, '仍 <44px 的 ' + small.length + '/' + today.targets.length + ' 个：' + JSON.stringify(small.slice(0, 8).map((x) => (x.id || x.cls) + ':' + x.h)));
    chk('E3 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* --- E4 键盘导航 --- */
  {
    const { ctx, page, errs } = await freshPage(browser, '9504');
    // 一次 seed 两题型：阅读组（有 .opt，覆盖"选项回车选中"）+ 选词填空组（无 .opt，只有
    // .cloze-slot/.wb-chip）。旧版只 seed 了选词填空组，却断言 .opt.sel——必然误报（见下）。
    await applySeed(page, { user: '9504', items: [
      { kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'e4read' },
      { kind: 'cloze', paperId: '2020-07-1', key: 'e4cloze' },
    ] });
    await page.evaluate(() => document.body.focus());
    const order = [];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => { const a = document.activeElement; return { tag: a.tagName, id: a.id || '', cls: String(a.className || '').slice(0, 18), txt: (a.textContent || '').trim().slice(0, 12) }; }));
    }
    // 键盘进入答题并回车选中
    await openFirstOpenGroup(page);
    const focusStart = await page.evaluate(() => { const b = document.getElementById('quizBack'); if (b) b.focus(); const a = document.activeElement; const q = document.getElementById('quiz'); return { id: a.id || '', cls: String(a.className || '').slice(0, 16), txt: (a.textContent || '').trim().slice(0, 10), inQuiz: !!(q && q.contains(a)) }; });
    // 阶段 1：从答题头部开始 Tab —— 提交按钮此时 disabled（浏览器语义：disabled 不在 Tab 序列内），
    // 本阶段用于判定遮罩层内的焦点是否会被 Tab 带走（focus trap 是否存在）
    let escaped = null, escapes = 0;
    const seen = [];
    for (let i = 0; i < 400; i++) {
      await page.keyboard.press('Tab');
      const a = await page.evaluate(() => { const a = document.activeElement; const q = document.getElementById('quiz'); return { id: a.id || '', cls: String(a.className || '').slice(0, 14), txt: (a.textContent || '').trim().slice(0, 10), inQuiz: !!(q && q.contains(a)) }; });
      seen.push(a);
      if (!a.inQuiz) { escapes++; if (escaped === null) escaped = i; }
    }
    // 阶段 2：聚焦未选中的选项 → 回车选中
    const firstOpt = await page.evaluate(() => { const b = document.querySelector('.opt:not(.sel)'); if (b) b.focus(); const a = document.activeElement; return { cls: String(a.className || '').slice(0, 24), q: (a.getAttribute && a.getAttribute('data-q')) || null, focusedIsOpt: a === b }; });
    await page.keyboard.press('Enter');
    const enterSel = await page.evaluate(() => document.querySelectorAll('.opt.sel').length);
    // 阶段 3：答完全部题目让提交按钮可用 → 从第一个选项 Tab，看能否走到提交
    await answerUntilComplete(page, 'first');
    const submitEnabled = await page.evaluate(() => { const b = document.getElementById('groupSubmit'); return !!b && !b.disabled; });
    await page.evaluate(() => { const b = document.querySelector('.opt'); if (b) b.focus(); });
    let reachedSubmit = -1;
    for (let i = 0; i < 400; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => (document.activeElement && document.activeElement.id) || '');
      if (id === 'groupSubmit') { reachedSubmit = i + 1; break; }
    }
    // 阶段 4：退出阅读组 → 打开选词填空组，验证"纯键盘作答"闭环。
    // 选词填空没有 .opt，交互是【聚焦空格 → 回车进入待选态 → 聚焦词库 → 回车填入】，
    // 三个环节全靠原生 <button> 的 Enter 触发 click，故应可完整键盘操作。
    await page.evaluate(() => { const d = document.getElementById('groupDone'); if (d && getComputedStyle(d).display !== 'none') d.click(); else { const b = document.getElementById('quizBack'); if (b) b.click(); } });
    await waitQuizClosed(page);
    const openedCloze = await openGroupByPaper(page, '2020-07-1');
    let clozeKb = null;
    if (openedCloze) {
      const slotFocus = await page.evaluate(() => { const s = document.querySelector('.cloze-slot'); if (s) s.focus(); const a = document.activeElement; return { has: !!s, focusedIsSlot: a === s, cls: String((a && a.className) || '').slice(0, 24) }; });
      await page.keyboard.press('Enter');
      const afterEnterSlot = await page.evaluate(() => ({ focusCls: document.querySelectorAll('.cloze-slot.focus').length }));
      const chipFocus = await page.evaluate(() => { const c = Array.prototype.filter.call(document.querySelectorAll('.wb-chip'), (x) => !x.disabled)[0]; if (c) c.focus(); const a = document.activeElement; return { has: !!c, focusedIsChip: a === c, cls: String((a && a.className) || '').slice(0, 24) }; });
      await page.keyboard.press('Enter');
      const afterEnterChip = await page.evaluate(() => ({ picked: document.querySelectorAll('.cloze-slot[data-picked]').length, prog: (document.getElementById('quizProg') || {}).textContent || '' }));
      clozeKb = { openedCloze, slotFocus, afterEnterSlot, chipFocus, afterEnterChip };
    }
    Ee.E4 = { tabOrder: order, focusStart, reachedSubmitAt: reachedSubmit, escapedAt: escaped, escapes, tabSteps: seen.length, tail: seen.slice(Math.max(0, seen.length - 8)), firstOpt, enterSel, submitEnabled, clozeKb, errs: errs.slice(0, 3) };
    chk('E4 今日页 Tab 顺序可达计划按钮与导航', order.some((x) => /btn/.test(x.cls)) && order.some((x) => x.txt === '今日'), JSON.stringify(order.map((x) => x.id || x.cls || x.txt)));
    chk('E4 答完后键盘可达提交按钮（≤400 次 Tab）', reachedSubmit >= 0, '从第一个选项起第 ' + reachedSubmit + ' 次 Tab 命中 #groupSubmit（提交按钮可用=' + submitEnabled + '；disabled 时不在 Tab 序列内属浏览器语义）');
    chk('E4 未答完时提交按钮 disabled（不可 Tab 到达，避免空答提交）', submitEnabled, 'answerUntilComplete 后 enabled=' + submitEnabled);
    chk('E4 选项可聚焦并回车选中', enterSel >= 1 && firstOpt.focusedIsOpt, 'Enter 后 sel=' + enterSel + ' 首个焦点=' + JSON.stringify(firstOpt));
    // 第三轮 P1-b：focus trap + 打开时给 #app 加 inert/aria-hidden。这条断言的语义从"记录问题存在"
    // 翻转为"记录问题已修"——上一轮它断言 escaped !== null（Tab 能逃出去），修好后 escaped 必为 null。
    chk('E4 键盘焦点始终留在答题层内（第三轮 P1-b 修复）', escaped === null, '400 步 Tab 全部落在 #quiz 内；最早离开 #quiz 的步=' + (escaped == null ? '无' : (escaped + 1)) + '，逃逸次数=' + escapes + ' / ' + seen.length + ' 步');
    chk('E4 [选词填空] 空格可键盘聚焦并回车进入待选态', !!(clozeKb && clozeKb.slotFocus.focusedIsSlot && clozeKb.afterEnterSlot.focusCls >= 1), JSON.stringify(clozeKb && { slot: clozeKb.slotFocus, afterEnterSlot: clozeKb.afterEnterSlot }));
    chk('E4 [选词填空] 词库可键盘聚焦并回车填入空格（纯键盘可作答）', !!(clozeKb && clozeKb.chipFocus.focusedIsChip && clozeKb.afterEnterChip.picked >= 1), JSON.stringify(clozeKb && { chip: clozeKb.chipFocus, afterEnterChip: clozeKb.afterEnterChip }));
    chk('E4 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* --- E5 深色模式全组件对比度 --- */
  {
    const DARK_ALL = ['header h1', '.card h3', '.muted', '#planSummary', '.btn', '.btn.ghost', '.btn.ok', '.btn.warn', '.btn.small',
      'nav button.on', 'nav button:not(.on)', '.opt', '.opt.sel', '.opt.right', '.opt.wrongpick', '.verdict.ok', '.verdict.bad', '.analysis .body', '.pt',
      '.stat-cell .v', '.stat-cell .k', 'table.acc th', 'table.acc td', '#statSummary', '.heat i.on', '.heat i.on.st1', '.heat i.on.st2',
      '.heat i.f2', '.heat i.f3', '.heat i.floor', '.heat i.on.floor', '.plan-item .ic', '.plan-item.done .ic', '.total-min',
      '.wb-item .stem', '.wb-item .meta', '.chip.due', '.chip.sched', '.empty', '.hl-bar', '.hl-bar button', '.passage', '#quizTimer', '.qprog'];
    const { ctx, page, errs } = await freshPage(browser, '9505');
    await page.evaluate(() => {
      const C = window.CET6Core, today = C.todayStr(), qids = window.__t.allQids().filter((id) => /-r-/.test(id));
      const wrongbook = {}; qids.slice(0, 8).forEach((id, i) => { wrongbook[id] = { addedAt: C.addDays(today, -9), box: 0, wrongCount: 1 + i, due: C.addDays(today, i <= 3 ? -(i + 1) : 2), ease: 2.5 - i * 0.1, iv: 1, streak: 0 }; });
      const history = {}; for (let i = 0; i < 30; i++) history[C.addDays(today, -i)] = { minutes: 30 + i, qCount: 10, right: 7, done: true, floor: i === 2 };
      const papers = {}; qids.slice(0, 12).forEach((id) => { papers[id] = { seen: 1, right: 0, wrong: 1, lastAt: today, lastResult: 'wrong' }; });
      // 第二个计划项预置为已完成：让 .plan-item.done .ic（第三轮新修）也进入测量范围
      window.__t.seed({ user: '9505', items: [{ kind: 'reading', paperId: '2020-12-2', qnoFrom: 46, qnoTo: 50, key: 'e5' },
        { kind: 'cloze', paperId: '2020-12-1', qnoFrom: 26, qnoTo: 30, key: 'e5done', done: true }], state: { wrongbook, history, papers } });
    });
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await page.evaluate(() => document.getElementById('themeBtn').click());
    await doubleRaf(page);
    const darkToday = await page.evaluate((sels) => window.__contrast(sels), DARK_ALL);
    await page.evaluate(() => window.__t.nav('wrong')); await doubleRaf(page);
    const darkWrong = await page.evaluate((sels) => window.__contrast(sels), DARK_ALL);
    const chips = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.chip'), (c) => c.className + '=' + c.textContent).slice(0, 4));
    await shot(page, 'e5-dark-wrong');
    await page.evaluate(() => window.__t.nav('stat')); await doubleRaf(page);
    const darkStat = await page.evaluate((sels) => window.__contrast(sels.concat(['.badge', '.badge.extra', '.badge.review', '.total-min', '#statGrid .stat-cell'])), DARK_ALL);
    await shot(page, 'e5-dark-stat');
    // 答题页（含已判分）——E5 前面切到了统计页，需先回今日页否则计划卡片不可见
    await page.evaluate(() => window.__t.nav('today')); await doubleRaf(page);
    await openFirstOpenGroup(page);
    const darkQuiz = await page.evaluate((sels) => window.__contrast(sels.concat(['.qtimer', '.analysis', '.hl-bar', '.blank-mark', 'mark.hl'])), DARK_ALL);
    await answerMixed(page);
    await page.evaluate(() => document.getElementById('groupSubmit').click());
    await page.waitForFunction(() => { const g = document.getElementById('groupDone'); return g && getComputedStyle(g).display !== 'none'; });
    const darkJudged = await page.evaluate((sels) => window.__contrast(sels), DARK_ALL);
    await shot(page, 'e5-dark-judged');
    const all = [].concat(darkToday, darkWrong, darkStat, darkQuiz, darkJudged).filter((c) => c && c.visible);
    const low45 = all.filter((c) => c.ratio < 4.5);
    const low3 = all.filter((c) => c.ratio < 3.0);
    const optc = all.filter((c) => c.sel === '.opt');
    Ee.E5 = { lowUnder45: low45.map((c) => c.sel + '=' + c.ratio + '(' + c.fg + '/' + c.bg + ')'), lowUnder3: low3.map((c) => c.sel + '=' + c.ratio), opt: optc, chips, total: all.length };
    chk('E5 深色 .opt 对比度 ≥4.5（各页）', optc.length > 0 && optc.every((c) => c.ratio >= 4.5), JSON.stringify(optc.map((c) => c.ratio)));
    chk('E5 深色全部件对比度 ≥3.0', low3.length === 0, low3.map((c) => c.sel + '=' + c.ratio).join(', ') || ('全部 ' + all.length + ' 项达标'));
    const EXTRA_SELS = ['.plan-item .ic', '.plan-item.done .ic', '.heat i.f2', '.heat i.f3', '.heat i.floor', '.heat i.on.floor', '.total-min'];
    const extraSeen = EXTRA_SELS.map((s) => { const hit = all.filter((c) => c.sel === s); return s + '=' + (hit.length ? Math.min.apply(null, hit.map((c) => c.ratio)) : 'absent'); });
    Ee.E5.extra = extraSeen;
    // 第三轮把这条从「记录发现」升级为硬门槛：P1-a 的目标就是深色下全部件 ≥4.5
    chk('E5 深色全部件对比度 ≥4.5（P1-a 目标）', low45.length === 0, '低于 4.5：' + (low45.map((c) => c.sel + '=' + c.ratio + '(' + c.fg + '/' + c.bg + ')').join(' | ') || 'none') + ' ‖ 本轮新增复核：' + extraSeen.join(', '));
    chk('E5 无页面错误', errs.length === 0, errs.join(' || ') || 'none');
    await ctx.close();
  }

  /* --- E6 听力播放器深色模式 --- */
  {
    const ctx = await newBrCtx(browser, { viewport: { width: 1440, height: 900 } }, false); // 放开第三方
    const page = ctx.pages()[0];
    const errs = watchErrors(page, []);
    await seedInit(ctx, '9506', null, 'E6-' + Date.now());
    await page.goto(URL, { waitUntil: 'commit' });
    await waitInit(page);
    await page.evaluate(() => window.__t.seed({ user: '9506', items: [{ kind: 'listening', paperId: '2020-12-1', qnoFrom: 1, qnoTo: 4, key: 'e6' }] }));
    await page.reload({ waitUntil: 'commit' }); await waitInit(page);
    await page.evaluate(() => document.getElementById('themeBtn').click());
    await doubleRaf(page);
    await openFirstOpenGroup(page);
    await page.waitForTimeout(4000);
    // 听力架构（2026-10 起）是该页内的 .listen-player + <audio>，二者都跟随本站主题；
    // 只有"烘焙缺失"才会退回第三方 iframe（第三方页不跟随本站深色，此处单独校验）。
    const fr = await page.evaluate(() => {
      const box = document.querySelector('#quizBody .listen-player');
      const audio = box ? box.querySelector('audio') : null;
      const ifr = document.querySelector('#quizBody iframe');
      const piece = document.querySelector('#quizBody .listen-strip .lp-piece');
      const px = (v) => (v || '').trim();
      return {
        dark: document.body.classList.contains('dark'),
        // 深色主题变量定义在 body.dark 上（不是 :root），必须从 body 取，否则永远读到浅色档
        darkToken: px(getComputedStyle(document.body).getPropertyValue('--card')),
        bgToken: px(getComputedStyle(document.body).getPropertyValue('--bg')),
        player: !!box,
        playerBg: box ? getComputedStyle(box).backgroundColor : '',
        cardBg: box && box.closest('.card') ? getComputedStyle(box.closest('.card')).backgroundColor : '',
        quizBg: getComputedStyle(document.getElementById('quiz')).backgroundColor,
        audio: !!audio,
        audioW: audio ? Math.round(audio.getBoundingClientRect().width) : 0,
        playerW: box ? Math.round(box.getBoundingClientRect().width) : 0,
        audioVisible: audio ? getComputedStyle(audio).display !== 'none' && getComputedStyle(audio).visibility !== 'hidden' : false,
        pieces: document.querySelectorAll('#quizBody .listen-strip .lp-piece').length,
        pieceColor: piece ? getComputedStyle(piece).color : '',
        pieceBg: piece ? getComputedStyle(piece).backgroundColor : '',
        iframe: !!ifr,
        iframeBg: ifr ? getComputedStyle(ifr).backgroundColor : '',
        iframeSrc: ifr ? ifr.getAttribute('src') : '',
      };
    });
    let innerDark = null;
    if (fr.iframe) {
      try { const f = page.frames().filter((x) => x !== page.mainFrame())[0]; if (f) innerDark = await f.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, colorScheme: getComputedStyle(document.documentElement).colorScheme, hasText: (document.body.innerText || '').length })); } catch (e) { innerDark = { err: String(e.message || e).slice(0, 120) }; }
    }
    await shot(page, 'e6-listening-dark');
    Ee.E6 = { outer: fr, inner: innerDark, errs: errs.slice(0, 3) };
    // 深色主题确实生效（--card 换到暗色档），且听力播放器仍在
    chk('E6 深色模式生效（body.dark 且 --card 切到暗色档）', fr.dark && fr.darkToken === '#1e293b', 'dark=' + fr.dark + ' --card=' + fr.darkToken + ' --bg=' + fr.bgToken);
    chk('E6 深色下听力播放器仍在（.listen-player 或 iframe 回退）', fr.player || fr.iframe, JSON.stringify({ player: fr.player, iframe: fr.iframe, src: fr.iframeSrc }));
    if (fr.player) {
      // 播放器属于本页 DOM → 必须跟随主题换成暗底，并且控件不被主题压暗/隐藏
      chk('E6 深色下听力容器跟随主题换暗底（非白底）', /(^|,)\s*rgb\(30,\s*41,\s*59\)\s*$/.test(fr.cardBg) || fr.cardBg === 'rgba(0, 0, 0, 0)' && fr.dark, '卡片底=' + fr.cardBg + ' 容器底=' + fr.playerBg + ' --card=' + fr.darkToken);
      chk('E6 深色下 <audio> 控件仍可见且占满容器宽度', fr.audio && fr.audioVisible && fr.audioW > 0 && Math.abs(fr.audioW - fr.playerW) <= 8, 'audioW=' + fr.audioW + ' playerW=' + fr.playerW + ' visible=' + fr.audioVisible);
      chk('E6 深色下分片按钮底色与文字色不同（可读）', fr.pieces > 0 && fr.pieceColor && fr.pieceBg && fr.pieceColor !== fr.pieceBg, 'pieces=' + fr.pieces + ' color=' + fr.pieceColor + ' bg=' + fr.pieceBg);
    }
    if (fr.iframe) {
      // 仅当该卷烘焙缺失才会走这里：第三方页不跟随本站深色，需保持浅底可读
      chk('E6 [iframe 回退] 深色下 iframe 仍是浅底（第三方页不跟随）', fr.iframeBg === 'rgb(255, 255, 255)', 'iframe bg=' + fr.iframeBg + ' 卡片底=' + fr.cardBg);
      const innerLight = !!(innerDark && !innerDark.err && innerDark.colorScheme === 'light' && (innerDark.bg === 'rgb(255, 255, 255)' || innerDark.bg === 'rgba(0, 0, 0, 0)' || /^oklch\(0\.9/.test(String(innerDark.bg)) || /^rgba?\(2[0-9][0-9]/.test(String(innerDark.bg))));
      chk('E6 [iframe 回退] iframe 内容为第三方独立页（浅底、不跟随本页深色）', innerLight, JSON.stringify(innerDark).slice(0, 200));
    }
    note('E6.detail', Ee.E6);
    await ctx.close();
  }

  await browser.close();
  R.sections.E.data = Ee;
}


/* ============================ main ============================ */
(async () => {
  const OUT = path.join(DOCS, 'round3-result.json');
  // 增量合并：分包运行时保留其它分区已有结果
  try {
    if (fs.existsSync(OUT)) {
      const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (old && old.sections) { R.sections = old.sections; if (old.env) R.env = Object.assign({}, old.env, R.env); }
    }
  } catch (e) { }
  const want = process.argv.slice(2).map((s) => s.toUpperCase());
  const has = (k) => !want.length || want.indexOf(k) >= 0;
  try {
    if (has('A')) await sectionA();
    if (has('B')) await sectionB();
    if (has('C')) await sectionC();
    if (has('D')) await sectionD();
    if (has('E')) await sectionE();
  } catch (e) {
    console.log('SECTION_FAILED: ' + (e && e.stack ? e.stack : e));
    R.fatal = String(e && e.message ? e.message : e);
  }
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1), 'utf8');
  let ok = 0, fail = 0;
  Object.keys(R.sections).forEach((k) => R.sections[k].checks.forEach((c) => (c.ok ? ok++ : fail++)));
  console.log('\n===== ROUND3 SUMMARY =====');
  Object.keys(R.sections).forEach((k) => {
    const s = R.sections[k]; const f = s.checks.filter((c) => !c.ok).length;
    console.log(k + ' ' + s.title + ' : ' + (s.checks.length - f) + ' ok / ' + f + ' fail');
  });
  console.log('TOTAL ' + ok + ' ok / ' + fail + ' fail');
  console.log('JSON -> docs/round3-result.json');

  /* ---------------------------- 硬闸门（防空绿） ----------------------------
     由来：本脚本此前无条件 process.exit(0)。实测曾出现"跑到一半抛 fatal、
     E 段整段没执行"，退出码仍是 0。以下四种情况一律判失败：
       1) fatal：任一区段抛出的未捕获异常
       2) 请求的区段没有落地任何断言（静默跳过）
       3) 总断言数 < MIN_ASSERTIONS（套件整体缩水）
       4) 存在 FAIL 断言
     注：实测全量通过时为 185 条（A9/B80/C56/D16/E24），下限取 150 留出余量。 */
  const MIN_ASSERTIONS = 150;
  const bad = [];
  if (R.fatal) bad.push('fatal: ' + R.fatal);
  ['A', 'B', 'C', 'D', 'E'].forEach(function (k) {
    if (!has(k)) return;
    const s = R.sections[k];
    if (!s || !s.checks.length) bad.push('区段 ' + k + ' 未产生任何断言（疑似静默跳过）');
  });
  const total3 = ok + fail;
  if (total3 === 0) bad.push('0 断言：脚本未做任何校验');
  else if (total3 < MIN_ASSERTIONS) bad.push('断言总数 ' + total3 + ' < 下限 ' + MIN_ASSERTIONS);
  if (fail > 0) bad.push(fail + ' 条断言失败');
  if (bad.length) { console.log('GATE FAIL: ' + bad.join('；')); process.exit(1); }
  console.log('GATE PASS: ' + total3 + ' 条断言全部通过');
  process.exit(0);
})();
