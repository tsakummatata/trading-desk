import { expect, test } from 'claude-code/testing'

import { AGENTS, DEFAULT_SETTINGS, isIdle, cacheWarmers, scorecard, parsePluginPicks, brainstormPrompt, improverPrompt, parseImprover, shouldThink, NET_CAP, agentPrompt, alertsFor, moodOf, addUsage, huddleDigest, mergeTally, parseYouTube, VOL_BOOST, volScale, LIMITS, clampSettings, hadLoss, parseChief, periodReport, REBALANCE_MS, START_CASH, cleanNews, isRebalanceDue, prior, equity, newDesk, parseIdeas, parseSignals, rebalance, train, vote, withAgents } from './desk'

test('parses agent replies and clamps signals', async () => {
  const p = parseSignals('Sure: {"BTC": 2, "ETH": -0.5, "SOL": "x", "note": "hi"}')
  expect(p?.signals).toEqual({ BTC: 1, ETH: -0.5 })
  expect(p?.note).toBe('hi')
  expect(parseSignals('no json')).toBe(null)
})

test('training moves weight to the agent that called the move right', async () => {
  let d = newDesk(0)
  d = { ...d, ticks: 1, prices: { BTC: 100 } }
  d.agents[0] = { ...d.agents[0]!, signals: { BTC: 1 } } // right
  d.agents[1] = { ...d.agents[1]!, signals: { BTC: -1 } } // wrong
  const t = train(d, { BTC: 102 })
  expect(t.agents[0]!.weight > t.agents[2]!.weight).toBe(true)
  expect(t.agents[1]!.weight < t.agents[2]!.weight).toBe(true)
  expect(Math.abs(t.agents.reduce((s, a) => s + a.weight, 0) - 1) < 1e-9).toBe(true)
  expect(t.agents[0]!.hits).toBe(1)
})

test('rebalance keeps equity (minus fees) and goes long on a bullish vote', async () => {
  let d = newDesk(0)
  d = { ...d, agents: d.agents.map(a => ({ ...a, signals: { BTC: 1, ETH: 0, SOL: 0, HYPE: 0 } })) }
  const prices = { BTC: 100, ETH: 10, SOL: 1, HYPE: 1 }
  const r = rebalance(d, prices, vote(d), 1)
  expect(r.positions.BTC).toBe(START_CASH / 4 / 100)
  const eq = equity(r, prices)
  expect(eq < START_CASH && eq > START_CASH * 0.999).toBe(true)
})

test('scout ideas are parsed and bad entries dropped', async () => {
  const ideas = parseIdeas('{"ideas":[{"asset":"TNSR","side":"long","why":"14x volume"},{"asset":"X","side":"up"}]}')
  expect(ideas).toEqual([{ asset: 'TNSR', side: 'long', why: '14x volume' }])
  expect(parseIdeas('nothing')).toEqual([])
})

test('news links are stripped', async () => {
  expect(cleanNews('1. Big news — Src (https://news.google.com/rss/abc?oc=5)\n2. More')).toBe('1. Big news — Src\n2. More')
})

test('an older desk gains the new agents and keeps learned weights in order', async () => {
  const old = newDesk(0)
  old.agents = old.agents.filter(a => a.id !== 'news' && a.id !== 'crowd')
  old.agents[0] = { ...old.agents[0]!, weight: 0.5 }
  const d = withAgents(old)
  expect(d.agents.length).toBe(AGENTS.length)
  expect(Math.abs(d.agents.reduce((s, a) => s + a.weight, 0) - 1) < 1e-9).toBe(true)
  const top = d.agents.find(a => a.id === old.agents[0]!.id)!
  expect(d.agents.every(a => a.weight <= top.weight)).toBe(true)
})

test('backtest priors sum to 1 and rank momentum above swing', async () => {
  const d = newDesk(0)
  expect(Math.abs(d.agents.reduce((s, a) => s + a.weight, 0) - 1) < 1e-9).toBe(true)
  expect(prior('momentum') > prior('swing')).toBe(true)
  expect(prior('news')).toBe(1 / AGENTS.length)
})

test('an existing desk gets the priors once, then keeps what it learns', async () => {
  const old = { ...newDesk(0), priorApplied: undefined }
  old.agents = old.agents.map(a => ({ ...a, weight: 1 / AGENTS.length }))
  const once = withAgents(old)
  expect(once.agents.find(a => a.id === 'momentum')!.weight).toBe(prior('momentum'))
  const learned = { ...once, agents: once.agents.map(a => (a.id === 'swing' ? { ...a, weight: 0.5 } : a)) }
  expect(withAgents(learned).agents.find(a => a.id === 'swing')!.weight > prior('swing')).toBe(true)
})

