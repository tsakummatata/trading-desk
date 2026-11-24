"""Test (a) a per-coin stop loss between 12h rebalances and (b) a funding-based Liquidity Hunter agent,
on top of the current desk (12h rebalance, vol sizing, 3% min trade, Risk Officer net cap 50%).
Walk-forward split as tune.py. Usage: python3 -I test2.py <data_dir>
"""
import json
import sys

import numpy as np

sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from backtest import AGENTS, COINS, FEE, WINDOW, load, signals  # noqa: E402
from tune import atr_frac, score  # noqa: E402


def funding(data_dir, n):
    """Hourly funding rate per coin, aligned to the last n candles by hour."""
    candles = json.load(open(f'{data_dir}/BTC.json'))[-n:]
    hours = np.array([c['t'] // 3_600_000 for c in candles])
    F = np.zeros((n, len(COINS)))
    for j, c in enumerate(COINS):
        m = {r['time'] // 3_600_000: float(r['fundingRate']) for r in json.load(open(f'{data_dir}/{c}_funding.json'))}
        F[:, j] = [m.get(h, np.nan) for h in hours]
        F[:, j] = np.where(np.isnan(F[:, j]), np.nanmean(F[:, j]), F[:, j])
    return F


def liquidity_signal(F, look=168):
    """Lean against the crowd paying to be in: funding far above its 7-day norm -> short, far below -> long."""
    S = np.zeros_like(F)
    for t in range(look, len(F)):
        w = F[t - look:t]
        z = (F[t] - w.mean(axis=0)) / np.maximum(w.std(axis=0), 1e-9)
        S[t] = -np.clip(z / 2, -1, 1)
    return S


def simulate(P, S, V, starts, cfg, rng):
    R, A, C = len(starts), S.shape[0], P.shape[1]
    every, lr, min_w, cap = 12, 40, 0.02, 0.5
    w = np.full((R, A), 1 / A)
    cash, pos = np.ones(R), np.zeros((R, C))
    entry = np.ones((R, C))
    sig_prev = np.zeros((R, A, C))
    px_prev = P[starts]
    peak, mdd = np.ones(R), np.zeros(R)
    stops = 0
    for t in range(WINDOW):
        idx = starts + t
        px = P[idx]
        if t % every:
            if cfg['stop']:
                # Per-coin stop: close a bet that has moved `stop` against its entry since the last rebalance.
                move = (px / entry - 1) * np.sign(pos)
                hit = (pos != 0) & (move < -cfg['stop'])
                stops += int(hit.sum())
                cash += np.where(hit, pos * px - np.abs(pos * px) * FEE, 0).sum(axis=1)
                pos = np.where(hit, 0, pos)
        else:
            if t:
                reward = (sig_prev * (px / px_prev - 1)[:, None, :]).sum(axis=2)
                w = w * np.exp(lr * reward)
                w /= w.sum(axis=1, keepdims=True)
                w = np.maximum(w, min_w)
                w /= w.sum(axis=1, keepdims=True)
            sig = np.clip(np.transpose(S[:, idx, :], (1, 0, 2)) + rng.normal(0, 0.15, (R, A, C)), -1, 1)
            sig_prev, px_prev = sig, px
            vote = (w[:, :, None] * sig).sum(axis=1)
            v = V[idx]
            vote = np.clip(vote * np.clip(v.min(axis=1, keepdims=True) / np.maximum(v, 1e-9), 0, 1) * 1.5, -1, 1)
            eq = cash + (pos * px).sum(axis=1)
            target = vote * (eq / C)[:, None]
            net = target.sum(axis=1)
            target *= np.minimum(1, cap * eq / np.maximum(np.abs(net), 1e-12))[:, None]
            delta = target - pos * px
            trade = np.abs(delta) >= cfg.get('min_trade', 0.03) * eq[:, None]
            delta = np.where(trade, delta, 0)
            cash -= delta.sum(axis=1) + np.abs(delta).sum(axis=1) * FEE
            pos = np.where(trade, target / px, pos)
            entry = np.where(trade, px, entry)
        eq = cash + (pos * px).sum(axis=1)
        peak = np.maximum(peak, eq)
        mdd = np.maximum(mdd, 1 - eq / peak)
    end = P[starts + WINDOW - 1]
    return cash + (pos * end).sum(axis=1) - 1, mdd, w, stops / R


def main():
    d = sys.argv[1]
    P = load(d)
    T = len(P)
    base = signals(P)
    L = liquidity_signal(funding(d, T))
    S_liq = np.concatenate([base, L[None]], axis=0)
    V = atr_frac(P)
    split = int(T * 0.67)
    # Solo check: does the funding signal predict the next 12h on its own?
    fwd = np.zeros_like(P)
    fwd[:-12] = P[12:] / P[:-12] - 1
    for name, lo, hi in (('in', 250, split), ('out', split, T - 12)):
        r = (L[lo:hi] * fwd[lo:hi]).sum(axis=1)
        hit = ((np.sign(L[lo:hi]) == np.sign(fwd[lo:hi])) & (np.abs(L[lo:hi]) > 0.1)).sum() / max((np.abs(L[lo:hi]) > 0.1).sum(), 1)
        print(f'liquidity solo {name}: mean 12h edge {r.mean()*1e4:+.2f}bp  hit rate {hit*100:.1f}%')
    for name, lo, hi in (('in', 250, split - WINDOW), ('out', split, T - WINDOW)):
        for label, S, cfg in (
            ('current', base, {'stop': 0}),
            ('stop 3%', base, {'stop': 0.03}),
            ('stop 5%', base, {'stop': 0.05}),
            ('stop 8%', base, {'stop': 0.08}),
            ('+liquidity', S_liq, {'stop': 0}),
        ):
            rng = np.random.default_rng(9)
            starts = rng.integers(lo, hi, 10000)
            ret, mdd, w, stops = simulate(P, S, V, starts, cfg, rng)
            assert np.isfinite(ret).all()
            s = score(ret, mdd)
            extra = f' liq weight {w[:, -1].mean()*100:.1f}%' if S.shape[0] > len(AGENTS) else ''
            print(f"{name:3} {label:11} median {s['median']*100:+.2f}% mean {s['mean']*100:+.2f}% win {s['win']*100:.0f}% "
                  f"p10 {s['p10']*100:+.2f}% mdd {s['mdd']*100:.2f}% SR {s['sharpe_like']:.3f} stops/run {stops:.1f}{extra}")


if __name__ == '__main__':
    main()
