// Pure trading-desk logic: no $, so it is unit-tested directly.
import type { ModelTextBlock } from 'claude-code'

import type { Desk, Idea2, Listing, Market, Mood, PeriodReport, PluginPick, Settings, Talk } from '../types'

export const SYMBOLS = ['BTC', 'ETH', 'SOL', 'HYPE'] as const
export const START_CASH = 10_000
const FEE = 0.0005 // 5 bps per side, simulated
// From the 800-setting walk-forward tune: learnRate 40 (80 and 160 learned noise and did worse; so did
// learning every hour), minTrade 3% (fewer fee-eating small trades).
// minTrade 8%: better than 3% in both backtest periods (unseen median -2.01% -> -1.36%); higher values only
// looked better in the falling unseen period because they trade less, and were worse in the earlier one.
export const DEFAULT_SETTINGS: Settings = { exposure: 1, learnRate: 40, minTrade: 0.08, agentScale: {} }
// The Head AI may only move settings inside these bounds. exposure tops out at the tested 100%:
// it can cut risk after losses, never add leverage beyond what the backtest covered.
export const LIMITS = { exposure: [0.2, 1], learnRate: [10, 80], minTrade: [0.02, 0.12], agentScale: [0, 1.5] } as const

export function settingsOf(d: Desk): Settings {
  return { ...DEFAULT_SETTINGS, ...d.settings, agentScale: { ...d.settings?.agentScale } }
}

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** Validate settings proposed by the Head AI: unknown keys dropped, every number clamped to LIMITS. */
export function clampSettings(raw: unknown, base: Settings): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const scaleIn = (r.agentScale && typeof r.agentScale === 'object' ? r.agentScale : {}) as Record<string, unknown>
  const agentScale: Record<string, number> = { ...base.agentScale }
  for (const a of AGENTS) if (a.id in scaleIn) agentScale[a.id] = clamp(scaleIn[a.id], LIMITS.agentScale, 1)
  return {
    exposure: clamp(r.exposure ?? base.exposure, LIMITS.exposure, base.exposure),
    learnRate: clamp(r.learnRate ?? base.learnRate, LIMITS.learnRate, base.learnRate),
    minTrade: clamp(r.minTrade ?? base.minTrade, LIMITS.minTrade, base.minTrade),
    agentScale,
  }
}
export const REBALANCE_MS = 12 * 3600_000 // walk-forward tune: 12h beat 4h, 6h, 8h and 24h
export const VOL_BOOST = 1.5 // with volatility sizing, the calmest coin gets 1.5x its slot (tuned value)

// Starting influence from the walk-forward tune (mean final in-sample weights at the chosen settings).
// News and Crowd can't be backtested (no historical intel), so they start at an even 1/12.
const BACKTEST_WEIGHTS: Record<string, number> = {
  // Breakout, Macro and Relative Value were removed: dropping them was as good or better in both
  // backtest periods (unseen period median -2.01% -> -1.67%), as they mostly echoed the others.
  trend: 0.098, momentum: 0.302, meanrev: 0.133, vol: 0.071,
  contrarian: 0.115, risk: 0.098, swing: 0.061,
}

/** Prior weight per agent, summing to 1 over the roster. */
export function prior(id: string): number {
  const even = 1 / AGENTS.length
  const tested = AGENTS.filter(a => a.id in BACKTEST_WEIGHTS).length
  const sum = Object.values(BACKTEST_WEIGHTS).reduce((t, w) => t + w, 0) // rounded weights sum to ~0.999
  return id in BACKTEST_WEIGHTS ? (BACKTEST_WEIGHTS[id]! / sum) * tested * even : even
}

export function isRebalanceDue(d: Desk, now: number): boolean {
  return !d.lastRebalance || now - d.lastRebalance >= REBALANCE_MS
}
const MIN_WEIGHT = 0.02 // no agent is ever fully silenced, so it can earn its way back

