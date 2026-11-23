// btc-race-bot: a rare, long-only trend-following bot for cbBTC/USDC.
//
// Strategy in one paragraph: wait for a genuine 120-minute Donchian breakout
// (the close above the highest close of the previous 120 bars) that is backed
// by a real 120-bar uptrend (>= 120 bps) but is not a vertical spike (the
// last 5 bars rose at most 60 bps), buy with the full cash balance, then ride
// it with a 120 bps trailing stop under the highest close since entry. The
// position is also closed when it moves 300 bps either way from the price it
// actually filled at: a 300 bps take-profit on the upside, a 300 bps hard
// stop on the downside as a backstop. After a sale the bot rests for 120
// bars before it may buy again. If the window stays flat or falling and no
// trade has happened by bar 1200, one looser breakout (60 bars, >= 50 bps)
// is taken so the bot still meets the competition's minimum of one trade.
//
// All price comparisons use BigInt cross-multiplication, so no float rounding
// can flip a signal. The bot is fully deterministic: no clock, no randomness,
// no network, no files outside this repository.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 10_000;

// Main breakout: Donchian window, minimum 120-bar return, maximum 5-bar spike.
const BREAKOUT_BARS = 120;
const MIN_TREND_BPS = 120n;
const MAX_SPIKE_BPS = 60n;
// Exits: trailing stop under the peak since entry, 300 bps band around the fill price.
const TRAILING_STOP_BPS = 120n;
const BAND_BPS = 300n;
// Rest after a sale before the next entry is allowed.
const COOLDOWN_BARS = 120;
// Fallback guardrail: if nothing has traded by this bar, take one looser trade.
const FALLBACK_BAR = 1200;
const FALLBACK_BARS = 60;
const FALLBACK_MIN_TREND_BPS = 50n;
const FALLBACK_TRAILING_STOP_BPS = 100n;

const BPS = 10_000n;

/** True when `now` is at least `bps` above `then`: now * 10000 >= then * (10000 + bps). */
function upAtLeast(now: bigint, then: bigint, bps: bigint): boolean {
  return now * BPS >= then * (BPS + bps);
}

/** True when `now` is at most `bps` above `then`: now * 10000 <= then * (10000 + bps). */
function upAtMost(now: bigint, then: bigint, bps: bigint): boolean {
  return now * BPS <= then * (BPS + bps);
}

/** True when `now` is at least `bps` below `ref`: now * 10000 < ref * (10000 - bps). */
function downAtLeast(now: bigint, ref: bigint, bps: bigint): boolean {
  return now * BPS < ref * (BPS - bps);
}

// Close of every batch so far, by seq (null when the symbol had no bar).
const closes: (bigint | null)[] = [];

// Position state, tracked from our own decisions (the account in `state`
// is the source of truth for what we hold; these track the entry itself).
// entryPrice is the price the buy actually filled at, as the harness
// reported it in the next batch's fills; entryClose is the close the buy
// was decided on (the peak starts there until the fill is known).
let entryClose: bigint | null = null;
let entryPrice: bigint | null = null;
let peakClose: bigint | null = null;
let fallbackTrade = false;
let lastSellSeq = -1_000_000;
let tradesTaken = 0;

/** Highest close of the `n` bars before `seq` (exclusive of the current bar). */
function maxCloseBefore(seq: number, n: number): bigint | null {
  let max: bigint | null = null;
  for (let i = seq - n; i < seq; i++) {
    const c = closes[i];
    if (c !== null && c !== undefined && (max === null || c > max)) max = c;
  }
  return max;
}

await runBars({
  onBatch(state: BarsState, batch) {
    closes.push(state.close(SYMBOL));
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];

    // Record the price our buy actually filled at (reported in this batch),
    // or clear a buy that was rejected so no stale entry survives.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.side !== 'buy') continue;
      if (fill.status === 'filled') entryPrice = BigInt(fill.price);
      if (fill.status === 'rejected') {
        entryClose = null;
        entryPrice = null;
        peakClose = null;
      }
    }

    const held = state.positions.get(SYMBOL);
    const seq = batch.seq;

    // --- Holding: manage the exit. -------------------------------------
    if (held !== undefined && held.qty > 0n && entryClose !== null) {
      if (peakClose === null || close > peakClose) peakClose = close;
      const trailingBps = fallbackTrade ? FALLBACK_TRAILING_STOP_BPS : TRAILING_STOP_BPS;
      const stopHit = peakClose !== null && downAtLeast(close, peakClose, trailingBps);
      // 300 bps band around the price the position actually filled at:
      // take the profit above it, stop out below it. Falls back to the
      // decision close while the fill has not been reported yet.
      const ref = entryPrice ?? entryClose;
      const bandHit = upAtLeast(close, ref, BAND_BPS) || downAtLeast(close, ref, BAND_BPS);
      if (stopHit || bandHit) {
        const orders: OrderInput[] = [
          { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS },
        ];
        entryClose = null;
        entryPrice = null;
        peakClose = null;
        fallbackTrade = false;
        lastSellSeq = seq;
        tradesTaken += 1;
        return orders;
      }
      return [];
    }

    // --- Flat: look for an entry. --------------------------------------
    if (held !== undefined && held.qty > 0n) return []; // Defensive: position without entry data.
    if (seq - lastSellSeq < COOLDOWN_BARS) return [];
    if (seq < BREAKOUT_BARS) return [];

    const prevMax = maxCloseBefore(seq, BREAKOUT_BARS);
    const then120 = closes[seq - BREAKOUT_BARS];
    const then5 = closes[seq - 5];
    if (prevMax !== null && then120 !== null && then120 !== undefined && then5 !== null && then5 !== undefined) {
      const breakout = close > prevMax;
      const trendOk = upAtLeast(close, then120, MIN_TREND_BPS);
      const notSpike = upAtMost(close, then5, MAX_SPIKE_BPS);
      if (breakout && trendOk && notSpike) {
        const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
        if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        entryClose = close;
        peakClose = close;
        fallbackTrade = false;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    // --- Fallback guardrail: one looser trade if nothing has happened. --
    if (tradesTaken === 0 && entryClose === null && seq >= FALLBACK_BAR && seq >= FALLBACK_BARS) {
      const fallbackMax = maxCloseBefore(seq, FALLBACK_BARS);
      const then60 = closes[seq - FALLBACK_BARS];
      if (fallbackMax !== null && then60 !== null && then60 !== undefined) {
        if (close > fallbackMax && upAtLeast(close, then60, FALLBACK_MIN_TREND_BPS)) {
          const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
          if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
          entryClose = close;
          peakClose = close;
          fallbackTrade = true;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }

    return [];
  },
});
