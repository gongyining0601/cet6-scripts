"""批量下载真题：整卷 docx + 整卷解析 PDF -> papers/cet6-{set}.docx / cet6-{set}-解析.pdf
用法: python3 download_sets.py [set1 set2 ...]   # 不带参数则下载内置默认列表
"""
import os, re, sys, time, urllib.request, urllib.parse

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'papers')
DEFAULT_SETS = ['2025-12-1', '2025-12-2', '2025-06-1', '2025-06-2',
                '2024-12-1', '2024-12-2', '2024-06-1', '2024-06-2']
SETS = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_SETS
PROGRESS = os.path.join(BASE, 'download_progress.jsonl')

def log_progress(entry):
    with open(PROGRESS, 'a', encoding='utf-8') as f:
        f.write(repr(entry) + '\n')

def done_keys():
    if not os.path.exists(PROGRESS):
        return set()
    keys = set()
    with open(PROGRESS, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                keys.add(eval(line)['key'])
    return keys

def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def extract_links(html):
    """返回 (整卷docx URL, 整卷解析pdf URL)"""
    urls = re.findall(r'https://downloads\.lazynote\.cn/[^"\'\\ ]+', html)
    docx = pdf = None
    for u in urls:
        dec = urllib.parse.unquote(u)
        if '真题（整卷）.docx' in dec:
            docx = u
        elif '真题及答案解析（整卷）.pdf' in dec:
            pdf = u
    return docx, pdf

def main():
    os.makedirs(BASE, exist_ok=True)
    done = done_keys()
    results = []
    for s in SETS:
        for kind, fname in (('docx', f'cet6-{s}.docx'), ('pdf', f'cet6-{s}-解析.pdf')):
            key = f'{s}:{kind}'
            out = os.path.join(BASE, fname)
            if key in done and os.path.exists(out) and os.path.getsize(out) > 10000:
                print(f'skip {key} (已下载 {os.path.getsize(out)}B)')
                continue
            # 每套先取页面链接
            page_url = f'https://english-exam.lazynote.cn/cet6/paper/{s}/?f=w'
            html = fetch(page_url).decode('utf-8', 'ignore')
            docx_u, pdf_u = extract_links(html)
            target = docx_u if kind == 'docx' else pdf_u
            if not target:
                print(f'FAIL {key}: 页面未找到整卷链接')
                log_progress({'key': key, 'status': 'no_link'})
                results.append((key, 'no_link')); continue
            for attempt in range(3):
                try:
                    data = fetch(target, timeout=120)
                    if len(data) < 10000:
                        raise RuntimeError(f'文件过小 {len(data)}B')
                    with open(out, 'wb') as f:
                        f.write(data)
                    print(f'ok {key} {len(data)}B -> {fname}')
                    log_progress({'key': key, 'status': 'ok', 'size': len(data)})
                    results.append((key, 'ok')); break
                except Exception as e:
                    print(f'retry {key} #{attempt+1}: {e}')
                    time.sleep(3)
            else:
                print(f'FAIL {key}: 下载失败')
                log_progress({'key': key, 'status': 'fail'})
                results.append((key, 'fail'))
    fails = [k for k, st in results if st != 'ok']
    print('\n汇总: 新下载', sum(1 for _, st in results if st == 'ok'), '失败', len(fails), fails)
    return 1 if fails else 0

if __name__ == '__main__':
    sys.exit(main())