// model: deeper-thinking agents use sonnet; the technical agents stay on cheap haiku.
// huddleOnly: speaks in the huddle (after round 1, having read the team's calls), not in round 1.
export const AGENTS: { id: string; name: string; style: string; model?: 'sonnet'; huddleOnly?: true }[] = [
  { id: 'news', name: 'News Scanner', model: 'sonnet', style: 'Read the headlines and unusual-activity list. Go long or short only where a fresh catalyst clearly hits a market; ignore stale or unrelated news.' },
  { id: 'bigpicture', name: 'Big-Picture Analyst', style: 'Read the DAILY charts you are given, not the hourly noise. A daily RSI under 30 after a long fall means a sharp bounce is likely even in a downtrend: do not chase shorts there. Trade with the daily trend only when the daily chart is not stretched.' },
  { id: 'liquidity', name: 'Liquidity Hunter', style: 'Read funding rates, 24h change and how much is close to liquidation. Crowded, over-leveraged sides get squeezed: lean against them when funding and positioning are stretched; otherwise stay near 0.' },
  { id: 'social', name: 'Social Sentiment', style: 'Read the social feed (recent YouTube video titles). Euphoric hype is a warning sign (lean short), capitulation and fear can mark bottoms (lean long). With no social data, signal 0 for everything.' },
  { id: 'skeptic', name: 'Skeptic', model: 'sonnet', huddleOnly: true, style: "You are the desk's realist. You see the team's first-round calls. Attack the weakest reasoning, flag groupthink and overconfidence, and point out what the team is ignoring (oversold bounces, crowded trades, stale news). Your own signals should be what a sober realist would actually bet." },
  { id: 'crowd', name: 'Crowd Watcher', model: 'sonnet', style: "Study what other traders are doing: the leaderboard's top performers' bias and biggest positions, and smart money vs the losing crowd. Follow the winners, fade the crowded losers." },
  { id: 'trend', name: 'Trend Follower', style: 'Go with the EMA20/50/200 stack: price above rising EMAs is long, below is short.' },
  { id: 'momentum', name: 'Momentum', style: 'Trade MACD histogram direction and RSI between 50 and 70 (long) or 30 and 50 (short).' },
  { id: 'meanrev', name: 'Mean Reverter', style: 'Fade extremes: RSI under 30 or price under the lower Bollinger band is long; RSI over 70 or above upper band is short.' },
  { id: 'vol', name: 'Volatility Scout', style: 'Narrow Bollinger bandwidth means a breakout is coming; lean in the direction of MACD. Wide bands: stay small.' },
  { id: 'contrarian', name: 'Contrarian', style: 'Bet against whatever the crowd-obvious read of the indicators is, but small.' },
  { id: 'risk', name: 'Risk Manager', style: 'Signal small and opposite to the riskiest-looking positions; protect capital above all.' },
  { id: 'swing', name: 'Swing Trader', style: 'Look for pullbacks within a trend: price near EMA20 in an uptrend is long, near EMA20 in a downtrend is short.' },
]

export type Idea = { asset: string; side: 'long' | 'short'; why: string }

export const SCOUT = {
  name: 'Trade Scout',
  style: 'You scout for the best trade setups ANYWHERE on Liquid, not just the desk markets: use the news catalysts, unusual-volume list, crowded positioning and top traders\' biggest positions.',
}

/** Bring a stored desk up to the current agent roster without losing learned weights. */
export function withAgents(d: Desk): Desk {
  const have = new Map(d.agents.map(a => [a.id, a]))
  const agents = AGENTS.map(a => have.get(a.id) ?? { id: a.id, weight: prior(a.id), signals: {}, score: 0, calls: 0, hits: 0, note: '' })
  if (!d.priorApplied) return { ...d, priorApplied: true, agents: agents.map(a => ({ ...a, weight: prior(a.id) })) }
  const total = agents.reduce((t, a) => t + a.weight, 0) || 1
  return { ...d, agents: agents.map(a => ({ ...a, weight: a.weight / total })) }
}

export function newDesk(now: number): Desk {
  return {
    priorApplied: true,
    isRunning: true,
    intervalMin: 15,
    cash: START_CASH,
    positions: {},
    prices: {},
    agents: AGENTS.map(a => ({ id: a.id, weight: prior(a.id), signals: {}, score: 0, calls: 0, hits: 0, note: '' })),
    ensemble: {},
    equityHistory: [{ t: now, equity: START_CASH }],
    log: [{ t: now, text: 'Desk opened with $10,000 paper cash. Live money is never touched automatically.' }],
    ticks: 0,
    lastTick: 0,
  }
}

export function equity(d: Desk, prices = d.prices): number {
  let e = d.cash
  for (const [s, qty] of Object.entries(d.positions)) e += qty * (prices[s] ?? 0)
  return e
}

/** Parse an agent's reply: a JSON object of symbol -> signal in [-1, 1], plus "note". */
export function parseSignals(text: string): { signals: Record<string, number>; note: string } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let obj: unknown
  try {
    obj = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const signals: Record<string, number> = {}
  for (const s of SYMBOLS) {
    const v = Number((obj as Record<string, unknown>)[s])
    if (Number.isFinite(v)) signals[s] = Math.max(-1, Math.min(1, v))
  }
  const note = String((obj as Record<string, unknown>).note ?? '').slice(0, 140)
  return { signals, note }
}

/** Training step (Hedge / multiplicative weights): reward each agent for how its last signals did. */
export function train(d: Desk, prices: Record<string, number>): Desk {
  if (d.ticks === 0) return d
  const agents = d.agents.map(a => {
    let reward = 0
    let calls = a.calls
    let hits = a.hits
    for (const s of SYMBOLS) {
      const sig = a.signals[s]
      const p0 = d.prices[s]
      const p1 = prices[s]
      if (sig === undefined || !p0 || !p1) continue
      const r = (p1 - p0) / p0
      reward += sig * r
      if (Math.abs(sig) > 0.1) {
        calls++
        if (Math.sign(sig) === Math.sign(r)) hits++
      }
    }
    return { ...a, calls, hits, score: a.score + reward, weight: a.weight * Math.exp(settingsOf(d).learnRate * reward) }
  })
  const total = agents.reduce((t, a) => t + a.weight, 0) || 1
  const floored = agents.map(a => ({ ...a, weight: Math.max(MIN_WEIGHT, a.weight / total) }))
  const t2 = floored.reduce((t, a) => t + a.weight, 0)
  return { ...d, agents: floored.map(a => ({ ...a, weight: a.weight / t2 })) }
}

