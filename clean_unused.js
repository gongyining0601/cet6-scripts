#!/usr/bin/env node
'use strict';
/* clean_unused.js · 一次性工具：精确清理存量 no-unused-vars warning
 *
 * 设计（保守、可验证、零行为影响）：
 *   1. 先用项目真实配置跑一遍，拿到 ESLint 报告的每条 no-unused-vars 的 (文件, 变量名, 行号)；
 *   2. 只处理这些「被报告的变量」——不像通用 codemod 那样遍历所有 scope（那会误伤正常变量）；
 *   3. 跳过解构声明（const {a,b}=x 里 b 改名要写成 b: _b，不冒险）、参数、catch、已有 _ 前缀；
 *   4. 用 scopeManager 拿到该变量的声明标识符 + 全部写引用，一起加 _ 前缀（避免漏改导致 no-undef）；
 *   5. 改完对每个文件重新 lint 验证：error 必须为 0、no-unused-vars 必须减少、不得新增 no-undef。
 *
 * 用法：
 *   node clean_unused.js --dry      # 只打印计划
 *   node clean_unused.js --apply    # 应用并逐文件验证
 */
const fs = require('fs');
const path = require('path');
const { ESLint, Linter } = require('eslint');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(__dirname, 'eslint.config.js');
const APPLY = process.argv.includes('--apply');
const RULE = 'cet6/prefix';

const prefixRule = {
  meta: { fixable: 'code' },
  create(context) {
    return {
      'Program:exit'() {
        const targets = context.settings.__targets || new Set();
        const sm = context.sourceCode.scopeManager;
        for (const scope of sm.scopes) {
          for (const v of scope.variables) {
            const declLine = v.identifiers[0] && v.identifiers[0].loc && v.identifiers[0].loc.start.line;
            if (!targets.has(v.name + '@' + declLine)) continue;
            if (v.name.startsWith('_')) continue;
            const def = v.defs[0];
            if (def && (def.type === 'Parameter' || def.type === 'CatchClause')) continue;
            // 解构声明跳过：VariableDeclarator.id 不是这个 identifier 本身
            if (def && def.name && def.name.parent && def.name.parent.type === 'VariableDeclarator'
                && def.name.parent.id !== def.name) continue;
            const ids = [...v.identifiers, ...v.references.map(r => r.identifier)].filter(Boolean);
            for (const id of ids) {
              context.report({ node: id, message: 'prefix unused', fix: f => f.insertTextBefore(id, '_') });
            }
          }
        }
      }
    };
  }
};

function _countByRule(messages) {
  const o = {};
  for (const m of messages) o[m.ruleId || '(null)'] = (o[m.ruleId || '(null)'] || 0) + 1;
  return o;
}

async function main() {
  const eslint = new ESLint({ overrideConfigFile: CONFIG, cwd: ROOT });
  const results = await eslint.lintFiles(['scripts', 'app']);

  const linter = new Linter({ configType: 'flat' });
  let filesChanged = 0, varsRenamed = 0, skipped = 0;
  const problems = [];

  for (const r of results) {
    const targets = new Set();
    for (const m of r.messages) {
      if (m.ruleId !== 'no-unused-vars') continue;
      const name = /'([^']+)'/.exec(m.message);
      if (name) targets.add(name[1] + '@' + m.line);
    }
    if (!targets.size) continue;

    const orig = fs.readFileSync(r.filePath, 'utf8');
    const cfg = [{
      languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
      settings: { __targets: targets },
      plugins: { cet6: { rules: { prefix: prefixRule } } },
      rules: { [RULE]: 'error' }
    }];
    const out = linter.verifyAndFix(orig, cfg, { filename: r.filePath });
    if (out.output === orig) { skipped += targets.size; continue; }

    // 验证：改后必须 error=0，且不得新增 no-undef
    const check = await eslint.lintText(out.output, { filePath: r.filePath });
    const msgs = check.length ? check[0].messages : [];
    const errs = msgs.filter(m => m.severity === 2);
    const undef = msgs.filter(m => m.ruleId === 'no-undef');
    const rel = path.relative(ROOT, r.filePath);
    const beforeCnt = r.messages.filter(m => m.ruleId === 'no-unused-vars').length;
    const afterCnt = msgs.filter(m => m.ruleId === 'no-unused-vars').length;

    if (errs.length || undef.length || afterCnt >= beforeCnt) {
      problems.push(`${rel}: error=${errs.length} no-undef=${undef.length} unused ${beforeCnt}->${afterCnt}`);
      continue;
    }

    const n = (out.output.match(/_/g) || []).length - (orig.match(/_/g) || []).length;
    console.log(`${APPLY ? '改' : '计划'}: ${rel}  unused ${beforeCnt}->${afterCnt}, +${n} 个 _ 前缀`);
    filesChanged++; varsRenamed += n;
    if (APPLY) fs.writeFileSync(r.filePath, out.output, 'utf8');
  }

  console.log(`\n合计：${filesChanged} 文件 / ${varsRenamed} 处改名；跳过（解构等）约 ${skipped} 条`);
  if (problems.length) {
    console.log('\n未通过验证、未改动的文件：');
    problems.forEach(p => console.log('  ' + p));
    process.exitCode = 4;
  }
  console.log(APPLY ? '\n已应用。请跑 npm run lint 与 core 组回归复核。' : '\ndry-run，未改任何文件。');
}

main().catch(e => { console.error(e.stack || e); process.exit(2); });
