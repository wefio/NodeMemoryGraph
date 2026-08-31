"""LME judged comparison: accuracy + context tokens by config."""
import json
import statistics
import sys
from collections import Counter, defaultdict

def audit(path, label):
    j = json.load(open(path, encoding='utf-8'))
    labels = Counter()
    bycat = defaultdict(Counter)
    tokens = []
    n = 0
    for uid, e in j.items():
        if e.get('status') != 'success': continue
        n += 1
        jj = e['llm_judgments']
        label = 'CORRECT' if all(jj.values()) else ('PARTIAL' if any(jj.values()) else 'WRONG')
        labels[label] += 1
        bycat[e['category']][label] += 1
        tokens.append(e['nlp_metrics']['context_tokens'])
    print(f'{label}: n={n} CORRECT={100*labels["CORRECT"]/max(n,1):.1f}% '
          f'PARTIAL={100*labels["PARTIAL"]/max(n,1):.1f}% WRONG={100*labels["WRONG"]/max(n,1):.1f}% '
          f'mean_tokens={statistics.mean(tokens):.0f}')
    for c, l in sorted(bycat.items()):
        tot = sum(l.values())
        if tot: print(f'    {c}: {100*l["CORRECT"]/tot:.1f}% ({tot})')

if __name__ == '__main__':
    paths = sys.argv[1:]
    for p in paths:
        label = p.split('nmg-')[-1].split('/')[0]
        audit(p, label)
