# -*- coding: utf-8 -*-
"""反向同步：app/bank/cet6-*.js  ->  bank/json/<set_id>.json

背景
----
内容修复轮次（第一轮 87 题听力题干回填 / 620 题解析污染清理 / 2021-12 写作题面补主题短文；
第二轮 6 卷 writing.image、70 题 PARAGRAPH MAP 清理、1208 题康熙部首还原、2026-06-3 题面补全、
168 处选项首字母大写、16 卷写作双空格压缩、27 卷翻译半角标点改全角）只落在
app/bank/*.js 上，bank/json/*.json 仍是修复前状态。若直接用 gen_bank_js.py 从 bank/json
重新生成 app/bank，全部修复会被覆盖。

本脚本把 app/bank/*.js 中已经修复好的 JSON 反向写回 bank/json/，作为流水线的可信输入。

铁律
----
* answer 字段零变更：同步前后逐题比对，出现差异直接报错退出（退出码 2）。
* 写入前必须已有备份（backup/bank-json-before-sync/），否则拒绝写入。
* 不改 app/bank/*.js。

用法
----
    python scripts/sync_bank_json.py                 # 预览（dry-run），不写盘
    python scripts/sync_bank_json.py --apply         # 写盘 bank/json/
    python scripts/sync_bank_json.py --apply --mirror-appbank-json
                                                     # 同时镜像 app/bank/json/（历史副本，保持与源一致）
"""
import json
import os
import re
import sys
import hashlib

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE, 'app', 'bank')
DST_DIR = os.path.join(BASE, 'bank', 'json')
MIRROR_DIR = os.path.join(BASE, 'app', 'bank', 'json')
BACKUP_DIR = os.path.join(BASE, 'backup', 'bank-json-before-sync')
REPORT_DIR = os.path.join(BASE, 'backup', 'bank-sync-reports')
BASELINE = os.path.join(BASE, 'bank', '_answers-baseline.json')

# app/bank/cet6-*.js 的确切包装格式（见 scripts/gen_bank_js.py 第 13-14 行）
WRAP = re.compile(
    r'\Awindow\.CET6_BANKS\s*=\s*window\.CET6_BANKS\s*\|\|\s*\[\];\s*'
    r'window\.CET6_BANKS\.push\((.*)\);\s*\Z',
    re.S,
)


def load_js_bank(path):
    """从一个 app/bank/cet6-*.js 中取出 paper 对象（严格校验包装格式）。"""
    with open(path, encoding='utf-8') as f:
        src = f.read()
    m = WRAP.match(src)
    if not m:
        raise ValueError(f'{os.path.basename(path)}: 不符合 push({...}); 包装格式')
    return json.loads(m.group(1))


def dump_json_text(data):
    """与 parse_cet6.py 第 327 行一致的序列化格式：indent=1, ensure_ascii=False, 无结尾换行。"""
    return json.dumps(data, ensure_ascii=False, indent=1)


def answer_map(paper):
    return {q.get('id'): q.get('answer') for q in paper.get('questions') or []}


def answer_digest(amap):
    blob = json.dumps(amap, ensure_ascii=False, sort_keys=True).encode('utf-8')
    return hashlib.sha256(blob).hexdigest()


def diff_paths(a, b, path='', out=None, limit=400):
    """递归比较两个 JSON 值，返回形如 questions[3].analysis 的字段级差异列表。"""
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if type(a) is not type(b):
        out.append({'path': path, 'kind': 'type', 'old': repr(a)[:120], 'new': repr(b)[:120]})
        return out
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            p = f'{path}.{k}' if path else k
            if k not in a:
                out.append({'path': p, 'kind': 'added', 'new': repr(b[k])[:120]})
            elif k not in b:
                out.append({'path': p, 'kind': 'removed', 'old': repr(a[k])[:120]})
            else:
                diff_paths(a[k], b[k], p, out, limit)
            if len(out) >= limit:
                return out
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append({'path': path, 'kind': 'len', 'old': len(a), 'new': len(b)})
        for i in range(min(len(a), len(b))):
            diff_paths(a[i], b[i], f'{path}[{i}]', out, limit)
            if len(out) >= limit:
                return out
    else:
        if a != b:
            out.append({'path': path, 'kind': 'value',
                        'old': repr(a)[:120], 'new': repr(b)[:120]})
    return out


