#!/usr/bin/env node
/**
 * fix_content.js — CET6 题库内容数据缺陷修复
 *
 * 覆盖三项修复：
 *   P1  回填 87 道被截断的听力题干（只改 stem 字段）
 *   P5  清理 611 道被污染的解析（在第一个污染标志处截断，保留有效解析主体）
 *   P2  补回 2021-12 三套写作题面的主题短文（Directions + 主题短文）
 *
 * 铁律：不改 answer 字段，不改解析的有效主体，不动 core.js / index.html。
 *
 * 用法（在 D:\CET6 下）：
 *   node scripts/fix_content.js --dry-run      # 只预览，不写盘
 *   node scripts/fix_content.js                # 备份 -> 修复 -> 自检
 *   node scripts/fix_content.js --verify-only  # 不写盘，只按备份基线做全库验证
 *
 * 可用环境变量覆盖清单路径（清单行数即验证口径，脚本不再把 87/611 写死）：
 *   CSV_STEM       听力题干对照表 CSV 路径
 *   CSV_POLLUTION  解析污染清单 CSV 路径（文件名会作为备份副本名）
 *
 * 产物：
 *   D:\CET6\backup\bank-before-content-fix\   原文件备份 + 基线（answer 哈希、题数、原解析长度）
 *   D:\CET6\backup\bank-before-content-fix\baseline.json
 *   D:\CET6\backup\bank-before-content-fix\*.csv   本次修复所依据的清单副本
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const BANK_DIR = path.join(APP_DIR, 'bank');
const RAW_DIR = path.join(ROOT, 'bank', 'raw');
const BACKUP_DIR = path.join(ROOT, 'backup', 'bank-before-content-fix');

const CSV_STEM = process.env.CSV_STEM ||
  'C:\\Users\\13841\\Doubao\\chats\\2026-09-26\\new-chat\\修复对照表-听力题干截断87题.csv';
const CSV_POLLUTION = process.env.CSV_POLLUTION ||
  'C:\\Users\\13841\\Doubao\\chats\\2026-09-26\\new-chat\\清单-解析污染611题.csv';
// 污染清单的文件名随 CSV_POLLUTION 一起走：备份副本与验证都以这个基准名为准，
// 避免换了清单文件却仍去读备份目录里的旧副本（旧副本作为证据保留，不覆盖）。
const POL_CSV_NAME = path.basename(CSV_POLLUTION);

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');
const VERIFY_ONLY = ARGS.has('--verify-only');
const FORCE_BACKUP = ARGS.has('--force-backup');

// ---------------------------------------------------------------- 基础工具

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * 最小 CSV 解析器（RFC4180 + 宽容规则）
 *  - 字段以 " 开头 → 引号模式
 *  - 引号模式内："" → 一个字面引号；紧邻分隔符/换行/EOF 的 " → 字段结束；
 *    其余位置的 " 视为字面引号（清单里存在未转义的引号，如 ``...view mise-en-place" or "put"``）
 *  - 非引号模式内出现的 " 一律按字面处理
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;          // 去掉 BOM
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        const n = text[i + 1];
        if (n === undefined || n === ',' || n === '\n' || n === '\r') { inQuotes = false; i++; continue; }
        field += '"'; i++; continue;                     // 字面引号
      }
      field += c; i++; continue;
    }
    if (c === ',') { row.push(field); field = ''; atFieldStart = true; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true; i++; continue; }
    if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; i++; continue; }
    field += c; atFieldStart = false; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readCsvObjects(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length && r.some((c) => c !== '')).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}

// ------------------------------------------------- Python json.dumps 兼容序列化
// 原始题库由 scripts/gen_bank_js.py 用 json.dumps(data, ensure_ascii=False) 生成，
// 即默认分隔符 ", " / ": "（不是紧凑格式）。这里复刻同一格式，保证未改动的文件
// 重新序列化后逐字节一致（76/76 已验证），从而“只改动该改的字节”。

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

// ---------------------------------------------------------------- 题库读写

function loadBankFile(file) {
  const p = path.join(file);
  const src = fs.readFileSync(p, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(p) });
  return (sandbox.window.CET6_BANKS || [])[0];
}

const BANK_FILES = () => fs.readdirSync(BANK_DIR).filter((f) => f.endsWith('.js')).sort();
const fileOfPaper = (paperId) => 'cet6-' + paperId + '.js';

// ---------------------------------------------------------------- 污染截断

// 污染标志（按任务清单编号；「最早出现者胜出」，编号只用于并列时的优先级）
const RE_SENTENCE_INSIGHTS = /SENTENCE INSIGHTS|句子精讲|句真题句逐层精讲/;      // 1
const RE_VOCAB_APPENDIX = /词汇附录/;                                            // 2
const RE_SECTION_LINE = /^[ \t]*Section[ \t]+[ABCD][ \t]*$/m;                    // 3
const RE_DIRECTIONS = /Directions:/;                                             // 4
// 5：cloze 15 词词库表——整行只有「X) 词」这种裸英文词条（不含中文、不含注释）
const RE_WORD_BANK_LINE = /^[ \t]*(?:[A-O]\)[ \t]*[A-Za-z][A-Za-z'’.\-]*(?:[ \t]+[A-O]\)[ \t]*[A-Za-z][A-Za-z'’.\-]*)*)[ \t]*$/;
// 6：写作范文块——段首的议论文开头 + 足够长的英文段落
const RE_ESSAY_BLOCK = /(?:^|\n)[ \t]*(?:With the trend|With the rapid|Nowadays|In recent years|In recent decades|Recently,|As the passage)[ \t]+[A-Za-z]/;
// 7：翻译译文块——连续 ≥200 个汉字、且整块不含任何解析结构标记或段落小结标记
const RE_TRANSLATION_BLOCK_DISQUALIFY = /【|信息指纹|段落精讲|信息核查/;
// 8：来源站点页面骨架（章节小标题 / 全卷构成 / 题目解析跳转）
const RE_PAGE_CHROME = /WORD BANK[ \t]*·|DISTRACTORS[ \t]*·|HIGH-FREQUENCY[ \t]*·|VOCABULARY[ \t]*·|全卷构成|题目解析[ \t]*→|·[ \t]*(?:句子精讲|词库分类表|真题高频词|词汇难度分布|干扰词复盘)|本篇出现的[ \t]*个/;
// 8b：卷面指令「Questions N to M are based on ...」
const RE_QUESTIONS_N_TO_M = /^[ \t]*Questions[ \t]+\d+[ \t]+to[ \t]+\d+[ \t]+are based on[ \t]/m;
// 9：Part I..IV 大题标题行
const RE_PART_LINE = /^[ \t]*Part[ \t]+(?:I{1,3}|IV)\b/m;
// 10：来源站点签名
const RE_LAZY_NOTES = /懒笔记|真题卷第\d+套\(/;

function lineOffsets(a) {
  const lines = a.split('\n');
  const offs = [];
  let o = 0;
  for (const l of lines) { offs.push(o); o += l.length + 1; }
  return { lines, offs };
}

/** 规则 5：≥3 行密集的裸词条行 */
function findWordBankTable(a) {
  const { lines, offs } = lineOffsets(a);
  const hit = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() && RE_WORD_BANK_LINE.test(lines[i])) hit.push(i);
  for (let s = 0; s + 2 < hit.length; s++) {
    if (hit[s + 2] - hit[s] + 1 <= 8) return offs[hit[s]];
  }
  return -1;
}