/** Weighted vote of every agent's latest signal per symbol. */
export function vote(d: Desk, which: 'signals' | 'pending' = 'signals'): Record<string, number> {
  const out: Record<string, number> = {}
  const scale = settingsOf(d).agentScale
  for (const s of SYMBOLS) {
    let num = 0
    let den = 0
    for (const a of d.agents) {
      const sig = (which === 'pending' ? a.pending ?? a.signals : a.signals)[s]
      if (sig === undefined) continue
      const w = a.weight * (scale[a.id] ?? 1)
      num += w * sig
      den += a.weight
    }
    out[s] = den ? num / den : 0
  }
  return out
}

/** Rebalance the paper book toward the ensemble: each symbol gets up to 1/N of equity, long or short. */
/**
 * Volatility sizing (tested in the tune): scale each coin so its expected hourly move matches the calmest
 * coin's. vol is ATR(14)/price per coin; coins without a reading keep their plain vote.
 */
export function volScale(vol: Record<string, number>): Record<string, number> {
  const vs = Object.values(vol).filter(v => v > 0)
  if (!vs.length) return {}
  const calm = Math.min(...vs)
  return Object.fromEntries(Object.entries(vol).filter(([, v]) => v > 0).map(([s, v]) => [s, Math.min(1, calm / v) * VOL_BOOST]))
}

// Risk Officer: the coins move together, so all-short (or all-long) is one big bet. Cap the book's
// net long/short at 50% of equity. Walk-forward backtest, unseen period: median -2.67% -> -1.94%,
// worst 10% -5.83% -> -4.63%, median drawdown 4.68% -> 3.72% (costs some upside in good months).
export const NET_CAP = 0.5

export function rebalance(d: Desk, prices: Record<string, number>, ensemble: Record<string, number>, now: number, vol: Record<string, number> = {}): Desk {
  const scale = volScale(vol)
  const eq = equity(d, prices)
  const { exposure, minTrade } = settingsOf(d)
  const slot = (eq / SYMBOLS.length) * exposure
  const targets: Record<string, number> = {}
  for (const s of SYMBOLS) if (prices[s]) targets[s] = Math.max(-1, Math.min(1, (ensemble[s] ?? 0) * (scale[s] ?? 1))) * slot
  const net = Object.values(targets).reduce((t, v) => t + v, 0)
  const keep = Math.abs(net) > NET_CAP * eq ? (NET_CAP * eq) / Math.abs(net) : 1
  let cash = d.cash
  const positions = { ...d.positions }
  const log = [...d.log]
  if (keep < 1) log.push({ t: now, text: `Risk Officer: every bet pointed the same way, trimmed the book ${Math.round((1 - keep) * 100)}%` })
  for (const s of SYMBOLS) {
    const p = prices[s]
    if (!p || targets[s] === undefined) continue
    const target = targets[s]! * keep
    const current = (positions[s] ?? 0) * p
    const delta = target - current
    if (Math.abs(delta) < eq * minTrade) continue // skip trades too small to beat their fees
    cash -= delta + Math.abs(delta) * FEE
    positions[s] = target / p
    log.push({ t: now, text: `${delta > 0 ? 'BUY ' : 'SELL'} ${s} $${Math.abs(delta).toFixed(0)} @ ${p} (paper)` })
  }
  return { ...d, cash, positions, log, riskTrim: 1 - keep }
}

export function addEquityPoint(d: Desk, prices: Record<string, number>, now: number): Desk {
  return { ...d, equityHistory: [...d.equityHistory, { t: now, equity: equity(d, prices) }].slice(-500) }
}

export function trimLog(d: Desk): Desk {
  return { ...d, log: d.log.slice(-200) }
}

/** Strip the long redirect links out of the news text so agents get headlines, not URLs. */
export function cleanNews(text: string): string {
  return text.replace(/\s*\(https?:\/\/[^)]*\)/g, '').slice(0, 4000)
}

export function parseIdeas(text: string): Idea[] {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return []
  try {
    const ideas = (JSON.parse(m[0]) as { ideas?: unknown }).ideas
    if (!Array.isArray(ideas)) return []
    return ideas
      .filter((i): i is Idea => !!i && typeof i.asset === 'string' && (i.side === 'long' || i.side === 'short'))
      .slice(0, 5)
      .map(i => ({ asset: i.asset.slice(0, 20), side: i.side, why: String(i.why ?? '').slice(0, 160) }))
  } catch {
    return []
  }
}

