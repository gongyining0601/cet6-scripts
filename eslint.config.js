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
 * 不覆盖：index.html 里的内联 <script>（ESLint 不解析 HTML；如需覆盖要另加
 *   eslint-plugin-html 或把内联脚本抽成独立文件，属于下一阶段的事）。
 *
 * 用法：
 *   npx eslint .                # 只查本仓
 *   npx eslint . ../app         # 连应用源码一起查（CI 用这条）
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
          CET_SYNC_CONFIG: 'readonly', CET6_VERSION_STR: 'readonly'
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
      // 3 处存量 `[, '']` 是「正则 exec 失败时取第 1 组默认值」的刻意写法（正确、非 bug），
      // 落在历史一次性修复脚本里；按宽松档记 warning，不为一个惯用法去改老脚本。
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
