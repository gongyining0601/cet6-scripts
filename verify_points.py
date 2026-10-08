# -*- coding: utf-8 -*-
"""verify_points.py — 独立验证：cloze 考点标签收敛修复（与修复脚本无关的第二实现）

口径
----
1. answer 逐题零变更（app/bank 现状 vs backup 备份，3315/3315）
2. 除 cloze 的 points 外，其余字段（含非 cloze 的 points）与备份全等
3. cloze：points[0] 恒为「选词填空」、points 长度恒为 2、points[1] ∈ 受控词表
4. 唯一标签数 ≤ 10
5. 用 parse_cet6.py 的归一化函数从 analysis 独立复算，必须等于盘上的 points[1]（parse↔题库一致）
6. 文件格式：UTF-8 无 BOM、单行 push 包装
7. bank/json 与 app/bank 一致

用法：python scripts/verify_points.py
"""
import io
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_BANK = os.path.join(BASE, 'app', 'bank')
BACKUP = os.path.join(BASE, 'backup', 'round3-fix-20260927-212756', 'app', 'bank')
JSON_DIR = os.path.join(BASE, 'bank', 'json')

sys.path.insert(0, os.path.join(BASE, 'scripts'))
import parse_cet6 as P  # noqa: E402

PUSH = re.compile(r'\Awindow\.CET6_BANKS = window\.CET6_BANKS \|\| \[\];\n'
                  r'window\.CET6_BANKS\.push\((.*)\);\n\Z', re.S)

results = []


def chk(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print('%s  %s%s' % ('PASS' if ok else 'FAIL', name, ('   ' + detail) if detail else ''))


def load(path):
    with io.open(path, encoding='utf-8', newline='') as f:
        raw = f.read()
    m = PUSH.match(raw)
    if not m:
        raise ValueError('%s: 包装格式不符' % os.path.basename(path))
    return json.loads(m.group(1)), raw


files = sorted(f for f in os.listdir(APP_BANK) if f.endswith('.js'))
chk('app/bank 共 76 个 JS', len(files) == 76, '%d 个' % len(files))

cur, bak = {}, {}
for fn in files:
    cur[fn], _ = load(os.path.join(APP_BANK, fn))
    bak[fn], _ = load(os.path.join(BACKUP, fn))

total = sum(len(cur[f]['questions']) for f in files)
chk('全库题数 3315', total == 3315, '%d 题' % total)

# ---- 1) answer 零变更
bad_ans, n_ans = [], 0
for fn in files:
    bmap = {q['id']: q for q in bak[fn]['questions']}
    for q in cur[fn]['questions']:
        bq = bmap.get(q['id'])
        n_ans += 1
        if bq is None or q.get('answer') != bq.get('answer'):
            bad_ans.append(q['id'])
chk('answer 字段逐题零变更', not bad_ans and n_ans == 3315,
    '%d/3315 一致' % n_ans if not bad_ans else '异常: %s' % bad_ans[:10])

# ---- 2) 非 points 字段零变动；非 cloze 的 points 零变动
diff = []
for fn in files:
    bmap = {q['id']: q for q in bak[fn]['questions']}
    for q in cur[fn]['questions']:
        bq = bmap[q['id']]
        for k in set(q) | set(bq):
            if k == 'points':
                continue
            if q.get(k) != bq.get(k):
                diff.append('%s.%s' % (q['id'], k))
        if q.get('type') != 'cloze':
            if q.get('points') != bq.get('points'):
                diff.append('%s.points(非cloze)' % q['id'])
# 卷级字段（writing / translation 等）
for fn in files:
    for k in set(cur[fn]) | set(bak[fn]):
        if k == 'questions':
            continue
        if cur[fn].get(k) != bak[fn].get(k):
            diff.append('%s.%s' % (fn, k))
chk('非 cloze 题 / 非 points 字段零变动', not diff, '全等' if not diff else '异常: %s' % diff[:10])

# ---- 3~5) cloze 标签
repro, badshape, dist, n_cloze = [], [], {}, 0
for fn in files:
    for q in cur[fn]['questions']:
        if q.get('type') != 'cloze':
            continue
        n_cloze += 1
        pts = q.get('points')
        if not isinstance(pts, list) or len(pts) != 2 or pts[0] != '选词填空':
            badshape.append((q['id'], pts))
            continue
        dist[pts[1]] = dist.get(pts[1], 0) + 1
        if P.cloze_point_label(q.get('analysis')) != pts[1]:
            repro.append((q['id'], pts[1], P.cloze_point_label(q.get('analysis'))))

chk('cloze 690 题且 points 恒为 [选词填空, 受控标签]', n_cloze == 690 and not badshape,
    '%d 题' % n_cloze if not badshape else '形态异常: %s' % badshape[:5])

allowed = set(P.CLOZE_POS_VOCAB) | {P.CLOZE_POS_FALLBACK}
out = [k for k in dist if k not in allowed]
chk('所有 cloze 标签都在受控词表内', not out, '越界: %s' % out if out else 'OK')
chk('唯一标签数 ≤ 10', len(dist) <= 10,
    '%d 种：%s' % (len(dist), json.dumps(sorted(dist.items(), key=lambda kv: -kv[1]), ensure_ascii=False)))
chk('parse_cet6 归一化函数可从 analysis 复现全部标签', not repro,
    'OK' if not repro else '不一致: %s' % repro[:5])
major = sum(v for k, v in dist.items() if k in ('名词', '动词', '形容词', '副词'))
chk('名词/动词/形容词/副词占比 ≥ 绝大多数', major == n_cloze,
    '%d/%d = %.1f%%' % (major, n_cloze, 100.0 * major / n_cloze))

# ---- 6) 文件格式
bad_fmt = []
for fn in files:
    with open(os.path.join(APP_BANK, fn), 'rb') as f:
        b = f.read()
    if b[:3] == b'\xef\xbb\xbf':
        bad_fmt.append(fn + '(BOM)')
    if b.count(b'\n') != 2:
        bad_fmt.append(fn + '(行数)')
chk('题库 JS 均为 UTF-8 无 BOM + 单行 push 包装', not bad_fmt,
    'OK' if not bad_fmt else '异常: %s' % bad_fmt[:5])

# ---- 7) bank/json 与 app/bank 一致
sync_bad = []
for fn in files:
    sid = fn[len('cet6-'):-len('.js')]
    p = os.path.join(JSON_DIR, sid + '.json')
    if not os.path.exists(p):
        sync_bad.append(sid + '(缺)')
        continue
    with io.open(p, encoding='utf-8', newline='') as f:
        j = json.loads(f.read())
    if j != cur[fn]:
        sync_bad.append(sid)
chk('bank/json 与 app/bank 逐题一致', not sync_bad,
    'OK' if not sync_bad else '不一致: %s' % sync_bad[:5])

n_pass = sum(1 for _, ok, _ in results if ok)
print('\n===== verify_points %d/%d PASS =====' % (n_pass, len(results)))
sys.exit(0 if n_pass == len(results) else 1)
