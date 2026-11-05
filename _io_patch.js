// scripts/_io_patch.js —— 通过 --require 预加载，把 fs 的写/打开/删除/复制操作替换为"重试+原子落盘"版本。
// 本机回归时 docs/*.png|*.json 会被 Defender/索引器锁住数秒甚至十几秒，直接操作抛 EBUSY/EPERM。
// 方案：
//   · 写操作：先写同目录 .tmp，再 rename 覆盖（rename 原子且不打开目标文件）；rename 也撞锁则退避重试；
//     最后兜底直接写（重试）。
//   · 打开/删除/复制/重命名：退避重试，总窗口拉到 ~60s，覆盖 Defender 最长锁定期。
// 覆盖：writeFileSync / writeFile / promises.writeFile / openSync / open / promises.open
//       copyFileSync / promises.copyFile / unlinkSync / rmSync / renameSync / promises.unlink / promises.rm / promises.rename
'use strict';
const fs = require('fs');
const path = require('path');

const _orig = {
  writeFileSync: fs.writeFileSync,
  openSync: fs.openSync,
  writeFile: fs.writeFile,
  open: fs.open,
  copyFileSync: fs.copyFileSync,
  unlinkSync: fs.unlinkSync,
  rmSync: fs.rmSync,
  renameSync: fs.renameSync,
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
};

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENOTEMPTY']);
function isLock(e) { return e && RETRY_CODES.has(e.code); }

/* ---- 同步休眠 ---- */
function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) {} }
}
/* ---- 异步休眠 ---- */
function sleepAsync(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---- 通用重试参数：总窗口 ~60s ---- */
// 退避序列：从 200ms 线性增长到 3000ms，之后持平，共 27 次。
// sleep 累计恰好 60s，加上每次操作本身耗时，端到端总窗口略大于 60s。
// 之所以拉长：全量回归时 docs/ 下 Defender 会密集扫描新建的 .tmp 文件，
// 单文件锁定期曾实测超过 12s，原来 15s 窗口不够。
const SYNC_BACKOFF = [
  200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000,
  3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000,
];
const ASYNC_BACKOFF = [
  200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000,
  3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000,
];

/* ---- 临时文件名生成：每次重试用新名字，避免撞上已被锁的旧 temp ---- */
// Date.now() 只有 ms 精度，同一 ms 内连续重试会撞名；加一个进程内自增序号保证唯一。
let _tmpCounter = 0;
function tmpName(dest) {
  _tmpCounter += 1;
  return String(dest) + '.tmp.' + process.pid + '.' + Date.now() + '.' + _tmpCounter;
}

/* ===================== 同步通用重试 ===================== */
function syncRetry(fn) {
  let lastErr;
  for (let i = 0; i < SYNC_BACKOFF.length; i++) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      if (isLock(e) && i < SYNC_BACKOFF.length - 1) { sleep(SYNC_BACKOFF[i]); continue; }
      throw e;
    }
  }
  throw lastErr;
}

/* ===================== openSync ===================== */
fs.openSync = function () {
  const args = arguments;
  return syncRetry(() => _orig.openSync.apply(fs, args));
};

/* ===================== unlinkSync ===================== */
fs.unlinkSync = function (p) {
  return syncRetry(() => _orig.unlinkSync.call(fs, p));
};

/* ===================== rmSync ===================== */
fs.rmSync = function (p, opts) {
  return syncRetry(() => _orig.rmSync.call(fs, p, opts));
};

/* ===================== renameSync ===================== */
fs.renameSync = function (a, b) {
  return syncRetry(() => _orig.renameSync.call(fs, a, b));
};