test('rebalance is due on the first scan and then every 12h', async () => {
  const d = newDesk(0)
  expect(isRebalanceDue(d, 1)).toBe(true)
  expect(isRebalanceDue({ ...d, lastRebalance: 1000 }, 1000 + REBALANCE_MS - 1)).toBe(false)
  expect(isRebalanceDue({ ...d, lastRebalance: 1000 }, 1000 + REBALANCE_MS)).toBe(true)
})

test('Head AI settings are clamped to the limits and unknown agents dropped', async () => {
  const s = clampSettings({ exposure: 5, learnRate: -1, minTrade: 'x', agentScale: { swing: 9, ghost: 0, risk: 0 } }, DEFAULT_SETTINGS)
  expect(s.exposure).toBe(LIMITS.exposure[1])
  expect(s.learnRate).toBe(LIMITS.learnRate[0])
  expect(s.minTrade).toBe(DEFAULT_SETTINGS.minTrade)
  expect(s.agentScale).toEqual({ swing: LIMITS.agentScale[1], risk: 0 })
})

test('Head AI reply is parsed; bad JSON is null', async () => {
  const out = parseChief('ok {"brief":"cut risk","lesson":"shorted into oversold","settings":{"exposure":0.5}}', DEFAULT_SETTINGS)
  expect(out?.settings.exposure).toBe(0.5)
  expect(out?.lesson).toBe('shorted into oversold')
  expect(parseChief('no', DEFAULT_SETTINGS)).toBe(null)
})

test('period report finds the loss and the agents that called it wrong', async () => {
  let d = newDesk(0)
  d = { ...d, lastRebalance: 1, basePrices: { BTC: 100 }, positions: { BTC: -1 } }
  d.agents[0] = { ...d.agents[0]!, signals: { BTC: -1 } }
  const r = periodReport(d, { BTC: 110 }, 2)!
  expect(r.bySymbol.BTC).toBe(-10)
  expect(hadLoss(r)).toBe(true)
  expect(r.agents[0]!.wrong).toEqual(['BTC'])
})

test('exposure scales the paper book', async () => {
  let d = newDesk(0)
  d = { ...d, settings: { ...DEFAULT_SETTINGS, exposure: 0.5 }, agents: d.agents.map(a => ({ ...a, signals: { BTC: 1 } })) }
  const r = rebalance(d, { BTC: 100, ETH: 1, SOL: 1, HYPE: 1 }, vote(d), 1)
  expect(r.positions.BTC).toBe((START_CASH / 4 / 100) * 0.5)
})

test('volatility sizing shrinks the wilder coin and caps each target at one slot', async () => {
  const s = volScale({ BTC: 0.004, SOL: 0.008 })
  expect(s.BTC).toBe(VOL_BOOST)
  expect(s.SOL).toBe(0.5 * VOL_BOOST)
  let d = newDesk(0)
  d = { ...d, agents: d.agents.map(a => ({ ...a, signals: { BTC: 1, SOL: 1 } })) }
  const r = rebalance(d, { BTC: 100, ETH: 1, SOL: 10, HYPE: 1 }, vote(d), 1, { BTC: 0.004, SOL: 0.008 })
  expect(r.positions.BTC).toBe(START_CASH / 4 / 100) // 1.5x capped at a full slot
  expect(r.positions.SOL).toBe((START_CASH / 4 / 10) * 0.75)
})

test('huddle digest lists every call the team made', async () => {
  const d = huddleDigest({ trend: { signals: { BTC: -0.6 }, note: 'below EMAs' }, skeptic: { signals: { BTC: 0.2 }, note: 'oversold' } })
  expect(d.includes('Trend Follower: BTC -0.60')).toBe(true)
  expect(d.includes('Skeptic: BTC 0.20')).toBe(true)
})

test('cost tally adds calls and tokens per model', async () => {
  const t = addUsage(addUsage({}, 'haiku', { input_tokens: 100, output_tokens: 10 }), 'haiku', { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 7 })
  expect(t.haiku).toEqual({ calls: 2, input: 150, output: 15, cached: 7, created: 0 })
  const m = mergeTally(t, { sonnet: { calls: 1, input: 1, output: 1, cached: 0 } })
  expect(m.sonnet!.calls + m.haiku!.calls).toBe(3)
  expect(t.sonnet).toBe(undefined) // merge does not mutate its input
})

