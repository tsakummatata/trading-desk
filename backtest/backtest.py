"""Monte Carlo backtest of the trading desk's technical agents on real Hyperliquid 1h candles.

Mirrors desk.ts: each agent emits a signal in [-1, 1] per coin, Hedge (multiplicative weights)
trains agent weights on realised returns, the weighted vote sets each coin's target exposure
(up to 1/N of equity, long or short), 5bp fee per traded dollar, trades under 1% of equity skipped.
Usage: python3 -I backtest.py <data_dir> <out.json> [runs]
"""
import json
import sys

import numpy as np

COINS = ['BTC', 'ETH', 'SOL', 'HYPE']
AGENTS = ['trend', 'momentum', 'meanrev', 'vol', 'breakout', 'contrarian', 'macro', 'relative', 'risk', 'swing']
FEE = 0.0005
WINDOW = 720  # 30 days of 1h bars
MIN_W = 0.02
import os
NORM = os.environ.get('NORM') == '1'
EVERY = [int(x) for x in os.environ.get('EVERY', '1,4,8').split(',')]


def ema(x, n):
    a = 2 / (n + 1)
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def rsi(c, n=14):
    d = np.diff(c, prepend=c[0])
    up = ema(np.clip(d, 0, None), 2 * n - 1)  # Wilder smoothing == EMA with span 2n-1
    dn = ema(np.clip(-d, 0, None), 2 * n - 1)
    return 100 - 100 / (1 + up / np.maximum(dn, 1e-12))


def rolling(x, n, fn):
    out = np.full_like(x, np.nan)
    for i in range(n - 1, len(x)):
        out[i] = fn(x[i - n + 1:i + 1])
    return out


def load(data_dir):
    closes = []
    for c in COINS:
        rows = json.load(open(f'{data_dir}/{c}.json'))
        closes.append(np.array([float(r['c']) for r in rows]))
    n = min(len(x) for x in closes)
    return np.stack([x[-n:] for x in closes], axis=1)  # bars x coins


def signals(P):
    T, C = P.shape
    S = np.zeros((len(AGENTS), T, C))
    ret24 = np.zeros((T, C))
    ret24[24:] = P[24:] / P[:-24] - 1
    for j in range(C):
        p = P[:, j]
        e20, e50, e200 = ema(p, 20), ema(p, 50), ema(p, 200)
        macd = ema(p, 12) - ema(p, 26)
        hist = macd - ema(macd, 9)
        r = rsi(p)
        mid = rolling(p, 20, np.mean)
        sd = rolling(p, 20, np.std)
        up, lo = mid + 2 * sd, mid - 2 * sd
        bw = (up - lo) / mid
        bw_lo = rolling(np.nan_to_num(bw, nan=np.nanmean(bw)), 200, lambda w: np.quantile(w, 0.2))
        hs = np.sign(hist)
        hist_up = np.r_[0, np.diff(hist)] > 0
        vol = rolling(np.r_[0, np.diff(np.log(p))], 24, np.std) * np.sqrt(24)

        trend = np.where((p > e20) & (e20 > e50) & (e50 > e200), 1.0,
                 np.where((p < e20) & (e20 < e50) & (e50 < e200), -1.0, 0.3 * np.sign(p - e200)))
        S[0, :, j] = trend
        S[1, :, j] = 0.5 * hs + np.where((r > 50) & (r < 70), 0.5, np.where((r > 30) & (r < 50), -0.5, 0))
        S[2, :, j] = np.where((r < 30) | (p < lo), 0.8, np.where((r > 70) | (p > up), -0.8, 0))
        S[3, :, j] = np.where(bw < bw_lo, 0.7, 0.2) * hs
        S[4, :, j] = np.where((p > up) & hist_up, 1.0, np.where((p < lo) & ~hist_up, -1.0, 0))
        S[5, :, j] = -0.3 * trend
        S[6, :, j] = np.where(np.sign(p - e200) == hs, 0.6 * hs, 0)
        S[8, :, j] = -0.3 * np.tanh(ret24[:, j] / np.maximum(np.nan_to_num(vol, nan=1), 1e-6))
        near = np.abs(p - e20) / p < 0.005
        S[9, :, j] = np.where(near & (e50 > e200), 0.7, np.where(near & (e50 < e200), -0.7, 0))
    rank = ret24.argsort(axis=1).argsort(axis=1)  # 0 weakest .. C-1 strongest
    S[7] = np.where(rank == C - 1, 0.6, np.where(rank == 0, -0.6, 0))
    S = np.nan_to_num(S)
    S[:, :250] = 0  # indicator warm-up
    return np.clip(S, -1, 1)


