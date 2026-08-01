"""
Le as fixtures com o pystitch e grava um JSON por arquivo, para comparacao
cruzada com dump-js.js (issue #18).
Uso: python3 dump_pystitch.py <dir-de-saida>
"""
import json
import os
import sys

import pystitch
from pystitch.EmbConstant import COMMAND_MASK, STITCH, JUMP, TRIM, COLOR_CHANGE

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FIXTURES_DIR = os.path.join(REPO_ROOT, 'tests', 'fixtures')


def stats_of(pattern):
    stitches = pattern.stitches
    counts = {'stitches': 0, 'jumps': 0, 'trims': 0, 'colorChanges': 0, 'total': len(stitches)}
    for s in stitches:
        cmd = s[2] & COMMAND_MASK
        if cmd == STITCH:
            counts['stitches'] += 1
        elif cmd == JUMP:
            counts['jumps'] += 1
        elif cmd == TRIM:
            counts['trims'] += 1
        elif cmd == COLOR_CHANGE:
            counts['colorChanges'] += 1
    return {
        'stitches': [[s[0], s[1], s[2] & COMMAND_MASK] for s in stitches],
        'threads': [t.hex_color() if t is not None else None for t in pattern.threadlist],
        'bounds': list(pattern.bounds()),
        'counts': counts,
    }


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    names = ['rosacea', 'multicolor']
    exts = ['vp3', 'hus', 'sew', 'pcs']
    for name in names:
        for ext in exts:
            path = os.path.join(FIXTURES_DIR, f'{name}.{ext}')
            if not os.path.exists(path):
                continue
            pattern = pystitch.read(path)
            stats = stats_of(pattern)
            with open(os.path.join(out_dir, f'{name}.{ext}.json'), 'w') as f:
                json.dump(stats, f)
            print(f'pystitch: {name}.{ext} -> stitches={stats["counts"]["total"]} threads={len(stats["threads"])}')


if __name__ == '__main__':
    main()
