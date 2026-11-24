# AI Trading Desk

A Claude Code plugin with 12 AI analyst agents and a Trade Scout. Each cycle the desk pulls live 1h indicators for BTC, ETH, SOL and HYPE plus market intel from the Liquid connector: news headlines and unusual-volume alerts, market-wide crowd positioning (smart money vs the losing crowd), and what the top traders on the 7-day leaderboard are positioned in. The News Scanner, Crowd Watcher and Trade Scout think on a larger model; the technical agents (trend, momentum, mean reversion, volatility, contrarian, risk, swing; Breakout, Macro and Relative Value were removed after a backtest showed the desk did as well or better without them) stay on a cheaper one.

The agents' weighted vote runs a $10,000 **paper** book. Agents re-scan every cycle, but the book rebalances and the desk trains only every 12 hours, with each coin sized by its volatility. Those settings, the 3% minimum trade, the learning rate and each agent's starting influence come from an 800-setting walk-forward tune on ~208 days of hourly Hyperliquid prices (tuned on the first two thirds, checked on the last third); after that, agents whose calls made money gain influence and losers lose it. The Trade Scout lists its best setups anywhere on Liquid.

Open with `/desk`. Auto ON/OFF runs cycles on a 5, 15 or 60 minute timer, starting one as soon as the desk opens. "Propose live trades" asks Claude to preview real trades that you approve one by one. The plugin itself only calls read-only Liquid tools and never places real orders.

**Head AI.** At every 12-hour rebalance a Head AI reviews the period: paper P&L per coin and which agents called it wrong. It writes a brief every agent reads next cycle, records a lesson after any loss (the agents read the latest lessons on every call), and tunes the desk's settings within fixed limits: exposure (20–100% of the backtested size, so it can cut risk but never add leverage), learning rate, minimum trade size, and muting or boosting individual agents. It cannot edit code: when it thinks a code change is needed it writes a proposal, and "Send proposal to Claude" passes it on for you to review. "Reset settings" puts everything back to the backtested defaults.

**Huddle.** Each cycle runs in rounds: every agent reads the market on its own, then the Skeptic reads all their calls and challenges the weakest reasoning, then every agent sees the whole team's calls plus the challenge and may revise. A Reporter writes a plain-English summary. Other agents: Liquidity Hunter (funding, open interest, value near liquidation) and Social Sentiment (recent crypto YouTube titles through the official YouTube Data API; needs a YouTube API key saved for www.googleapis.com, header X-Goog-Api-Key; refreshed hourly to stay inside the free daily quota). TikTok and Instagram are not scanned: their APIs don't offer this and scraping them breaks their terms.

**AI usage.** The pane tallies the desk's own AI calls and tokens per model, and shows the session's cost estimate (which includes chat); `/usage` splits out the desk's share. The full team (about 30 AI calls, 4 on Sonnet) meets only when a 12-hour trade is due or when you press Check now; scheduled checks in between refresh prices, mood and alerts with no AI calls.

**Safety and awareness.** A Risk Officer caps the book's net long/short at 50% of equity, because the four coins move together and all-short is really one big bet (walk-forward backtest on the unseen period: median -2.67% to -1.94%, median drawdown 4.68% to 3.72%). A Big-Picture Analyst reads the daily charts so the desk doesn't chase shorts into an oversold bounce. A Market Mood label (Trending, Choppy, Panicky, from BTC's 1h chart) is shown to the agents and on the Overview; it does not reweight agents, since that showed no clear gain in the backtest. The Alert Bot notifies you about big losses, risk cuts, strong team calls and panicky markets, at most once per kind every 6 hours (toggle in Settings). Round-1 agent prompts share one cached opening, so the market data and intel are billed at the cached rate after the first call.

**Tested and left out.** A per-coin stop loss between rebalances (3% made things worse by locking in normal swings; 5% and 8% changed almost nothing) and a backtested starting weight for the Liquidity Hunter (its funding-rate signal helped in the recent period but hurt in the earlier one, so it starts even and earns its say live).

**Improver.** After every full team meeting, whenever an alert fires (at most hourly), and whenever you press "Think now", an Improver agent reads what the desk has actually done (losses, lessons, each agent's say and hit rate, Risk Officer trims, AI usage) and keeps a ranked list of up to five improvements on the Updates tab. When it needs input it asks up to three teammates (any agent, or the Head AI) one question each and finalizes with their answers; the exchange shows under Brainstorm. It knows which ideas were already tested and rejected. It cannot change anything itself: each idea has a "Send to Claude" button, and Claude reviews it, tests it against price history and ships it only if it holds up.

**Plugin Scout.** Once a day (and on "Search now") it searches the Claude plugin and skill directory, read-only, for trading, market data, backtesting, risk, sentiment and on-chain add-ons, and a cheap model ranks up to five against the desk's known gaps, marking ones that are new. It never installs anything: "Ask Claude to review" has Claude check what the add-on can read or change before offering it to you. GitHub trending repositories are not searched: that needs a linked GitHub account.

**Scorecards.** Before every call each agent reads its own record: hit rate, how much its vote counts, and which coins it called the wrong way last period, so it can correct its own habits.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install trading-desk --marketplace <owner>/trading-desk
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install trading-desk --marketplace <owner>/trading-desk`. In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `<owner>/trading-desk`, then Add plugin.

This repository is private: installing needs read access on GitHub and a git credential for github.com on that machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

Open the desk with `/desk`. It needs the Liquid connector for market data. Practice money only; real trades happen only when you approve them in chat.
