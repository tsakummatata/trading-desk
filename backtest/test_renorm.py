"""Improver idea: renormalize the vote over agents that committed (non-zero call) instead of all agents.
Abstain = the agent's rule gives exactly 0 (no noise added, like a live agent answering 0).
Current desk: 7 chart agents, 12h rebalance, vol sizing, 8% min trade, net cap 50%. Usage: python3 -I test_renorm.py <data_dir>
"""
import sys

import numpy as np

sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from backtest import AGENTS, FEE, WINDOW, load, signals  # noqa: E402
from tune import atr_frac, score  # noqa: E402

KEEP = [AGENTS.index(a) for a in ('trend', 'momentum', 'meanrev', 'vol', 'contrarian', 'risk', 'swing')]


def simulate(P, S, V, starts, renorm, rng, min_trade=0.08):
    R, A, C = len(starts), S.shape[0], P.shape[1]
    lr, min_w, cap = 40, 0.02, 0.5
    w = np.full((R, A), 1 / A)
    cash, pos = np.ones(R), np.zeros((R, C))
    sig_prev, px_prev = np.zeros((R, A, C)), P[starts]
    peak, mdd, conv = np.ones(R), np.zeros(R), []
    for t in range(WINDOW):
        idx = starts + t
        px = P[idx]
        if t % 12 == 0:
            if t:
                w = w * np.exp(lr * (sig_prev * (px / px_prev - 1)[:, None, :]).sum(axis=2))
                w /= w.sum(axis=1, keepdims=True)
                w = np.maximum(w, min_w)
                w /= w.sum(axis=1, keepdims=True)
            raw = np.transpose(S[:, idx, :], (1, 0, 2))
            on = raw != 0
            sig = np.where(on, np.clip(raw + rng.normal(0, 0.15, raw.shape), -1, 1), 0)
            sig_prev, px_prev = sig, px
            num = (w[:, :, None] * sig).sum(axis=1)
            den = (w[:, :, None] * on).sum(axis=1) if renorm else np.ones_like(num)
            vote = np.where(den > 0, num / np.maximum(den, 1e-12), 0)
            conv.append(np.abs(vote).mean())
            v = V[idx]
            vote = np.clip(vote * np.clip(v.min(axis=1, keepdims=True) / np.maximum(v, 1e-9), 0, 1) * 1.5, -1, 1)
            eq = cash + (pos * px).sum(axis=1)
            target = vote * (eq / C)[:, None]
            net = target.sum(axis=1)
            target *= np.minimum(1, cap * eq / np.maximum(np.abs(net), 1e-12))[:, None]
            delta = target - pos * px
            trade = np.abs(delta) >= min_trade * eq[:, None]
            delta = np.where(trade, delta, 0)
            cash -= delta.sum(axis=1) + np.abs(delta).sum(axis=1) * FEE
            pos = np.where(trade, target / px, pos)
        eq = cash + (pos * px).sum(axis=1)
        peak = np.maximum(peak, eq)
        mdd = np.maximum(mdd, 1 - eq / peak)
    return cash + (pos * P[starts + WINDOW - 1]).sum(axis=1) - 1, mdd, float(np.mean(conv))


def main():
    P = load(sys.argv[1])
    T = len(P)
    S = signals(P)[KEEP]
    V = atr_frac(P)
    split = int(T * 0.67)
    print(f'share of calls that are abstain (0): {(S[:, 250:] == 0).mean()*100:.0f}%')
    for name, lo, hi in (('in', 250, split - WINDOW), ('out', split, T - WINDOW)):
        for label, renorm in (('current', False), ('renorm', True)):
            rng = np.random.default_rng(9)
            starts = rng.integers(lo, hi, 10000)
            ret, mdd, conv = simulate(P, S, V, starts, renorm, rng)
            assert np.isfinite(ret).all()
            s = score(ret, mdd)
            print(f"{name:3} {label:8} median {s['median']*100:+.2f}% mean {s['mean']*100:+.2f}% win {s['win']*100:.0f}% "
                  f"p10 {s['p10']*100:+.2f}% mdd {s['mdd']*100:.2f}% SR {s['sharpe_like']:.3f} avg |vote| {conv:.2f}")


if __name__ == '__main__':
    main()
