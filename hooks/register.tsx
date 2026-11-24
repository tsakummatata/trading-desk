import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelTextBlock, Register } from 'claude-code'

import type { Desk, Listing, Market, ModelTally, Talk } from '../types'
import type { Call } from './desk'
import {
  AGENTS, SYMBOLS, START_CASH, addEquityPoint, agentPrompt, cleanNews, equity, newDesk,
  CHIEF, DEFAULT_SETTINGS, cacheWarmers, scorecard, IMPROVER, PLUGIN_SCOUT, parsePluginPicks, pluginScoutPrompt, agentName, brainstormPrompt, improverPrompt, parseImprover, MOODS, alertsFor, moodOf, addUsage, huddleDigest, huddlePrompt, mergeTally, parseYouTube, reporterPrompt, skepticPrompt, chiefPrompt, hadLoss, memo, parseChief, periodReport, settingsOf, isRebalanceDue, shouldThink, parseIdeas, parseSignals, rebalance, REBALANCE_MS, scoutPrompt, sparkline, train, trimLog, vote, withAgents,
} from './desk'

const PANE = 'trading-desk'
const STORE_KEY = 'desk-v1'
const MCP_SERVER = 'liquid_trade'
// Safety: the mod may only call these read-only market-data tools. $.mcp.call has no
// permission prompt, so order/execution tools must never appear here.
const READ_ONLY_TOOLS = ['get_technical_indicators', 'get_news', 'get_positioning_pulse', 'leaderboard_data', 'analyze_market'] as const
type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number]

async function readTool($: EngineInterface, tool: ReadOnlyTool, args: Record<string, unknown>): Promise<string | null> {
  const r = await $.mcp.call(MCP_SERVER, tool, args)
  const block = r.content.find(c => c.type === 'text') as { text?: string } | undefined
  return r.isError || !block?.text ? null : block.text
}

/** News, crowd positioning, top traders and per-market smart money, as one text block for the agents. */
async function gatherIntel($: EngineInterface): Promise<string> {
  const safe = (p: Promise<string | null>) => p.catch(() => null)
  const [news, pulse, board, ...smart] = await Promise.all([
    safe(readTool($, 'get_news', {})),
    safe(readTool($, 'get_positioning_pulse', { limit: 8 })),
    safe(readTool($, 'leaderboard_data', { duration: '7D', limit: 15 })),
    ...SYMBOLS.map(sym => safe(readTool($, 'analyze_market', { symbol: sym }))),
  ])
  const field = (text: string, key: string): unknown => {
    try {
      return (JSON.parse(text) as Record<string, unknown>)[key]
    } catch {
      return undefined
    }
  }
  const parts: string[] = []
  if (news) parts.push('NEWS:\n' + cleanNews(String(field(news, 'text') ?? news)))
  if (pulse) parts.push('CROWD POSITIONING:\n' + String(field(pulse, 'text') ?? pulse))
  if (board) {
    const rows = (field(board, 'entries') ?? []) as { rank: number; pnl: number; long_percentage?: number; biggest_position_asset?: string }[]
    // Trader names and wallets are left out on purpose: the agents need the positioning only.
    parts.push('TOP TRADERS (7D pnl):\n' + rows.map(r => `#${r.rank} pnl $${Math.round(r.pnl)} long ${r.long_percentage ?? '?'}% biggest ${r.biggest_position_asset ?? 'hidden'}`).join('\n'))
  }
  smart.forEach((m, i) => {
    const line = m ? field(m, 'smartMoney') : undefined
    if (typeof line === 'string') parts.push(`${SYMBOLS[i]} SMART MONEY: ${line}`)
    // Funding, 24h move and value near liquidation, for the Liquidity Hunter.
    const t = m ? (field(m, 'ticker') as Record<string, string> | undefined) : undefined
    const seg = m ? ((field(m, 'sections') as { size?: { breakdownBySize?: { valueCloseToLiquidation?: number; totalPositionValue?: number }[] } } | undefined)?.size?.breakdownBySize ?? []) : []
    const nearLiq = seg.reduce((s, r) => s + (r.valueCloseToLiquidation ?? 0), 0)
    const longBias = seg.reduce((s, r) => s + (r.totalPositionValue ?? 0), 0)
    if (t) parts.push(`${SYMBOLS[i]} LEVERAGE: funding ${t.funding} 24h ${t.change24h} OI ${t.openInterest} near-liquidation $${Math.round(nearLiq).toLocaleString('en-US')} of $${Math.round(longBias).toLocaleString('en-US')} open`)
  })
  const social = await socialFeed($)
  parts.push(social.items.length ? 'SOCIAL (recent YouTube titles):\n' + social.items.join('\n') : `SOCIAL: none (${social.status})`)
  return parts.join('\n\n')
}

/** Recent crypto YouTube titles via the official Data API, cached for an hour. The key is added by the network proxy. */
async function socialFeed($: EngineInterface): Promise<{ status: string; items: string[] }> {
  const cached = (await read($, desk)).social
  if (cached && Date.now() - cached.t < SOCIAL_EVERY_MS) return cached
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  let social: { t: number; status: string; items: string[] }
  try {
    const r = await $.http.fetch(`${YOUTUBE}&publishedAfter=${encodeURIComponent(since)}`)
    const items = r.ok ? parseYouTube(r.text) : []
    social = { t: Date.now(), status: r.ok ? `YouTube: ${items.length} videos` : r.status === 403 || r.status === 400 ? 'YouTube: no API key set' : `YouTube error ${r.status}`, items }
  } catch {
    social = { t: Date.now(), status: 'YouTube unreachable', items: [] }
  }
  await update($, desk, d => ({ ...d, social }))
  return social
}

