"""Does a smaller chart team do as well? Same desk as test2.py (12h, vol sizing, Risk Officer), agent subsets only.
Usage: python3 -I test_subsets.py <data_dir>"""
import sys
import numpy as np
sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from backtest import AGENTS, load, signals, WINDOW  # noqa: E402
from tune import atr_frac, score  # noqa: E402
from test2 import simulate  # noqa: E402

P = load(sys.argv[1]); S = signals(P); V = atr_frac(P); T = len(P); split = int(T * 0.67)
teams = {
    'all 10': AGENTS,
    'drop 3 weakest': [a for a in AGENTS if a not in ('breakout', 'relative', 'macro')],
    'top 4 by weight': ['momentum', 'meanrev', 'contrarian', 'trend'],
    '5 distinct styles': ['trend', 'momentum', 'meanrev', 'vol', 'risk'],
    '3 core': ['trend', 'momentum', 'meanrev'],
}
for name, lo, hi in (('in', 250, split - WINDOW), ('out', split, T - WINDOW)):
    for label, team in teams.items():
        idx = [AGENTS.index(a) for a in team]
        rng = np.random.default_rng(9)
        starts = rng.integers(lo, hi, 10000)
        ret, mdd, _, _ = simulate(P, S[idx], V, starts, {'stop': 0}, rng)
        s = score(ret, mdd)
        print(f"{name:3} {label:18} median {s['median']*100:+.2f}% win {s['win']*100:.0f}% p10 {s['p10']*100:+.2f}% mdd {s['mdd']*100:.2f}% SR {s['sharpe_like']:.3f}")