test('YouTube titles are read; bad JSON gives none', async () => {
  expect(parseYouTube('{"items":[{"snippet":{"title":"BTC crash!","channelTitle":"Coin"}}]}')).toEqual(['BTC crash! — Coin'])
  expect(parseYouTube('nope')).toEqual([])
})

test('the skeptic speaks only in the huddle', async () => {
  expect(AGENTS.find(a => a.id === 'skeptic')?.huddleOnly).toBe(true)
  expect(AGENTS.filter(a => !a.huddleOnly).length).toBe(AGENTS.length - 1)
})

test('Risk Officer caps the net bet when every coin points the same way', async () => {
  let d = newDesk(0)
  d = { ...d, agents: d.agents.map(a => ({ ...a, signals: { BTC: -1, ETH: -1, SOL: -1, HYPE: -1 } })) }
  const prices = { BTC: 100, ETH: 10, SOL: 1, HYPE: 1 }
  const r = rebalance(d, prices, vote(d), 1)
  const net = Object.entries(r.positions).reduce((t, [s, q]) => t + q * prices[s as keyof typeof prices], 0)
  expect(Math.abs(Math.abs(net) - NET_CAP * START_CASH) < 1).toBe(true)
  expect(r.riskTrim! > 0).toBe(true)
  const mixed = { ...d, agents: d.agents.map(a => ({ ...a, signals: { BTC: 1, ETH: -1, SOL: 0, HYPE: 0 } })) }
  expect(rebalance(mixed, prices, vote(mixed), 1).riskTrim).toBe(0)
})

test('market mood reads panic, trend and chop', async () => {
  const m = (rsi14: number, ema50: number, ema200: number, price = 100) => ({ symbol: 'BTC', price, indicators: { rsi14, ema: { ema50, ema200 }, bollinger: { lower: 90 } } })
  expect(moodOf(m(25, 100, 100))).toBe('panic')
  expect(moodOf(m(45, 100, 95))).toBe('trend')
  expect(moodOf(m(45, 100, 99.5))).toBe('chop')
  expect(moodOf(undefined)).toBe(undefined)
})

test('alerts fire on a risk cut and stay quiet for 6h after', async () => {
  const before = newDesk(0)
  const after = { ...before, settings: { ...DEFAULT_SETTINGS, exposure: 0.5 } }
  const found = alertsFor(before, after, 10)
  expect(found.map(a => a.key)).toEqual(['risk'])
  expect(alertsFor(before, { ...after, alerts: [{ t: 10, key: 'risk', text: '' }] }, 20)).toEqual([])
})

test('agent prompts share one cacheable opening and differ only in the role', async () => {
  const a = agentPrompt('trend style', [], 'intel', 'memo')
  const b = agentPrompt('swing style', [], 'intel', 'memo', 'daily data')
  expect(a[0]).toEqual(b[0]!)
  expect(a[0]!.cache).toBe(true)
  expect(b[1]!.text.includes('daily data')).toBe(true)
})

test('the team only thinks when a trade is due or it has no votes yet', async () => {
  const fresh = newDesk(0)
  expect(shouldThink(fresh, 1)).toBe(true) // no votes yet
  const voted = { ...fresh, lastRebalance: 1000, agents: fresh.agents.map(a => ({ ...a, pending: { BTC: 0.2 } })) }
  expect(shouldThink(voted, 1000 + REBALANCE_MS / 2)).toBe(false)
  expect(shouldThink(voted, 1000 + REBALANCE_MS)).toBe(true)
})

test('Improver ideas are parsed and malformed ones dropped', async () => {
  const out = parseImprover('{"ideas":[{"title":"Bench Macro","why":"3% say, 40% right","kind":"agent","impact":"medium"},{"title":"x","kind":"magic","impact":"high"}]}')
  expect(out.ideas).toEqual([{ title: 'Bench Macro', why: '3% say, 40% right', kind: 'agent', impact: 'medium' }])
  expect(parseImprover('nope')).toEqual({ ideas: [], consult: [] })
})

test('Improver is told what was already rejected and never to trade for real', async () => {
  const p = improverPrompt(newDesk(0))
  expect(p.includes('per-coin stop losses')).toBe(true)
  expect(p.includes('Never propose placing real trades')).toBe(true)
})

