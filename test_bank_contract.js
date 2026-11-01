'use strict';
/* B2 · 题库字段契约测试（逐卷逐题校验）
 * 用法：node scripts/test_bank_contract.js
 * 目的：把 app/bank/ 76 卷 3315 题的字段形状从"人眼观察"升级为机器判定的契约。
 * 失败时 process.exitCode=1，供 run_all.js core 组闸门拦截。
 *
 * 复测：把某卷 questions[0].answer 改成 'Z'（越界），本用例必须 FAIL。 */
const fs = require('fs');
const path = require('path');

const BANK = path.join(__dirname, '..', 'app', 'bank');
global.window = { CET6_BANKS: [] };
// 排除 meta.js / listeningMeta.js（元数据，不是试卷）
const files = fs.readdirSync(BANK).filter(f => f.endsWith('.js') && f !== 'meta.js' && f !== 'listeningMeta.js');
files.forEach(f => {
  try { eval(fs.readFileSync(path.join(BANK, f), 'utf8')); }
  catch (e) { console.error('加载卷失败 ' + f + ': ' + e.message); process.exitCode = 1; }
});
const BANKS = global.window.CET6_BANKS;

let nOk = 0, nFail = 0;
function chk(name, cond, detail) {
  if (cond) { nOk++; console.log('ok   ' + name + (detail ? ' | ' + detail : '')); }
  else { nFail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

const VALID_TYPES = ['listening', 'cloze', 'match', 'reading'];
const TYPE_LETTER = { listening: 'l', cloze: 'c', match: 'm', reading: 'r' };
const ANS_RANGE = {
  listening: /^[ABCD]$/,
  reading: /^[ABCD]$/,
  cloze: /^[A-O]$/,
};

chk('题库非空且是数组', Array.isArray(BANKS) && BANKS.length > 0, '套数=' + BANKS.length);
chk('卷数与文件数一致', BANKS.length === files.length, '卷=' + BANKS.length + ' 文件=' + files.length);

const idSet = new Set();
const paperIds = new Set();

BANKS.forEach(p => {
  // 1) paper 级契约
  chk('paper.id 格式 ' + p.id, /^\d{4}-\d{2}-\d$/.test(p.id), p.id);
  chk('paper.questions 是数组 ' + p.id, Array.isArray(p.questions),
    p.id + ' n=' + (p.questions ? p.questions.length : 'missing'));
  // 共享卷：questions 为空但通过 *SharedWith 引用别卷内容（设计使然）
  const shared = [p.listeningSharedWith, p.clozeSharedWith, p.matchSharedWith, p.readingSharedWith].some(Boolean);
  if (p.questions && p.questions.length === 0) {
    chk('空卷必须有 SharedWith ' + p.id, shared, p.id + ' 空卷但无共享引用');
  } else {
    chk('paper 至少 1 题 ' + p.id, p.questions && p.questions.length > 0, p.id);
  }
  chk('paper.writing 有 prompt+sample ' + p.id,
    !!(p.writing && p.writing.prompt && p.writing.sample), p.id);
  chk('paper.translation 有 prompt+sample ' + p.id,
    !!(p.translation && p.translation.prompt && p.translation.sample), p.id);
  if (paperIds.has(p.id)) chk('paper.id 唯一 ' + p.id, false, '重复');
  paperIds.add(p.id);

  // 2) 逐题契约
  const matchLabels = (p.matchParagraphs || []).map(m => m.label);
  p.questions.forEach(q => {
    const qid = q.id;
    if (idSet.has(qid)) chk('qid 唯一 ' + qid, false, '重复');
    idSet.add(qid);

    // id 格式：<paperId>-<letter>-<qno>
    const letter = TYPE_LETTER[q.type];
    const idRe = new RegExp('^' + p.id.replace(/[-]/g, '\\-') + '-' + letter + '-\\d+$');
    chk('qid 格式 ' + qid, idRe.test(qid), qid);

    // type 枚举
    chk('type 合法 ' + qid, VALID_TYPES.indexOf(q.type) >= 0, qid + ' type=' + q.type);

    // qno 正整数
    chk('qno 正整数 ' + qid, Number.isInteger(q.qno) && q.qno > 0, qid + ' qno=' + q.qno);

    // answer 合法性（按题型）
    if (q.type === 'match') {
      chk('match answer 是段落标签 ' + qid,
        matchLabels.indexOf(q.answer) >= 0, qid + ' ans=' + q.answer + ' labels=' + matchLabels.join(','));
    } else {
      const re = ANS_RANGE[q.type];
      chk('answer 在合法区间 ' + qid, re && re.test(q.answer), qid + ' ans=' + q.answer);
    }

    // options 长度约束
    if (q.type === 'listening' || q.type === 'reading') {
      chk('options 恰 4 项 ' + qid, Array.isArray(q.options) && q.options.length === 4,
        qid + ' n=' + (q.options ? q.options.length : 'missing'));
    } else if (q.type === 'cloze') {
      chk('options 恰 15 项 ' + qid, Array.isArray(q.options) && q.options.length === 15,
        qid + ' n=' + (q.options ? q.options.length : 'missing'));
    } else if (q.type === 'match') {
      chk('match 无 options ' + qid, !q.options || q.options.length === 0, qid);
    }

    // analysis 非空（客观题）
    chk('analysis 非空 ' + qid, typeof q.analysis === 'string' && q.analysis.length > 0,
      qid + ' len=' + (q.analysis ? q.analysis.length : 0));
  });
});

chk('qid 全局无重复', idSet.size === BANKS.reduce((a, p) => a + p.questions.length, 0),
  'unique=' + idSet.size + ' total=' + BANKS.reduce((a, p) => a + p.questions.length, 0));

console.log('\n===== 题库契约: ' + nOk + ' ok / ' + nFail + ' fail (' +
  BANKS.length + ' 卷 / ' + BANKS.reduce((a, p) => a + p.questions.length, 0) + ' 题) =====');
process.exitCode = nFail ? 1 : 0;
