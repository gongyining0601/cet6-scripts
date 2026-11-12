#!/usr/bin/env node
'use strict';
/* ============================================================================
   test_mutation.js · 变异测试自动化（把 docs/mutation-cases.md 从"人工记录"变成可复算）

   原来 15 个变异体是「手工改代码 → 手工跑 → 手工记 ✅」，无法重跑验证。
   本脚本自动完成：建立**临时副本** → 基线跑一次确认原版全绿 →
   逐个注入单点变异 → 跑指定用例 → 必须 FAIL（被杀）→ 还原 → 输出 JSON。

   关键安全设计：**绝不修改 D:\CET6 里的任何生产文件**。
   整个变异过程在 os.tmpdir() 的临时副本上进行，结束删除副本。

   首批 5 个变异体（对应 mutation-cases.md 的 #1/#2/#3/#4/#6）：
     #5 描述「删掉 String(a)」与当前源码不符（dayDiff 本就直接 a.split），
     已替换为 #6 addDays 月份偏移，注释里如实记录。
   用法：node test_mutation.js     产物：docs/mutation-result.json
   退出码：0 = 全部被杀，1 = 有存活/未生效
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const APP_SRC = path.join(ROOT, 'app');

const CASES = [
  {
    id: 1, name: 'judge 永远判对', file: 'app/core.js',
    from: 'CORE.judge = function (q, answer) { return answer === q.answer; };',
    to: 'CORE.judge = function (q, answer) { return true; };',
    kill: ['test_journey_logic.js']
  },
  {
    id: 2, name: '坏档隔离备份被注释', file: 'app/core.js',
    from: '        CORE.lastCorruptBackup = bk;',
    to: '        // CORE.lastCorruptBackup = bk;',
    kill: ['verify_fixes.js']
  },
  {
    id: 3, name: 'meta 卷序退回旧→新', file: 'app/core.js',
    from: '    var order = (src && Array.isArray(src.order)) ? src.order : Object.keys(papers);',
    to: '    var order = Object.keys(papers);',
    kill: ['verify_bank.js']
  },
  {
    id: 4, name: 'esc 正则删掉单引号', file: 'app/index.html',
    from: ".replace(/[&<>\"']/g,",
    to: '.replace(/[&<>"]/g,',
    kill: ['retest_core.js']
  },
  {
    id: 6, name: 'addDays 月份少减 1', file: 'app/core.js',
    from: 'var d = new Date(p[0], p[1] - 1, p[2] + n);',
    to: 'var d = new Date(p[0], p[1], p[2] + n);',
    kill: ['test_core.js']
  }
];

const R = {
  ts: new Date().toISOString(), method: '临时副本 + 单点源码替换 + 指定用例必须 FAIL',
  sandbox: 'os.tmpdir() 副本，生产目录零改动',
  note: 'mutation-cases.md 的 #5 与当前源码不符（dayDiff 本就无 String(a) 防护），本轮用 #6 替代；其余 10 个变异体待补',
  baseline: [], cases: [], killed: 0, survived: 0, notApplied: 0, verdict: ''
};

function runScript(script, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], {
      cwd, env: Object.assign({}, process.env, { NO_COLOR: '1' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
    child.on('error', e => resolve({ code: null, out: String(e) }));
  });
}
// 有些自研 assert 脚本失败时仍 exit 0，所以同时看输出里的 FAIL 标记
const isKill = r => r.code !== 0 || /\bFAIL\b|❌|✗/.test(r.out);
const tail = (s, n) => s.split(/\r?\n/).filter(Boolean).slice(-n).join(' ⏎ ').slice(0, 220);

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cet6-mutation-'));
  const SCRIPTS_DST = path.join(TMP, 'scripts');
  try {
    fs.cpSync(APP_SRC, path.join(TMP, 'app'), { recursive: true });
    fs.mkdirSync(SCRIPTS_DST, { recursive: true });
    fs.mkdirSync(path.join(TMP, 'docs', 'metrics'), { recursive: true });
    fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).forEach(f => {
      fs.copyFileSync(path.join(__dirname, f), path.join(SCRIPTS_DST, f));
    });
    /* verify_fixes.js 会真起浏览器做 CSV 导出，必须带上 playwright-core。
       只复制文本类既有证据，跳过 60MB 的 PNG 截图。 */
    const NM = path.join(__dirname, 'node_modules');
    if (fs.existsSync(NM)) fs.cpSync(NM, path.join(SCRIPTS_DST, 'node_modules'), { recursive: true });
    if (fs.existsSync(DOCS)) {
      fs.readdirSync(DOCS).filter(f => /\.(json|txt|csv|md|log)$/i.test(f)).forEach(f => {
        const s = path.join(DOCS, f);
        if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(TMP, 'docs', f));
      });
      const b = path.join(DOCS, 'metrics', 'baseline.json');
      if (fs.existsSync(b)) fs.copyFileSync(b, path.join(TMP, 'docs', 'metrics', 'baseline.json'));
    }
    // 根仓 README 只在 test_id_isolation 用，本轮不跑；留空文件以防其它脚本读
    fs.writeFileSync(path.join(TMP, 'README.md'), 'mutation sandbox\n', 'utf8');
    console.log('临时副本: ' + TMP);

    // 基线：确认每个"杀手"脚本在未变异时本来就全绿，否则被杀结论不成立
    const killers = [...new Set(CASES.flatMap(c => c.kill))];
    for (const k of killers) {
      const r = await runScript(k, SCRIPTS_DST);
      R.baseline.push({ script: k, exit: r.code, pass: !isKill(r) });
      console.log('基线 ' + k + ' → ' + (!isKill(r) ? 'PASS' : 'FAIL(基线不成立)'));
      if (isKill(r)) console.log('        │ ' + tail(r.out, 3));
    }

    for (const c of CASES) {
      const target = path.join(TMP, c.file);
      const original = fs.readFileSync(target, 'utf8');
      if (!original.includes(c.from)) {
        R.notApplied++; R.cases.push(Object.assign({ result: 'NOT-APPLIED', reason: '替换文本未命中源码' },
          { id: c.id, name: c.name, file: c.file }));
        console.log('FAIL - 变异 #' + c.id + ' ' + c.name + ' | 替换文本未命中源码');
        continue;
      }
      try {
        fs.writeFileSync(target, original.replace(c.from, c.to), 'utf8');
        const runs = [];
        for (const k of c.kill) {
          const r = await runScript(k, SCRIPTS_DST);
          runs.push({ script: k, exit: r.code, killed: isKill(r), tail: tail(r.out, 3) });
        }
        const killed = runs.some(x => x.killed);
        killed ? R.killed++ : R.survived++;
        R.cases.push({ id: c.id, name: c.name, file: c.file, result: killed ? 'KILLED' : 'SURVIVED', runs });
        console.log((killed ? 'ok  ' : 'FAIL') + ' - 变异 #' + c.id + ' ' + c.name +
          ' → ' + (killed ? '被杀' : '存活（断言没抓住）'));
      } finally {
        // 无条件还原，绝不把变异留在副本之外
        fs.writeFileSync(target, original, 'utf8');
      }
    }

    // 还原校验：原始字节必须完全一致
    const dirty = CASES.filter(c => fs.readFileSync(path.join(TMP, c.file), 'utf8') !==
      fs.readFileSync(path.join(ROOT, c.file), 'utf8')).map(c => c.file);
    R.restoreVerified = dirty.length === 0;
    if (dirty.length) console.log('FAIL - 副本还原校验不通过: ' + dirty.join(', '));

    R.verdict = (R.survived === 0 && R.notApplied === 0 && R.restoreVerified)
      ? '通过（' + R.killed + '/' + CASES.length + ' 被杀）'
      : '不通过（存活 ' + R.survived + ' / 未生效 ' + R.notApplied + ' / 还原异常 ' + (dirty.length ? '是' : '否') + '）';
  } catch (e) {
    R.fatal = e.message;
    R.verdict = '未实测（中断）';
    console.log('FAIL - 变异流程中断 | ' + e.message);
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  }

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'mutation-result.json'), JSON.stringify(R, null, 2), 'utf8');
  console.log('\n=== 变异自动化: 被杀 ' + R.killed + ' / 存活 ' + R.survived +
    ' / 未生效 ' + R.notApplied + ' · ' + R.verdict + ' ===');
  console.log('产物 -> docs/mutation-result.json');
  process.exit(R.verdict.startsWith('通过') ? 0 : 1);
})();