const desk = atom({ plugin: 'trading-desk', key: 'desk' } as const, newDesk(0), { shape: 'desk-1' })
const busy = atom({ plugin: 'trading-desk', key: 'busy' } as const, false)
const showAll = atom({ plugin: 'trading-desk', key: 'showAll' } as const, false)
const tabAtom = atom({ plugin: 'trading-desk', key: 'tab' } as const, 'overview')
const SOCIAL_EVERY_MS = 3600_000 // a YouTube search costs 100 of the API's 10,000 daily quota units
const YOUTUBE = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=20&q=' + encodeURIComponent('bitcoin|ethereum|solana|hyperliquid crypto')

let timer: { cancel: () => void } | undefined

async function fetchMarket($: EngineInterface, symbol: string): Promise<Market | null> {
  const text = await readTool($, 'get_technical_indicators', { symbol, interval: '1h' })
  if (!text) return null
  try {
    const j = JSON.parse(text)
    const atr = Number(j.indicators?.atr14)
    return Number.isFinite(j.currentPrice)
      ? { symbol, price: j.currentPrice, indicators: j.indicators, vol: atr > 0 ? atr / j.currentPrice : undefined }
      : null
  } catch {
    return null
  }
}

async function log($: EngineInterface, text: string) {
  await update($, desk, d => trimLog({ ...d, log: [...d.log, { t: Date.now(), text }] }))
}

