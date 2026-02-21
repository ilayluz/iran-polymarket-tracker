import urllib.request, json

url = 'https://gamma-api.polymarket.com/events?slug=us-strikes-iran-by'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())

event = data[0]
markets = event.get('markets', [])

closed = [m for m in markets if m.get('closed')]
active_open = [m for m in markets if not m.get('closed')]

print(f'Total markets: {len(markets)}')
print(f'Closed (resolved No): {len(closed)}')
print(f'Still open (trading): {len(active_open)}')
print()

print('=== OPEN MARKETS sorted by question date ===')
for m in sorted(active_open, key=lambda x: x.get('groupItemTitle','')):
    prices = json.loads(m.get('outcomePrices','[]'))
    yes_price = prices[0] if prices else 'N/A'
    no_price = prices[1] if len(prices) > 1 else 'N/A'
    vol = float(m.get('volume', 0))
    print(f"  {m['groupItemTitle']:>15s} | ID: {m['id']:>8s} | Yes={yes_price:>6s} No={no_price:>6s} | vol=${vol:>14,.2f} | endDate={m.get('endDate','')}")

print()
print('=== EVENT DESCRIPTION ===')
print(event.get('description',''))
