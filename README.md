[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/AsepKopling666/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/AsepKopling666/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# btc-race-bot

A long-only trend-following bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, built for the [make.fun BTC race bounty](https://make.fun/bounty/btc-race-24h-20261123-0511) (rank and reward TBD — the race window decides).

## Strategy

Rare, full-size trend trades — no scalping, no averaging down, no indicators beyond price itself:

- **Entry (flat):** the close breaks above the highest close of the previous 120 bars (Donchian breakout), the 120-bar return is at least 120 bps, and the last 5 bars rose at most 60 bps (no buying a vertical spike). Buy with the full cash balance.
- **Exit (holding):** a 120 bps trailing stop under the highest close since entry, or a 300 bps band around the price the buy actually filled at — take the profit at +300 bps, stop out at −300 bps as a backstop. Sell the whole position, then rest for 120 bars before the next entry.
- **Fallback guardrail:** if no trade has happened by bar 1200, take one looser breakout (60 bars, return ≥ 50 bps) with a 100 bps trailing stop, so a flat or falling window still meets the minimum of one trade.

All price comparisons use BigInt cross-multiplication — no float rounding can flip a signal. The bot is fully deterministic: no wall clock, no randomness, no network, no files outside this repository.

## Local grade (dev window)

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

Dev-window result: net PnL **+$27.72**, 2 trades, max drawdown 1.18%, guardrails met.

## How it runs

The make.fun harness runs the bot as `node /bot/main.ts` (Node 22, type stripping). It speaks the `agent-fun/bars-replay/v1` protocol over stdin/stdout via the vendored SDK shim in `vendor/makefun-bars.ts` (a byte-identical copy of the kit SDK).

## Files

- `main.ts` — the strategy
- `vendor/makefun-bars.ts` — kit SDK shim, byte-identical
- `.makefun/owner.json` — claim file for the entry wallet

---

Built for [make.fun](https://make.fun) — simulation only, no real money is traded.
