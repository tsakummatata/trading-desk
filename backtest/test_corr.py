"""Improver idea: Momentum, Trend and Swing vote alike, so cap their combined vote share.
Prints their signal correlations, then the desk with caps 100% (current), 50%, 40%, 33%. Usage: python3 -I test_corr.py <data_dir>
"""
import sys

import numpy as np

sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from backtest import load, signals  # noqa: E402
from test_renorm import KEEP, WINDOW, simulate  # noqa: E402
from tune import atr_frac, score  # noqa: E402

NAMES = ('trend', 'momentum', 'meanrev', 'vol', 'contrarian', 'risk', 'swing')
GROUP = [NAMES.index(a) for a in ('trend', 'momentum', 'swing')]


def main():
    P = load(sys.argv[1])
    T = len(P)
    S = signals(P)[KEEP]
    V = atr_frac(P)
    flat = S[:, 250:].reshape(len(NAMES), -1)
    c = np.corrcoef(flat)
    for i, j in ((0, 1), (0, 6), (1, 6), (0, 5)):
        print(f'corr {NAMES[i]}-{NAMES[j]}: {c[i, j]:+.2f}')
    split = int(T * 0.67)
    for name, lo, hi in (('in', 250, split - WINDOW), ('out', split, T - WINDOW)):
        for cap in (1.0, 0.6, 0.5, 0.4, 0.33):
            rng = np.random.default_rng(9)
            starts = rng.integers(lo, hi, 10000)
            ret, mdd, _ = simulate(P, S, V, starts, False, rng, group=GROUP, group_cap=cap)
            s = score(ret, mdd)
            print(f"{name:3} cap {cap:.0%}  median {s['median']*100:+.2f}% mean {s['mean']*100:+.2f}% win {s['win']*100:.0f}% "
                  f"p10 {s['p10']*100:+.2f}% mdd {s['mdd']*100:.2f}% SR {s['sharpe_like']:.3f}")


if __name__ == '__main__':
    main()
