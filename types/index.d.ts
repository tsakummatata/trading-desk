export type Market = { symbol: string; price: number; indicators: unknown; vol?: number }

export type AgentState = {
  id: string
  weight: number
  signals: Record<string, number>
  score: number
  calls: number
  hits: number
  note: string
  /** Latest signals; `signals` are the ones committed at the last rebalance, which training scores. */
  pending?: Record<string, number>
}

export type Desk = {
  isRunning: boolean
  intervalMin: number
  cash: number
  positions: Record<string, number>
  prices: Record<string, number>
  agents: AgentState[]
  ensemble: Record<string, number>
  equityHistory: { t: number; equity: number }[]
  log: { t: number; text: string }[]
  ticks: number
  ideas?: { asset: string; side: 'long' | 'short'; why: string }[]
  lastTick: number
  lastRebalance?: number
  /** Prices at the last rebalance, the baseline training scores against. */
  basePrices?: Record<string, number>
  priorApplied?: boolean
  /** Set by the Head AI within LIMITS; absent fields fall back to DEFAULT_SETTINGS. */
  settings?: Settings
  lessons?: { t: number; text: string }[]
  chief?: { t: number; brief: string; codeProposal: string }
  lastReport?: PeriodReport
  /** Running tally of the desk's own AI calls (tokens, not dollars). */
  costs?: Costs
  /** The Reporter's plain-English summary of the last cycle, and what the huddle changed. */
  report?: { t: number; text: string; challenge: string; revised: number }
  /** Cached social scan (YouTube), refreshed at most hourly to stay inside the API's daily quota. */
  social?: { t: number; status: string; items: string[] }
  /** Market mood from BTC's 1h chart. Shown to the agents and the owner; it does not reweight agents (backtest: no clear gain). */
  mood?: Mood
  /** Share of the book the Risk Officer trimmed at the last rebalance (0 = untouched). */
  riskTrim?: number
  alerts?: { t: number; key: string; text: string }[]
  alertsOn?: boolean
  /** Daily-chart indicators for the Big-Picture Analyst, refreshed hourly. */
  daily?: { t: number; data: Record<string, unknown> }
  /** The Improver's ranked list of ways to make the desk better, rewritten once a day. */
  backlog?: { t: number; items: Idea2[]; why: string; talk: Talk[] }
  /** Ideas the owner sent to Claude, newest last. */
  sent?: { t: number; title: string }[]
  /** Plugin Scout: ranked plugins and skills from the directory that could help the desk. */
  plugins?: { t: number; status: string; picks: PluginPick[]; seen: string[] }
  /** Research AI: daily notes from forums, news and trading books, shared with the team. */
  research?: { t: number; status: string; notes: string[]; sources: string[] }
  /** The owner's real Liquid account, read-only snapshot. */
  account?: { t: number; equity: number; available: number; positions: { symbol: string; side: string; value: number; pnl: number }[] }
}

export type PluginPick = { id: string; name: string; kind: 'plugin' | 'skill'; why: string; fit: 'high' | 'medium' | 'low'; firstSeen: number }
export type Listing = { id: string; name: string; description: string; kind: 'plugin' | 'skill'; enabled: boolean }

/** One brainstorm exchange: the Improver asks a teammate, the teammate answers. */
export type Talk = { who: string; q: string; a: string }

export type Mood = 'trend' | 'chop' | 'panic'

export type Idea2 = { title: string; why: string; kind: 'setting' | 'agent' | 'code'; impact: 'high' | 'medium' | 'low' }

export type ModelTally = { calls: number; input: number; output: number; cached: number; created?: number }
export type Costs = { since: number; total: Record<string, ModelTally>; lastCycle: Record<string, ModelTally> }

export type Settings = { exposure: number; learnRate: number; minTrade: number; agentScale: Record<string, number> }

export type PeriodReport = {
  t: number
  pnl: number
  bySymbol: Record<string, number>
  agents: { id: string; reward: number; wrong: string[] }[]
}

declare module 'claude-code' {
  interface PluginState {
    'trading-desk': { desk: Shaped<Desk>; busy: boolean; showAll: boolean; tab: string; doing: Record<string, string> }
  }
}
