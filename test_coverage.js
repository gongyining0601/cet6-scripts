/* scripts/test_coverage.js —— core.js 覆盖率门禁（B6）
 *
 * 用 Node 内置 NODE_V8_COVERAGE 跑 test_core.js + retest_core.js，
 * 解析 V8 覆盖率，排除 app/bank/**，断言 core.js 行覆盖 ≥ 80%、分支覆盖 ≥ 80%。
 *
 * 用法：node test_coverage.js
 * 退出码：0 = 达标，1 = 不达标
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'app', 'core.js');
const CORE_URL = 'file:///' + CORE.replace(/\\/g, '/');

/* ---------- 1. 起带覆盖率的子进程跑两个 core 测试 ---------- */
function runWithCoverage(script, covDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', path.join(__dirname, '_io_patch.js'), script], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { NODE_V8_COVERAGE: covDir, NO_COLOR: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
    child.on('error', reject);
  });
}

/* ---------- 2. V8 覆盖率 → 行覆盖 / 分支覆盖 ----------
   V8 输出：result[].functions[].ranges[] = { startOffset, endOffset, count }
   isBlockCoverage=true 时，ranges 代表基本块（可用于分支覆盖）。
   行覆盖：把 byte offset 映射到源文件行号，某行被任意 count>0 的 range 覆盖即算覆盖。
   分支覆盖：block 级 range 中 count>0 的比例。 */
function parseCoverage(covFiles, targetUrl) {
  const source = fs.readFileSync(CORE, 'utf8');
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const offsetToLine = off => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  // 跨进程合并：同一 range (start,end) 取 count 最大值，避免分母重复计算
  const rangeCounts = new Map(); // key: "start-end" -> max count
  const blockRanges = new Set(); // 记录哪些 range 属于 block coverage（用于分支分母）

  covFiles.forEach(f => {
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
    (data.result || []).forEach(r => {
      if (r.url !== targetUrl) return;
      (r.functions || []).forEach(fn => {
        const isBlock = !!fn.isBlockCoverage;
        (fn.ranges || []).forEach(rg => {
          const key = rg.startOffset + '-' + rg.endOffset;
          const prev = rangeCounts.get(key) || 0;
          if (rg.count > prev) rangeCounts.set(key, rg.count);
          if (isBlock) blockRanges.add(key);
        });
      });
    });
  });

  const coveredLines = new Set();
  const totalLines = new Set();
  let blockTotal = 0, blockHit = 0;

  rangeCounts.forEach((count, key) => {
    const [s, e] = key.split('-').map(Number);
    const sLine = offsetToLine(s), eLine = offsetToLine(e);
    for (let l = sLine; l <= eLine; l++) totalLines.add(l);
    if (count > 0) for (let l = sLine; l <= eLine; l++) coveredLines.add(l);
    if (blockRanges.has(key)) {
      blockTotal++;
      if (count > 0) blockHit++;
    }
  });

  const srcLines = source.split('\n');
  const significant = new Set();
  for (let i = 0; i < srcLines.length; i++) {
    const t = srcLines[i].trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    significant.add(i + 1);
  }
  const denom = [...totalLines].filter(l => significant.has(l));
  const hit = denom.filter(l => coveredLines.has(l));

  return {
    linePct: denom.length ? (hit.length / denom.length * 100) : 0,
    lineHit: hit.length, lineTotal: denom.length,
    branchPct: blockTotal ? (blockHit / blockTotal * 100) : 0,
    branchHit: blockHit, branchTotal: blockTotal,
  };
}

(async () => {
  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cet6-cov-'));
  console.log('coverage dir:', covDir);

  // 跑所有 require core.js 的 Node 侧测试，最大化分支覆盖
  const scripts = [
    'test_core.js',
    'retest_core.js',
    'verify_bank.js',
    'verify_fixes.js',
    'verify_fix_report.js',
    'test_bank_contract.js',
    'test_journey_logic.js',
  ];
  for (const s of scripts) {
    const r = await runWithCoverage(s, covDir);
    console.log(s + ' exit:', r.code, '| tail:', r.out.split('\n').filter(Boolean).slice(-1).join(''));
  }

  const covFiles = fs.readdirSync(covDir).map(f => path.join(covDir, f)).filter(f => f.endsWith('.json'));
  console.log('coverage files:', covFiles.length);

  const cov = parseCoverage(covFiles, CORE_URL);
  console.log('\n===== core.js 覆盖率 =====');
  console.log('  行覆盖:   ' + cov.lineHit + '/' + cov.lineTotal + ' = ' + cov.linePct.toFixed(1) + '%');
  console.log('  分支覆盖: ' + cov.branchHit + '/' + cov.branchTotal + ' = ' + cov.branchPct.toFixed(1) + '%');

  const LINE_MIN = 80, BRANCH_MIN = 80;
  const lineOk = cov.linePct >= LINE_MIN;
  const branchOk = cov.branchPct >= BRANCH_MIN;
  console.log('\n  行覆盖 ≥ ' + LINE_MIN + '%: ' + (lineOk ? 'PASS' : 'FAIL'));
  console.log('  分支覆盖 ≥ ' + BRANCH_MIN + '%: ' + (branchOk ? 'PASS' : 'FAIL'));

  // 清理
  try { covFiles.forEach(f => fs.unlinkSync(f)); fs.rmdirSync(covDir); } catch (e) {}

  if (lineOk && branchOk) {
    console.log('\nGATE PASS: core.js 行/分支覆盖均 ≥ 80%');
    process.exit(0);
  } else {
    console.log('\nGATE FAIL: 覆盖率未达标');
    process.exit(1);
  }
})();
