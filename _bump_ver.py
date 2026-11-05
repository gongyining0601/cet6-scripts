# -*- coding: utf-8 -*-
# 手动递增版本号的备用工具。真正的实现只有一份：scripts/bump_version.js
# （gen_meta.js 加卷时也会自动调用它）。本文件只是给习惯用 Python 的场景留个入口，
# 保留两套独立实现正是过去「三方版本串漂移」的根因，故这里只做转发。
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
script = root / 'scripts' / 'bump_version.js'
args = ['node', str(script)] + sys.argv[1:]
sys.exit(subprocess.call(args, cwd=str(root)))