/** 规则 7：连续 ≥200 汉字、且不是「段落精讲 / 逐段小结」的译文块 */
function findTranslationBlock(a) {
  const { lines, offs } = lineOffsets(a);
  let run = 0;
  let start = -1;
  let block = [];
  const flush = () => {
    if (run >= 200 && !RE_TRANSLATION_BLOCK_DISQUALIFY.test(block.join('\n'))) return offs[start];
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const zh = (lines[i].match(/[\u4e00-\u9fa5]/g) || []).length;
    const nonZh = lines[i].replace(/[\u4e00-\u9fa5]/g, '').trim().length;
    if (zh >= 10 && nonZh < zh * 0.5) {
      if (run === 0) { start = i; block = []; }
      run += zh; block.push(lines[i]);
    } else if (lines[i].trim() === '' && run > 0) {
      block.push(lines[i]);
    } else {
      const r = flush(); if (r >= 0) return r;
      run = 0; start = -1; block = [];
    }
  }
  const r = flush();
  return r >= 0 ? r : -1;
}

/** 找到第一个污染标志的位置；找不到返回 null */
function findBoundary(a) {
  let best = null;
  const consider = (index, marker) => {
    if (index >= 0 && (best === null || index < best.index)) best = { index, marker };
  };
  const rules = [
    ['1-sentence-insights', RE_SENTENCE_INSIGHTS],
    ['2-vocab-appendix', RE_VOCAB_APPENDIX],
    ['3-section-line', RE_SECTION_LINE],
    ['4-directions', RE_DIRECTIONS],
    ['8-page-chrome', RE_PAGE_CHROME],
    ['8b-questions-n-to-m', RE_QUESTIONS_N_TO_M],
    ['9-part-line', RE_PART_LINE],
    ['10-site-signature', RE_LAZY_NOTES],
  ];
  for (const [name, re] of rules) { const m = a.match(re); if (m) consider(m.index, name); }
  const m6 = a.match(RE_ESSAY_BLOCK);
  if (m6) {
    const para = a.slice(m6.index).split('\n')[0];
    if ((para.match(/[A-Za-z]/g) || []).length >= 80) consider(m6.index, '6-writing-sample');
  }
  consider(findWordBankTable(a), '5-cloze-word-bank');
  consider(findTranslationBlock(a), '7-translation-block');
  return best;
}