export function scoutPrompt(markets: Market[], intel: string, memo = ''): string {
  return [
    SCOUT.style,
    '',
    'Desk market indicators (JSON):', JSON.stringify(markets),
    ...(memo ? ['', 'From the Head AI:', memo] : []),
    '', 'Market intel:', intel,
    '',
    'Think it through carefully, then reply with ONLY a JSON object: {"ideas":[{"asset":"SYMBOL","side":"long"|"short","why":"one sentence citing the evidence"}]} with your 1-5 best setups, strongest first. Use Liquid symbols as they appear in the intel.',
  ].join('\n')
}

/**
 * The shared part comes first and is marked for the prompt cache: every round-1 agent sends the same
 * market data, intel and Head AI memo, so after the first call the rest read it from cache.
 * The agent's own role (and any data only it needs) comes last.
 */
export function agentPrompt(style: string, markets: Market[], intel = '', memo = '', extra = ''): ModelTextBlock[] {
  const shared = [
    'You are one analyst on an AI trading desk. Your style is given at the end.',
    '',
    'Latest 1h indicators per market (JSON):',
    JSON.stringify(markets),
    ...(intel ? ['', 'Market intel (news, crowd positioning, top traders):', intel] : []),
    ...(memo ? ['', 'From the Head AI (desk brief and lessons from past losses — take them seriously):', memo] : []),
    '',
    `Reply with ONLY a JSON object: a signal from -1 (strong short) to 1 (strong long) for each of ${SYMBOLS.join(', ')}, and a "note" under 120 characters explaining your main call.`,
    'Example: {"BTC":0.3,"ETH":-0.2,"SOL":0,"HYPE":0.1,"note":"BTC holding EMA50"}',
  ].join('\n')
  return [{ text: shared, cache: true }, { text: `Your style: ${style}${extra ? `\n\n${extra}` : ''}` }]
}

/** Tiny ASCII sparkline of equity. */
export function sparkline(values: number[], width = 40): string {
  const v = values.slice(-width)
  if (v.length < 2) return ''
  const lo = Math.min(...v)
  const hi = Math.max(...v)
  const bars = '▁▂▃▄▅▆▇█'
  return v.map(x => bars[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)]).join('')
}

// ---------- Head AI: reviews each period, learns from losses, tunes settings ----------

export const CHIEF = { name: 'Head AI', model: 'sonnet' as const }

/** What happened since the last rebalance: paper P&L per coin and how each agent's committed calls did. */
export function periodReport(d: Desk, prices: Record<string, number>, now: number): PeriodReport | null {
  const base = d.basePrices
  if (!base || !d.lastRebalance) return null
  const bySymbol: Record<string, number> = {}
  let pnl = 0
  for (const s of SYMBOLS) {
    const p0 = base[s]
    const p1 = prices[s]
    if (!p0 || !p1) continue
    bySymbol[s] = (d.positions[s] ?? 0) * (p1 - p0)
    pnl += bySymbol[s]!
  }
  const agents = d.agents.map(a => {
    let reward = 0
    const wrong: string[] = []
    for (const s of SYMBOLS) {
      const sig = a.signals[s]
      const p0 = base[s]
      const p1 = prices[s]
      if (sig === undefined || !p0 || !p1) continue
      const r = (p1 - p0) / p0
      reward += sig * r
      if (Math.abs(sig) > 0.1 && Math.sign(sig) !== Math.sign(r)) wrong.push(s)
    }
    return { id: a.id, reward, wrong }
  })
  return { t: now, pnl, bySymbol, agents }
}

export const hadLoss = (r: PeriodReport) => r.pnl < 0 || Object.values(r.bySymbol).some(v => v < 0)

/** What every agent reads each cycle: the Head AI's latest brief and its most recent lessons. */
export function memo(d: Desk): string {
  const lines: string[] = []
  if (d.mood) lines.push(`Market mood: ${MOODS[d.mood].label} (${MOODS[d.mood].hint})`)
  if (d.chief?.brief) lines.push(`Brief: ${d.chief.brief}`)
  for (const l of (d.lessons ?? []).slice(-6)) lines.push(`Lesson: ${l.text}`)
  return lines.join('\n')
}

