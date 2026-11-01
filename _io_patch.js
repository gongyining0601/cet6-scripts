// scripts/_io_patch.js —— 通过 --require 预加载，把 fs.writeFileSync 替换为"原子落盘"版本。
// 本机回归时 docs/*.json 会被 Defender/索引器短暂锁住，直接 writeFileSync 抛 EBUSY/EPERM。
// 方案：先写到同目录的 .tmp 临时文件，再 renameSync 覆盖目标（rename 在 Windows 上是原子的，
// 且不需要打开目标文件）。rename 若也撞锁，退避重试。
'use strict';
const fs = require('fs');
const path = require('path');
const _orig = fs.writeFileSync;

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

fs.writeFileSync = function (file, data, opts) {
  // 写到临时文件再 rename，避免直接打开被锁的目标文件
  const tmp = String(file) + '.tmp.' + process.pid;
  let lastErr;
  // 写临时文件（新文件，几乎不会撞锁；若撞锁也重试）
  for (let i = 0; i < 8; i++) {
    try { _orig.call(fs, tmp, data, opts); break; }
    catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) { sleep(150 + i * 80); continue; }
      throw e;
    }
  }
  // rename 覆盖目标（原子）。短重试：锁通常是瞬时的，长时间重试只会拖慢用例。
  for (let i = 0; i < 3; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) { sleep(150); continue; }
      break;
    }
  }
  // 兜底：直接写（短重试）
  for (let i = 0; i < 3; i++) {
    try { _orig.call(fs, file, data, opts); return; }
    catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) { sleep(150); continue; }
      throw e;
    }
  }
  try { fs.unlinkSync(tmp); } catch (_) {}
  throw lastErr;
};