/**
 * 截断点若不在行首（说明会从句子中间切开），向前回退到最近的句末标点之后再截断。
 * 若截断点本来就落在行首，则不存在“句中被截断”，不做二次收缩——否则会把合法的
 * 尾部内容（如「借⽤原⽂：…」引文行）一起删掉，属于越删。
 */
function applyPunctuationBackoff(a, idx) {
  if (idx <= 0) return idx;
  if (a[idx - 1] === '\n') return idx;
  const seg = a.slice(0, idx);
  let last = -1;
  for (const ch of ['。', '！', '？', '.', '!', '?']) {
    const p = seg.lastIndexOf(ch);
    if (p > last) last = p;
  }
  return last >= 0 ? last + 1 : idx;
}

const PUNCT_BACKOFF_APPLIED = Symbol('punctBackoff');

/** 返回 {ok, body, reason, marker} */
function cleanAnalysis(a) {
  const b = findBoundary(a);
  if (!b) return { ok: false, reason: '未找到标志，跳过' };
  const idx0 = b.index;
  const idx = applyPunctuationBackoff(a, idx0);
  const body = a.slice(0, idx).replace(/\s+$/, '');
  if (body.length <= 50) return { ok: false, reason: '截断后不足 50 字符，跳过', marker: b.marker };
  if (!body.includes('【答案】')) return { ok: false, reason: '截断后丢失【答案】标记，跳过', marker: b.marker };
  if (body.length >= a.length) return { ok: false, reason: '截断后未变短，跳过', marker: b.marker };
  return { ok: true, body, marker: b.marker, backoff: idx !== idx0 };
}

// ---------------------------------------------------------------- docx 读取

/** 最小 ZIP 读取（stored / deflate），只取指定条目 */
function readZipEntry(file, entry) {
  const buf = fs.readFileSync(file);
  // 从尾部找 End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP: ' + file);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏: ' + file);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (name === entry) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('不支持的压缩方式 ' + method);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('ZIP 中不存在条目 ' + entry);
}

function xmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** docx -> 段落文本数组（按文档顺序，保留段落边界） */
function docxParagraphs(file) {
  const xml = readZipEntry(file, 'word/document.xml').toString('utf8');
  const out = [];
  const re = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const runs = m[0].match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) || [];
    const text = runs.map((r) => xmlUnescape(r.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, ''))).join('');
    out.push(text);
  }
  return out;
}

/** 递归查找匹配的文件名 */
function findFileRecursive(dir, re, acc) {
  acc = acc || [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFileRecursive(p, re, acc);
    else if (re.test(e.name)) acc.push(p);
  }
  return acc;
}

const RE_PART = /^Part[ \t]+(?:I{1,3}|IV)\b/;
const RE_SECTION = /^Section[ \t]+[A-D]\b/;
const RE_QUESTIONS = /^Questions[ \t]+\d+[ \t]+to[ \t]+\d+/;

/** 从 docx 段落里抽取写作题面：Directions 段落 + 其后直到下个大题的全部正文 */
function extractWritingPrompt(paras) {
  let di = -1;
  for (let i = 0; i < paras.length; i++) {
    if (/^Directions:/.test(paras[i].trim())) { di = i; break; }
  }
  if (di < 0) return null;
  const parts = [paras[di].trim()];
  for (let i = di + 1; i < paras.length; i++) {
    const t = paras[i].trim();
    if (!t) continue;
    if (RE_PART.test(t) || RE_SECTION.test(t) || RE_QUESTIONS.test(t)) break;
    parts.push(t);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- 主流程

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function backup() {
  ensureDir(BACKUP_DIR);
  const files = BANK_FILES();
  let copied = 0;
  for (const f of files) {
    const dst = path.join(BACKUP_DIR, f);
    if (FORCE_BACKUP || !fs.existsSync(dst)) { fs.copyFileSync(path.join(BANK_DIR, f), dst); copied++; }
  }
  // 清单副本，保证修复可复现
  for (const [src, name] of [[CSV_STEM, '修复对照表-听力题干截断87题.csv'],
                             [CSV_POLLUTION, POL_CSV_NAME]]) {
    const dst = path.join(BACKUP_DIR, name);
    if (FORCE_BACKUP || !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
  // 基线：文件哈希 + answer 哈希 + 题数 + 每题解析长度
  const baseline = {
    createdAt: new Date().toISOString(),
    bankDir: BANK_DIR,
    files: {},
    answers: {},
    counts: { papers: 0, questions: 0, perFile: {} },
  };
  for (const f of files) {
    const buf = fs.readFileSync(path.join(BANK_DIR, f));
    baseline.files[f] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
    const data = loadBankFile(path.join(BANK_DIR, f));
    baseline.counts.papers++;
    baseline.counts.perFile[f] = data.questions.length;
    baseline.counts.questions += data.questions.length;
    for (const q of data.questions) {
      baseline.answers[q.id] = sha256(String(q.answer === undefined ? '' : q.answer));
      baseline.files[f].analysisLen = baseline.files[f].analysisLen || {};
      baseline.files[f].analysisLen[q.id] = String(q.analysis || '').length;
    }
  }
  fs.writeFileSync(path.join(BACKUP_DIR, 'baseline.json'), JSON.stringify(baseline, null, 1), 'utf8');
  console.log(`[备份] ${BACKUP_DIR}  新复制 ${copied} 个文件（共产出 ${files.length} 个题库文件副本）`);
  return baseline;
}

function readBaseline() {
  const p = path.join(BACKUP_DIR, 'baseline.json');
  if (!fs.existsSync(p)) throw new Error('找不到基线文件，请先不带 --verify-only 运行一次：' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const t0 = Date.now();
  console.log('=== CET6 题库内容修复 ===');
  console.log('项目根目录:', ROOT);
  console.log('题库目录  :', BANK_DIR);
  console.log('模式      :', VERIFY_ONLY ? '仅验证' : (DRY_RUN ? '预览（不写盘）' : '备份 + 修复 + 自检'));
  console.log('');

  const files = BANK_FILES();
  const bankByFile = {};
  const paperById = {};
  const questionById = new Map();
  for (const f of files) {
    const p = loadBankFile(path.join(BANK_DIR, f));
    bankByFile[f] = p;
    paperById[p.id] = p;
    for (const q of p.questions) questionById.set(q.id, { q, paper: p, file: f });
  }
  console.log(`[加载] ${files.length} 个题库文件 / ${Object.keys(paperById).length} 套卷 / ${questionById.size} 题`);

  // 备份
  let baseline;
  if (VERIFY_ONLY) {
    baseline = readBaseline();
    console.log('[备份] 使用既有基线:', path.join(BACKUP_DIR, 'baseline.json'));
  } else {
    baseline = backup();
  }

  const report = { stem: { rows: 0, applied: 0, equal: 0, mismatched: [], missing: [], anomalies: [] },
                   analysis: { rows: 0, applied: 0, skipped: [], minLen: null, backoff: 0, markers: {} },
                   writing: { applied: [] },
                   files: { changed: [], unchanged: 0 } };

  if (!VERIFY_ONLY) {
    // ---------------- P1: 回填听力题干 ----------------
    console.log('\n--- P1 听力题干回填 ---');
    const stemRows = readCsvObjects(CSV_STEM);
    report.stem.rows = stemRows.length;
    for (const r of stemRows) {
      const id = r.id;
      const target = r['应修正为(PDF原文)'] !== undefined ? r['应修正为(PDF原文)'] : r['应修正为'];
      const hit = questionById.get(id);
      if (!hit) { report.stem.missing.push(id); console.log('  ! 题号不存在:', id); continue; }
      if (!('stem' in hit.q)) { report.stem.missing.push(id + '(无 stem 字段)'); continue; }
      if (hit.q.stem !== r['当前(截断)']) {
        report.stem.anomalies.push({ id, bank: hit.q.stem, csvCurrent: r['当前(截断)'] });
      }
      hit.q.stem = target;
      report.stem.applied++;
    }
    console.log(`  回填 ${report.stem.applied}/${report.stem.rows} 题；当前值与清单不一致 ${report.stem.anomalies.length} 条`);

    // ---------------- P5: 清理污染解析 ----------------
    console.log('\n--- P5 污染解析清理 ---');
    const polRows = readCsvObjects(CSV_POLLUTION);
    report.analysis.rows = polRows.length;
    for (const r of polRows) {
      const id = r.id;
      const hit = questionById.get(id);
      if (!hit) { report.analysis.skipped.push({ id, reason: '题号不存在' }); continue; }
      const before = String(hit.q.analysis || '');
      const res = cleanAnalysis(before);
      if (!res.ok) { report.analysis.skipped.push({ id, reason: res.reason, marker: res.marker || null }); continue; }
      hit.q.analysis = res.body;
      report.analysis.applied++;
      report.analysis.markers[res.marker] = (report.analysis.markers[res.marker] || 0) + 1;
      if (res.backoff) report.analysis.backoff++;
      const b = baseline.files[hit.file];
      const bLen = b && b.analysisLen ? b.analysisLen[id] : undefined;
      if (bLen !== undefined && res.body.length >= bLen) report.analysis.skipped.push({ id, reason: '截断后长度未减少' });
    }
    console.log(`  清理 ${report.analysis.applied}/${report.analysis.rows} 题；跳过 ${report.analysis.skipped.length} 题`);
    console.log('  命中标志分布:', JSON.stringify(report.analysis.markers));
    if (report.analysis.skipped.length) console.log('  跳过明细:', JSON.stringify(report.analysis.skipped.slice(0, 10)));

    // ---------------- P2: 2021-12 写作题面 ----------------
    console.log('\n--- P2 2021-12 写作题面 ---');
    for (let set = 1; set <= 3; set++) {
      const paperId = `2021-12-${set}`;
      const paper = paperById[paperId];
      if (!paper) { console.log(`  ! 找不到卷 ${paperId}`); continue; }
      const pat = new RegExp('^cet6-2021-12-' + set + '\\.docx$', 'i');
      const found = findFileRecursive(RAW_DIR, pat);
      if (!found.length) {
        console.log(`  ! 未修复：${paperId} 原始 docx 不可得`);
        report.writing.applied.push({ id: paperId, ok: false, reason: '原始 docx 不可得' });
        continue;
      }
      const docx = found[0];
      const paras = docxParagraphs(docx);
      const prompt = extractWritingPrompt(paras);
      if (!prompt) {
        console.log(`  ! 未修复：${paperId} 未在 docx 中定位到 Directions 写作题面`);
        report.writing.applied.push({ id: paperId, ok: false, reason: 'docx 中未定位到题面' });
        continue;
      }
      const old = paper.writing.prompt;
      paper.writing.prompt = prompt;
      report.writing.applied.push({ id: paperId, ok: true, docx, oldLen: old.length, newLen: prompt.length,
                                    topic: prompt.split('\n\n').slice(1).join(' ').slice(0, 60) });
      console.log(`  ${paperId}: ${old.length} -> ${prompt.length} 字符  (${path.basename(docx)})`);
    }

    // ---------------- 写回 ----------------
    console.log('\n--- 写回 ---');
    for (const f of files) {
      const p = path.join(BANK_DIR, f);
      const orig = fs.readFileSync(p);
      const out = Buffer.from(serializeBank(bankByFile[f]), 'utf8');
      if (out.equals(orig)) { report.files.unchanged++; continue; }
      report.files.changed.push(f);
      if (!DRY_RUN) fs.writeFileSync(p, out);
    }
    console.log(`  ${DRY_RUN ? '（预览）拟改动' : '已改动'} ${report.files.changed.length} 个文件，${report.files.unchanged} 个文件字节未变`);
    console.log('  改动文件:', report.files.changed.join(', '));
  }

  // ---------------- 验证 ----------------
  let v = [];
  if (DRY_RUN) {
    console.log('\n=== 全库验证 ===\n  （预览模式不落盘，跳过落盘验证；去掉 --dry-run 后执行完整验证）');
    console.log(`  预览统计：题干拟回填 ${report.stem.applied} 题；解析拟清理 ${report.analysis.applied} 题；` +
                `写作题面拟写回 ${report.writing.applied.filter((x) => x.ok).length} 套；拟改动 ${report.files.changed.length} 个文件`);
  } else {
    console.log('\n=== 全库验证 ===');
    v = verify(baseline);
    console.log(v.map((x) => `  [${x.pass ? 'PASS' : 'FAIL'}] ${x.name} — ${x.detail}`).join('\n'));
  }
  const ok = DRY_RUN ? true : v.every((x) => x.pass);

  if (!VERIFY_ONLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(BACKUP_DIR, `fix-report-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ report, verify: v, ms: Date.now() - t0 }, null, 1), 'utf8');
    console.log('\n报告:', outPath);
  }
  console.log(`\n总耗时 ${Date.now() - t0} ms | 结论: ${ok ? '全部通过' : '存在未通过项'}`);
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- 验证

function verify(baseline) {
  const out = [];
  const files = BANK_FILES();
  const papers = [];
  for (const f of files) papers.push(loadBankFile(path.join(BANK_DIR, f)));

  // 1) 全库题数
  let total = 0;
  for (const p of papers) total += p.questions.length;
  out.push({ name: '全库题数不变（76 卷 / 3315 题）',
             pass: papers.length === 76 && total === 3315,
             detail: `${papers.length} 卷 / ${total} 题` });

  // 2) answer 字段哈希未变
  let ansBad = [];
  const seen = new Set();
  for (const p of papers) for (const q of p.questions) {
    seen.add(q.id);
    const h = sha256(String(q.answer === undefined ? '' : q.answer));
    if (baseline.answers[q.id] !== h) ansBad.push(q.id);
  }
  out.push({ name: 'answer 字段未被修改',
             pass: ansBad.length === 0,
             detail: ansBad.length ? '不一致: ' + ansBad.slice(0, 10).join(',') : `全部 ${seen.size} 题哈希一致` });

  // 3) P1 题干
  const stemRows = baseline /* keep */ && fs.existsSync(BACKUP_DIR)
    ? readCsvObjects(path.join(BACKUP_DIR, '修复对照表-听力题干截断87题.csv'))
    : [];
  const qmap = new Map();
  for (const p of papers) for (const q of p.questions) qmap.set(q.id, q);
  let eq = 0; const bad = [];
  for (const r of stemRows) {
    const q = qmap.get(r.id);
    if (!q) { bad.push(r.id + '(缺题)'); continue; }
    if (q.stem === r['应修正为(PDF原文)']) eq++; else bad.push(r.id);
  }
  out.push({ name: `P1 听力题干回填（${stemRows.length} 题逐条核对）`,
             pass: stemRows.length > 0 && eq === stemRows.length && bad.length === 0,
             detail: `${eq}/${stemRows.length} 一致` + (bad.length ? ' | 不一致: ' + bad.join(',') : '') });

  // 4) P5 解析
  const polRows = fs.existsSync(BACKUP_DIR)
    ? readCsvObjects(path.join(BACKUP_DIR, POL_CSV_NAME)) : [];
  let shorter = 0, keptAns = 0, over50 = 0;
  const pBad = [];
  for (const r of polRows) {
    const q = qmap.get(r.id);
    if (!q) { pBad.push(r.id + '(缺题)'); continue; }
    const a = String(q.analysis || '');
    const orig = baseline.files && (() => {
      for (const f of Object.keys(baseline.files)) {
        const m = baseline.files[f].analysisLen;
        if (m && m[r.id] !== undefined) return m[r.id];
      }
      return undefined;
    })();
    if (orig === undefined || a.length < orig) shorter++; else pBad.push(r.id + '(未变短)');
    if (a.includes('【答案】')) keptAns++; else pBad.push(r.id + '(丢【答案】)');
    if (a.length > 50) over50++; else pBad.push(r.id + '(<=50)');
  }
  const n = polRows.length;
  out.push({ name: `P5 解析截断（${n} 题：变短 / 保留【答案】/ >50 字符）`,
             pass: n > 0 && shorter === n && keptAns === n && over50 === n,
             detail: `变短 ${shorter}/${n} · 保留【答案】 ${keptAns}/${n} · >50 字符 ${over50}/${n}` +
                     (pBad.length ? ' | 异常: ' + pBad.slice(0, 10).join(',') : '') });

  // 5) 2021-12 写作题面
  const w = ['2021-12-1', '2021-12-2', '2021-12-3'].map((id) => papers.find((p) => p.id === id));
  const prompts = w.map((p) => (p && p.writing && p.writing.prompt) || '');
  const distinct = new Set(prompts).size === 3;
  const hasTopic = prompts.every((p, i) => p.includes('Directions:') && p.split('\n\n').length >= 2 && p.split('\n\n')[1].length >= 100);
  out.push({ name: 'P2 2021-12 三套写作题面互不相同且含主题短文',
             pass: distinct && hasTopic,
             detail: `distinct=${distinct} 含主题短文=${hasTopic} 长度=[${prompts.map((p) => p.length).join(', ')}]` });

  // 6) 序列化稳定：把当前数据重新序列化，应与磁盘字节一致
  let stable = 0; const unstable = [];
  for (const f of files) {
    const cur = fs.readFileSync(path.join(BANK_DIR, f));
    const re = Buffer.from(serializeBank(loadBankFile(path.join(BANK_DIR, f))), 'utf8');
    if (re.equals(cur)) stable++; else unstable.push(f);
  }
  out.push({ name: '写回格式与原始格式一致（重新序列化逐字节相同）',
             pass: unstable.length === 0,
             detail: `${stable}/${files.length}` + (unstable.length ? ' | 不一致: ' + unstable.join(',') : '') });

  return out;
}

main();
