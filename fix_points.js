#!/usr/bin/env node
/**
 * fix_points.js — CET6 题库 cloze 考点标签（points）收敛修复
 *
 * 背景
 * ----
 * parse_cet6.py 第 668 行用 `re.search(r'【词性槽】([^\n]{0,20})', analysis)` 生成 cloze 的
 * 第二个考点标签，`{0,20}` 把句子级描述硬截断成碎片 → 685 种唯一标签、678 种只出现一次。
 *
 * 修复
 * ----
 * 只改 cloze 题的 points[1]，把它换成受控词表标签：
 *     名词 / 动词 / 形容词 / 副词 / 连词 / 介词 / 代词 / 数词 / 冠词   （兜底：词性判断）
 * points[0]（"选词填空"）保持不变；answer / stem / analysis / options 一概不动。
 *
 * 归一化两通道（见 normalizeClozePos）
 *   A 主通道：analysis 中紧邻「【答案】…」行的答案词性标注行（原始解析自带，逐个校验）
 *   B 兜底  ：完整「【词性槽】…」描述的受控词表语义规则（原始来源无标注时才用）
 *
 * 用法（在 D:\CET6 下）
 *   node scripts/fix_points.js --eval       # 只读：在全部 690 题上评估归一化，不写盘
 *   node scripts/fix_points.js --dry-run    # 预览改动，不写盘
 *   node scripts/fix_points.js              # 备份校验 + 修复 + 自检
 *
 * 产物
 *   D:\CET6\backup\round3-fix-20260927-212756\points-fix-report.json   统计与验证结果
 *   D:\CET6\backup\round3-fix-20260927-212756\points-changes.csv       逐题改动明细
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const BANK_DIR = path.join(ROOT, 'app', 'bank');
const BACKUP_DIR = path.join(ROOT, 'backup', 'round3-fix-20260927-212756', 'app', 'bank');
const REPORT_DIR = path.join(ROOT, 'backup', 'round3-fix-20260927-212756');

const ARGS = new Set(process.argv.slice(2));
const EVAL_ONLY = ARGS.has('--eval');
const DRY_RUN = ARGS.has('--dry-run');

// ============================================================ 受控词表

const CLOZE_POS_VOCAB = ['名词', '动词', '形容词', '副词', '连词', '介词', '代词', '数词', '冠词'];
const CLOZE_POS_FALLBACK = '词性判断';

// 标注行/描述里出现的词性写法 → 受控标签
const POS_ALIAS = {
  名词: '名词', 动词: '动词', 形容词: '形容词', 副词: '副词', 连词: '连词',
  介词: '介词', 代词: '代词', 数词: '数词', 冠词: '冠词',
  物主代词: '代词', 人称代词: '代词', 指示代词: '代词', 反身代词: '代词',
  情态动词: '动词', 助动词: '动词', 系动词: '动词', 动词原形: '动词',
  动名词: '动词', 分词: '动词', 过去分词: '动词', 现在分词: '动词',
  过去式: '动词', 第三人称单数: '动词', 非谓语: '动词',
  形容词性: '形容词', 副词性: '副词',
};

// ============================================================ 归一化

/** A 主通道：解析原文自带的「答案词性标注行」→ 受控标签（取不到返回 null） */
function posFromAnnotation(analysis) {
  const m = /【答案】[^\n]*\n([^\n]{1,12})/.exec(String(analysis || ''));
  if (!m) return null;
  const line = m[1].trim().replace(/[。．.,，;；:：]+$/, '');
  if (!line || line.length > 6) return null;         // 超过 6 字不是词性标注，是正文
  if (CLOZE_POS_VOCAB.indexOf(line) >= 0) return line;
  return POS_ALIAS[line] || null;
}

/**
 * B 兜底通道：完整「【词性槽】…」描述 → 受控标签。
 * 规则按语义优先级排列，目标是「空格处应填词性（答案词性）」，而非描述里出现的所有词性。
 */