def simulate(P, S, starts, lr, every, noise, rng):
    """Vectorised over runs. Returns final return, max drawdown, final weights, single-agent returns."""
    R, A, C = len(starts), S.shape[0], P.shape[1]
    w = np.full((R, A), 1 / A)
    cash = np.ones(R)
    pos = np.zeros((R, C))  # units held per unit starting equity
    last_sig = np.zeros((R, A, C))
    last_px = P[starts]
    peak = np.ones(R)
    mdd = np.zeros(R)
    solo = np.ones((R, A))  # each agent trading alone, no fees: sum of sig * ret / C
    for t in range(0, WINDOW, every):
        idx = starts + t
        px = P[idx]  # R x C
        r = px / last_px - 1
        if t:
            raw = (last_sig * r[:, None, :]).sum(axis=2)  # R x A
            solo *= 1 + raw / C
            # NORM: score return per unit of conviction, so a selective agent isn't starved for sitting at 0.
            reward = raw / np.maximum(np.abs(last_sig).sum(axis=2), 0.25) if NORM else raw
            w = w * np.exp(lr[:, None] * reward)
            w /= w.sum(axis=1, keepdims=True)
            w = np.maximum(w, MIN_W)
            w /= w.sum(axis=1, keepdims=True)
        sig = np.transpose(S[:, idx, :], (1, 0, 2))  # R x A x C
        sig = np.clip(sig + rng.normal(0, 1, sig.shape) * noise[:, None, None], -1, 1)
        vote = (w[:, :, None] * sig).sum(axis=1)  # R x C
        eq = cash + (pos * px).sum(axis=1)
        target = vote * (eq / C)[:, None]
        delta = target - pos * px
        trade = np.abs(delta) >= 0.01 * eq[:, None]
        delta = np.where(trade, delta, 0)
        cash -= delta.sum(axis=1) + np.abs(delta).sum(axis=1) * FEE
        pos = np.where(trade, target / px, pos)
        eq = cash + (pos * px).sum(axis=1)
        peak = np.maximum(peak, eq)
        mdd = np.maximum(mdd, 1 - eq / peak)
        last_sig, last_px = sig, px
    end = P[starts + WINDOW - 1]
    eq = cash + (pos * end).sum(axis=1)
    return eq - 1, mdd, w, solo - 1


def main():
    data_dir, out = sys.argv[1], sys.argv[2]
    runs = int(sys.argv[3]) if len(sys.argv) > 3 else 10_000
    rng = np.random.default_rng(7)
    P = load(data_dir)
    S = signals(P)
    T = len(P)
    lo, hi = 250, T - WINDOW
    res = {'ret': [], 'mdd': [], 'w': [], 'solo': [], 'lr': [], 'every': [], 'noise': [], 'start': []}
    for k, every in enumerate(EVERY):
        n = runs // len(EVERY) + (runs % len(EVERY) if k == 0 else 0)
        starts = rng.integers(lo, hi, n)
        lr = rng.uniform(5, 60, n)
        noise = rng.uniform(0, 0.3, n)
        ret, mdd, w, solo = simulate(P, S, starts, lr, every, noise, rng)
        for k, v in (('ret', ret), ('mdd', mdd), ('w', w), ('solo', solo), ('lr', lr), ('noise', noise), ('start', starts)):
            res[k].append(v)
        res['every'].append(np.full(n, every))
    res = {k: np.concatenate(v) for k, v in res.items()}
    starts = res['start']
    hold = (P[starts + WINDOW - 1] / P[starts] - 1).mean(axis=1)  # equal-weight buy & hold
    ret = res['ret']
    assert len(ret) == runs and np.isfinite(ret).all()

    def stats(mask):
        r = ret[mask]
        return {
            'runs': int(mask.sum()),
            'median_return': float(np.median(r)), 'mean_return': float(r.mean()),
            'p10': float(np.quantile(r, 0.1)), 'p90': float(np.quantile(r, 0.9)),
            'win_rate': float((r > 0).mean()), 'beat_hold': float((r > hold[mask]).mean()),
            'median_max_drawdown': float(np.median(res['mdd'][mask])),
        }

    every = res['every']
    lr_bins = [(5, 20), (20, 40), (40, 60)]
    report = {
        'runs': runs,
        'bars': int(T), 'window_days': WINDOW // 24,
        'period': 'last ~208 days of Hyperliquid 1h candles',
        'overall': stats(np.ones(runs, bool)),
        'buy_and_hold': {'median_return': float(np.median(hold)), 'win_rate': float((hold > 0).mean())},
        'by_rebalance_hours': {str(e): stats(every == e) for e in EVERY},
        'by_learning_rate': {f'{a}-{b}': stats((res['lr'] >= a) & (res['lr'] < b)) for a, b in lr_bins},
        'agents': {
            a: {
                'mean_final_weight': float(res['w'][:, i].mean()),
                'top_weight_share': float((res['w'].argmax(axis=1) == i).mean()),
                'solo_median_return': float(np.median(res['solo'][:, i])),
                'solo_win_rate': float((res['solo'][:, i] > 0).mean()),
            }
            for i, a in enumerate(AGENTS)
        },
    }
    json.dump(report, open(out, 'w'), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
