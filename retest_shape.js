'use strict';
/* 只读：打印题库 paper / question 的字段形状，供复测脚本构造用例 */
const fs = require('fs'), path = require('path');
const BANK = path.join(__dirname, '..', 'app', 'bank');
const files = fs.readdirSync(BANK).filter(f => f.endsWith('.js'));
global.window = { CET6_BANKS: [] };
const src = files.map(f => fs.readFileSync(path.join(BANK, f), 'utf8')).join('\n');
eval(src);
const B = global.window.CET6_BANKS;
console.log('banks=', B.length);
const p = B.find(b => b.id === '2026-06-1');
console.log('paper keys:', Object.keys(p).join(','));
console.log('writing keys:', Object.keys(p.writing || {}).join(','));
console.log('translation keys:', Object.keys(p.translation || {}).join(','));
console.log('matchParagraphs[0]:', JSON.stringify((p.matchParagraphs || [])[0] || null).slice(0, 200));
console.log('readingPassages keys:', Object.keys(p.readingPassages || {}).join(','));
console.log('questions=', p.questions.length);
const t = {};
p.questions.forEach(q => { t[q.type] = (t[q.type] || 0) + 1; });
console.log('types:', JSON.stringify(t));
for (const ty of Object.keys(t)) {
  const q = p.questions.find(x => x.type === ty);
  console.log('---', ty, JSON.stringify(q).slice(0, 420));
}
const noListen = B.filter(b => !b.questions.some(q => q.type === 'listening')).map(b => b.id);
console.log('no-listening papers:', noListen.join(','));
console.log('sample listeningUrl:', B.find(b => b.listeningUrl) && B.find(b => b.listeningUrl).listeningUrl);
console.log('sharedWith sample:', B.filter(b => b.listeningSharedWith).map(b => b.id + '->' + b.listeningSharedWith).join(','));
let n = 0; B.forEach(b => n += b.questions.length); console.log('total questions=', n);