const DESC_RULES = [
  // 动名词是动词的 -ing 形式（高精度：描述里出现「动名词」时答案几乎总是动词形式）
  ['动词', /动名词/],
  // 「副词修饰 X」/「缺…状语」/「修饰位」：答案本身是副词
  ['副词', /副词修饰|缺状语|状语位/],
  ['副词', /(?:缺|需要|需|要|填)(?:一个|一种)?[^，。；]{0,10}?副词/],
  ['副词', /(?:助动词|情态动词)[^，。；]{0,20}之间/],
  ['副词', /(?:过去分词|现在分词|动词|形容词)[^，。；]{0,8}前(?:的)?修饰位/],
  // 名词：中心名词 / 缺名词 / 作宾语 / 名词前 / 形容词·物主代词之后接名词
  ['名词', /中心名词|名词中心词|词组中心/],
  ['名词', /(?:需要|需|缺|要|填|补)(?:一个|一种|单数|复数)?[^，。；]{0,6}?名词/],
  ['名词', /作[^，。；]{0,18}?的宾语|缺宾语|宾语(?:位|位置|中心词|成分)/],
  ['名词', /名词前|(?:所有格|物主代词)[^，。；]{0,12}(?:后|\+)/],
  ['名词', /形容词[^，。；]{1,10}修饰[^，。；]{0,4}名词/],
  ['名词', /形容词[^，。；]{0,10}(?:后|接)[^，。；]{0,4}?名词/],
  ['名词', /构成[^，。；]{0,10}名词/],
  // 动词：分词 / 谓语 / 被动 等形态
  ['动词', /过去分词|现在分词|动词原形|过去式|第三人称单数|谓语|被动|进行时|完成时|非谓语|分词/],
  // 形容词：显式词性 / 表语 / 系动词 / 冠词与名词之间 / 定语
  ['形容词', /形容词|表语|系动词|be\s*动词/],
  ['形容词', /(?:冠词|限定词)[^，。；]{0,10}(?:与|和)[^，。；]{0,10}名词[^，。；]{0,6}之间/],
  ['形容词', /定语/],
  ['动词', /动词/],
  ['名词', /名词/],
  ['副词', /副词|状语/],
  ['连词', /连词/], ['介词', /介词/], ['代词', /代词/],
  ['数词', /数词/], ['冠词', /冠词/],
];

function posFromDesc(desc) {
  const d = String(desc || '').trim();
  if (!d) return CLOZE_POS_FALLBACK;
  for (let i = 0; i < DESC_RULES.length; i++) {
    if (DESC_RULES[i][1].test(d)) return DESC_RULES[i][0];
  }
  return CLOZE_POS_FALLBACK;
}

/** 归一化入口：analysis → { label, source } */
function normalizeClozePos(analysis, legacyDesc) {
  const a = posFromAnnotation(analysis);
  if (a) return { label: a, source: 'A-词性标注行' };
  const slot = (/【词性槽】([^\n]*)/.exec(String(analysis || '')) || [, ''])[1].trim();
  const desc = slot || String(legacyDesc || '').replace(/^词性判断·/, '');
  return { label: posFromDesc(desc), source: slot ? 'B-槽描述规则' : 'B-旧标签规则' };
}

// ============================================================ Python json.dumps 兼容序列化
// 原库由 gen_bank_js.py 用 json.dumps(data, ensure_ascii=False)（默认分隔符 ", " / ": "）生成，
// 这里复刻同一格式：未改动的文件重新序列化后必须逐字节一致。

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

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ============================================================ 加载

function loadBankFile(p) {
  const src = fs.readFileSync(p, 'utf8');
  const sb = { window: {} };
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: path.basename(p) });
  return (sb.window.CET6_BANKS || [])[0];
}

const files = fs.readdirSync(BANK_DIR).filter((f) => f.endsWith('.js')).sort();
const papers = {}, backupPapers = {};
for (const f of files) {
  papers[f] = loadBankFile(path.join(BANK_DIR, f));
  const bp = path.join(BACKUP_DIR, f);
  if (!fs.existsSync(bp)) throw new Error('备份缺失: ' + bp);
  backupPapers[f] = loadBankFile(bp);
}

const allQ = [];
for (const f of files) for (const q of papers[f].questions) allQ.push({ f, q });
const clozeQ = allQ.filter((x) => x.q.type === 'cloze');
const isCloze = (q) => q.type === 'cloze' || String(q.id).includes('-c-');

// ============================================================ --eval

