# cbBTC dip-reversion bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/c/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/leoether/cbbtc-dip-bot-20261117/rank.svg)](https://make.fun/c/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/leoether/cbbtc-dip-bot-20261117/reward.svg)](https://make.fun/c/btc-race-24h-20261117-0603)

Entry for make.fun `btc-race-24h-20261117-0603`: a bot that trades Coinbase
Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, long only, from
1,000 USDC of paper money.

## Strategy

One entry shape, one shared exit. The dev window is a flat, choppy tape
(+0.5% over 24 hours, range roughly $63.9k–$65.5k), so trend following loses
and deep V-bounces never fire. Shallow mean reversion is what pays:

1. **Dip buy (full size)** — the close sits at least 130 bps below the
   highest close of the previous 120 bars. A dip inside a range, not a
   breakdown.

**Exit** (checked every bar while holding): sell when the close is 80 bps
above the entry close, or 80 bps below the highest close since entry
(trailing stop), or after 240 bars held. No new entries in the last 30 bars
of the window.

## Dev-window result (local grade, `grade-local --driver process`)

- Net PnL: **+15.66 USDC** (grade-local, process driver; 2x-fees net PnL +12.43)
- Max drawdown: 1.13%
- Trades: 8 (4 round trips, win rate 100%)

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `sdk/makefun-bars.ts` shim, which owns the `agent-fun/bars-replay/v1` wire:
  one reply per batch echoing its seq, orders decided on a bar filling at the
  next bar's open.

No network, no wall clock, no randomness: the same bars give the same orders.
