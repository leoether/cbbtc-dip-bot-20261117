// cbBTC dip-reversion bot (agent-fun/bars-replay/v1).
//
// The dev window (1,440 one-minute bars of cbBTC/USDC) is a flat, choppy
// tape: +0.5% over 24 hours, range roughly $63.9k-$65.5k, one-minute moves of
// only ~6 bps. Trend following loses here (it buys the top of each wiggle and
// pays ~26 bps a round trip in fees, slippage and impact), and the deepest
// pullback against a 120-bar high is only ~2.1%, so a deep V-bounce never
// fires. What does make money on this tape is shallow mean reversion: the
// price keeps dipping ~1.3% off its recent high and bouncing back ~0.8%.
//
// So this bot buys exactly one shape and lets a trailing stop do the selling:
//
//   Dip buy (full size): the close sits at least 130 bps below the highest
//   close of the previous 120 bars. That is a dip inside a range, not a
//   breakdown: the window never fell more than ~2.1% off a 120-bar high, so
//   every such dip so far has retraced.
//
// Exits (shared, checked on every bar while holding): sell when the close is
// 80 bps above the entry close, or 80 bps below the highest close since
// entry (a trailing stop that is also the hard stop while the trade has not
// moved up), or after 240 bars held. No new entries in the last 30 bars of
// a 1,440-bar window: a position opened there would pay a full round trip of
// fees for one bar of upside. One position at most, long only, no leverage.
//
// The hello carries the universe, capital, caps and fees; each batch carries
// the bar that just closed plus the fills of the orders sent on the previous
// batch and the account. The bot answers every batch with exactly one reply
// echoing its seq. Orders decided on a bar fill at the next bar's open, so
// every signal is read off closes already seen. No clock, no network, no
// randomness: the same bars give the same orders, run after run.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Dip buy: bars back for the reference high (highest close). */
const LOOKBACK_BARS = 120;
/** Dip buy: the close must sit this far (bps) below the reference high. */
const DIP_BPS = 130;
/** Dip buy size: full cash (bps of cash). */
const SIZE_BPS = 10000;
/** Exit: sell when the close is this far (bps) above the entry close. */
const EXIT_BPS = 100;
/** Trailing stop: sell when the close falls this far (bps) below the peak. */
const TRAIL_BPS = 80;
/** Time stop: sell after this many bars held. */
const TIME_STOP_BARS = 240;
/** No new entries once this many bars of the window have been seen. */
const NO_ENTRY_AFTER_BARS = 1410;
/** Slippage cap on every order, measured from the latest close (bps). */
const MAX_SLIPPAGE_BPS = 150;

/** Per-symbol history and open-trade state. */
interface Series {
  closes: number[];
  /** Bars seen, entry bar included; -1 while flat. */
  entryBar: number;
  entryClose: number;
  /** Highest close since entry. */
  peak: number;
}

const series = new Map<string, Series>();

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = { closes: [], entryBar: -1, entryClose: 0, peak: 0 };
    series.set(symbol, s);
  }
  return s;
}

/** Highest close of the last `n` bars before the current one, or null. */
function prevHigh(s: Series, n: number): number | null {
  const c = s.closes;
  if (c.length < 2) return null;
  const start = Math.max(0, c.length - 1 - n);
  let m = -Infinity;
  for (let i = start; i < c.length - 1; i++) if (c[i] > m) m = c[i];
  return m === -Infinity ? null : m;
}

function push(bar: Bar): Series {
  const s = getSeries(bar.symbol);
  s.closes.push(Number(bar.c));
  return s;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Read this batch's bars into history first; warm-up bars seed the
    // indicators but never carry orders (the replay rejects warm-up orders).
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];

    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      if (s === undefined) continue;
      const held = state.positions.get(symbol);
      const n = s.closes.length;
      const close = s.closes[n - 1];

      if (held !== undefined) {
        // Holding: track the peak close, then the shared exits.
        if (close > s.peak) s.peak = close;
        const target = s.entryClose * (1 + EXIT_BPS / 10000);
        const trail = s.peak * (1 - TRAIL_BPS / 10000);
        const stale = s.entryBar >= 0 && n - s.entryBar >= TIME_STOP_BARS;
        if (close >= target || close < trail || stale) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      // Flat: forget any stale entry state, then look for an entry.
      s.entryBar = -1;
      s.peak = 0;
      if (n > NO_ENTRY_AFTER_BARS) continue;
      // Entries need a full 120-bar reference window first, so the
      // 120-bar high is a real one.
      if (n < LOOKBACK_BARS + 2) continue;

      // Dip buy: close at least 130 bps below the 120-bar high.
      const refHigh = prevHigh(s, LOOKBACK_BARS);
      if (refHigh === null) continue;
      const drawdownBps = ((close / refHigh) - 1) * 10000;
      if (drawdownBps > -DIP_BPS) continue;

      const notional = (state.cash * BigInt(SIZE_BPS)) / 10000n;
      if (notional < minNotional) continue;
      buys.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
      // Record the entry now; the fill lands at the next bar's open and the
      // position shows up in the next batch's account. If the order is
      // rejected the flat branch above resets this on the next bar.
      s.entryBar = n;
      s.entryClose = close;
      s.peak = close;
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    let cash = state.cash;
    for (const b of buys) {
      if (orders.length >= caps.max_orders_per_bar) break;
      if (b.notional_quote_units > cash) continue;
      orders.push(b);
      cash -= b.notional_quote_units;
    }
    return orders;
  },
});