if (EVAL_ONLY) {
  let aHit = 0, agree = 0;
  const aDist = {}, bDist = {}, srcDist = {};
  const fails = [];
  for (const { q } of clozeQ) {
    const a = String(q.analysis || '');
    const slot = (/【词性槽】([^\n]*)/.exec(a) || [, ''])[1].trim();
    const A = posFromAnnotation(a);
    const B = posFromDesc(slot);
    if (A) aHit++;
    if (A === B) agree++;
    aDist[String(A)] = (aDist[String(A)] || 0) + 1;
    bDist[B] = (bDist[B] || 0) + 1;
    const n = normalizeClozePos(a, (q.points || [])[1]);
    srcDist[n.source] = (srcDist[n.source] || 0) + 1;
    if (A !== B) fails.push({ id: q.id, A, B, slot });
  }
  console.log(`[eval] cloze ${clozeQ.length} 题`);
  console.log(`  A 通道（答案词性标注行）命中 ${aHit}/${clozeQ.length}  分布 ${JSON.stringify(aDist)}`);
  console.log(`  B 通道（槽描述受控规则）可判定 ${clozeQ.length - (bDist[CLOZE_POS_FALLBACK] || 0)}/${clozeQ.length}` +
              `  一致率 ${((agree / clozeQ.length) * 100).toFixed(1)}%  分布 ${JSON.stringify(bDist)}`);
  console.log(`  最终走到的通道 ${JSON.stringify(srcDist)}`);
  console.log(`  最终标签分布（A 优先）:`);
  const final = {};
  for (const { q } of clozeQ) {
    const n = normalizeClozePos(q.analysis, (q.points || [])[1]);
    final[n.label] = (final[n.label] || 0) + 1;
  }
  for (const [k, v] of Object.entries(final).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
  console.log(`  最终唯一标签数 ${Object.keys(final).length}`);
  console.log(`  A/B 不一致 ${fails.length} 例（B 仅在无标注来源时兜底，不影响本次交付）`);
  return;
}

// ============================================================ 修复

const csvRows = [];
const changes = [];
for (const { f, q } of clozeQ) {
  const oldPts = q.points;
  if (!Array.isArray(oldPts) || oldPts.length < 2) throw new Error('cloze points 形态异常: ' + q.id);
  const oldLabel = oldPts[1];
  const n = normalizeClozePos(q.analysis, oldLabel);
  if (n.label === oldLabel) continue;                    // 已收敛（如通用标签）不视为改动
  oldPts[1] = n.label;
  changes.push({ id: q.id, paper: papers[f].id, qno: q.qno, answer: q.answer, old: oldLabel, new: n.label, source: n.source });
  csvRows.push([
    q.id, papers[f].id, String(q.qno), q.answer || '', oldLabel, n.label, n.source,
    (/【词性槽】([^\n]*)/.exec(String(q.analysis || '')) || [, ''])[1].trim(),
  ]);
}

// ---------------- 写回（只写真正变化的文件）
const changedFiles = [], stableFail = [];
for (const f of files) {
  const p = path.join(BANK_DIR, f);
  const orig = fs.readFileSync(p);
  const out = Buffer.from(serializeBank(papers[f]), 'utf8');
  if (out.equals(orig)) continue;
  changedFiles.push(f);
  if (!DRY_RUN) fs.writeFileSync(p, out);
}

// ============================================================ 验证

const v = [];
const push = (name, pass, detail) => v.push({ name, pass: !!pass, detail });

// 1) 题数
let total = 0;
for (const f of files) total += papers[f].questions.length;
push('全库题数不变（76 卷 / 3315 题）', files.length === 76 && total === 3315, `${files.length} 卷 / ${total} 题`);

// 2) answer 逐题零变更（与备份比对，全 3315 题）
let ansBad = [], ansN = 0;
for (const f of files) {
  const bmap = new Map(backupPapers[f].questions.map((q) => [q.id, q]));
  for (const q of papers[f].questions) {
    const bq = bmap.get(q.id);
    if (!bq) { ansBad.push(q.id + '(备份缺题)'); continue; }
    ansN++;
    if (sha256(String(q.answer)) !== sha256(String(bq.answer))) ansBad.push(q.id);
  }
}
push('answer 字段零变更（逐题与备份比对）', ansBad.length === 0 && ansN === 3315,
     ansBad.length ? '不一致: ' + ansBad.slice(0, 10).join(',') : `${ansN}/3315 一致`);

// 3) 除 cloze 的 points 外，其余字段与备份完全一致
const fieldDiff = [];
for (const f of files) {
  const bmap = new Map(backupPapers[f].questions.map((q) => [q.id, q]));
  for (const q of papers[f].questions) {
    const bq = bmap.get(q.id);
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, val) => (k === 'points' ? undefined : val)));
    if (JSON.stringify(strip(q)) !== JSON.stringify(strip(bq))) fieldDiff.push(q.id + '(非 points 字段变动)');
    if (!isCloze(q)) {
      if (JSON.stringify(q.points) !== JSON.stringify(bq.points)) fieldDiff.push(q.id + '(非 cloze 的 points 变动)');
    } else {
      if (JSON.stringify(q.points[0]) !== JSON.stringify(bq.points[0])) fieldDiff.push(q.id + '(cloze points[0] 变动)');
      if (bq.points.length !== q.points.length) fieldDiff.push(q.id + '(cloze points 长度变动)');
    }
  }
}
push('非 cloze 题与非 points 字段零变动', fieldDiff.length === 0,
     fieldDiff.length ? fieldDiff.slice(0, 10).join(',') : 'answer/stem/analysis/options/writing/translation 全等');