test('Improver may consult up to 3 real teammates; unknown ids are dropped', async () => {
  const out = parseImprover('{"ideas":[],"consult":[{"id":"skeptic","question":"q1"},{"id":"ghost","question":"q"},{"id":"chief","question":"q2"},{"id":"risk","question":"q3"},{"id":"macro","question":"q4"}]}')
  expect(out.consult.map(c => c.id)).toEqual(['skeptic', 'chief', 'risk'])
})

test('a teammate answers in role, with its own record', async () => {
  const p = brainstormPrompt(newDesk(0), 'skeptic', 'Should we bench Macro?')
  expect(p.includes('Skeptic')).toBe(true)
  expect(p.includes('Should we bench Macro?')).toBe(true)
  expect(brainstormPrompt(newDesk(0), 'chief', 'q').includes('Head AI')).toBe(true)
})

test('Plugin Scout keeps only real, uninstalled listings and marks new ones', async () => {
  const listings = [
    { id: 'p1', name: 'TradingCalc', description: 'trading math', kind: 'plugin' as const, enabled: false },
    { id: 'p2', name: 'Installed', description: '', kind: 'plugin' as const, enabled: true },
    { id: 'p3', name: 'Old', description: '', kind: 'skill' as const, enabled: false },
  ]
  const text = '{"picks":[{"id":"p1","why":"checks the math","fit":"high"},{"id":"p2","why":"x","fit":"high"},{"id":"ghost","why":"x","fit":"low"},{"id":"p3","why":"y","fit":"low"}]}'
  const picks = parsePluginPicks(text, listings, ['p3'], 100)
  expect(picks.map(p => p.id)).toEqual(['p1', 'p3'])
  expect(picks[0]!.firstSeen).toBe(100) // never seen before: new
  expect(picks[1]!.firstSeen).toBe(0) // seen in an earlier scan: not new
  expect(parsePluginPicks('nope', listings, [], 1)).toEqual([])
})

test('removed chart agents are dropped from a stored desk and weights stay whole', async () => {
  const old = newDesk(0)
  old.agents = [...old.agents, { id: 'macro', weight: 0.2, signals: {}, score: 0, calls: 0, hits: 0, note: '' }]
  const d = withAgents(old)
  expect(d.agents.some(a => a.id === 'macro')).toBe(false)
  expect(Math.abs(d.agents.reduce((s, a) => s + a.weight, 0) - 1) < 1e-9).toBe(true)
})

test('an agent sees its own scorecard, including last period\'s wrong calls', async () => {
  let d = newDesk(0)
  d = { ...d, agents: d.agents.map(a => (a.id === 'trend' ? { ...a, calls: 10, hits: 4 } : a)) }
  d = { ...d, lastReport: { t: 1, pnl: -5, bySymbol: {}, agents: [{ id: 'trend', reward: -0.01, wrong: ['BTC'] }] } }
  const card = scorecard(d, 'trend')
  expect(card.includes('right 40% of 10')).toBe(true)
  expect(card.includes('called BTC the wrong way')).toBe(true)
  expect(card.includes('below a coin flip')).toBe(true)
  expect(scorecard(newDesk(0), 'trend')).toBe('Your record: no scored calls yet.')
})

test('one warm-up call per model, and cache writes are tallied', async () => {
  const warm = cacheWarmers([{ id: 'a' }, { id: 'b', model: 'sonnet' }, { id: 'c' }, { id: 'd', model: 'sonnet' }])
  expect(warm.map(a => a.id)).toEqual(['a', 'b'])
  const t = addUsage({}, 'haiku', { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 5000 })
  expect(t.haiku!.created).toBe(5000)
  expect(mergeTally(t, t).haiku!.created).toBe(10000)
})

test('Social Sentiment sits out without a feed, so it neither costs calls nor dilutes the vote', async () => {
  const d = newDesk(0)
  expect(isIdle(d, 'social')).toBe(true)
  expect(isIdle({ ...d, social: { t: 1, status: '', items: ['BTC to the moon'] } }, 'social')).toBe(false)
  expect(isIdle(d, 'trend')).toBe(false)
  // An agent with no signal is left out of the vote rather than counted as 0.
  const v = vote({ ...d, agents: d.agents.map(a => ({ ...a, signals: (a.id === 'trend' ? { BTC: 1 } : {}) as Record<string, number> })) })
  expect(v.BTC).toBe(1)
})