export function chiefPrompt(d: Desk, report: PeriodReport): string {
  const name = (id: string) => AGENTS.find(a => a.id === id)?.name ?? id
  return [
    'You are the Head AI of an AI paper-trading desk. Your job: minimise losses and learn from every one.',
    'Each period the agents vote, the book rebalances every 12h (sized by volatility), and you review what happened.',
    '',
    `Period P&L: $${report.pnl.toFixed(2)} on equity $${equity(d).toFixed(0)}. By coin: ${JSON.stringify(report.bySymbol)}`,
    'Agents (reward = signal x return; wrong = coins called the wrong way):',
    ...report.agents.map(a => {
      const ag = d.agents.find(x => x.id === a.id)
      return `- ${name(a.id)} [${a.id}] weight ${((ag?.weight ?? 0) * 100).toFixed(1)}% reward ${a.reward.toFixed(4)} wrong ${a.wrong.join(',') || 'none'} | said: ${ag?.note ?? ''}`
    }),
    '',
    `Current settings: ${JSON.stringify(settingsOf(d))}`,
    `Limits: exposure ${LIMITS.exposure.join('-')} (fraction of the tested position size), learnRate ${LIMITS.learnRate.join('-')}, minTrade ${LIMITS.minTrade.join('-')} (fraction of equity), agentScale ${LIMITS.agentScale.join('-')} per agent id (0 mutes, 1 normal).`,
    `Past lessons: ${(d.lessons ?? []).slice(-10).map(l => l.text).join(' | ') || 'none yet'}`,
    '',
    'Reply with ONLY a JSON object:',
    '{"brief": "<=200 chars, what the team should focus on next period; every agent reads this",',
    ' "lesson": "<=200 chars: if anything lost money, the concrete cause and what to do differently; else empty",',
    ' "settings": {"exposure": n, "learnRate": n, "minTrade": n, "agentScale": {"<agent id>": n}},',
    ' "codeProposal": "empty unless a settings change cannot fix a repeated problem: then describe the code change in plain words"}',
    'Cut exposure after losses and raise it back gradually when calls are working. Do not overreact to one small period.',
  ].join('\n')
}

export function parseChief(text: string, base: Settings): { brief: string; lesson: string; settings: Settings; codeProposal: string } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>
    return {
      brief: String(o.brief ?? '').slice(0, 240),
      lesson: String(o.lesson ?? '').slice(0, 240),
      settings: clampSettings(o.settings, base),
      codeProposal: String(o.codeProposal ?? '').slice(0, 1000),
    }
  } catch {
    return null
  }
}

// ---------- Huddle: agents read each other's calls, the Skeptic challenges, everyone may revise ----------

export type Call = { signals: Record<string, number>; note: string }

export function huddleDigest(calls: Record<string, Call>): string {
  const name = (id: string) => AGENTS.find(a => a.id === id)?.name ?? id
  return Object.entries(calls)
    .map(([id, c]) => `${name(id)}: ${SYMBOLS.map(s => `${s} ${(c.signals[s] ?? 0).toFixed(2)}`).join(' ')} | ${c.note}`)
    .join('\n')
}

export function huddlePrompt(style: string, mine: Call, digest: string, challenge: string): string {
  return [
    'You are one analyst on an AI trading desk, in the team huddle. Your style:', style,
    '', `Your first call: ${JSON.stringify(mine.signals)} (${mine.note})`,
    '', "The team's first-round calls:", digest,
    '', `The Skeptic's challenge: ${challenge || 'none'}`,
    '', 'Keep your call or revise it if a teammate or the Skeptic showed you something real. Do not just follow the majority.',
    `Reply with ONLY a JSON object with a signal from -1 to 1 for each of ${SYMBOLS.join(', ')} and a "note" under 120 characters saying what you kept or changed and why.`,
  ].join('\n')
}

export function skepticPrompt(style: string, markets: Market[], intel: string, digest: string): string {
  return [
    style,
    '', 'Desk market indicators (JSON):', JSON.stringify(markets),
    ...(intel ? ['', 'Market intel:', intel] : []),
    '', "The team's first-round calls:", digest,
    '', `Reply with ONLY a JSON object: your own signal from -1 to 1 for each of ${SYMBOLS.join(', ')}, and a "note" under 200 characters: your sharpest challenge to the team.`,
  ].join('\n')
}

export function reporterPrompt(digest: string, ensemble: Record<string, number>, revised: number, challenge: string): string {
  return [
    "You are the desk's Reporter. Write for the desk's owner, who is not a professional trader.",
    '', "Final team calls after the huddle:", digest,
    '', `Weighted team vote (-1 short .. 1 long): ${JSON.stringify(ensemble)}`,
    `Agents who changed their mind in the huddle: ${revised}. Skeptic's challenge: ${challenge || 'none'}`,
    '', 'In at most 3 short plain sentences: what the team thinks, where it disagrees, and the main risk. No jargon, no advice to trade real money.',
  ].join('\n')
}

// ---------- Cost tracker (tokens per model; dollars come from the session's own estimate) ----------

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

export function addUsage(t: Record<string, { calls: number; input: number; output: number; cached: number; created?: number }>, model: string, u: Usage | undefined) {
  const row = (t[model] ??= { calls: 0, input: 0, output: 0, cached: 0 })
  row.calls++
  row.input += u?.input_tokens ?? 0
  row.output += u?.output_tokens ?? 0
  row.cached += u?.cache_read_input_tokens ?? 0
  row.created = (row.created ?? 0) + (u?.cache_creation_input_tokens ?? 0)
  return t
}

