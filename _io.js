// scripts/_io.js —— Windows 文件锁安全写入
// 本机运行回归时，docs/*.json 会被 Defender/索引器短暂锁住，导致 fs.writeFileSync 抛
// EBUSY / EPERM，进而让用例在断言全绿后被判 FAIL（写结果阶段崩溃）。
// 这里提供带重试的 writeFileSync：遇到锁相关错误就退避重试，最多约 5s。
'use strict';
const fs = require('fs');

function sleep(ms) {
  // Node 主线程阻塞睡眠（用例脚本是短生命周期，可接受）。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function writeFileSyncRetry(file, data, opts) {
  let lastErr;
  for (let i = 0; i < 12; i++) {
    try {
      return fs.writeFileSync(file, data, opts);
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EMFILE')) {
        sleep(150 + i * 80);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

module.exports = { writeFileSyncRetry, sleep };
