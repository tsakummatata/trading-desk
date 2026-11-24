# Backtests

Rule-based stand-ins for the desk's chart agents, replayed on real Hyperliquid 1h candles with the desk's learning, voting, sizing and fees. Every setting the desk ships with was chosen here.

```bash
mkdir -p data && python3 -I fetch_candles.py data
python3 -I get_funding.py data "$(python3 -c "import json;print(json.load(open('data/BTC.json'))[0]['t'])")"
python3 -I backtest.py data report.json 10000   # 10,000 Monte Carlo runs
python3 -I tune.py data tune.json               # walk-forward tune: first 2/3 in-sample, last 1/3 unseen
python3 -I test_new.py data                     # Risk Officer and market mood
python3 -I test2.py data                        # stop losses and the funding signal
python3 -I test_subsets.py data                 # smaller chart teams
```

Needs Python 3 and numpy.
