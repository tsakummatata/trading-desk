"""Walk-forward tuning of the desk's settings on real Hyperliquid 1h candles.

Tunes on the first ~2/3 of history (in-sample), then re-runs the best settings on the last ~1/3
(out-of-sample, never seen while tuning). Reuses the agent signals from backtest.py.
Usage: python3 -I tune.py <data_dir> <out.json>
"""
import itertools
import json
import sys

import numpy as np

sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from backtest import AGENTS, FEE, WINDOW, load, signals  # noqa: E402


def atr_frac(P, n=14):
    """ATR(14)/price from closes only (no highs/lows): mean absolute hourly move as a fraction of price."""
    move = np.abs(np.diff(P, axis=0, prepend=P[:1])) / P
    out = np.zeros_like(P)
    a = 2 / (n + 1)
    for t in range(1, len(P)):
        out[t] = a * move[t] + (1 - a) * out[t - 1]
    return out


def simulate(P, S, V, starts, cfg, rng):
    R, A, C = len(starts), S.shape[0], P.shape[1]
    every, lr, min_w = cfg['rebalance_h'], cfg['lr'], cfg['min_w']
    train_h = 1 if cfg['learn_hourly'] else every
    w = np.full((R, A), 1 / A)
    cash, pos = np.ones(R), np.zeros((R, C))
    sig_prev = np.zeros((R, A, C))
    px_prev = P[starts]
    peak, mdd = np.ones(R), np.zeros(R)
    brake_until = np.full(R, -1)
    noise = cfg.get('noise', 0.15)
    for t in range(0, WINDOW, train_h):
        idx = starts + t
        px = P[idx]
        if t:
            r = px / px_prev - 1
            reward = (sig_prev * r[:, None, :]).sum(axis=2)
            w = w * np.exp(lr * reward)
            w /= w.sum(axis=1, keepdims=True)
            w = np.maximum(w, min_w)
            w /= w.sum(axis=1, keepdims=True)
        sig = np.transpose(S[:, idx, :], (1, 0, 2))
        sig = np.clip(sig + rng.normal(0, noise, sig.shape), -1, 1)
        sig_prev, px_prev = sig, px
        eq = cash + (pos * px).sum(axis=1)
        peak = np.maximum(peak, eq)
        mdd = np.maximum(mdd, 1 - eq / peak)
        if t % every:
            continue
        vote = (w[:, :, None] * sig).sum(axis=1)
        if cfg['vol_target']:
            # Size each coin so its expected hourly move matches the calmest coin's: inverse-volatility weighting.
            v = V[idx]
            vote = vote * np.clip(v.min(axis=1, keepdims=True) / np.maximum(v, 1e-9), 0, 1) * cfg['vol_boost']
        if cfg['brake']:
            hit = (1 - eq / peak) > cfg['brake']
            brake_until = np.where(hit, t + 24, brake_until)
            vote = np.where((t < brake_until)[:, None], 0, vote)
        target = np.clip(vote, -1, 1) * (eq / C)[:, None]
        delta = target - pos * px
        trade = np.abs(delta) >= cfg['min_trade'] * eq[:, None]
        delta = np.where(trade, delta, 0)
        cash -= delta.sum(axis=1) + np.abs(delta).sum(axis=1) * FEE
        pos = np.where(trade, target / px, pos)
    end = P[starts + WINDOW - 1]
    return cash + (pos * end).sum(axis=1) - 1, mdd, w


def score(ret, mdd):
    return {
        'median': float(np.median(ret)), 'mean': float(ret.mean()), 'std': float(ret.std()),
        'win': float((ret > 0).mean()), 'p10': float(np.quantile(ret, 0.1)),
        'mdd': float(np.median(mdd)), 'sharpe_like': float(ret.mean() / max(ret.std(), 1e-9)),
    }


def run(P, S, V, lo, hi, cfg, n, seed):
    rng = np.random.default_rng(seed)
    starts = rng.integers(lo, hi, n)
    ret, mdd, w = simulate(P, S, V, starts, cfg, rng)
    hold = (P[starts + WINDOW - 1] / P[starts] - 1).mean(axis=1)
    out = score(ret, mdd)
    out['beat_hold'] = float((ret > hold).mean())
    out['hold_median'] = float(np.median(hold))
    out['weights'] = {a: round(float(w[:, i].mean()), 3) for i, a in enumerate(AGENTS)}
    return out


def main():
    data_dir, out = sys.argv[1], sys.argv[2]
    P = load(data_dir)
    S = signals(P)
    V = atr_frac(P)
    T = len(P)
    split = int(T * 0.67)
    ins = (250, split - WINDOW)
    oos = (split, T - WINDOW)

    current = dict(rebalance_h=8, lr=40, min_w=0.02, learn_hourly=False, vol_target=False, vol_boost=1.0, brake=0, min_trade=0.01)
    grid = dict(
        rebalance_h=[4, 6, 8, 12, 24], lr=[10, 20, 40, 80, 160], min_w=[0.02, 0.05],
        learn_hourly=[False, True], vol_target=[False, True], brake=[0, 0.08], min_trade=[0.01, 0.03],
    )
    results = []
    keys = list(grid)
    for vals in itertools.product(*(grid[k] for k in keys)):
        cfg = dict(zip(keys, vals), vol_boost=1.5)
        s = run(P, S, V, *ins, cfg, 1500, seed=1)
        results.append((s['sharpe_like'], cfg, s))
    results.sort(key=lambda x: -x[0])

    report = {
        'bars': T, 'in_sample_bars': split, 'out_of_sample_bars': T - split, 'configs_tested': len(results),
        'current_in': run(P, S, V, *ins, current, 10000, 2),
        'current_out': run(P, S, V, *oos, current, 10000, 3),
        'top': [],
    }
    for _, cfg, s in results[:8]:
        report['top'].append({'cfg': cfg, 'in': run(P, S, V, *ins, cfg, 10000, 2), 'out': run(P, S, V, *oos, cfg, 10000, 3)})
    # Which single choices matter most: mean in-sample sharpe per option value.
    report['option_effect'] = {
        k: {str(v): float(np.mean([r[0] for r in results if r[1][k] == v])) for v in grid[k]} for k in keys
    }
    json.dump(report, open(out, 'w'), indent=1)


if __name__ == '__main__':
    main()
