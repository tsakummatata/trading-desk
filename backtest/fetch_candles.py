"""Download ~208 days of 1h candles for the desk's coins from Hyperliquid's public info API.
Usage: python3 -I fetch_candles.py <out_dir>   (then: get_funding.py <out_dir> <first candle ms>)
"""
import json
import sys
import time
import urllib.request

out = sys.argv[1]
start = int((time.time() - 208 * 86400) * 1000)
for coin in ['BTC', 'ETH', 'SOL', 'HYPE']:
    body = json.dumps({'type': 'candleSnapshot', 'req': {'coin': coin, 'interval': '1h', 'startTime': start}}).encode()
    req = urllib.request.Request('https://api.hyperliquid.xyz/info', body, {'Content-Type': 'application/json'})
    rows = json.load(urllib.request.urlopen(req, timeout=30))
    json.dump(rows, open(f'{out}/{coin}.json', 'w'))
    print(coin, len(rows))