export function mergeTally<T extends Record<string, { calls: number; input: number; output: number; cached: number; created?: number }>>(a: T, b: T): T {
  const out = structuredClone(a)
  for (const [m, r] of Object.entries(b)) {
    const row = ((out as Record<string, typeof r>)[m] ??= { calls: 0, input: 0, output: 0, cached: 0 })
    row.calls += r.calls
    row.input += r.input
    row.output += r.output
    row.cached += r.cached
    row.created = (row.created ?? 0) + (r.created ?? 0)
  }
  return out
}

// ---------- Social scan ----------

/** Titles from a YouTube Data API search response, newest first. */
export function parseYouTube(text: string): string[] {
  try {
    const items = (JSON.parse(text) as { items?: { snippet?: { title?: string; channelTitle?: string } }[] }).items ?? []
    return items.map(i => `${i.snippet?.title ?? ''} — ${i.snippet?.channelTitle ?? ''}`.slice(0, 160)).filter(t => t.length > 3)
  } catch {
    return []
  }
}

// ---------- Market mood (BTC 1h: RSI, EMA50/200, lower Bollinger band) ----------

export const MOODS: Record<Mood, { label: string; hint: string }> = {
  trend: { label: 'Trending', hint: 'a clear direction; trend calls tend to work' },
  chop: { label: 'Choppy', hint: 'no clear direction; expect fake moves' },
  panic: { label: 'Panicky', hint: 'oversold or breaking down hard; sharp bounces are common' },
}

export function moodOf(m: Market | undefined): Mood | undefined {
  const i = m?.indicators as { rsi14?: number; ema?: { ema50?: number; ema200?: number }; bollinger?: { lower?: number } } | undefined
  if (!m || !i?.rsi14 || !i.ema?.ema50 || !i.ema.ema200) return undefined
  if (i.rsi14 < 30 || (i.bollinger?.lower && m.price < i.bollinger.lower)) return 'panic'
  return Math.abs(i.ema.ema50 - i.ema.ema200) / m.price > 0.015 ? 'trend' : 'chop'
}

// ---------- Alert Bot ----------

export const ALERT_QUIET_MS = 6 * 3600_000 // one alert of a kind per 6h at most

/** What changed between two desk states that the owner should hear about, without opening the pane. */
export function alertsFor(before: Desk, after: Desk, now: number): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  const eq = equity(after)
  const r = after.lastReport
  if (r && r.t !== before.lastReport?.t && r.pnl < -0.01 * eq) out.push({ key: 'loss', text: `Practice book lost $${Math.abs(r.pnl).toFixed(0)} last period. The Head AI is reviewing it.` })
  const peak = Math.max(...after.equityHistory.map(p => p.equity))
  if (peak > 0 && eq < peak * 0.95) out.push({ key: 'drawdown', text: `Practice book is ${((1 - eq / peak) * 100).toFixed(1)}% below its peak.` })
  const e0 = settingsOf(before).exposure
  const e1 = settingsOf(after).exposure
  if (e1 < e0) out.push({ key: 'risk', text: `Head AI cut bet size to ${Math.round(e1 * 100)}%: ${after.chief?.brief ?? ''}`.slice(0, 200) })
  const avg = (x: Desk) => SYMBOLS.reduce((t, s) => t + (x.ensemble[s] ?? 0), 0) / SYMBOLS.length
  if (Math.abs(avg(after)) > 0.5 && Math.abs(avg(before)) <= 0.5) out.push({ key: 'strong', text: `Strong team call: crypto expected to ${avg(after) > 0 ? 'rise' : 'fall'}.` })
  if (after.mood === 'panic' && before.mood !== 'panic') out.push({ key: 'panic', text: 'Market mood turned panicky: sharp moves both ways are likely.' })
  const last = new Map((after.alerts ?? []).map(a => [a.key, a.t]))
  return out.filter(a => !last.has(a.key) || now - last.get(a.key)! >= ALERT_QUIET_MS)
}

/**
 * The full AI team (~30 calls) only matters when the book trades, every 12h. Scheduled checks in between
 * just refresh prices, mood and alerts with no AI calls. A trade-due check, or a desk with no votes yet, thinks.
 */
export function shouldThink(d: Desk, now: number): boolean {
  return isRebalanceDue(d, now) || d.agents.every(a => !a.pending || Object.keys(a.pending).length === 0)
}

// ---------- Improver: keeps a ranked list of ways to make the desk better ----------

// Thinks after every full team meeting and on every alert, but at most once an hour (one Sonnet call, two if it brainstorms).
export const IMPROVER = { name: 'Improver', model: 'sonnet' as const, minGapMs: 3600_000, maxConsult: 3 }