/* ===================== copyFileSync（tmp + rename，copyFile 撞锁时退化为 read+write） ===================== */
fs.copyFileSync = function (src, dest, mode) {
  let tmp;
  // 方案 A：copyFile 到临时文件（每次重试用新 tmp 名，避免撞已被锁的旧 temp）
  try {
    syncRetry(() => { tmp = tmpName(dest); _orig.copyFileSync.call(fs, src, tmp, mode); });
  } catch (e) {
    // 方案 B：copyFile 撞锁 → readFileSync + writeFileSync
    if (isLock(e)) {
      const buf = syncRetry(() => _orig.readFileSync.call(fs, src));
      syncRetry(() => { tmp = tmpName(dest); _orig.writeFileSync.call(fs, tmp, buf); });
    } else { throw e; }
  }
  // rename 覆盖目标
  try {
    syncRetry(() => _orig.renameSync.call(fs, tmp, dest));
    return;
  } catch (e) {
    if (!isLock(e)) { try { _orig.unlinkSync.call(fs, tmp); } catch (_) {} throw e; }
  }
  // rename 失败 → 兜底直接写目标
  try {
    const buf = _orig.readFileSync.call(fs, tmp);
    syncRetry(() => _orig.writeFileSync.call(fs, dest, buf));
  } finally {
    try { _orig.unlinkSync.call(fs, tmp); } catch (_) {}
  }
};

/* ===================== writeFileSync（tmp + rename） ===================== */
fs.writeFileSync = function (file, data, opts) {
  let tmp;
  // 写临时文件（每次重试用新 tmp 名，避免撞上已被锁的旧 temp）
  syncRetry(() => { tmp = tmpName(file); _orig.writeFileSync.call(fs, tmp, data, opts); });
  // rename 覆盖（原子，不打开目标）；撞锁重试
  try {
    syncRetry(() => _orig.renameSync.call(fs, tmp, file));
    return;
  } catch (e) {
    if (!isLock(e)) { try { _orig.unlinkSync.call(fs, tmp); } catch (_) {} throw e; }
  }
  // rename 彻底失败 → 兜底直接写（重试）
  try {
    syncRetry(() => _orig.writeFileSync.call(fs, file, data, opts));
  } finally {
    try { _orig.unlinkSync.call(fs, tmp); } catch (_) {}
  }
};

/* ===================== 回调：open ===================== */
fs.open = function () {
  const args = Array.from(arguments);
  const cb = args[args.length - 1];
  if (typeof cb !== 'function') { return _orig.open.apply(fs, arguments); }
  let i = 0;
  const tryOpen = () => {
    const wrapped = (err, fd) => {
      if (!err) return cb(err, fd);
      if (isLock(err) && i < ASYNC_BACKOFF.length - 1) { i++; setTimeout(tryOpen, ASYNC_BACKOFF[i]); return; }
      cb(err);
    };
    args[args.length - 1] = wrapped;
    _orig.open.apply(fs, args);
  };
  tryOpen();
};

/* ===================== 回调：writeFile（tmp + rename） ===================== */
fs.writeFile = function (file, data, opts, cb) {
  const args = Array.from(arguments);
  const callback = args[args.length - 1];
  if (typeof callback !== 'function') {
    return _orig.writeFile.apply(fs, arguments);
  }
  let tmp; // 每次 writeTmp 重试用新名字，避免撞上已被锁的旧 temp
  const hasOpts = args.length >= 4;
  let lastErr;

  let wTries = 0;
  const writeTmp = () => {
    tmp = tmpName(file);
    const onDone = (err) => {
      if (!err) { renameStep(0); return; }
      lastErr = err;
      if (isLock(err) && wTries < ASYNC_BACKOFF.length - 1) {
        wTries++; setTimeout(writeTmp, ASYNC_BACKOFF[wTries]); return;
      }
      callback(err);
    };
    const a = [tmp, data];
    if (hasOpts) a.push(opts);
    a.push(onDone);
    _orig.writeFile.apply(fs, a);
  };

  const renameStep = (i) => {
    fs.rename(tmp, file, (err) => {
      if (!err) { callback(null); return; }
      lastErr = err;
      if (isLock(err) && i < 3) { setTimeout(() => renameStep(i + 1), 300); return; }
      directStep(0);
    });
  };

  const directStep = (i) => {
    const onDone = (err) => {
      if (!err) { callback(null); return; }
      lastErr = err;
      if (isLock(err) && i < ASYNC_BACKOFF.length - 1) {
        i++; setTimeout(() => directStep(i), ASYNC_BACKOFF[i]); return;
      }
      try { fs.unlink(tmp, () => {}); } catch (_) {}
      callback(err);
    };
    const a = [file, data];
    if (hasOpts) a.push(opts);
    a.push(onDone);
    _orig.writeFile.apply(fs, a);
  };

  writeTmp();
};

