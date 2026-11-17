/* eslint.config.js —— CET6 测试工具仓的 ESLint 配置（flat config）
 *
 * 档位：**宽松起步**（2026-11-17 用户确认）
 *   - 只把「明确错误」留成 error：未定义变量、重复键、重复声明、赋值给只读全局等。
 *     这些是真会导致运行时出错的问题，挡住 CI 有意义。
 *   - 存量老式写法（未使用变量、空 catch、while(true)、正则无谓转义等）降为 warn，
 *     只体检、不拦提交。等存量清完再逐条收紧，不搞「一接就红一片」。
 *
 * 覆盖范围：
 *   - 本仓 CET6/scripts 下全部手写 .js
 *   - 跨仓的 CET6/app 下手写 .js（CI 里 clone 到 ../app）
 *   - **排除 app/bank/**：那是 80 个自动生成的题库数据文件（单行 100KB+ JSON），
 *     不是人写的代码，lint 它们既慢又无意义。
 *   - 排除 node_modules / sync-data / docs / .deploy
 *
 * 覆盖 index.html 内联 <script>：由 lint_inline.js 用 ESLint Node API 的 lintText
 *   单独检查（不引入 eslint-plugin-html 依赖），共享本配置，行号换算回 HTML 原文。
 *   因 HTML 里的 '<\/script>' 是为避免标签提前闭合的必需转义，纯 JS 视角的
 *   no-useless-escape 在内联脚本里被 lint_inline.js 关掉，其余规则一致。
 *
 * 用法：
 *   npm run lint                # 统一入口：本仓 + app 源码 + index.html 内联脚本
 *   npx eslint . ../app         # 只查 .js 文件（不含内联脚本）
 * 退出码：只要没有 error 就是 0；warning 不影响门禁。
 */
'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/sync-data/**',
      '**/bank/**',
      '**/docs/**',
      '**/.deploy/**',
      '**/coverage/**',
      '**/.scratch/**',      // 运行时生成的临时测试夹具（csp-fixture*/sw.js），非源码、未入 git
      '**/_cet6-ci-sim/**'
    ]
  },
  {
    // 从 CET6/ 根作为基准，才能同时覆盖 CET6/scripts 与同级 CET6/app（CI 里 clone 到 ../app）
    basePath: require('path').resolve(__dirname, '..'),
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: Object.assign(
        {},
        globals.node,
        globals.browser,
        globals.es2021,
        {
          // 项目自定义全局（题库/核心/同步层通过 window 挂载，非 import）
          CET6Core: 'readonly', CET6_BANKS: 'writable', CET6_META: 'readonly',
          CET6_LISTEN_META: 'readonly', CET6_VERSION: 'readonly',
          CET_SYNC_CONFIG: 'readonly', CET_SYNC: 'readonly', CET6_VERSION_STR: 'readonly'
        }
      )
    },
    rules: Object.assign({}, js.configs.recommended.rules, {
      // ---- 保留 error：明确的运行时错误 ----
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-cond-assign': 'error',
      'no-func-assign': 'error',
      'no-obj-calls': 'error',
      'no-unexpected-multiline': 'error',
      'no-global-assign': 'error',
      'no-self-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      // ---- 降为 warn：存量风格问题，先体检不拦人 ----
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': 'warn',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'no-unreachable': 'warn',
      'no-unsafe-finally': 'warn',
      'no-unsafe-negation': 'warn',
      'no-fallthrough': 'warn',
      'no-extra-boolean-cast': 'warn',
      // 2026-11-17 存量清理后仅剩的 5 条 warning，均为「刻意写法、正确非 bug」，有意保留不改源码：
      //   - 3 处 `[, '']`（fix_points.js）：正则 exec 失败时取第 1 组默认值的惯用法；
      //   - 2 处 `\-`（fix_content.js:151）：英文词条字符类里连字符转义，语义无害。
      // 都在历史一次性修复脚本里，不为一个惯用法去动已验证过的老脚本；记 warning 体检即可。
      'no-sparse-arrays': 'warn',
      // importScripts 是 Service Worker 全局；仓库里 .scratch 已忽略，app/sw.js 仍会用到
      'no-undef': ['error', { typeof: true }]
    })
  },
  {
    // Service Worker 脚本：补上 SW 专有全局，避免把 importScripts 误判成错误
    files: ['**/sw.js'],
    languageOptions: { globals: { importScripts: 'readonly', clients: 'readonly', self: 'readonly', caches: 'readonly' } }
  }
];
