# -*- coding: utf-8 -*-
# 版本号单点化后的一键递增：只改 app/version.js 里的 cet6-vN（sw.js 与 index.html 都引用它）
import io, re
p = r'D:\CET6\app\version.js'
s = io.open(p, encoding='utf-8').read()
m = re.search(r"cet6-v(\d+)", s)
assert m, 'version.js 里找不到 cet6-vN 版本号'
nv = 'cet6-v%d' % (int(m.group(1)) + 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(m.group(0), nv, 1))
print('OK version.js: %s -> %s' % (m.group(0), nv))
