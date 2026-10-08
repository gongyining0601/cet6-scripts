// 全库准确性校验：答案字段合法性 + 解析【答案】与字段交叉核对
// 用法：node scripts/verify_bank.js（路径相对于本脚本，任何机器上可跑）
//
// 说明（改造）：本脚本原先只 console.log 各项计数、不做任何判定，因此被回归 runner
// 归类为"0 断言"——跑完了却无法判断题库到底合不合格。现改为逐项输出 ok/FAIL 断言
// 并设置退出码，使其真正成为题库闸门。
const fs = require('fs');
const path = require('path');
global.window = {};
const C = require(path.join(__dirname, '..', 'app', 'core.js'));
const dir = path.join(__dirname, '..', 'app', 'bank') + path.sep;
fs.readdirSync(dir).filter(f => f.endsWith('.js')).forEach(f => {
  eval(fs.readFileSync(dir + f, 'utf8'));
});
const BANKS = window.CET6_BANKS;

let nOk = 0, nFail = 0;
function chk(name, cond, detail) {
  if (cond) { nOk++; console.log('ok   ' + name + (detail ? ' | ' + detail : '')); }
  else { nFail++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
  return cond;
}

let total = 0, bad = [], mismatch = [], noAns = [], noAnalysis = [];
const papers = {};
BANKS.forEach(p => {
  p.questions.forEach(q => {
    total++;
    papers[p.id] = (papers[p.id] || 0) + 1;
    // 1) answer 非空
    if (!q.answer) { noAns.push(q.id); return; }
    // 2) 合法性
    if (q.type === 'match') {
      const labels = (p.matchParagraphs || []).map(x => x.label);
      if (labels.indexOf(q.answer) < 0) bad.push(q.id + ' match答案不在段落:' + q.answer);
    } else if (q.type === 'cloze') {
      const n = (q.options || []).length;
      if (q.answer.charCodeAt(0) < 65 || q.answer.charCodeAt(0) >= 65 + Math.max(n, 4)) bad.push(q.id + ' cloze答案越界:' + q.answer);
    } else if (q.type === 'listening' || q.type === 'reading') {
      if (!/^[ABCD]$/.test(q.answer)) bad.push(q.id + ' 选项答案非法:' + q.answer);
    }
    // 3) 解析【答案】与字段一致
    if (!q.analysis) { noAnalysis.push(q.id); return; }
    const m = String(q.analysis).match(/【答案】\s*([A-Z])/);
    if (m && m[1] !== q.answer) mismatch.push(q.id + ' 解析=' + m[1] + ' 字段=' + q.answer);
    if (!m && q.type !== 'writing' && q.type !== 'translation') {
      // 选词/匹配解析格式不同，单独看
      const m2 = String(q.analysis).match(/答案[】:：]\s*([A-Z])/);
      if (m2 && m2[1] !== q.answer) mismatch.push(q.id + ' 解析2=' + m2[1] + ' 字段=' + q.answer);
    }
  });
});
console.log('套数: ' + BANKS.length + ' | 总题数: ' + total);
console.log('每套题数分布: min=' + Math.min(...Object.values(papers)) + ' max=' + Math.max(...Object.values(papers)));

/* 4) 抽样：非选择题结构（写译题面与范文） */
let essay = 0;
BANKS.forEach(p => { if (p.writing && p.writing.prompt && p.writing.sample && p.translation && p.translation.prompt && p.translation.sample) essay++; });
/* 5) 听力音频链接 */
let audio = 0;
BANKS.forEach(p => { if (p.listeningUrl) audio++; });

/* ---------------- 断言：题库必须满足的硬条件 ---------------- */
chk('题库非空且是数组', Array.isArray(BANKS) && BANKS.length > 0, '套数=' + BANKS.length);
chk('每套至少 1 题', Math.min(...Object.values(papers)) > 0, 'min=' + Math.min(...Object.values(papers)));
chk('answer 无缺失', noAns.length === 0, '缺失 ' + noAns.length + ' 条' + (noAns.length ? ' → ' + noAns.slice(0, 5) : ''));
chk('answer 无越界/非法', bad.length === 0, '非法 ' + bad.length + ' 条' + (bad.length ? ' → ' + bad.slice(0, 10) : ''));
chk('解析【答案】与字段一致', mismatch.length === 0, '不一致 ' + mismatch.length + ' 条' + (mismatch.length ? ' → ' + mismatch.slice(0, 10) : ''));
chk('每道客观题都有解析', noAnalysis.length === 0, '无解析 ' + noAnalysis.length + ' 条' + (noAnalysis.length ? ' → ' + noAnalysis.slice(0, 5) : ''));
chk('写译题面+范文齐全', essay === BANKS.length, essay + '/' + BANKS.length);

/* 听力音频链接是"内容完备性"指标而非错误：部分卷听力与别卷共用（listeningSharedWith），
   没有自己的 URL 是设计使然，故只作为信息输出，不计入失败。 */
console.log('fact 听力音频链接存在: ' + audio + '/' + BANKS.length + '（其余卷与别卷共用听力，见 listeningSharedWith）');

console.log('\n===== 题库校验: ' + nOk + ' ok / ' + nFail + ' fail =====');
process.exitCode = nFail ? 1 : 0;
