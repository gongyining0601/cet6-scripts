/**
 * CET6 题库内容数据修复 · 第二轮
 * ------------------------------------------------------------------
 * 只改 D:/CET6/app/bank/cet6-*.js，不触碰 core.js / index.html。
 *
 * 修复项：
 *   N-CONT-1  6 卷写作题补 writing.image 字段（图片已由 round2_prep.py 提取）
 *   N-CONT-2  70 题 match 解析删除「PARAGRAPH MAP · 段落主旨图」附录
 *   N-CONT-3  解析字段中的康熙部首 / CJK 部首补遗字符还原为统一汉字
 *   N-CONT-4  2026-06-3 写作题面补回被遗漏的第二段指令句
 *   LOW-5     非 cloze 题选项正文首字母小写 -> 大写（168 处）
 *   LOW-6     写作题面中连续空格压缩为单个空格（16 卷）
 *   LOW-7     翻译题面中文句中的半角逗号 -> 全角逗号（27 卷）
 *
 * 序列化复刻 scripts/gen_bank_js.py 的 json.dumps(data, ensure_ascii=False)
 * 默认分隔符格式，未改动的文件重新序列化后逐字节一致。
 *
 * 用法：
 *   node scripts/fix_content_round2.js --dry-run   预览，不写盘
 *   node scripts/fix_content_round2.js             写盘并自检
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = 'D:/CET6';
const BANK_DIR = path.join(ROOT, 'app/bank');
const BACKUP_DIR = path.join(ROOT, 'backup/bank-before-round2-fix');
const INPUTS = process.env.ROUND2_INPUTS ||
  'C:/Users/13841/AppData/Local/Doubao/User Data/Profile 2/.doubao/agent_mode/workspace/.sessions/38444185497454594/agents/s_000cZ4x3OyX/scratch/round2-inputs.json';
const REPORT_DIR = path.join(ROOT, 'backup/bank-before-round2-fix');
const DRY_RUN = process.argv.includes('--dry-run');

// ------------------------------------------------- Python json.dumps 兼容序列化
function pyJson(v) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  const t = typeof v;
  if (t === 'number') {
    if (!isFinite(v)) throw new Error('序列化遇到非有限数字');
    return String(v);
  }
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (t === 'object') {
    return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ': ' + pyJson(v[k])).join(', ') + '}';
  }
  throw new Error('不支持的类型: ' + t);
}
const serializeBank = (data) =>
  'window.CET6_BANKS = window.CET6_BANKS || [];\n' +
  'window.CET6_BANKS.push(' + pyJson(data) + ');\n';

function loadBankFile(p) {
  const src = fs.readFileSync(p, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(p) });
  return (sandbox.window.CET6_BANKS || [])[0];
}
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const BANK_FILES = () => fs.readdirSync(BANK_DIR).filter((f) => f.endsWith('.js')).sort();

// ------------------------------------------------------------------ N-CONT-2
const PARAGRAPH_MAP_MARKERS = ['PARAGRAPH MAP', '段落主旨图', '段落地图'];

function findMarker(a) {
  let idx = -1;
  let hit = null;
  for (const mk of PARAGRAPH_MAP_MARKERS) {
    const i = a.indexOf(mk);
    if (i >= 0 && (idx < 0 || i < idx)) { idx = i; hit = mk; }
  }
  return { idx, hit };
}

/** 返回 {changed, head, hit, cut, fallback} */
function stripParagraphMap(a) {
  const { idx, hit } = findMarker(a);
  if (idx < 0) return { changed: false };
  let cut = idx;
  if (cut > 0 && a[cut - 1] !== '\n') {
    const nl = a.lastIndexOf('\n', cut - 1);
    cut = nl >= 0 ? nl + 1 : cut;
  }
  let head = a.slice(0, cut).replace(/\s+$/, '');
  let fallback = false;
  if (head.length < 50) {
    // 有效解析过短：保底保留【答案】行 + 紧随其后的第一行解释
    const lines = a.slice(0, idx).split('\n');
    const out = [];
    let started = false;
    let nonEmpty = 0;
    for (const ln of lines) {
      if (!started && ln.indexOf('【答案】') >= 0) started = true;
      if (!started) continue;
      out.push(ln);
      if (ln.trim()) nonEmpty++;
      if (nonEmpty >= 2) break;
    }
    const cand = out.join('\n').replace(/\s+$/, '');
    if (cand.length > head.length) head = cand;
    fallback = true;
  }
  return { changed: head !== a, head, hit, cut, fallback };
}

