// scripts/_env.js —— 本机（Windows）测试环境适配
// 昨天审计脚本写死在 Linux 沙箱路径（/home/gem/.aily、/opt/chromium），
// 在本机运行需动态探测 playwright-core 与本机浏览器。
const path = require('path');
const fs = require('fs');
const vm = require('vm');

function chromium() {
  const cands = [
    process.env.PW_PATH,
    path.join(__dirname, 'node_modules', 'playwright-core'),
    path.join(process.cwd(), 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const c of cands) { try { return require(c); } catch (e) {} }
  throw new Error('playwright-core not found；请先在本目录执行 npm install playwright-core');
}

// 本机浏览器探测：Edge / Chrome / 备用环境变量
const EXE = [
  process.env.CET6_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && fs.existsSync(p)) || null;

/* ---------- 按需加载架构下的"题库就绪"辅助 ----------
   2026-10 起应用改为「meta 骨架 + 按需加载卷」：首屏 window.CET6_BANKS 是空数组，
   卷正文在点击「开始」那一刻才动态注入。测试若要直接读 window.CET6_BANKS
   （判题、题库卡、篡改用例等），必须先注入目标卷，否则 BANKS 为空 ——
   轻则断言恒失败，重则 b.questions 取到 undefined 直接抛 TypeError。 */
const BANK_PREFIX = 'cet6-';
const BANK_GLOBAL = 'CET6_BANKS';
const META_GLOBAL = 'CET6_META';

async function ensurePaper(page, pid, timeoutMs) {
  return page.evaluate(({ pid, prefix, g, t }) => new Promise((res) => {
    const has = () => (window[g] || []).some((b) => b.id === pid);
    if (has()) return res(true);
    const s = document.createElement('script');
    s.src = 'bank/' + prefix + pid + '.js';
    s.onload = () => res(has());
    s.onerror = () => res(false);
    document.head.appendChild(s);
    setTimeout(() => res(has()), t || 15000);
  }), { pid, prefix: BANK_PREFIX, g: BANK_GLOBAL, t: timeoutMs });
}

async function ensureAllPapers(page, timeoutMs) {
  return page.evaluate(({ prefix, g, mg, t }) => new Promise((res) => {
    const order = (window[mg] && window[mg].order) || [];
    if (!order.length) return res(false);
    const has = (id) => (window[g] || []).some((b) => b.id === id);
    const need = order.filter((id) => !has(id));
    if (!need.length) return res(true);
    let left = need.length;
    const tick = () => { if (--left <= 0) res(true); };
    need.forEach((pid) => {
      const s = document.createElement('script');
      s.src = 'bank/' + prefix + pid + '.js';
      s.onload = tick; s.onerror = tick;
      document.head.appendChild(s);
    });
    setTimeout(() => res(order.every(has)), t || 60000);
  }), { prefix: BANK_PREFIX, g: BANK_GLOBAL, mg: META_GLOBAL, t: timeoutMs });
}

/* ---------- 题库实时统计（Node 侧读真实卷文件） ----------
   两仓的题量与"写作配图卷"并不相同（本仓 3315 题、6 卷看图作文；四级仓 3325 题、
   写作以文字命题为主、只有 3 卷配图）。用例里写死这些数字，在另一仓必然假红 ——
   这正是镜像分叉后最常复发的一类问题。这里直接从 app/bank/<前缀>-*.js 统计，
   作为唯一事实来源。

   返回 { papers, questions, imgWriting, writingWords }：
     papers       卷号数组（升序）
     questions    总题数（各卷 questions.length 之和）
     imgWriting    writing.image 非空的卷号（= 需要渲染配图的卷）
     writingWords  卷号 -> 卷面要求词数（从 prompt 的 "at least N words" 提取） */
function bankDigest(prefix) {
  const pre = prefix || BANK_PREFIX;
  const gname = BANK_GLOBAL;
  const out = { papers: [], questions: 0, imgWriting: [], writingWords: {} };
  const dir = path.join(__dirname, '..', 'app', 'bank');
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).filter((f) => f.indexOf(pre) === 0 && /\.js$/.test(f)).forEach((f) => {
    try {
      // 每卷一个全新上下文。注意：不能复用同一个 sandbox 再 delete 全局名 ——
      // 卷文件是 `window.X = window.X || []; window.X.push(...)`，而在 Node 侧
      // delete 一个 contextified sandbox 上的属性并不生效，会导致数组逐卷累加
      // （实测把 76 卷统计成 2926 卷）。开新上下文最省事且不会踩这个坑。
      const sandbox = {};
      sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f, timeout: 8000 });
      (sandbox[gname] || []).forEach((b) => {
        out.papers.push(b.id);
        out.questions += (b.questions || []).length;
        const w = b.writing || {};
        if (w.image) out.imgWriting.push(b.id);
        const m = /at least\s+(\d+)\s+words/i.exec(w.prompt || '');
        if (m) out.writingWords[b.id] = Number(m[1]);
      });
    } catch (e) { /* 单卷损坏不该让整体统计崩掉；卷质量问题由 verify_bank 负责报 */ }
  });
  out.papers.sort();
  out.imgWriting.sort();
  return out;
}

module.exports = { chromium, EXE, ensurePaper, ensureAllPapers, bankDigest };