def main():
    apply_ = '--apply' in sys.argv
    mirror = '--mirror-appbank-json' in sys.argv

    files = sorted(f for f in os.listdir(SRC_DIR)
                   if f.startswith('cet6-') and f.endswith('.js'))
    if not files:
        print('!! app/bank 下没有 cet6-*.js'); return 1

    # 写入前必须先有备份
    if apply_:
        if not os.path.isdir(BACKUP_DIR):
            print(f'!! 备份目录不存在，拒绝写入: {BACKUP_DIR}'); return 1
        n_bak = len([f for f in os.listdir(BACKUP_DIR) if f.endswith('.json')])
        if n_bak == 0:
            print(f'!! 备份目录为空，拒绝写入: {BACKUP_DIR}'); return 1
        print(f'[前置] bank/json 备份已就位: {BACKUP_DIR} ({n_bak} 个 json)')

    report = {'mode': 'apply' if apply_ else 'dry-run', 'papers': [], 'totals': {},
              'answerChanged': [], 'anomalies': [], 'answersDigestOld': {},
              'answersDigestNew': {}}
    baseline = {}
    total_q = 0

    for fn in files:
        src_path = os.path.join(SRC_DIR, fn)
        sid = fn[len('cet6-'):-len('.js')]
        dst_path = os.path.join(DST_DIR, sid + '.json')
        entry = {'file': fn, 'id': sid, 'dst': dst_path, 'jsonExists': os.path.exists(dst_path)}

        try:
            paper = load_js_bank(src_path)
        except Exception as e:
            report['anomalies'].append({'file': fn, 'what': f'JS 解析失败: {e}'})
            entry['error'] = str(e)
            report['papers'].append(entry)
            continue

        if paper.get('id') != sid:
            report['anomalies'].append(
                {'file': fn, 'what': f'id 不一致: 文件 {sid} vs 数据 {paper.get("id")}'})

        qs = paper.get('questions') or []
        entry['questions'] = len(qs)
        total_q += len(qs)

        new_text = dump_json_text(paper)
        new_amap = answer_map(paper)
        entry['answersDigest'] = answer_digest(new_amap)
        baseline[sid] = {'source': paper.get('source'), 'questions': len(qs),
                         'answers': new_amap, 'answersDigest': entry['answersDigest']}

        old_text = None
        if os.path.exists(dst_path):
            with open(dst_path, encoding='utf-8') as f:
                old_text = f.read()
        entry['oldBytes'] = len(old_text.encode('utf-8')) if old_text is not None else None
        entry['newBytes'] = len(new_text.encode('utf-8'))

        if old_text is None:
            entry['status'] = 'created'
        elif old_text == new_text:
            entry['status'] = 'identical'
        else:
            entry['status'] = 'updated'
            try:
                old = json.loads(old_text)
                old_amap = answer_map(old)
                report['answersDigestOld'][sid] = answer_digest(old_amap)
                report['answersDigestNew'][sid] = entry['answersDigest']
                if answer_digest(old_amap) != entry['answersDigest']:
                    changed = sorted(
                        q for q in set(old_amap) | set(new_amap) if old_amap.get(q) != new_amap.get(q))
                    report['answerChanged'].append({'id': sid, 'qids': changed})
                entry['fieldDiffs'] = diff_paths(old, paper)
                entry['fieldDiffCount'] = len(entry['fieldDiffs'])
                e_old = len(old.get('questions') or [])
                if e_old != len(qs):
                    report['anomalies'].append(
                        {'file': fn, 'what': f'题数变化 {e_old} -> {len(qs)}'})
            except Exception as e:
                report['anomalies'].append({'file': fn, 'what': f'旧 JSON 解析失败: {e}'})
            if apply_:
                with open(dst_path, 'w', encoding='utf-8', newline='') as f:
                    f.write(new_text)

        if entry['status'] == 'created' and apply_:
            with open(dst_path, 'w', encoding='utf-8', newline='') as f:
                f.write(new_text)

        if mirror and apply_:
            mpath = os.path.join(MIRROR_DIR, sid + '.json')
            if os.path.isdir(MIRROR_DIR):
                with open(mpath, 'w', encoding='utf-8', newline='') as f:
                    f.write(new_text)

        report['papers'].append(entry)

    # ---------------- 冻结 answer 基线（防覆盖校验的参考值） ----------------
    baseline_blob = {
        '_note': '由 scripts/sync_bank_json.py 从【修复后】的 app/bank/cet6-*.js 生成的 answer 冻结基线；'
                 'scripts/gen_bank_js.py 生成后逐题比对，不一致即报错。请勿手改。',
        '_generatedFrom': 'D:/CET6/app/bank/cet6-*.js',
        'papers': baseline,
    }
    if apply_:
        with open(BASELINE, 'w', encoding='utf-8', newline='') as f:
            json.dump(baseline_blob, f, ensure_ascii=False, indent=1)

    # ---------------- 汇总 ----------------
    st = {}
    for p in report['papers']:
        st[p.get('status', 'error')] = st.get(p.get('status', 'error'), 0) + 1
    report['totals'] = {'files': len(files), 'questions': total_q, 'byStatus': st,
                        'answerChangedSets': len(report['answerChanged']),
                        'anomalies': len(report['anomalies'])}

    changed_fields = {}
    for p in report['papers']:
        for d in p.get('fieldDiffs', []):
            key = re.sub(r'\[\d+\]', '[]', d['path'])
            changed_fields[key] = changed_fields.get(key, 0) + 1
    report['totals']['changedFieldHistogram'] = dict(
        sorted(changed_fields.items(), key=lambda kv: -kv[1]))

    out_dir = REPORT_DIR
    os.makedirs(out_dir, exist_ok=True)
    rep_path = os.path.join(out_dir, '_sync-report.json')
    with open(rep_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    print(f'[模式] {"写盘" if apply_ else "预览"}'
          f'{" + 镜像 app/bank/json" if (mirror and apply_) else ""}')
    print(f'[文件] {len(files)} 个 cet6-*.js -> {DST_DIR}')
    print(f'[题数] 合计 {total_q}')
    print(f'[状态] {json.dumps(st, ensure_ascii=False)}')
    print(f'[answer 变更] {len(report["answerChanged"])} 套（硬约束要求 0）')
    print(f'[异常] {len(report["anomalies"])}')
    for a in report['anomalies'][:20]:
        print('   !!', a)
    print('[字段级改动直方图]')
    for k, v in list(report['totals']['changedFieldHistogram'].items())[:25]:
        print(f'   {v:6d}  {k}')
    print('[报告]', rep_path)
    if apply_:
        print('[基线]', BASELINE, os.path.getsize(BASELINE), 'bytes')

    if report['answerChanged']:
        print('\n!!! answer 字段发生变化，违反硬约束 !!!')
        for x in report['answerChanged']:
            print('   ', x['id'], x['qids'][:20])
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
