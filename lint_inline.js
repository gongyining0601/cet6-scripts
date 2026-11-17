#!/usr/bin/env node
'use strict';
/* lint_inline.js · 把 app/index.html 里的内联 <script> 纳入 ESLint
 *
 * 为什么单独写一个：ESLint 不解析 HTML，`index.html` 里那段 1700+ 行的主体脚本
 * 一直是 lint 盲区。这里不引入 eslint-plugin-html（多一个依赖、多一份 CI 装包风险），
 * 改用 ESLint Node API 的 lintText：把每段内联脚本当纯 JS 文本检查，不落临时文件、
 * 不碰生产代码，CI 与本地跑的结果完全一致。
 *
 * 行号换算：lintText 报的行号是「段内相对行号」，这里加上该段在 index.html 的起始行
 * 减一，让报错能直接对到 HTML 原文行号，排查时不用自己数。
 *
 * 用法：
 *   node lint_inline.js          # 单独跑，打印内联脚本的 error/warning
 * 退出码：有 error 为 1，只有 warning 或干净为 0（与宽松档一致，warning 不挡门禁）。
 */
const fs = require('fs');
const path = require('path');
const { ESLint } = require('eslint');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'app', 'index.html');
const CONFIG = path.join(__dirname, 'eslint.config.js');

// 提取「开标签无 src 属性」的内联脚本；<script src=...> 是外部引用，跳过。
// 结束标签用字面 </script> 匹配：内容里的 '<\/script>' 带反斜杠，不会被误当成结束。
function extractInlineScripts(html) {
  const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(0, m.index + m[0].indexOf('>') + 1);
    const startLine = before.split('\n').length; // 内容首行在 HTML 中的行号
    blocks.push({ code: m[1], startLine });
  }
  return blocks;
}

async function main() {
  if (!fs.existsSync(HTML)) {
    console.log('lint_inline: 未找到 app/index.html，跳过（非 CET6 根布局）');
    return 0;
  }
  const html = fs.readFileSync(HTML, 'utf8');
  const blocks = extractInlineScripts(html);
  if (!blocks.length) {
    console.log('lint_inline: index.html 中没有内联脚本，跳过');
    return 0;
  }

  const eslint = new ESLint({
    overrideConfigFile: CONFIG,
    cwd: ROOT,
    // '<\/script>' 在 HTML 内联脚本中是避免标签提前闭合的必需转义，纯 JS 规则会误判，
    // 仅对内联脚本关掉这条；其余规则与 .js 文件完全一致。
    overrideConfig: [{ rules: { 'no-useless-escape': 'off' } }]
  });
  let errors = 0, warnings = 0;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // filePath 用 .js 虚拟路径：ESLint 默认忽略 .html，用 HTML 路径会导致
    // 「no matching configuration」。lintText 只读文本、不会去磁盘读这个文件。
    // config 已含 browser + 项目自定义 globals，正好覆盖内联脚本。
    const virtual = path.join(ROOT, 'app', '__lint_inline_virtual__.js');
    const results = await eslint.lintText(b.code, { filePath: virtual });
    const msgs = results.length ? results[0].messages : [];
    if (!msgs.length) continue;
    console.log(`\n${HTML}  内联脚本段 ${i + 1}（内容起始于第 ${b.startLine} 行）`);
    for (const msg of msgs) {
      const line = (msg.line || 1) + b.startLine - 1;
      const col = msg.column || 1;
      const sev = msg.severity === 2 ? 'error' : 'warning';
      if (msg.severity === 2) errors++; else warnings++;
      console.log(`  ${line}:${col}  ${sev}  ${msg.message}  ${msg.ruleId || ''}`);
    }
  }

  console.log(`\n✖ index.html 内联脚本：${errors} errors, ${warnings} warnings（${blocks.length} 段）`);
  return errors ? 1 : 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('lint_inline 运行失败：' + (err && err.stack || err));
  process.exit(2);
});
