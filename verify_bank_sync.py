# -*- coding: utf-8 -*-
"""校验反向同步结果：bank/json/*.json 与【修复后】的 app/bank/*.js 等价，且关键修复点齐备。

校验项
------
A1 每卷都有 bank/json            A2 bank/json 与 app/bank 深度等价
B1 全库题数 3315                 B2 逐卷题数与 app/bank 一致
C1 answer 零变更（vs 同步前备份）D1 answer 与冻结基线一致      D2 基线来源标注
E1 87 题听力题干 = CSV「应修正为」E2 同 87 题在同步前备份里 = CSV「当前(截断)」
F1 同步后解析无污染标志 / 无超长解析 / 无卷面脚手架残留
G1 同步后全库无康熙部首字符
H1 writing.image 6 卷值正确      H2 6 张图片在盘上
I1 2026-06-3 写作题面长度/哈希与二轮证据一致   I2 第二段指令句存在
J1 非 cloze 选项无 "A) 小写" 形态
K1 解析改动溯源：620 污染清单 ∪ 70 PARAGRAPH MAP ∪ 1208 康熙题 == 实际解析改动集合（对称差 0）

注：清单 CSV 里存在未转义的引号（如 ``...view mise-en-place" or "put in place"?"``），
标准 csv 模块会把它当字段结束符，故这里用与 scripts/fix_content.js 同规则的宽容解析器。
"""
import csv
import hashlib
import json
import os
import re
import sys
from collections import Counter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE, 'app', 'bank')
DST_DIR = os.path.join(BASE, 'bank', 'json')
BAK_DIR = os.path.join(BASE, 'backup', 'bank-json-before-sync')
R1_BAK = os.path.join(BASE, 'backup', 'bank-before-content-fix')
R2_BAK = os.path.join(BASE, 'backup', 'bank-before-round2-fix')
REPORT_DIR = os.path.join(BASE, 'backup', 'bank-sync-reports')
BASELINE = os.path.join(BASE, 'bank', '_answers-baseline.json')
PAPER_FILE = re.compile(r'^\d{4}-\d{2}-\d\.json$')
WRAP = re.compile(
    r'\Awindow\.CET6_BANKS\s*=\s*window\.CET6_BANKS\s*\|\|\s*\[\];\s*'
    r'window\.CET6_BANKS\.push\((.*)\);\s*\Z', re.S)

KANGXI_RANGES = [(0x2E80, 0x2EFF), (0x2F00, 0x2FD5)]
POLLUTION = ['PARAGRAPH MAP', '段落主旨图', '段落地图', 'SENTENCE INSIGHTS',
             '句子精讲', '词汇附录', '复盘资产', '四档评分']
SCAFFOLD = ['Directions:', 'Part I', 'Part II', 'Part III', 'Part IV',
            '@@PAGE', '懒笔记', '听力原文', '参考译文']
RE_OPT_LOWER = re.compile(r'^([A-Z])\)(\s*)([a-z])')
IMAGE_SETS = {'2015-12-1', '2015-12-2', '2015-12-3', '2021-06-1', '2021-06-2', '2021-06-3'}

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   {detail}' if detail else ''))
    return ok