/* ===================== Promise 版本 ===================== */
// fs.promises 在 Node 里是懒加载 getter，首次访问后返回缓存对象。
// Playwright 截图走 fs.promises.writeFile（见 coreBundle.js），下载走 fs.promises.copyFile。
try {
  const fsp = fs.promises;
  const orig = {
    open: fsp.open,
    writeFile: fsp.writeFile,
    copyFile: fsp.copyFile,
    unlink: fsp.unlink,
    rm: fsp.rm,
    rename: fsp.rename,
    readFile: fsp.readFile,
  };

  async function asyncRetry(fn) {
    let lastErr;
    for (let i = 0; i < ASYNC_BACKOFF.length; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        if (isLock(e) && i < ASYNC_BACKOFF.length - 1) { await sleepAsync(ASYNC_BACKOFF[i]); continue; }
        throw e;
      }
    }
    throw lastErr;
  }

  fsp.open = async function () {
    const args = arguments;
    return asyncRetry(() => orig.open.apply(fsp, args));
  };

  fsp.copyFile = async function (src, dest, mode) {
    let tmp;
    // 方案 A：copyFile 到临时文件（每次重试用新 tmp 名，避免撞已被锁的旧 temp）
    let lastErr;
    try {
      await asyncRetry(async () => { tmp = tmpName(dest); await orig.copyFile.call(fsp, src, tmp, mode); });
    } catch (e) {
      lastErr = e;
      // 方案 B：copyFile 跨卷/撞锁失败时，退化为 readFile + writeFile
      // （Playwright download.saveAs 的源文件可能被短暂独占，copyFile 开源失败；
      //   readFile 走另一套打开路径，配合 writeFile 的 tmp+rename 更稳）
      if (isLock(e)) {
        const buf = await asyncRetry(() => orig.readFile.call(fsp, src));
        await asyncRetry(async () => { tmp = tmpName(dest); await orig.writeFile.call(fsp, tmp, buf); });
      } else { throw e; }
    }
    // rename 覆盖目标（原子，不打开目标文件）
    try {
      await asyncRetry(() => orig.rename.call(fsp, tmp, dest));
      return;
    } catch (e) {
      if (!isLock(e)) { try { await orig.unlink.call(fsp, tmp); } catch (_) {} throw e; }
    }
    // rename 失败 → 兜底直接写目标
    try {
      const buf = await orig.readFile.call(fsp, tmp);
      await asyncRetry(() => orig.writeFile.call(fsp, dest, buf));
    } finally {
      try { await orig.unlink.call(fsp, tmp); } catch (_) {}
    }
  };

  fsp.unlink = async function (p) {
    return asyncRetry(() => orig.unlink.call(fsp, p));
  };

  fsp.rm = async function (p, opts) {
    return asyncRetry(() => orig.rm.call(fsp, p, opts));
  };

  fsp.rename = async function (a, b) {
    return asyncRetry(() => orig.rename.call(fsp, a, b));
  };

  fsp.writeFile = async function (file, data, opts) {
    let tmp;
    // 写临时文件（每次重试用新 tmp 名，避免撞上已被锁的旧 temp）
    await asyncRetry(async () => { tmp = tmpName(file); await orig.writeFile.call(fsp, tmp, data, opts); });
    // rename 覆盖
    try {
      await asyncRetry(() => orig.rename.call(fsp, tmp, file));
      return;
    } catch (e) {
      if (!isLock(e)) { try { await orig.unlink.call(fsp, tmp); } catch (_) {} throw e; }
    }
    // 兜底直接写
    try {
      await asyncRetry(() => orig.writeFile.call(fsp, file, data, opts));
    } finally {
      try { await orig.unlink.call(fsp, tmp); } catch (_) {}
    }
  };
} catch (e) {
  // 极少数老 Node 没有 fs.promises，忽略
}
