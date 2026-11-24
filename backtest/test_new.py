"""Test the Risk Officer (net-exposure cap) and Market Mood (per-regime agent weights) against the tuned desk.

Same walk-forward split as tune.py: in-sample = first 2/3, out-of-sample = last 1/3.
Usage: python3 -I test_new.py <data_dir>
"""
import sys

import numpy as np

sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from backtest import FEE, WINDOW, ema, load, rolling, rsi, signals  # noqa: E402
from tune import atr_frac, score  # noqa: E402

TREND, CHOP, PANIC = 0, 1, 2


def regimes(P):
    """Market mood from BTC's 1h chart, using only what the live desk also sees (RSI, EMA50/200, Bollinger)."""
    p = P[:, 0]
    r = rsi(p)
    e50, e200 = ema(p, 50), ema(p, 200)
    mid, sd = rolling(p, 20, np.mean), rolling(p, 20, np.std)
    lower = np.nan_to_num(mid - 2 * sd, nan=0)
    panic = (r < 30) | (p < lower)
    trend = np.abs(e50 - e200) / p > 0.015
    return np.where(panic, PANIC, np.where(trend, TREND, CHOP))


def simulate(P, S, V, G, starts, cfg, rng):
    R, A, C = len(starts), S.shape[0], P.shape[1]
    every, lr, min_w = 12, 40, 0.02
    moods = 3 if cfg['mood'] else 1
    w = np.full((moods, R, A), 1 / A)
    cash, pos = np.ones(R), np.zeros((R, C))
    sig_prev = np.zeros((R, A, C))
    px_prev = P[starts]
    mood_prev = np.zeros(R, int)
    peak, mdd = np.ones(R), np.zeros(R)
    rows = np.arange(R)
    for t in range(0, WINDOW, every):
        idx = starts + t
        px = P[idx]
        mood = G[idx] if cfg['mood'] else np.zeros(R, int)
        if t:
            reward = (sig_prev * (px / px_prev - 1)[:, None, :]).sum(axis=2)
            # Each run trains only the weights of the mood its last calls were made in.
            wm = w[mood_prev, rows] * np.exp(lr * reward)
            wm /= wm.sum(axis=1, keepdims=True)
            wm = np.maximum(wm, min_w)
            w[mood_prev, rows] = wm / wm.sum(axis=1, keepdims=True)
        sig = np.clip(np.transpose(S[:, idx, :], (1, 0, 2)) + rng.normal(0, 0.15, (R, A, C)), -1, 1)
        sig_prev, px_prev, mood_prev = sig, px, mood
        vote = (w[mood, rows][:, :, None] * sig).sum(axis=1)
        v = V[idx]
        vote = np.clip(vote * np.clip(v.min(axis=1, keepdims=True) / np.maximum(v, 1e-9), 0, 1) * 1.5, -1, 1)
        eq = cash + (pos * px).sum(axis=1)
        target = vote * (eq / C)[:, None]
        if cfg['net_cap']:
            # Risk Officer: the whole book's net long/short may not exceed net_cap of equity.
            net = target.sum(axis=1)
            k = np.minimum(1, cfg['net_cap'] * eq / np.maximum(np.abs(net), 1e-12))
            target = target * k[:, None]
        delta = target - pos * px
        trade = np.abs(delta) >= 0.03 * eq[:, None]
        delta = np.where(trade, delta, 0)
        cash -= delta.sum(axis=1) + np.abs(delta).sum(axis=1) * FEE
        pos = np.where(trade, target / px, pos)
        eq = cash + (pos * px).sum(axis=1)
        peak = np.maximum(peak, eq)
        mdd = np.maximum(mdd, 1 - eq / peak)
    end = P[starts + WINDOW - 1]
    return cash + (pos * end).sum(axis=1) - 1, mdd


def main():
    P = load(sys.argv[1])
    S, V, G = signals(P), atr_frac(P), regimes(P)
    T = len(P)
    split = int(T * 0.67)
    print('mood share (trend, chop, panic):', [round(float((G == g).mean()), 2) for g in (TREND, CHOP, PANIC)])
    for name, lo, hi in (('in', 250, split - WINDOW), ('out', split, T - WINDOW)):
        for cfg in ({'net_cap': 0, 'mood': False}, {'net_cap': 0.5, 'mood': False}, {'net_cap': 0.3, 'mood': False},
                    {'net_cap': 0, 'mood': True}, {'net_cap': 0.5, 'mood': True}):
            rng = np.random.default_rng(5)
            starts = rng.integers(lo, hi, 10000)
            ret, mdd = simulate(P, S, V, G, starts, cfg, rng)
            assert np.isfinite(ret).all()
            s = score(ret, mdd)
            print(f"{name:3} cap={cfg['net_cap']:<3} mood={cfg['mood']!s:5} median {s['median']*100:+.2f}% mean {s['mean']*100:+.2f}% "
                  f"win {s['win']*100:.0f}% p10 {s['p10']*100:+.2f}% mdd {s['mdd']*100:.2f}% SR {s['sharpe_like']:.3f}")


if __name__ == '__main__':
    main()