// ------------------------------------------------------------------ N-CONT-3
function makeRadicalReplacer(map, ranges) {
  const keys = Object.keys(map).map((k) => parseInt(k, 10));
  const lookup = {};
  for (const k of keys) lookup[k] = map[String(k)];
  const inRange = (cp) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
  const hasUnmapped = (s) => {
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (inRange(cp) && lookup[cp] === undefined) return cp;
    }
    return -1;
  };
  let replaced = 0;
  const replacer = (s) => {
    let out = '';
    let any = false;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (inRange(cp) && lookup[cp] !== undefined) {
        out += String.fromCodePoint(lookup[cp]);
        any = true;
        replaced++;
      } else {
        out += ch;
      }
    }
    return any ? out : s;
  };
  return { replacer, hasUnmapped, stats: () => replaced, reset: () => { replaced = 0; } };
}

// ------------------------------------------------------------------ LOW-5
const RE_OPT_LOWER_TEXT = /^([A-Z])\)(\s*)([a-z])([\s\S]*)$/;
function capitalizeOptionText(op) {
  const m = RE_OPT_LOWER_TEXT.exec(op);
  if (!m) return null;
  return m[1] + ')' + m[2] + m[3].toUpperCase() + m[4];
}

// ------------------------------------------------------------------ LOW-7
const isDigit = (ch) => ch >= '0' && ch <= '9';
function fixHalfwidthComma(s) {
  let out = '';
  let any = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ',') {
      const l = s[i - 1];
      const r = s[i + 1];
      if (!(l !== undefined && r !== undefined && isDigit(l) && isDigit(r))) {
        out += '，';
        any = true;
        continue;
      }
    }
    out += s[i];
  }
  return any ? out : s;
}