// 4) 收敛：cloze points[1] 唯一标签数 ≤ 10，且都属受控词表
const labelDist = {};
for (const f of files) for (const q of papers[f].questions) {
  if (!isCloze(q)) continue;
  const L = (q.points || [])[1];
  labelDist[L] = (labelDist[L] || 0) + 1;
}
const labels = Object.keys(labelDist);
const allowed = CLOZE_POS_VOCAB.concat([CLOZE_POS_FALLBACK]);
const outsiders = labels.filter((l) => allowed.indexOf(l) < 0);
push('cloze points[1] 收敛到 ≤10 种受控标签', labels.length <= 10 && outsiders.length === 0,
     `${labels.length} 种：` + JSON.stringify(labelDist));

// 5) 写回格式稳定：重新序列化与磁盘逐字节一致
if (!DRY_RUN) {
  let stable = 0, unstable = [];
  for (const f of files) {
    const cur = fs.readFileSync(path.join(BANK_DIR, f));
    const re = Buffer.from(serializeBank(loadBankFile(path.join(BANK_DIR, f))), 'utf8');
    if (re.equals(cur)) stable++; else unstable.push(f);
  }
  push('写回格式与原始格式一致（重新序列化逐字节相同）', unstable.length === 0,
       `${stable}/${files.length}` + (unstable.length ? ' | 不一致: ' + unstable.join(',') : ''));
} else {
  push('写回格式稳定（预览模式跳过）', true, 'dry-run');
}

// ---------------- 输出
console.log(`模式: ${DRY_RUN ? '预览（不写盘）' : '修复并写盘'}`);
console.log(`cloze ${clozeQ.length} 题；拟改标签 ${changes.length} 题；改动文件 ${changedFiles.length}/${files.length}`);
console.log('收敛后标签分布:', JSON.stringify(labelDist));
console.log(`唯一标签 ${labels.length} 种`);
console.log('改动文件:', changedFiles.join(', '));
console.log('\n=== 验证 ===');
console.log(v.map((x) => `  [${x.pass ? 'PASS' : 'FAIL'}] ${x.name} — ${x.detail}`).join('\n'));

if (!DRY_RUN) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const csv = '\ufeffid,paper,qno,answer,old_points1,new_label,rule_source,full_slot\n' +
    csvRows.map((r) => r.map((c) => {
      const s = String(c == null ? '' : c);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n') + '\n';
  fs.writeFileSync(path.join(REPORT_DIR, 'points-changes.csv'), csv, 'utf8');
  fs.writeFileSync(path.join(REPORT_DIR, 'points-fix-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), cloze: clozeQ.length, changed: changes.length,
                     changedFiles, labelDist, verify: v, changes }, null, 1), 'utf8');
  console.log('\n报告:', path.join(REPORT_DIR, 'points-fix-report.json'));
  console.log('明细:', path.join(REPORT_DIR, 'points-changes.csv'));
}
if (!v.every((x) => x.pass)) process.exitCode = 1;