/** Facts only: what the desk has actually done, so ideas come from evidence rather than guesses. */
export function improverPrompt(d: Desk, talk: Talk[] = []): string {
  const name = (id: string) => AGENTS.find(a => a.id === id)?.name ?? id
  const ranked = [...d.agents].sort((a, b) => b.weight - a.weight)
  const tokens = Object.entries(d.costs?.total ?? {}).map(([m, r]) => `${m}: ${r.calls} calls, ${r.input + r.output} tokens, ${r.cached} cached`)
  return [
    "You are the Improver on an AI paper-trading desk. Your only job: find what would make the desk lose less, earn more, or cost less, and rank it.",
    '',
    `Equity $${equity(d).toFixed(0)} from $${START_CASH}. Checks run: ${d.ticks}. Market mood: ${d.mood ?? 'unknown'}.`,
    `Settings: ${JSON.stringify(settingsOf(d))}. Risk Officer trimmed ${Math.round((d.riskTrim ?? 0) * 100)}% at the last trade.`,
    `Last period: ${d.lastReport ? `P&L $${d.lastReport.pnl.toFixed(2)} ${JSON.stringify(d.lastReport.bySymbol)}` : 'none yet'}`,
    'Agents (say = vote weight, right = hit rate on committed calls):',
    ...ranked.map(a => `- ${name(a.id)}: say ${(a.weight * 100).toFixed(1)}%, right ${a.calls ? Math.round((a.hits / a.calls) * 100) : '?'}% of ${a.calls}`),
    `Lessons from losses: ${(d.lessons ?? []).slice(-10).map(l => l.text).join(' | ') || 'none yet'}`,
    `Recent alerts: ${(d.alerts ?? []).slice(-5).map(a => a.text).join(' | ') || 'none'}`,
    `AI usage: ${tokens.join('; ') || 'none yet'}. Social feed: ${d.social?.status ?? 'unknown'}.`,
    `Your previous list: ${(d.backlog?.items ?? []).map(i => i.title).join(' | ') || 'none'}`,
    '',
    'Already tested on price history and rejected, do not propose again: per-coin stop losses, mood-based agent weights, learning faster than rate 40, learning every hour, rebalancing more often than 12h, cutting the chart team below 7 agents, minTrade above 8%, hand-capping or boosting agents on a few periods of hit rates (the learning already reweights them; a few periods are noise).',
    'Never propose placing real trades automatically or giving the desk write access to the trading account.',
    '',
    ...(talk.length
      ? ['', 'You asked teammates for input. Their answers:', ...talk.map(t => `- ${t.who} (asked: ${t.q}): ${t.a}`), '', 'Use what holds up; ignore what does not. This is your final list: leave "consult" empty.']
      : ['', `If you need a teammate's view before deciding, add up to ${IMPROVER.maxConsult} entries to "consult" with their id and one question. Ids: ${[...AGENTS.map(a => a.id), 'chief'].join(', ')} (chief = Head AI). Only consult when it would change your list.`]),
    '',
    'Reply with ONLY a JSON object: {"ideas":[{"title":"<=80 chars","why":"<=200 chars citing the numbers above","kind":"setting"|"agent"|"code","impact":"high"|"medium"|"low"}], "consult":[{"id":"<agent id>","question":"<=200 chars"}]} with 1-5 ideas, best first. Prefer ideas that can be tested on past prices.',
  ].join('\n')
}

export function parseImprover(text: string): { ideas: Idea2[]; consult: { id: string; question: string }[] } {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { ideas: [], consult: [] }
  try {
    const o = JSON.parse(m[0]) as { ideas?: unknown; consult?: unknown }
    const ids = new Set([...AGENTS.map(a => a.id), 'chief'])
    const consult = (Array.isArray(o.consult) ? o.consult : [])
      .filter((c): c is { id: string; question: string } => !!c && ids.has(c.id) && typeof c.question === 'string' && c.question.length > 0)
      .slice(0, IMPROVER.maxConsult)
      .map(c => ({ id: c.id, question: c.question.slice(0, 240) }))
    const ideas = o.ideas
    if (!Array.isArray(ideas)) return { ideas: [], consult }
    const kinds = ['setting', 'agent', 'code']
    const impacts = ['high', 'medium', 'low']
    return {
      consult,
      ideas: ideas
        .filter((i): i is Idea2 => !!i && typeof i.title === 'string' && kinds.includes(i.kind) && impacts.includes(i.impact))
        .slice(0, 5)
        .map(i => ({ title: i.title.slice(0, 100), why: String(i.why ?? '').slice(0, 240), kind: i.kind, impact: i.impact })),
    }
  } catch {
    return { ideas: [], consult: [] }
  }
}

/** A teammate answers the Improver from its own specialty and its own record on the desk. */
export function brainstormPrompt(d: Desk, id: string, question: string): string {
  const def = AGENTS.find(a => a.id === id)
  const me = d.agents.find(a => a.id === id)
  const role = id === 'chief'
    ? `You are the Head AI of the desk. Recent lessons: ${(d.lessons ?? []).slice(-5).map(l => l.text).join(' | ') || 'none'}. Settings: ${JSON.stringify(settingsOf(d))}.`
    : `You are the ${def?.name ?? id} on the desk. Your style: ${def?.style ?? ''} Your record: say ${((me?.weight ?? 0) * 100).toFixed(1)}%, right ${me?.calls ? Math.round((me.hits / me.calls) * 100) : '?'}% of ${me?.calls ?? 0} calls. Your latest note: ${me?.note ?? ''}`
  return [
    role,
    '', `The desk's Improver is brainstorming how to make the desk better and asks you: ${question}`,
    '', 'Answer honestly in at most 3 short sentences from your specialty. Say so if you think the idea is wrong.',
  ].join('\n')
}

