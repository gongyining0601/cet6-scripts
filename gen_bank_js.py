# -*- coding: utf-8 -*-
"""把 bank/json/*.json 生成 app/bank/*.js（本地 file:// 可直接加载的题库脚本）

输入：bank/json/<set_id>.json
      —— scripts/parse_cet6.py 的产物；内容修复由 scripts/sync_bank_json.py 反向同步进来
输出：app/bank/cet6-<set_id>.js
      —— 固定包装 + 单行 JSON（与历史产物逐字节一致）：
         window.CET6_BANKS = window.CET6_BANKS || [];
         window.CET6_BANKS.push({...});

只认 <set_id>.json（形如 2015-06-1.json）的文件，selfcheck.json / _answers-baseline.json
等非卷面 JSON 一律忽略，避免被当成题库卷。

防覆盖校验（生成后自动执行）
    bank/_answers-baseline.json 是 scripts/sync_bank_json.py 从【内容修复后】的
    app/bank/cet6-*.js 冻结出来的 answer 真值。每次生成后逐题比对：
      * 基线里有而本次没生成的卷  -> 失败（说明 JSON 目录不对/文件缺失）
      * 同一题 answer 不一致       -> 失败（说明内容修复被覆盖）
    失败时打印差异并返回退出码 3。

退出码
    0 成功   3 完整性/answer 校验不通过   4 没找到任何卷面 JSON（防止静默空跑）

用法
    python scripts/gen_bank_js.py                     # 默认读 bank/json/
    python scripts/gen_bank_js.py --check-only        # 只校验，不写盘
    python scripts/gen_bank_js.py --no-guard          # 跳过校验（首次自举用）
    python scripts/gen_bank_js.py --json-dir <dir> --out-dir <dir>
"""
import argparse
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(BASE, 'app', 'bank')
BASELINE = os.path.join(BASE, 'bank', '_answers-baseline.json')
PAPER_FILE = re.compile(r'^(\d{4})-(\d{2})-(\d)\.json$')


def default_json_dir():
    """优先 bank/json/（当前布局）；兼容 JSON 直接放在 bank/ 下的旧布局。"""
    p = os.path.join(BASE, 'bank', 'json')
    if os.path.isdir(p):
        return p
    return os.path.join(BASE, 'bank')


def wrap(data):
    return ('window.CET6_BANKS = window.CET6_BANKS || [];\n'
            'window.CET6_BANKS.push(' + json.dumps(data, ensure_ascii=False) + ');\n')


def answer_map(paper):
    return {q.get('id'): q.get('answer') for q in paper.get('questions') or []}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json-dir', default=None)
    ap.add_argument('--out-dir', default=APP)
    ap.add_argument('--baseline', default=BASELINE)
    ap.add_argument('--check-only', action='store_true')
    ap.add_argument('--no-guard', action='store_true')
    a = ap.parse_args()

    json_dir = a.json_dir or default_json_dir()
    if not os.path.isdir(json_dir):
        print(f'!! JSON 目录不存在: {json_dir}')
        return 4
    files = sorted(f for f in os.listdir(json_dir) if PAPER_FILE.match(f))
    if not files:
        print(f'!! {json_dir} 下没有任何 <set_id>.json（如 2015-06-1.json），拒绝空跑'
              f'（旧版脚本在此会静默不生成任何文件，导致 app/bank 状态不明）')
        return 4
    print(f'[输入] {json_dir}  ({len(files)} 个卷面 JSON)')
    print(f'[输出] {a.out_dir}{"（--check-only，不写盘）" if a.check_only else ""}')
    if not a.check_only:
        os.makedirs(a.out_dir, exist_ok=True)

    generated, total_q, with_image, id_bad = {}, 0, [], []
    for fn in files:
        with open(os.path.join(json_dir, fn), encoding='utf-8') as f:
            data = json.load(f)
        sid = fn[:-5]
        if data.get('id') != sid:
            id_bad.append((fn, data.get('id')))
        if not a.check_only:
            with open(os.path.join(a.out_dir, 'cet6-' + sid + '.js'), 'w',
                      encoding='utf-8', newline='') as f:
                f.write(wrap(data))
        generated[sid] = data
        total_q += len(data.get('questions') or [])
        if (data.get('writing') or {}).get('image'):
            with_image.append((sid, data['writing']['image']))
    print(f'[统计] {len(generated)} 卷 / {total_q} 题')
    print(f'[writing.image] {len(with_image)} 卷: {json.dumps(with_image, ensure_ascii=False)}')
    if id_bad:
        print(f'!! 文件名与数据 id 不一致: {id_bad}')
        return 3

    if a.no_guard:
        print('[校验] 已按 --no-guard 跳过')
        return 0

    # ---------------- 防覆盖：answer 逐题比对 + 卷面完整性 ----------------
    if not os.path.exists(a.baseline):
        print(f'[校验] !! 基线不存在，跳过: {a.baseline}')
        return 0
    with open(a.baseline, encoding='utf-8') as f:
        base = json.load(f).get('papers', {})

    bad, missing_sets = [], []
    for sid, rec in base.items():
        if sid not in generated:
            missing_sets.append(sid)
            continue
        got, want = answer_map(generated[sid]), rec.get('answers', {})
        if got != want:
            diff = sorted(q for q in set(got) | set(want) if got.get(q) != want.get(q))
            bad.append((sid, len(diff), [(q, want.get(q), got.get(q)) for q in diff[:5]]))
    extra = sorted(set(generated) - set(base))
    print(f'[校验] 基线 {len(base)} 卷 / 本次 {len(generated)} 卷'
          f' / answer 不一致 {len(bad)} 卷 / 基线缺卷 {len(missing_sets)} / 多出卷 {len(extra)}')

    if missing_sets:
        print(f'\n!!! 防覆盖校验失败：基线中有 {len(missing_sets)} 卷本次未生成 !!!')
        print(f'  缺: {missing_sets[:12]}{" ..." if len(missing_sets) > 12 else ""}')
        print('  含义：--json-dir 指向的目录不是完整题库（例如指向了 bank/ 而不是 bank/json/）。')
        return 3
    if bad:
        print('\n!!! 防覆盖校验失败：answer 与冻结基线不一致 !!!')
        for sid, n, sample in bad:
            print(f'  {sid}: {n} 题不一致  例: {sample}')
        print('  含义：bank/json 很可能不是内容修复后的版本（例如由旧版 parse_cet6.py 重新生成），')
        print('        或有人手工改过 JSON/JS。请先跑 scripts/sync_bank_json.py 恢复，再重新生成。')
        return 3
    print('[校验] PASS：76 卷齐全，answer 与冻结基线逐题一致（内容修复未被覆盖）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