/** One desk cycle: fetch data -> train on last cycle's outcome -> every agent votes -> rebalance paper book. */
/** One check. `force` (Check now, run_cycle) always runs the full team; scheduled checks think only when due. */
async function tick($: EngineInterface, force = false) {
  if (await read($, busy)) return
  await $.state.set({ plugin: 'trading-desk', key: 'busy' }, true)
  try {
    const markets = (await Promise.all(SYMBOLS.map(s => fetchMarket($, s).catch(() => null)))).filter(
      (m): m is Market => m !== null,
    )
    if (markets.length === 0) {
      await log($, `No market data: is the ${MCP_SERVER} connector connected? (/mcp)`)
      return
    }
    const prices = Object.fromEntries(markets.map(m => [m.symbol, m.price]))
    const vol = Object.fromEntries(markets.filter(m => m.vol).map(m => [m.symbol, m.vol!]))

    const mood = moodOf(markets.find(m => m.symbol === 'BTC'))
    await update($, desk, x => ({ ...x, mood: mood ?? x.mood }))
    const before = await read($, desk)
    if (!force && !shouldThink(before, Date.now())) {
      // Quick check: no AI. Mark the book to market, keep the chart moving, raise any alerts.
      const t = Date.now()
      await update($, desk, x => trimLog(addEquityPoint({ ...x, prices: { ...x.prices, ...prices }, ticks: x.ticks + 1, lastTick: t }, prices, t)))
      if (await raiseAlerts($, before, t)) await improve($, 'an alert fired')
      const q = await read($, desk)
      await $.store.set(STORE_KEY, q)
      $.ui.status(`Desk ${equity(q) >= START_CASH ? '+' : ''}$${(equity(q) - START_CASH).toFixed(0)} (paper)`)
      return
    }
    const intel = await gatherIntel($).catch(() => '')
    const note = memo(before)
    const daily = await dailyCharts($)
    if (!intel) await log($, 'Intel unavailable this cycle (news/positioning); agents use indicators only.')
    const tally: Record<string, ModelTally> = {}
    const ask = async (model: 'haiku' | 'sonnet', prompt: string | ModelTextBlock[], maxTokens: number) => {
      const r = await $.model.complete({ model, prompt, maxTokens })
      addUsage(tally, model, r.usage)
      return r
    }
    const parse = (r: Awaited<ReturnType<typeof ask>> | undefined) => (r?.isAnswered ? parseSignals(r.text) : null)

    // Round 1: every agent and the Scout read the market on their own.
    const round1 = AGENTS.filter(a => !a.huddleOnly)
    const call = (a: (typeof round1)[number]) =>
      ask(a.model ?? 'haiku', agentPrompt(a.style, markets, intel, note, [scorecard(before, a.id), a.id === 'bigpicture' ? daily : ''].filter(Boolean).join('\n\n')), a.model ? 800 : 300)
    // One call per model writes the shared prompt cache first; the rest then read it at the cached rate.
    const warmers = cacheWarmers(round1)
    const warmed = new Map(warmers.map((a, i) => [a.id, i]))
    const warmReplies = await Promise.all(warmers.map(call))
    const [scout, ...rest] = await Promise.all([ask('sonnet', scoutPrompt(markets, intel, note), 1500), ...round1.filter(a => !warmed.has(a.id)).map(call)])
    let k = 0
    const r1 = round1.map(a => (warmed.has(a.id) ? warmReplies[warmed.get(a.id)!] : rest[k++]))
    const ideas = scout?.isAnswered ? parseIdeas(scout.text) : []
    const first: Record<string, Call> = {}
    round1.forEach((a, i) => {
      const p = parse(r1[i])
      if (p) first[a.id] = p
    })

    // Huddle: the Skeptic reads everyone's calls and challenges them; then each agent may revise.
    const skepticDef = AGENTS.find(a => a.id === 'skeptic')!
    const sk = parse(await ask('sonnet', skepticPrompt(skepticDef.style, markets, intel, huddleDigest(first)), 800))
    const digest = huddleDigest(sk ? { ...first, skeptic: sk } : first)
    const challenge = sk?.note ?? ''
    const r2 = await Promise.all(
      Object.entries(first).map(async ([id, mine]) => {
        const style = AGENTS.find(a => a.id === id)!.style
        return [id, parse(await ask('haiku', huddlePrompt(style, mine, digest, challenge), 250))] as const
      }),
    )
    const final: Record<string, Call> = { ...first, ...(sk ? { skeptic: sk } : {}) }
    let revised = 0
    for (const [id, p] of r2) {
      if (!p || !first[id]) continue
      if (SYMBOLS.some(s => Math.abs((p.signals[s] ?? 0) - (first[id]!.signals[s] ?? 0)) >= 0.1)) revised++
      final[id] = { signals: p.signals, note: p.note || first[id]!.note }
    }
    const now = Date.now()
    await update($, desk, d0 => {
      // Every cycle: agents re-read the market (pending signals) and the view updates.
      let d: Desk = {
        ...d0,
        agents: d0.agents.map(a => {
          const c = final[a.id]
          return c ? { ...a, pending: c.signals, note: c.note } : { ...a, pending: {}, note: 'no answer this cycle' }
        }),
      }
      d = { ...d, ensemble: vote(d, 'pending') }
      // Every 12h: score the signals committed last rebalance, commit the new ones, trade the paper book.
      if (isRebalanceDue(d, now)) {
        d = { ...d, lastReport: periodReport(d, prices, now) ?? d.lastReport }
        d = train({ ...d, prices: d.basePrices ?? {} }, prices)
        d = { ...d, agents: d.agents.map(a => ({ ...a, signals: a.pending ?? {} })) }
        d = rebalance(d, prices, vote(d), now, vol)
        d = { ...d, lastRebalance: now, basePrices: prices }
      }
      d = { ...d, prices: { ...d0.prices, ...prices }, ticks: d.ticks + 1, lastTick: now, ideas: ideas.length ? ideas : d.ideas }
      return trimLog(addEquityPoint(d, prices, now))
    })
    // The Reporter sums the cycle up in plain words for the owner.
    const rep = await ask('haiku', reporterPrompt(huddleDigest(final), (await read($, desk)).ensemble, revised, challenge), 300)
    await update($, desk, x => ({
      ...x,
      report: { t: now, text: rep.isAnswered ? rep.text.trim().slice(0, 600) : x.report?.text ?? '', challenge, revised },
      costs: { since: x.costs?.since ?? now, total: mergeTally(x.costs?.total ?? {}, tally), lastCycle: tally },
    }))
    if ((await read($, desk)).lastReport?.t === now) await review($)
    await raiseAlerts($, before, now)
    await improve($, 'after the team meeting')
    if (Date.now() - ((await read($, desk)).plugins?.t ?? 0) > PLUGIN_SCOUT.everyMs) await scoutPlugins($)
    const d = await read($, desk)
    await $.store.set(STORE_KEY, d)
    const pnl = equity(d) - START_CASH
    $.ui.status(`Desk ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (paper)`)
  } catch (err) {
    await log($, `Cycle failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await $.state.set({ plugin: 'trading-desk', key: 'busy' }, false)
  }
}

/** Head AI review of the last period: brief for the team, a lesson after any loss, bounded settings changes. */
async function review($: EngineInterface) {
  const d = await read($, desk)
  const report = d.lastReport
  if (!report) {
    await log($, `${CHIEF.name}: nothing to review until the first full period has run.`)
    return
  }
  const r = await $.model.complete({ model: CHIEF.model, prompt: chiefPrompt(d, report), maxTokens: 1200 })
  const t = addUsage({}, CHIEF.model, r.usage)
  await update($, desk, x => ({ ...x, costs: { since: x.costs?.since ?? Date.now(), total: mergeTally(x.costs?.total ?? {}, t), lastCycle: x.costs?.lastCycle ?? {} } }))
  const out = r.isAnswered ? parseChief(r.text, settingsOf(d)) : null
  if (!out) {
    await log($, `${CHIEF.name}: review failed this period.`)
    return
  }
  const now = Date.now()
  const lostMoney = hadLoss(report)
  await update($, desk, x => {
    const before = settingsOf(x)
    const changed = (['exposure', 'learnRate', 'minTrade'] as const).filter(k => before[k] !== out.settings[k])
    const log = [...x.log, { t: now, text: `${CHIEF.name}: ${out.brief}` }]
    if (changed.length) log.push({ t: now, text: `${CHIEF.name} set ${changed.map(k => `${k} ${before[k]}→${out.settings[k]}`).join(', ')}` })
    return trimLog({
      ...x,
      settings: out.settings,
      chief: { t: now, brief: out.brief, codeProposal: out.codeProposal },
      lessons: lostMoney && out.lesson ? [...(x.lessons ?? []), { t: now, text: out.lesson }].slice(-30) : x.lessons,
      log,
    })
  })
}

/**
 * Plugin Scout: search the plugin and skill directory (read-only) for anything that could help the desk,
 * and have a cheap model rank it against the desk's known gaps. It never installs anything.
 */
async function scoutPlugins($: EngineInterface) {
  const listings = new Map<string, Listing>()
  let failed = 0
  for (const kind of ['plugin', 'skill'] as const) {
    const r = await $.tool.call(kind === 'plugin' ? { tool: 'SearchPlugins', keywords: PLUGIN_SCOUT.keywords } : { tool: 'SearchSkills', keywords: PLUGIN_SCOUT.keywords }).catch(() => undefined)
    const rows = (r && 'result' in r ? (r.result as { results?: { id: string; name: string; display_name?: string | null; description?: string | null; enabled?: boolean | null }[] })?.results : undefined) ?? []
    if (!r || !('result' in r)) failed++
    for (const x of rows) listings.set(x.id, { id: x.id, name: x.display_name || x.name, description: x.description ?? '', kind, enabled: !!x.enabled })
  }
  const all = [...listings.values()]
  const d = await read($, desk)
  const prevSeen = d.plugins?.seen ?? []
  let picks = d.plugins?.picks ?? []
  let status = failed === 2 ? 'Directory search unavailable in this session' : `${all.length} listings checked`
  if (all.length) {
    const r = await $.model.complete({ model: 'haiku', prompt: pluginScoutPrompt(d, all), maxTokens: 800 })
    const t = addUsage({}, 'haiku', r.usage)
    picks = r.isAnswered ? parsePluginPicks(r.text, all, prevSeen, Date.now(), d.plugins?.picks) : picks
    await update($, desk, x => ({ ...x, costs: { since: x.costs?.since ?? Date.now(), total: mergeTally(x.costs?.total ?? {}, t), lastCycle: x.costs?.lastCycle ?? {} } }))
    const fresh = all.filter(l => !prevSeen.includes(l.id)).length
    if (prevSeen.length && fresh) status += ` · ${fresh} new since last scan`
  }
  await update($, desk, x => ({ ...x, plugins: { t: Date.now(), status, picks, seen: [...new Set([...prevSeen, ...all.map(l => l.id)])].slice(-500) } }))
  await log($, `${PLUGIN_SCOUT.name}: ${status}${picks.length ? `, top pick ${picks[0]!.name}` : ''}`)
}

let improving = false

/**
 * Improver: draft a ranked list from what the desk has actually done; if it asks, up to 3 teammates answer
 * its questions, and it finalizes with their input. Event-driven (team meetings, alerts, the button), at most hourly
 * unless `force` (the button).
 */
async function improve($: EngineInterface, why: string, force = false) {
  const d0 = await read($, desk)
  if (improving || (!force && Date.now() - (d0.backlog?.t ?? 0) < IMPROVER.minGapMs)) return
  improving = true
  try {
    const tally: Record<string, ModelTally> = {}
    const draftR = await $.model.complete({ model: IMPROVER.model, prompt: improverPrompt(d0), maxTokens: 1500 })
    addUsage(tally, IMPROVER.model, draftR.usage)
    let out = draftR.isAnswered ? parseImprover(draftR.text) : { ideas: [], consult: [] }
    const talk: Talk[] = []
    if (out.consult.length) {
      const answers = await Promise.all(
        out.consult.map(async c => {
          const model = c.id === 'chief' ? CHIEF.model : AGENTS.find(a => a.id === c.id)?.model ?? 'haiku'
          const r = await $.model.complete({ model, prompt: brainstormPrompt(d0, c.id, c.question), maxTokens: 300 })
          addUsage(tally, model, r.usage)
          return { who: agentName(c.id), q: c.question, a: r.isAnswered ? r.text.trim().slice(0, 400) : '(no answer)' }
        }),
      )
      talk.push(...answers)
      const finalR = await $.model.complete({ model: IMPROVER.model, prompt: improverPrompt(d0, talk), maxTokens: 1500 })
      addUsage(tally, IMPROVER.model, finalR.usage)
      const final = finalR.isAnswered ? parseImprover(finalR.text) : null
      if (final?.ideas.length) out = final
    }
    await update($, desk, x => ({
      ...x,
      backlog: out.ideas.length ? { t: Date.now(), items: out.ideas, why, talk } : x.backlog,
      costs: { since: x.costs?.since ?? Date.now(), total: mergeTally(x.costs?.total ?? {}, tally), lastCycle: x.costs?.lastCycle ?? {} },
    }))
    await log(
      $,
      out.ideas.length
        ? `${IMPROVER.name} (${why})${talk.length ? `, after asking ${talk.map(t => t.who).join(', ')}` : ''}: top idea ${out.ideas[0]!.title}`
        : `${IMPROVER.name}: no usable ideas this time.`,
    )
  } finally {
    improving = false
  }
}

/** Daily-chart indicators for the Big-Picture Analyst; daily candles barely move within an hour, so cache. */
async function dailyCharts($: EngineInterface): Promise<string> {
  const cached = (await read($, desk)).daily
  let data = cached?.data
  if (!cached || Date.now() - cached.t > 3600_000) {
    const rows = await Promise.all(
      SYMBOLS.map(s => readTool($, 'get_technical_indicators', { symbol: s, interval: '1d', indicators: ['rsi', 'macd', 'ema', 'bollinger'] }).catch(() => null)),
    )
    data = {}
    rows.forEach((r, i) => {
      try {
        if (r) data![SYMBOLS[i]!] = JSON.parse(r)
      } catch {
        // a coin without a daily reading is left out; the analyst works with the rest
      }
    })
    await update($, desk, x => ({ ...x, daily: { t: Date.now(), data: data! } }))
  }
  return data && Object.keys(data).length ? `DAILY charts (JSON):\n${JSON.stringify(data)}` : 'DAILY charts unavailable this cycle: signal 0.'
}

/** Alert Bot: tell the owner about big moves without them watching the pane. */
async function raiseAlerts($: EngineInterface, before: Desk, now: number): Promise<boolean> {
  const after = await read($, desk)
  const found = alertsFor(before, after, now)
  if (!found.length) return false
  await update($, desk, x => ({ ...x, alerts: [...(x.alerts ?? []), ...found.map(a => ({ ...a, t: now }))].slice(-50) }))
  if (after.alertsOn !== false) {
    for (const a of found) {
      const r = await $.ui.notify(a.text, { title: 'Trading desk' }).catch(() => undefined)
      if (!r?.isSent) $.ui.toast(a.text) // no native notification on this surface: show it in the app instead
    }
  }
  return true
}

function schedule($: EngineInterface, d: Desk) {
  timer?.cancel()
  timer = d.isRunning ? $.clock.every(d.intervalMin * 60_000, () => void tick($)) : undefined
}

const fmt = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
// Plain-words reading of a vote from -1 (sell) to 1 (buy).
const lean = (v: number) => (v > 0.3 ? 'Strong buy' : v > 0.1 ? 'Leaning buy' : v < -0.3 ? 'Strong sell' : v < -0.1 ? 'Leaning sell' : 'Neutral')
const tone = (v: number) => (v > 0.1 ? 'success' : v < -0.1 ? 'error' : 'subtle')
const headline = (avg: number) =>
  avg > 0.1 ? 'The team expects crypto to rise' : avg < -0.1 ? 'The team expects crypto to fall' : 'The team sees no clear direction'
const span = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`)
const ago = (t: number) => (t ? `${span(Date.now() - t)} ago` : '—')
const until = (t: number) => (!t ? 'soon' : t <= Date.now() ? 'now' : `in ${span(t - Date.now())}`)
const time = (t: number) => (t ? new Date(t).toISOString().slice(11, 16) + 'Z' : '—')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(STORE_KEY)) as Desk | undefined
    if (saved?.agents?.length) await update($, desk, () => withAgents(saved))
    else await update($, desk, d => (d.equityHistory[0]?.t ? withAgents(d) : newDesk(Date.now())))
    await $.command.register({ name: 'desk', description: 'Open the AI trading desk pane' })
    await $.tool.register({
      name: 'run_cycle',
      description: 'Run one AI trading desk cycle now (paper only: fetch data, train agents, vote, rebalance) and return a summary.',
      isDeferred: false,
    })
    const d = await read($, desk)
    schedule($, d)
    if (d.isRunning && Date.now() - d.lastTick > d.intervalMin * 60_000) void tick($)
    void $.ui.open({ id: PANE, title: 'AI Trading Desk' })
    return next(e)
  })

  on('tool.run', { tool: /^mcp__trading.desk__run_cycle$/ }, async $ => {
    await tick($, true)
    const d = await read($, desk)
    const text = [
      `Equity ${fmt(equity(d))} (${pct(equity(d) / START_CASH - 1)}), cycles ${d.ticks}, next rebalance ${d.lastRebalance ? time(d.lastRebalance + REBALANCE_MS) : 'next scan'}`,
      `Votes ${JSON.stringify(d.ensemble)} Prices ${JSON.stringify(d.prices)}`,
      ...d.agents.map(a => `${a.id} w=${(a.weight * 100).toFixed(1)}% ${JSON.stringify(a.pending ?? a.signals)} ${a.note}`),
      'Recent log:',
      ...d.log.slice(-8).map(l => `${time(l.t)} ${l.text}`),
    ].join('\n')
    return { result: text, text }
  })

  on('command.run', { command: 'desk' }, async $ => {
    await $.ui.open({ id: PANE, title: 'AI Trading Desk' })
    return { text: 'Trading desk opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, desk)
    const isBusy = await read($, busy)
    const expanded = await read($, showAll)
    const tab = await read($, tabAtom)
    const sessionCost = await $.session.usage().then(u => u.cost).catch(() => undefined)
    const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
    const usageRows = Object.entries(d.costs?.total ?? {})
    const lastCalls = Object.values(d.costs?.lastCycle ?? {}).reduce((s, r) => s + r.calls, 0)
    const eq = equity(d)
    const ret = eq / START_CASH - 1
    const ranked = [...d.agents].sort((a, b) => b.weight - a.weight)
    const name = (id: string) => AGENTS.find(a => a.id === id)?.name ?? id

    const toggle = async () => {
      await update($, desk, x => ({ ...x, isRunning: !x.isRunning }))
      const x = await read($, desk)
      schedule($, x)
      await $.store.set(STORE_KEY, x)
      if (x.isRunning) void tick($)
    }
    const setInterval = (min: number) => async () => {
      await update($, desk, x => ({ ...x, intervalMin: min }))
      schedule($, await read($, desk))
    }
    const reset = async () => {
      await update($, desk, () => newDesk(Date.now()))
      const x = await read($, desk)
      await $.store.set(STORE_KEY, x)
      schedule($, x)
    }
    const reviewNow = () => void review($)
    const resetHead = async () => {
      await update($, desk, x => ({ ...x, settings: DEFAULT_SETTINGS }))
      await log($, `Settings reset to the backtested defaults.`)
    }
    // Both the Head AI's code idea and the Improver's ideas reach Claude only when the owner presses send.
    const sendIdea = (from: string, idea: string) => () => {
      void update($, desk, x => ({ ...x, sent: [...(x.sent ?? []), { t: Date.now(), title: idea.slice(0, 120) }].slice(-20) }))
      void $.prompt.submit({
        text:
          `Trading desk ${from} suggests an improvement to the trading-desk mod: "${idea}". ` +
          'Review it, explain the trade-offs, and only implement it if it is sound and keeps the plugin paper-only with read-only Liquid calls. Test it with the backtest before shipping.',
      })
    }
    const reviewPlugin = (name: string, id: string, kind: string) => () =>
      void $.prompt.submit({
        text:
          `Trading desk Plugin Scout found the ${kind} "${name}" (${id}). Review it: what it does, what it can read or change, ` +
          'whether it would really help the desk, and any risk. Only offer to install it if it is worth it; never install without my OK.',
      })
    const sendProposal = sendIdea(CHIEF.name, d.chief?.codeProposal ?? '')
    const goLive = () =>
      void $.prompt.submit({
        text:
          'Trading desk: here is the current ensemble view ' + JSON.stringify(d.ensemble) +
          ' with prices ' + JSON.stringify(d.prices) +
          '. Use liquid_trade to preview (suggest_trade) the trades this implies for my account, small size, with stop losses. Do NOT execute anything until I approve each one.',
      })

    const cfg = settingsOf(d)
    const lastAlert = (d.alerts ?? []).at(-1)
    const muted = Object.entries(cfg.agentScale).filter(([, v]) => v === 0).map(([id]) => name(id))
    const card = { flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, paddingY: 0 } as const
    const up = ret >= 0
    const avg = SYMBOLS.reduce((s, x) => s + (d.ensemble[x] ?? 0), 0) / SYMBOLS.length
    const nextCheck = d.lastTick ? d.lastTick + d.intervalMin * 60_000 : 0
    const tabs = [['overview', 'Overview'], ['team', 'Team'], ['updates', 'Updates'], ['activity', 'Activity'], ['settings', 'Settings']] as const

    const tabBar = (
      <Box flexDirection="row" gap={1}>
        {tabs.map(([id, label], i) => (
          <Button key={`tab-${id}`} hotkey={String(i + 1)} variant={tab === id ? 'primary' : 'secondary'} label={label} onPress={() => update($, tabAtom, () => id)} />
        ))}
      </Box>
    )

    const overview = (
      <Box flexDirection="column" gap={1}>
        <Box {...card} borderColor={up ? 'success' : 'error'}>
          <Text dimColor size="footnote">Practice money</Text>
          <Text size="title" weight="bold" tabular>{fmt(eq)}</Text>
          <Text color={up ? 'success' : 'error'}>
            {up ? '▲' : '▼'} {up ? '+' : '−'}{fmt(Math.abs(eq - START_CASH))} ({pct(ret)}) since start
          </Text>
          <Text color={up ? 'success' : 'error'} mono>{sparkline(d.equityHistory.map(p => p.equity), 40) || ' '}</Text>
          <Text dimColor size="footnote">
            {isBusy ? '◌ The team is thinking…' : d.isRunning ? `● Running · prices ${until(nextCheck)} · full team ${d.lastRebalance ? until(d.lastRebalance + REBALANCE_MS) : 'next check'}` : '❚❚ Paused'}
          </Text>
        </Box>

        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Text size="footnote">
            <Text dimColor>Mood </Text>
            <Text bold color={d.mood === 'panic' ? 'error' : d.mood === 'trend' ? 'success' : 'warning'}>{d.mood ? MOODS[d.mood].label : '—'}</Text>
          </Text>
          <Text size="footnote">
            <Text dimColor>Risk Officer </Text>
            <Text bold color={d.riskTrim ? 'warning' : 'success'}>{d.riskTrim ? `trimmed ${Math.round(d.riskTrim * 100)}%` : 'all clear'}</Text>
          </Text>
          <Text size="footnote">
            <Text dimColor>Bet size </Text>
            <Text bold>{Math.round(cfg.exposure * 100)}%</Text>
          </Text>
        </Box>
        {lastAlert && Date.now() - lastAlert.t < 24 * 3600_000 ? <Text size="footnote" color="warning">🔔 {lastAlert.text} <Text dimColor>· {ago(lastAlert.t)}</Text></Text> : null}

        <Box flexDirection="row" gap={1}>
          <Button key="run" variant="primary" hotkey="r" label={isBusy ? 'Working…' : '▶ Check now'} onPress={() => void tick($, true)} />
          <Button key="toggle" hotkey="a" label={d.isRunning ? 'Pause' : 'Resume auto'} onPress={toggle} />
        </Box>

        <Box {...card}>
          <Text weight="semibold">What the team thinks</Text>
          <Text bold color={tone(avg)}>{headline(avg)}</Text>
          {d.report?.text ? <Text>{d.report.text}</Text> : <Text dimColor>A plain summary appears after the next check.</Text>}
          {d.report?.challenge ? <Text size="footnote" color="warning">Devil's advocate: {d.report.challenge}</Text> : null}
        </Box>

        <Box {...card}>
          <Text weight="semibold">Coins</Text>
          {SYMBOLS.map(s => {
            const val = (d.positions[s] ?? 0) * (d.prices[s] ?? 0)
            const v = d.ensemble[s] ?? 0
            return (
              <Box key={s} flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text bold>{s}</Text> <Text dimColor tabular>${d.prices[s]?.toLocaleString('en-US') ?? '—'}</Text>
                </Text>
                <Text>
                  <Text color={tone(v)}>{lean(v)}</Text>
                  <Text dimColor> · {val === 0 ? 'no bet' : `${val > 0 ? 'bet it rises' : 'bet it falls'} ${fmt(Math.abs(val))}`}</Text>
                </Text>
              </Box>
            )
          })}
        </Box>
        <Text dimColor size="footnote">Practice money only. A real trade only happens if you approve it in chat.</Text>
      </Box>
    )

    const team = (
      <Box flexDirection="column" gap={1}>
        <Box {...card} borderColor="claude">
          <Text weight="semibold" color="claude">◆ Head AI</Text>
          <Text>{d.chief?.brief || 'Reviews the team every 12 hours, starting after the first full period.'}</Text>
          <Text dimColor size="footnote">
            Using {Math.round(cfg.exposure * 100)}% of normal bet size{muted.length ? ` · benched: ${muted.join(', ')}` : ''}
            {d.chief ? ` · last review ${ago(d.chief.t)}` : ''}
          </Text>
          {(d.lessons ?? []).slice(-3).reverse().map((l, i) => (
            <Text key={`lesson${i}`} size="footnote" color="warning">✎ Learned: {l.text}</Text>
          ))}
        </Box>

        <Box {...card}>
          <Text weight="semibold">Trade ideas from the Scout</Text>
          {(d.ideas ?? []).length === 0 && <Text dimColor>Ideas arrive with the next check.</Text>}
          {(d.ideas ?? []).slice(0, 4).map((idea, i) => (
            <Text key={`idea${i}`}>
              <Text bold color={idea.side === 'long' ? 'success' : 'error'}>{idea.side === 'long' ? '▲ Buy' : '▼ Sell'} {idea.asset}</Text>
              <Text dimColor> — {idea.why}</Text>
            </Text>
          ))}
        </Box>

        <Box {...card}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="semibold">Agent team · {d.agents.length}</Text>
            <Button key="showall" plain label={expanded ? 'Show fewer' : 'Show all'} onPress={() => update($, showAll, v => !v)} />
          </Box>
          <Text dimColor size="footnote">Say = how much their vote counts (earned from results). Right = how often their calls were correct.</Text>
          {(expanded ? ranked : ranked.slice(0, 6)).map(a => (
            <Box key={a.id} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text>{name(a.id)}</Text>
                <Text tabular dimColor>
                  say <Text color="claude">{(a.weight * 100).toFixed(0)}%</Text> · right {a.calls ? `${Math.round((a.hits / a.calls) * 100)}%` : '—'}
                </Text>
              </Box>
              {a.note ? <Text dimColor size="footnote">  “{a.note}”</Text> : null}
            </Box>
          ))}
        </Box>
      </Box>
    )

    const isNew = (t: number) => Date.now() - t < 3600_000
    const updates = (
      <Box flexDirection="column" gap={1}>
        <Box {...card} borderColor="claude">
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="semibold" color="claude">How to get better</Text>
            <Button key="improve" plain label="Think now" onPress={() => void improve($, 'you asked', true)} />
          </Box>
          {!d.backlog && <Text dimColor>The Improver thinks after every team meeting and whenever an alert fires, and ranks what would help most.</Text>}
          {(d.backlog?.items ?? []).map((idea, i) => (
            <Box key={`imp${i}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text bold color={idea.impact === 'high' ? 'success' : idea.impact === 'medium' ? 'warning' : 'subtle'}>{i + 1}.</Text> {idea.title}
                </Text>
                <Button key={`send-imp${i}`} plain label="Send to Claude" onPress={sendIdea(IMPROVER.name, `${idea.title}: ${idea.why}`)} />
              </Box>
              <Text dimColor size="footnote">   {idea.impact} impact · {idea.kind} · {idea.why}</Text>
            </Box>
          ))}
          {d.backlog ? (
            <Text dimColor size="footnote">
              {isNew(d.backlog.t) ? '● New · ' : ''}Updated {ago(d.backlog.t)}{d.backlog.why ? ` (${d.backlog.why})` : ''}. Nothing changes until you send an idea and Claude tests it.
            </Text>
          ) : null}
        </Box>

        <Box {...card}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="semibold">{PLUGIN_SCOUT.name} · add-ons that could help</Text>
            <Button key="scoutplugins" plain label="Search now" onPress={() => void scoutPlugins($)} />
          </Box>
          {!d.plugins && <Text dimColor>Searches the plugin and skill directory once a day for things that fill the desk's gaps.</Text>}
          {d.plugins && !d.plugins.picks.length && <Text dimColor>Nothing that fits yet. {d.plugins.status}.</Text>}
          {(d.plugins?.picks ?? []).map((p, i) => (
            <Box key={`plug${i}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text bold color={p.fit === 'high' ? 'success' : p.fit === 'medium' ? 'warning' : 'subtle'}>{p.name}</Text>
                  <Text dimColor> · {p.kind}</Text>
                  {p.firstSeen && Date.now() - p.firstSeen < 3 * 24 * 3600_000 ? <Text color="claude"> ● new</Text> : null}
                </Text>
                <Button key={`review-plug${i}`} plain label="Ask Claude to review" onPress={reviewPlugin(p.name, p.id, p.kind)} />
              </Box>
              <Text dimColor size="footnote">   {p.why}</Text>
            </Box>
          ))}
          {d.plugins ? <Text dimColor size="footnote">Checked {ago(d.plugins.t)} · {d.plugins.status}. Nothing is installed without your OK.</Text> : null}
        </Box>

        <Box {...card}>
          <Text weight="semibold">Brainstorm</Text>
          {!(d.backlog?.talk ?? []).length && <Text dimColor>When the Improver needs a teammate's view, the questions and answers show here.</Text>}
          {(d.backlog?.talk ?? []).map((t, i) => (
            <Box key={`talk${i}`} flexDirection="column">
              <Text size="footnote"><Text bold>Improver → {t.who}:</Text> {t.q}</Text>
              <Text size="footnote" dimColor>  {t.a}</Text>
            </Box>
          ))}
        </Box>

        <Box {...card}>
          <Text weight="semibold">Sent to Claude</Text>
          {!(d.sent ?? []).length && <Text dimColor>Ideas you send show here.</Text>}
          {(d.sent ?? []).slice(-6).reverse().map((x, i) => (
            <Text key={`sent${i}`} size="footnote"><Text dimColor>{ago(x.t).padEnd(8)}</Text> {x.title}</Text>
          ))}
        </Box>
      </Box>
    )

    const activity = (
      <Box flexDirection="column" gap={1}>
        <Box {...card}>
          <Text weight="semibold">Alerts</Text>
          {(d.alerts ?? []).length === 0 && <Text dimColor>None yet. You get one for big losses, risk cuts, strong team calls and panicky markets.</Text>}
          {(d.alerts ?? []).slice(-5).reverse().map((a, i) => (
            <Text key={`alert${i}`} size="footnote"><Text dimColor>{ago(a.t).padEnd(8)}</Text> {a.text}</Text>
          ))}
        </Box>
        <Box {...card}>
          <Text weight="semibold">Recent activity</Text>
          {d.log.slice(-14).reverse().map((l, i) => (
            <Text key={`log${i}`} color={l.text.startsWith('BUY') ? 'success' : l.text.startsWith('SELL') ? 'error' : undefined} dimColor={!/^(BUY|SELL)/.test(l.text)}>
              <Text dimColor>{ago(l.t).padEnd(8)}</Text> {l.text.replace(' (paper)', '')}
            </Text>
          ))}
        </Box>
        <Box {...card}>
          <Text weight="semibold">AI usage</Text>
          {usageRows.length === 0 && <Text dimColor>No AI calls yet.</Text>}
          {usageRows.map(([m, r]) => (
            <Box key={`use-${m}`} flexDirection="row" justifyContent="space-between">
              <Text>{m}</Text>
              <Text tabular dimColor>{r.calls} calls · {tok(r.input + r.output)} tokens · {tok(r.cached)} from cache</Text>
            </Box>
          ))}
          <Text dimColor size="footnote">
            {lastCalls ? `${lastCalls} calls per check. ` : ''}This session so far: {sessionCost ? `~$${sessionCost.usd.toFixed(2)}` : 'n/a'} (estimate, includes chat)
          </Text>
          <Text dimColor size="footnote">{d.social?.status ?? 'Social scan runs with the next check.'}</Text>
        </Box>
      </Box>
    )

    const settings = (
      <Box flexDirection="column" gap={1}>
        <Box {...card}>
          <Text weight="semibold">How often to check the market</Text>
          <Box flexDirection="row" gap={1}>
            {[5, 15, 60].map(m => (
              <Button key={`i${m}`} variant={d.intervalMin === m ? 'primary' : 'secondary'} label={m === 60 ? 'Every hour' : `Every ${m} min`} onPress={setInterval(m)} />
            ))}
          </Box>
          <Text dimColor size="footnote">Checks between trades are free (prices, mood and alerts, no AI). The full AI team (~30 calls) meets once per 12-hour trade, or when you press Check now.</Text>
        </Box>
        <Box {...card}>
          <Text weight="semibold">Alerts</Text>
          <Button key="alerts" variant={d.alertsOn === false ? 'secondary' : 'primary'} label={d.alertsOn === false ? '🔕 Alerts off' : '🔔 Alerts on'} onPress={() => update($, desk, x => ({ ...x, alertsOn: x.alertsOn === false }))} />
          <Text dimColor size="footnote">Notifies you about big losses, risk cuts, strong calls and panicky markets, at most once per kind every 6 hours.</Text>
        </Box>
        <Box {...card}>
          <Text weight="semibold">Real money</Text>
          <Button key="live" label="Suggest real trades (you approve each one)" onPress={goLive} />
          <Text dimColor size="footnote">Claude previews trades in chat. Nothing is placed without your OK.</Text>
        </Box>
        <Box {...card}>
          <Text weight="semibold">Head AI</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="review" label="Review now" onPress={reviewNow} />
            <Button key="resethead" label="Undo its settings" onPress={resetHead} />
            {d.chief?.codeProposal ? <Button key="proposal" label="Send its code idea to Claude" onPress={sendProposal} /> : null}
          </Box>
          {d.chief?.codeProposal ? <Text size="footnote">Code idea: {d.chief.codeProposal}</Text> : null}
        </Box>
        <Box {...card} borderColor="error">
          <Text weight="semibold">Start over</Text>
          <Button key="reset" label="Reset practice money to $10,000" onPress={reset} />
          <Text dimColor size="footnote">Clears trades, history and what the agents learned.</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {tabBar}
        {tab === 'team' ? team : tab === 'updates' ? updates : tab === 'activity' ? activity : tab === 'settings' ? settings : overview}
      </Box>
    )
  })
}