export const agentName = (id: string) => (id === 'chief' ? 'Head AI' : AGENTS.find(a => a.id === id)?.name ?? id)

// ---------- Plugin Scout: plugins and skills from the directory that could help this desk ----------

export const PLUGIN_SCOUT = {
  name: 'Plugin Scout',
  everyMs: 24 * 3600_000,
  keywords: ['crypto trading', 'market data', 'technical analysis', 'backtesting', 'risk management', 'social sentiment', 'on-chain analytics', 'trading signals'],
}

export function pluginScoutPrompt(d: Desk, listings: Listing[]): string {
  const gaps = [
    d.social?.items.length ? '' : 'no social media data (YouTube key missing; TikTok/Instagram not possible)',
    'no on-chain or whale data',
    'no economic calendar',
    'trading math is hand-written',
  ].filter(Boolean)
  return [
    "You are the desk's Plugin Scout. The desk is an AI paper-trading team for BTC, ETH, SOL and HYPE using Liquid market data, news, crowd positioning and daily charts.",
    `Its known gaps: ${gaps.join('; ')}.`,
    '',
    'Plugins and skills found in the directory (id | name | kind | installed? | description):',
    ...listings.map(l => `${l.id} | ${l.name} | ${l.kind} | ${l.enabled ? 'installed' : 'not installed'} | ${l.description.slice(0, 220)}`),
    '',
    'Pick at most 5 that would genuinely help THIS desk (fill a gap, add a data source, check its math). Skip generic accounting or finance-office tools, and anything already installed.',
    'Reply with ONLY a JSON object: {"picks":[{"id":"<id from the list>","why":"<=160 chars: which gap it fills","fit":"high"|"medium"|"low"}]}, best first. Empty list if nothing fits.',
  ].join('\n')
}

export function parsePluginPicks(text: string, listings: Listing[], prevSeen: string[], now: number, prev: PluginPick[] = []): PluginPick[] {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return []
  try {
    const picks = (JSON.parse(m[0]) as { picks?: unknown }).picks
    if (!Array.isArray(picks)) return []
    const byId = new Map(listings.map(l => [l.id, l]))
    const fits = ['high', 'medium', 'low']
    return picks
      .filter((p): p is { id: string; why: string; fit: PluginPick['fit'] } => !!p && byId.has(p.id) && fits.includes(p.fit) && !byId.get(p.id)!.enabled)
      .slice(0, 5)
      .map(p => {
        const l = byId.get(p.id)!
        const firstSeen = prev.find(x => x.id === p.id)?.firstSeen ?? (prevSeen.includes(p.id) ? 0 : now)
        return { id: p.id, name: l.name, kind: l.kind, why: String(p.why ?? '').slice(0, 200), fit: p.fit, firstSeen }
      })
  } catch {
    return []
  }
}

/**
 * Each agent's own scorecard, read before every call so it can correct its own habits:
 * its say, hit rate, and which coins it called wrong last period.
 */
export function scorecard(d: Desk, id: string): string {
  const a = d.agents.find(x => x.id === id)
  if (!a || !a.calls) return 'Your record: no scored calls yet.'
  const last = d.lastReport?.agents.find(x => x.id === id)
  const rate = Math.round((a.hits / a.calls) * 100)
  return [
    `Your record: right ${rate}% of ${a.calls} scored calls; your vote counts ${(a.weight * 100).toFixed(1)}% on the desk (earned from results).`,
    last ? (last.wrong.length ? `Last period you called ${last.wrong.join(', ')} the wrong way. Ask yourself why before repeating that call.` : 'Last period none of your calls went the wrong way.') : '',
    rate < 45 ? 'You are below a coin flip: be more selective and use 0 when your setup is not clearly there.' : '',
  ].filter(Boolean).join(' ')
}

/**
 * The first round-1 call of each model, sent ahead of the rest. Cache entries are per model, and calls
 * sent all at once can't read an entry none of them has written yet (measured: 0 cached of ~1.1M tokens).
 */
export function cacheWarmers<T extends { model?: string }>(agents: readonly T[]): T[] {
  const seen = new Set<string>()
  return agents.filter(a => {
    const m = a.model ?? 'haiku'
    if (seen.has(m)) return false
    seen.add(m)
    return true
  })
}

/** An agent with nothing to read sits out: no AI call, and no zero vote diluting the others. */
export const isIdle = (d: Desk, id: string) => id === 'social' && !d.social?.items.length
