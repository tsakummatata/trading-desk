"""Download hourly funding-rate history from Hyperliquid's public info API, paginated (500 rows per call).
Usage: python3 -I get_funding.py <out_dir> <start_ms>
"""
import json
import sys
import time
import urllib.request

out, start = sys.argv[1], int(sys.argv[2])
for coin in ['BTC', 'ETH', 'SOL', 'HYPE']:
    rows, t = [], start
    while True:
        req = urllib.request.Request('https://api.hyperliquid.xyz/info', json.dumps({'type': 'fundingHistory', 'coin': coin, 'startTime': t}).encode(), {'Content-Type': 'application/json'})
        page = json.load(urllib.request.urlopen(req, timeout=30))
        if not page:
            break
        rows += page
        t = page[-1]['time'] + 1
        if len(page) < 500:
            break
        time.sleep(0.3)
    json.dump(rows, open(f'{out}/{coin}_funding.json', 'w'))
    print(coin, len(rows), rows[0]['fundingRate'] if rows else None)
