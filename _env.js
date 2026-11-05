// scripts/_env.js —— 本机（Windows）测试环境适配
// 昨天审计脚本写死在 Linux 沙箱路径（/home/gem/.aily、/opt/chromium），
// 在本机运行需动态探测 playwright-core 与本机浏览器。
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { pathToFileURL } = require('url');

/* ---------- file:// URL 构造（跨平台，2026-10-08 抽出来统一） ----------
   坑：以前每个用例各自写 'file:///' + 路径。
     · Windows：路径是 D:\CET6\app\index.html，拼出 file:///D:/... —— 对的；
     · Linux  ：路径本身以 / 开头（/home/runner/...），同样的拼法会变成
                file:////home/...（四道斜杠），浏览器直接打不开页面。
   CI 是 Linux，所以这个坑会让所有 file:// 用例在 CI 上必然失败。
   用标准库的 pathToFileURL 一劳永逸，两边都正确。 */
function fileUrl(p) {
  return pathToFileURL(p).href;
}

function chromium() {
  const cands = [
    process.env.PW_PATH,
    path.join(__dirname, 'node_modules', 'playwright-core'),
    path.join(process.cwd(), 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const c of cands) { try { return require(c); } catch (e) {} }
  throw new Error('playwright-core not found；请先在本目录执行 npm install playwright-core');
}

/* ---------- 浏览器探测（2026-10-08 补 Linux 分支） ----------
   原来只列了 Windows 上 Edge/Chrome 的绝对路径，Linux runner 上一个都不存在，
   EXE 会变成 null，浏览器起不来。现在分三级：
     1) 环境变量（CET6_BROWSER 优先，其次 CI 常见的 CHROME_BIN）
     2) 系统浏览器（Windows 的 Edge/Chrome + Linux 的常见路径）
     3) playwright 自带的 chromium（CI 上由 npx playwright install 下载）
   三级都找不到时返回 undefined（不能是 null）：让调用方把它当"未指定"，
   playwright 才会回退到它自己注册的浏览器。 */
const EXE = (function () {
  const cands = [
    process.env.CET6_BROWSER,
    process.env.CHROME_BIN,
    // Windows
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // Linux（GitHub Actions runner / 常见发行版）
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  const hit = cands.find((p) => fs.existsSync(p));
  if (hit) return hit;

  // 回退 playwright 自带 chromium
  try {
    const p = chromium().chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* playwright-core 没装或没下载浏览器，交给下一级 */ }

  return undefined;
})();

/* ---------- 按需加载架构下的"题库就绪"辅助 ----------
   2026-10 起应用改为「meta 骨架 + 按需加载卷」：首屏 window.CET6_BANKS 是空数组，
   卷正文在点击「开始」那一刻才动态注入。测试若要直接读 window.CET6_BANKS
   （判题、题库卡、篡改用例等），必须先注入目标卷，否则 BANKS 为空 ——
   轻则断言恒失败，重则 b.questions 取到 undefined 直接抛 TypeError。 */
const BANK_PREFIX = 'cet6-';
const BANK_GLOBAL = 'CET6_BANKS';
const META_GLOBAL = 'CET6_META';

/* ---------- 从 core.js 读「清单结构版本」PLAN_VERSION ----------
   2026-11-05：一批老脚本把 plan.v 写死成 3，而 PLAN_VERSION 已升到 8。
   ensurePlan() 只要发现 plan.v !== PLAN_VERSION 就整份丢弃重算 ——
   于是注入的 plan 从未生效，用例看到的永远是"自动生成的清单"，
   后续对着卡片/题目下手全部错位（表现为 TIMEOUT、草稿为空、取到 undefined）。
   凡是注入 plan 的夹具，v 一律取这里，别再写死。 */
function planVersion() {
  const p = path.join(__dirname, '..', 'app', 'core.js');
  const m = /CORE\.PLAN_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(p, 'utf8'));
  if (!m) throw new Error('无法从 app/core.js 解析 CORE.PLAN_VERSION');
  return Number(m[1]);
}

/* ---------- 读完一题所需的最小状态（供各用例复用） ----------
   注意：这里不能让它抛异常。_env 被所有用例 require，
   一旦某个仓里没有 app/core.js，抛错会让全体用例连启动都失败。 */
let PLAN_V = null;
try { PLAN_V = planVersion(); } catch (e) { PLAN_V = null; }

/* ---------- 把当前浮层里的题全部作答（客观题 + 选词填空） ----------
   2026-11-05：老版本的 answerAll 只点 .opt，遇到"选词填空"组（词库点选）
   一题都答不上 → #groupSubmit 永远 disabled → click 死等到超时。
   选词填空的交互是：先点空格 .cloze-slot（进入聚焦），再点词库 .wb-chip 填入。
   这里两种都覆盖，返回实际作答的题数。 */
async function answerAllInQuiz(page) {
  const n = await page.evaluate(() => {
    const body = document.getElementById('quizBody');
    if (!body) return { opt: 0, cloze: 0 };
    let opt = 0, cloze = 0;
    // 1) 选择题：每题点第一个选项（已选过的不重复点）
    const answeredQ = {};
    Array.prototype.forEach.call(body.querySelectorAll('.opt[data-q]'), (b) => {
      const q = b.getAttribute('data-q');
      if (!answeredQ[q]) { answeredQ[q] = 1; b.click(); opt++; }
    });
    // 2) 选词填空：空格与词库一一配对（先点空格聚焦，再点词填入）
    const chips = Array.prototype.slice.call(body.querySelectorAll('.wb-chip'));
    Array.prototype.forEach.call(body.querySelectorAll('.cloze-slot[data-qno]'), (slot, i) => {
      if (slot.getAttribute('data-picked')) return;
      const chip = chips[i] || chips[chips.length - 1];
      if (!chip) return;
      slot.click();
      chip.click();
      if (slot.getAttribute('data-picked')) cloze++;
    });
    return { opt, cloze };
  });
  return n.opt + n.cloze;
}

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

/* ---------- 离线 HTTPS 证书自举（S2） ----------
   离线 PWA 测试需要 certs/key.pem + certs/cert.pem。删除 certs/ 目录后重跑应能
   自动重建，而不是直接抛 ENOENT。缺则调用 gen_certs.js 生成（node-forge 自签）。 */
const { execSync } = require('child_process');
function ensureCerts() {
  const dir = path.join(__dirname, 'certs');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    execSync(process.execPath + ' ' + JSON.stringify(path.join(__dirname, 'gen_certs.js')), { stdio: 'pipe' });
  }
  return { dir, key, cert };
}

module.exports = { chromium, EXE, fileUrl, ensurePaper, ensureAllPapers, bankDigest, ensureCerts, planVersion, PLAN_V, answerAllInQuiz };