def jload(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def amap(p):
    return {q.get('id'): q.get('answer') for q in p.get('questions') or []}


def anmap(p):
    return {q.get('id'): q.get('analysis') or '' for q in p.get('questions') or []}


def sha(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def parse_csv_tolerant(text):
    """与 scripts/fix_content.js 的 parseCsv 同规则：引号模式内，紧邻分隔符/换行的 \" 结束字段，
    其余位置的 \" 按字面处理。"""
    rows, row, field, in_q, at_start, i = [], [], '', False, True, 0
    n = len(text)
    while i < n:
        c = text[i]
        if in_q:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field += '"'; i += 2; continue
                if i + 1 >= n or text[i + 1] in ',\r\n':
                    in_q = False; i += 1; continue
                field += '"'; i += 1; continue
            field += c; i += 1; continue
        if at_start and c == '"':
            in_q = True; at_start = False; i += 1; continue
        if c == ',':
            row.append(field); field = ''; at_start = True; i += 1; continue
        if c in '\r\n':
            row.append(field)
            if any(x.strip() for x in row):
                rows.append(row)
            row, field, at_start = [], '', True
            if c == '\r' and i + 1 < n and text[i + 1] == '\n':
                i += 1
            i += 1; continue
        field += c; at_start = False; i += 1
    if field or row:
        row.append(field)
        if any(x.strip() for x in row):
            rows.append(row)
    return rows


def read_csv_dict(path):
    with open(path, encoding='utf-8-sig') as f:
        rows = parse_csv_tolerant(f.read())
    hdr = rows[0]
    return [dict(zip(hdr, r + [''] * (len(hdr) - len(r)))) for r in rows[1:]]


def load_dir(d):
    out = {}
    for fn in sorted(os.listdir(d)):
        if PAPER_FILE.match(fn):
            p = jload(os.path.join(d, fn))
            out[p['id']] = p
    return out


def main():
    os.makedirs(REPORT_DIR, exist_ok=True)
    ids = sorted(f[len('cet6-'):-3] for f in os.listdir(SRC_DIR)
                 if f.startswith('cet6-') and f.endswith('.js'))
    js, js_ = {}, {}
    for sid in ids:
        with open(os.path.join(SRC_DIR, f'cet6-{sid}.js'), encoding='utf-8') as f:
            js[sid] = json.loads(WRAP.match(f.read()).group(1))
        p = os.path.join(DST_DIR, sid + '.json')
        js_[sid] = jload(p) if os.path.exists(p) else None

    # A / B
    missing = [s for s in ids if js_[s] is None]
    check('A1 每卷都有对应 bank/json 文件', not missing,
          f'缺 {missing}' if missing else f'{len(ids)} 卷')
    ne = [s for s in ids if js_[s] != js[s]]
    check('A2 bank/json 与 app/bank 深度等价', not ne, f'不等价 {ne}' if ne else '76/76')
    nq = sum(len(p['questions']) for p in js_.values())
    check('B1 全库题数 = 3315', nq == 3315, f'实际 {nq}')
    cd = [s for s in ids if len(js_[s]['questions']) != len(js[s]['questions'])]
    check('B2 逐卷题数与 app/bank 一致', not cd, f'不一致 {cd}' if cd else '')

    old = load_dir(BAK_DIR)

    # C
    changed, checked = [], 0
    for sid in ids:
        if sid not in old:
            continue
        a, b = amap(old[sid]), amap(js_[sid])
        checked += len(a)
        if a != b:
            changed.append((sid, sorted(q for q in set(a) | set(b) if a.get(q) != b.get(q))[:10]))
    check('C1 sync 前后 answer 零变更', not changed,
          f'变更 {changed}' if changed else f'{checked} 个 (sid,qid) 逐题比对，0 变更')

    # D
    if os.path.exists(BASELINE):
        blob = jload(BASELINE)
        bad = [s for s in ids if blob['papers'].get(s, {}).get('answers') != amap(js_[s])]
        check('D1 bank/json 与 answer 冻结基线一致', not bad,
              f'不一致 {bad}' if bad else '76/76')
        check('D2 基线来源标注', blob.get('_generatedFrom') == 'D:/CET6/app/bank/cet6-*.js',
              str(blob.get('_generatedFrom')))
    else:
        check('D1 bank/json 与 answer 冻结基线一致', False, '基线文件不存在')

    # E
    csv_stem = os.path.join(R1_BAK, '修复对照表-听力题干截断87题.csv')
    if os.path.exists(csv_stem):
        rows = read_csv_dict(csv_stem)
        idx = {q['id']: q for p in js_.values() for q in p['questions'] if q.get('id')}
        oidx = {q['id']: q for p in old.values() for q in p['questions'] if q.get('id')}
        ok1 = bad1 = ok2 = 0
        miss = []
        for r in rows:
            if idx.get(r['id'], {}).get('stem') == r['应修正为(PDF原文)']:
                ok1 += 1
            else:
                bad1 += 1; miss.append(r['id'])
            if oidx.get(r['id'], {}).get('stem') == r['当前(截断)']:
                ok2 += 1
        check('E1 87 题听力题干 = CSV「应修正为」', ok1 == len(rows),
              f'{ok1}/{len(rows)} 命中' + (f'，未命中 {miss}' if miss else ''))
        check('E2 同 87 题在同步前备份里 = CSV「当前(截断)」', ok2 == len(rows),
              f'{ok2}/{len(rows)} 命中（证明题干确实被修复过）')
    else:
        check('E1 87 题听力题干 = CSV「应修正为」', False, f'对照表不存在 {csv_stem}')

    # F
    def scan(papers, keys):
        c = Counter()
        longs = 0
        for p in papers.values():
            for q in p['questions']:
                a = q.get('analysis') or ''
                if len(a) > 2000:
                    longs += 1
                for mk in keys:
                    if mk in a:
                        c[mk] += 1
        return c, longs

    co, lo = scan(old, POLLUTION)
    cn, ln = scan(js_, POLLUTION)
    cns, _ = scan(js_, SCAFFOLD)
    check('F1 同步后解析无污染标志残留', not cn, f'残留 {dict(cn)}')
    check('F2 同步后无 >2000 字符的超长解析', ln == 0,
          f'超长 {ln} 题（同步前 {lo} 题，上限 {max(len((q.get("analysis") or ""))for p in old.values() for q in p["questions"])} 字符）')
    check('F3 同步后解析无卷面脚手架残留', not cns, f'残留 {dict(cns)}')
    print(f'      [参考] 同步前旧 JSON 污染标志命中: {dict(co)}')

    # G
    def scan_rad(papers, fields):
        cnt, dis = 0, set()
        for p in papers.values():
            for q in p['questions']:
                for fl in fields:
                    v = q.get(fl)
                    if isinstance(v, str):
                        for ch in v:
                            cp = ord(ch)
                            if any(x <= cp <= y for x, y in KANGXI_RANGES):
                                cnt += 1; dis.add(cp)
                    elif isinstance(v, list):
                        for s in v:
                            if isinstance(s, str):
                                for ch in s:
                                    cp = ord(ch)
                                    if any(x <= cp <= y for x, y in KANGXI_RANGES):
                                        cnt += 1; dis.add(cp)
        return cnt, dis

    n_new, d_new = scan_rad(js_, ('analysis', 'stem', 'answer', 'options'))
    n_old, d_old = scan_rad(old, ('analysis',))
    check('G1 同步后全库无康熙部首字符', n_new == 0 and not d_new,
          f'残留 {n_new} 个 / {len(d_new)} 种')
    print(f'      [参考] 同步前旧 JSON analysis 部首命中 {n_old} 次 / {len(d_old)} 种不同字符')

    # H
    got = {s: js_[s].get('writing', {}).get('image') for s in ids
           if js_[s].get('writing', {}).get('image')}
    check('H1 writing.image 命中 6 卷且值正确',
          set(got) == IMAGE_SETS and all(got[s] == f'img/{s}.jpg' for s in got),
          json.dumps(got, ensure_ascii=False))
    lack = [s for s in got if not os.path.exists(os.path.join(SRC_DIR, got[s]))]
    check('H2 6 张图片文件在盘上', not lack, f'缺 {lack}')

    # I（第四轮 R4-L3：补上 "globalization, students" 逗号后空格，len 482→483，sha 随更）
    w = js_['2026-06-3']['writing']['prompt']
    check('I1 2026-06-3 写作题面与二轮证据一致（R4-L3 补空格后）',
          len(w) == 483 and sha(w) == '207a86891a9368560ee73e94ac0aedbc76a48a6602177e42efc5ad0fdf484a78',
          f'len={len(w)} sha={sha(w)[:16]}')
    check('I2 2026-06-3 第二段指令句存在',
          'You should copy the sentence given in quotes at the beginning of your essay.' in w)

    # J
    n_lower = sum(1 for p in js_.values() for q in p['questions']
                  if q.get('type') != 'cloze' and q.get('options')
                  for op in q['options'] if isinstance(op, str) and RE_OPT_LOWER.match(op))
    check('J1 非 cloze 选项无 "A) 小写" 形态', n_lower == 0, f'残留 {n_lower} 处')

    # K 溯源
    # 第四轮 R4-L5 新增：2026-06-2 信息匹配 9 条解析繁转简（m-36..m-44；m-45 已在历史集合）。
    # 另：M2(2018-06-1-r-55)、M6(2017-12-1-l-16) 解析修正已在历史 620/1208 集合内覆盖。
    src620 = os.path.join(BASE, 'docs', '清单-解析污染620题.csv')
    r2rep = os.path.join(R2_BAK, 'round2-fix-report.json')
    if os.path.exists(src620) and os.path.exists(r2rep):
        s620 = {r['id'] for r in read_csv_dict(src620)}
        r2 = jload(r2rep)
        smap = {x['id'] for x in r2['analysis']['mapStripped']}
        skx = set(r2['analysis']['kangxiRewritten'])
        r4trad = {'2026-06-2-m-%d' % i for i in range(36, 45)}   # R4-L5 繁转简 9 条
        act = set()
        for sid, p in js_.items():
            ao = anmap(old[sid]); an = anmap(p)
            act |= {q for q in an if ao.get(q) != an[q]}
        union = s620 | smap | skx | r4trad
        check('K1 解析改动溯源（620 ∪ 70 ∪ 1208 ∪ R4L5 繁转简 == 实际改动集）', union == act,
              f'|620|={len(s620)} |map|={len(smap)} |kangxi|={len(skx)} '
              f'|R4L5|={len(r4trad)} |union|={len(union)} |actual|={len(act)} 对称差={len(union ^ act)}')
        check('K2 620 污染清单是实际改动集的子集', s620 <= act, f'缺 {len(s620 - act)}')
    else:
        check('K1 解析改动溯源（620 ∪ 70 ∪ 1208 == 实际改动集）', False, '证据文件缺失')

    n_pass = sum(1 for _, ok, _ in results if ok)
    print(f'\n===== {n_pass}/{len(results)} PASS =====')
    out = {'pass': n_pass, 'total': len(results),
           'items': [{'name': n, 'ok': o, 'detail': d} for n, o, d in results],
           'reference': {'oldPollutionHits': dict(co), 'newPollutionHits': dict(cn),
                         'oldAnalysisOver2000': lo, 'newAnalysisOver2000': ln,
                         'oldKangxiCount': n_old, 'oldKangxiDistinct': len(d_old)},
           'context': {'appBankJs': len(ids), 'bankJson': len(old), 'questions': nq}}
    rp = os.path.join(REPORT_DIR, '_verify-report.json')
    with open(rp, 'w', encoding='utf-8', newline='') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print('[报告]', rp)
    return 0 if n_pass == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
