#!/usr/bin/env node
'use strict';
/* lint_all.js · ESLint 统一入口（本地与 CI 用同一条命令）
 *
 * 为什么需要包装：ESLint flat config 的 basePath = 运行时 cwd，
 * 而项目是「CET6/scripts（测试）+ CET6/app（源码）」双目录分治。
 * 直接在 scripts/ 下跑 `eslint . ../app` 会因 app 在 basePath 之外而退出码 2。
 * 这里把 cwd 固定到 CET6/ 根，再显式指向 scripts 里的配置与 eslint 可执行文件，
 * 两个目录就都在 basePath 内了。
 *
 * 用法：npm run lint   （在 CET6/scripts 下执行）
 * 退出码：直接透传 ESLint（0 = 无 error；warning 不影响门禁）
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ESLINT_BIN = path.join(__dirname, 'node_modules', 'eslint', 'bin', 'eslint.js');
const CONFIG = path.join(__dirname, 'eslint.config.js');

const r = spawnSync(process.execPath,
  [ESLINT_BIN, '--config', CONFIG, 'scripts', 'app'],
  { cwd: ROOT, stdio: 'inherit' });

if (r.error) { console.error('lint 启动失败：' + r.error.message); process.exit(2); }
process.exit(r.status === null ? 2 : r.status);