// ------------------------------------------------------------------ main
function main() {
  const t0 = Date.now();
  const inputs = JSON.parse(fs.readFileSync(INPUTS, 'utf8'));
  const IMAGES = inputs.images;
  const KX_MAP = inputs.kangxi_map;
  const KX_RANGES = inputs.kangxi_ranges;
  const PROMPT_4063 = inputs.prompt2026_06_3;

  console.log('=== CET6 题库内容数据修复（第二轮） ===');
  console.log('题库目录:', BANK_DIR);
  console.log('输入文件:', INPUTS);
  console.log('模式    :', DRY_RUN ? '预览（不写盘）' : '写盘 + 自检');
  console.log('');

  // 备份一致性前置检查
  const files = BANK_FILES();
  const preMismatch = [];
  for (const f of files) {
    const live = fs.readFileSync(path.join(BANK_DIR, f));
    const bak = path.join(BACKUP_DIR, f);
    if (!fs.existsSync(bak) || !fs.readFileSync(bak).equals(live)) preMismatch.push(f);
  }
  console.log('[前置] 备份核对: ' + files.length + ' 个文件，与备份不一致 ' + preMismatch.length + ' 个');
  if (preMismatch.length) throw new Error('备份与当前文件不一致，请重新备份: ' + preMismatch.join(', '));

  const radical = makeRadicalReplacer(KX_MAP, KX_RANGES);
  const kxPapers = new Set();
  const report = {
    papers: files.length,
    questions: 0,
    answers: {},
    writingImageAdded: [],
    analysis: { changed: [], mapStripped: [], kangxiRewritten: [], fallback: [], residualUnmapped: [] },
    kangxi: { files: 0, questions: 0, chars: 0, unmappedInOtherFields: [] },
    prompt4063: null,
    low5: { questions: [], options: [] },
    low6: [],
    low7: [],
    files: { changed: [], unchanged: [] },
    anomalies: [],
  };

  const changedFieldOf = {};
  for (const f of files) {
    const p = path.join(BANK_DIR, f);
    const paper = loadBankFile(p);
    const pid = paper.id;
    changedFieldOf[f] = new Set();

    // ---- N-CONT-1 ----
    if (IMAGES[pid]) {
      const want = 'img/' + pid + '.jpg';
      if (paper.writing) {
        if (paper.writing.image !== want) {
          paper.writing.image = want;
          changedFieldOf[f].add('writing.image');
          report.writingImageAdded.push({ id: pid, value: want, member: IMAGES[pid].member });
        }
      } else {
        report.anomalies.push({ file: f, what: 'N-CONT-1 目标卷缺少 writing 对象' });
      }
    }

    // ---- N-CONT-4 ----
    if (pid === '2026-06-3') {
      const cur = (paper.writing || {}).prompt || '';
      if (cur.length !== PROMPT_4063.directions_len || sha256(cur) !== PROMPT_4063.directions_sha256) {
        report.anomalies.push({ file: f, what: 'N-CONT-4 现有题面与源 docx Directions 段不一致',
                                curLen: cur.length, wantLen: PROMPT_4063.directions_len });
      } else {
        const next = cur + '\n\n' + PROMPT_4063.tail;
        if (sha256(next) !== PROMPT_4063.combined_sha256 || next.length !== PROMPT_4063.combined_len) {
          report.anomalies.push({ file: f, what: 'N-CONT-4 拼合结果与源 docx 校验值不符' });
        } else {
          paper.writing.prompt = next;
          changedFieldOf[f].add('writing.prompt');
          report.prompt4063 = { id: pid, oldLen: cur.length, newLen: next.length };
        }
      }
    }

    for (const q of paper.questions) {
      report.questions++;
      report.answers[q.id] = sha256(String(q.answer === undefined ? '' : q.answer));

      // ---- N-CONT-3（仅 analysis） ----
      const an0 = q.analysis || '';
      let radicalChars = 0;
      for (const ch of an0) {
        const cp = ch.codePointAt(0);
        if (KX_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) && KX_MAP[String(cp)] !== undefined) radicalChars++;
      }
      const an1 = radical.replacer(an0);
      if (an1 !== an0) {
        q.analysis = an1;
        changedFieldOf[f].add('analysis');
        if (report.analysis.changed.indexOf(q.id) < 0) report.analysis.changed.push(q.id);
        report.kangxi.questions++;
        report.kangxi.chars += radicalChars;
        report.analysis.kangxiRewritten.push(q.id);
        kxPapers.add(pid);
      }
      // 其它字段是否也含部首字符（按任务要求只改 analysis，如有需上报）
      for (const fld of ['stem', 'answer']) {
        const v = q[fld];
        if (typeof v === 'string') {
          const bad = radical.hasUnmapped(v);
          if (bad >= 0) report.kangxi.unmappedInOtherFields.push({ id: q.id, field: fld, cp: bad.toString(16) });
        }
      }
      if (Array.isArray(q.options)) {
        for (let i = 0; i < q.options.length; i++) {
          if (typeof q.options[i] === 'string') {
            const bad = radical.hasUnmapped(q.options[i]);
            if (bad >= 0) report.kangxi.unmappedInOtherFields.push({ id: q.id, field: 'options[' + i + ']', cp: bad.toString(16) });
          }
        }
      }

      // ---- N-CONT-2 ----
      const r = stripParagraphMap(q.analysis || '');
      if (r.changed) {
        q.analysis = r.head;
        changedFieldOf[f].add('analysis');
        if (report.analysis.changed.indexOf(q.id) < 0) report.analysis.changed.push(q.id);
        report.analysis.mapStripped.push({ id: q.id, marker: r.hit, oldLen: (an0 || '').length, newLen: r.head.length, fallback: !!r.fallback });
        if (r.fallback) report.analysis.fallback.push(q.id);
      }

      // ---- LOW-5（仅非 cloze） ----
      if (q.type !== 'cloze' && Array.isArray(q.options)) {
        let hit = false;
        const next = q.options.map((op) => {
          if (typeof op !== 'string') return op;
          const fixed = capitalizeOptionText(op);
          if (fixed !== null && fixed !== op) {
            report.low5.options.push({ id: q.id, before: op, after: fixed });
            return fixed;
          }
          return op;
        });
        if (next.some((v, i) => v !== q.options[i])) {
          q.options = next;
          hit = true;
          changedFieldOf[f].add('options');
          report.low5.questions.push(q.id);
        }
      }
    }

    // ---- LOW-6 / LOW-7 ----
    if (paper.writing && typeof paper.writing.prompt === 'string') {
      const w0 = paper.writing.prompt;
      const w1 = w0.replace(/ {2,}/g, ' ');
      if (w1 !== w0) {
        paper.writing.prompt = w1;
        changedFieldOf[f].add('writing.prompt');
        report.low6.push({ id: pid, runs: (w0.match(/ {2,}/g) || []).length,
                           before: w0.slice(0, 160), after: w1.slice(0, 160) });
      }
    }
    if (paper.translation && typeof paper.translation.prompt === 'string') {
      const t0s = paper.translation.prompt;
      const t1s = fixHalfwidthComma(t0s);
      if (t1s !== t0s) {
        paper.translation.prompt = t1s;
        changedFieldOf[f].add('translation.prompt');
        report.low7.push({ id: pid, commas: (t0s.match(/,/g) || []).length - (t1s.match(/,/g) || []).length,
                           before: t0s, after: t1s });
      }
    }

    // ---- 写回 ----
    const orig = fs.readFileSync(p);
    const out = Buffer.from(serializeBank(paper), 'utf8');
    if (out.equals(orig)) {
      report.files.unchanged.push(f);
    } else {
      report.files.changed.push({ file: f, fields: Array.from(changedFieldOf[f]).sort() });
      if (!DRY_RUN) fs.writeFileSync(p, out);
    }
  }

  report.kangxi.files = kxPapers.size;
  report.analysis.changedCount = report.analysis.changed.length;

  console.log('\n--- 改动概览 ---');
  console.log('  N-CONT-1 writing.image 新增 : ' + report.writingImageAdded.length + ' 卷 ' +
              JSON.stringify(report.writingImageAdded.map((x) => x.id)));
  console.log('  N-CONT-2 PARAGRAPH MAP 清理 : ' + report.analysis.mapStripped.length + ' 题' +
              (report.analysis.fallback.length ? '（其中走保底 ' + report.analysis.fallback.length + ' 题）' : ''));
  console.log('  N-CONT-3 康熙部首还原       : ' + report.kangxi.chars + ' 字 / ' + report.kangxi.questions + ' 题 / ' + report.kangxi.files + ' 卷');
  console.log('  （解析字段被改动合计 ' + report.analysis.changed.length + ' 题）');
  console.log('  N-CONT-4 题面补全           : ' + (report.prompt4063 ? JSON.stringify(report.prompt4063) : '未执行'));
  console.log('  LOW-5 选项首字母大写        : ' + report.low5.options.length + ' 处 / ' + report.low5.questions.length + ' 题');
  console.log('  LOW-6 写作题面双空格        : ' + report.low6.length + ' 卷');
  console.log('  LOW-7 翻译题面半角逗号      : ' + report.low7.length + ' 卷 (' +
              report.low7.reduce((s, x) => s + x.commas, 0) + ' 处)');
  console.log('  改动文件 : ' + report.files.changed.length + ' 个；字节未变 ' + report.files.unchanged.length + ' 个');
  if (report.anomalies.length) console.log('  !! 异常: ' + JSON.stringify(report.anomalies, null, 1));
  if (report.kangxi.unmappedInOtherFields.length) {
    console.log('  !! analysis 之外仍含部首字符: ' + JSON.stringify(report.kangxi.unmappedInOtherFields.slice(0, 10)));
  }

  const outPath = path.join(REPORT_DIR, DRY_RUN ? 'round2-dry-run-report.json' : 'round2-fix-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1), 'utf8');
  console.log('\n报告:', outPath);
  console.log('耗时 ' + (Date.now() - t0) + ' ms');
}

main();
