
import { higherIntervals, intervals, type Analysis, type Budget, type Candle, type Costs, type Features, type Instrument, type Interval, type Plan, type Snapshot, type Strategy } from './types';

export function checkSettings(strategy: Strategy, costs: Costs, budget?: Budget): void {
  const inRange = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  if (!strategy || !['breakout', 'pullback'].includes(strategy.id) || strategy.version !== 1 ||
      !Number.isInteger(strategy.lookback) || !inRange(strategy.lookback, 5, 100) ||
      !inRange(strategy.atrMultiple, 0.5, 8) || !inRange(strategy.reward, 1, 10) ||
      typeof strategy.volumeFilter !== 'boolean') throw new Error('Invalid strategy parameters.');
  if (!costs || !inRange(costs.feeBps, 0, 500) || !inRange(costs.executionBps, 0, 500)) {
    throw new Error('Fees and execution costs must be between 0 and 500 basis points per side.');
  }
  if (budget && (!inRange(budget.equity, 0.01, 1e12) || !inRange(budget.percent, 0.001, 100) ||
      typeof budget.currency !== 'string' || !/^[A-Z0-9]{2,12}$/.test(budget.currency))) {
    throw new Error('Enter positive paper equity, a risk percentage and its currency.');
  }
}

// EMA seeded by SMA. RSI and ATR use Wilder smoothing. Gaps reset indicator warmup.
export function indicatorSeries(bars: Candle[], seconds: number) {
  let count = 0, gain = 0, loss = 0, atr = 0;
  const periods = [20, 50, 200];
  const ema = [0, 0, 0];
  return bars.map((bar, i) => {
    const previous = bars[i - 1];
    if (!previous || bar.time - previous.time !== seconds) {
      count = gain = loss = atr = 0;
      ema.fill(0);
    }
    count++;
    for (const [j, period] of periods.entries()) {
      if (count <= period) ema[j] += bar.close / period;
      else ema[j] += (bar.close - ema[j]) * 2 / (period + 1);
    }
    const change = count === 1 ? 0 : bar.close - previous.close;
    const range = count === 1 ? bar.high - bar.low :
      Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
    atr = count <= 14 ? atr + range / 14 : (13 * atr + range) / 14;
    if (count > 1 && count <= 15) {
      gain += Math.max(0, change) / 14;
      loss += Math.max(0, -change) / 14;
    } else if (count > 15) {
      gain = (13 * gain + Math.max(0, change)) / 14;
      loss = (13 * loss + Math.max(0, -change)) / 14;
    }
    const [ema20, ema50, ema200] = ema.map((value, j) => count >= periods[j] ? value : undefined);
    const rsi = count < 15 ? undefined : loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    return { ema20, ema50, ema200, rsi, atr: count >= 14 ? atr : undefined, count };
  });
}

export function confirmedPivots(bars: Candle[], index: number, seconds: number): Features['pivots'] {
  const result: Features['pivots'] = [];
  for (let i = Math.max(2, index - 79); i <= index - 2; i++) {
    if (bars[i + 2].time - bars[i - 2].time !== 4 * seconds) continue;
    const bar = bars[i];
    const neighbors = [bars[i - 2], bars[i - 1], bars[i + 1], bars[i + 2]];
    if (neighbors.every(other => bar.high > other.high)) result.push({ time: bar.time, price: bar.high, side: 'high' });
    if (neighbors.every(other => bar.low < other.low)) result.push({ time: bar.time, price: bar.low, side: 'low' });
  }
  return result;
}

export function tradeCosts(price: number, costs: Costs, side: 'buy' | 'sell') {
  const fill = price * (1 + (side === 'buy' ? 1 : -1) * costs.executionBps / 10_000);
  const fee = fill * costs.feeBps / 10_000;
  return { fill, fee, cash: side === 'buy' ? fill + fee : fill - fee };
}

function roundPrice(value: number, tick: number | undefined, up: boolean) {
  if (!tick) return value;
  const ticks = value / tick;
  const nearest = Math.round(ticks);
  const rounded = Math.abs(ticks - nearest) < 1e-8 ? nearest : (up ? Math.ceil(ticks) : Math.floor(ticks));
  return rounded * tick;
}

export function makePlan(rawEntry: number, rawStop: number, strategy: Strategy, instrument: Instrument,
  costs: Costs, expiresAt: number, budget?: Budget, targetOverride?: number): Plan | undefined {
  if (!(rawEntry > rawStop && rawStop > 0)) return;
  const entry = roundPrice(rawEntry, instrument.tick, true);
  const stop = roundPrice(rawStop, instrument.tick, false);
  const distance = entry - stop;
  const tp1 = roundPrice(entry + distance * strategy.reward, instrument.tick, true);
  const tp2 = roundPrice(targetOverride ?? entry + distance * (strategy.reward + 1), instrument.tick, true);
  if (!(stop > 0 && entry > stop && tp1 > entry && tp2 > tp1) || !Number.isFinite(tp2)) return;
  const paid = tradeCosts(entry, costs, 'buy').cash;
  const riskPerUnit = paid - tradeCosts(stop, costs, 'sell').cash;
  const netR = [tp1, tp2].map(p => (tradeCosts(p, costs, 'sell').cash - paid) / riskPerUnit) as [number, number];
  if (netR[0] <= 0) return;
  const plan: Plan = { entry, stop, targets: [tp1, tp2], expiresAt, grossR: (tp1 - entry) / distance, netR, riskPerUnit,
    sizing: 'Enter a paper balance and risk budget for sizing.' };
  if (!budget) return plan;
  if (budget.currency !== instrument.quote) {
    plan.sizing = 'Use paper equity in ' + instrument.quote + '. No FX conversion is configured.';
    return plan;
  }
  const { step, minQty, minValue, tick } = instrument;
  if (!step || minQty === undefined || minValue === undefined || !tick) {
    plan.sizing = 'Sizing needs tick size, quantity step and minimum order metadata.';
    return plan;
  }
  const riskLimit = budget.equity * budget.percent / 100;
  let units = Math.floor(Math.min(riskLimit / riskPerUnit, budget.equity / paid) / step);
  if (!Number.isSafeInteger(units)) {
    plan.sizing = 'Quantity exceeds the supported precision.';
    return plan;
  }
  if (units * step * riskPerUnit > riskLimit || units * step * paid > budget.equity) units--;
  const quantity = units * step;
  if (quantity <= 0 || quantity < minQty || quantity * entry < minValue) {
    plan.sizing = 'No feasible quantity within the paper risk and order minimums.';
    return plan;
  }
  plan.quantity = quantity;
  plan.plannedLoss = quantity * riskPerUnit;
  plan.sizing = 'Estimated loss at the modeled stop fill. Gaps can increase losses.';
  return plan;
}

export function evaluate(bars: Candle[], i: number, series: ReturnType<typeof indicatorSeries>, strategy: Strategy,
  seconds: number, volumeKnown: boolean) {
  const bar = bars[i];
  const { ema20, ema50, ema200, atr, rsi, count } = series[i];
  const prior = bars.slice(Math.max(0, i - strategy.lookback), i);
  const high = Math.max(...prior.map(candle => candle.high));
  const low = Math.min(...prior.map(candle => candle.low));
  const knownVolume = volumeKnown && prior.length > 0 && prior.every(candle => candle.volume !== null);
  const volumeMean = knownVolume ? prior.reduce((sum, candle) => sum + candle.volume!, 0) / prior.length : undefined;
  const volumeOk = !strategy.volumeFilter || (volumeMean !== undefined && volumeMean > 0 && (bar.volume ?? 0) >= volumeMean);
  const trend: Features['trend'] = ema20 !== undefined && ema50 !== undefined
    ? ema20 > ema50 && bar.close > ema20 ? 'up' : ema20 < ema50 && bar.close < ema20 ? 'down' : 'mixed' : 'mixed';
  const warm = count >= Math.max(strategy.id === 'pullback' ? 50 : 15, strategy.lookback + 1) && atr !== undefined;
  const previous = bars[i - 1];
  const enter = warm && volumeOk && (strategy.id === 'breakout' ? bar.close > high :
    trend === 'up' && bar.low <= ema20! && previous.close <= series[i - 1].ema20! && bar.close > ema20!);
  const exit = warm && (strategy.id === 'breakout' ? bar.close < low : bar.close < ema50!);
  return { bar, ema20, ema50, ema200, atr, rsi, trend, warm, enter, exit, volumeOk, volumeMean,
    stop: enter ? Math.min(strategy.id === 'breakout' ? high : bar.low, bar.close - atr! * strategy.atrMultiple) : undefined,
    pivots: () => confirmedPivots(bars, i, seconds) };
}

function cluster(values: number[], tolerance: number): number[] {
  const groups: number[][] = [];
  for (const value of values.sort((a, b) => a - b)) {
    const group = groups.at(-1);
    if (group && value - group[0] <= tolerance) group.push(value);
    else groups.push([value]);
  }
  return groups.map(group => group.reduce((sum, price) => sum + price, 0) / group.length);
}

export function completedHigherBars(bars: Candle[], interval: Interval, higher: Interval): Candle[] {
  const seconds = intervals[interval], width = intervals[higher], ratio = width / seconds;
  if (ratio <= 1 || !Number.isInteger(ratio)) return [];
  const result: Candle[] = [];
  for (let i = 0; i + ratio <= bars.length;) {
    const first = bars[i], last = bars[i + ratio - 1];
    if (first.time % width || last.time !== first.time + width - seconds) { i++; continue; }
    const group = bars.slice(i, i + ratio);
    result.push({ time: first.time, open: first.open, high: Math.max(...group.map(bar => bar.high)),
      low: Math.min(...group.map(bar => bar.low)), close: last.close,
      volume: group.every(bar => bar.volume !== null) ? group.reduce((sum, bar) => sum + bar.volume!, 0) : null });
    i += ratio;
  }
  return result;
}
export function analyze(snapshot: Snapshot, strategy: Strategy, costs: Costs, budget?: Budget, paperLong = false): Analysis {
  checkSettings(strategy, costs, budget);
  const { candles, interval, instrument } = snapshot;
  const seconds = intervals[interval];
  const decision = evaluate(candles, candles.length - 1, indicatorSeries(candles, seconds), strategy, seconds, snapshot.volumeUnit === 'base');
  const { close } = decision.bar;
  const pivots = decision.pivots();
  const lows = cluster(pivots.filter(p => p.side === 'low' && p.price < close).map(p => p.price), (decision.atr ?? 0) * 0.25);
  const highs = cluster(pivots.filter(p => p.side === 'high' && p.price > close).map(p => p.price), (decision.atr ?? 0) * 0.25);
  const { ema20, ema50, ema200, atr, rsi, trend, volumeMean } = decision;
  const features: Features = { close, ema20, ema50, ema200, atr, rsi, trend, volumeMean, pivots, support: lows.at(-1), resistance: highs[0] };
  const higher = higherIntervals[interval];
  if (higher) {
    const bars = completedHigherBars(candles, interval, higher);
    const higherSeries = indicatorSeries(bars, intervals[higher]);
    if (higherSeries.at(-1)?.ema50 !== undefined) {
      const higherDecision = evaluate(bars, bars.length - 1, higherSeries, strategy, intervals[higher], false);
      features.higher = { interval: higher, trend: higherDecision.trend,
        latestClosedAt: (higherDecision.bar.time + intervals[higher]) * 1000 };
    }
  }
  const result: Analysis = { id: crypto.randomUUID(), snapshot, strategy, costs, budget, features,
    signal: 'WAIT', status: 'no_setup', reason: 'The latest closed candle did not confirm the strategy trigger.' };
  if (snapshot.stale) return { ...result, status: 'stale_data', reason: 'The Kraken feed is stale.' };
  if (!decision.warm) return { ...result, status: 'insufficient_data', reason: 'More consecutive closed candles are needed for strategy warmup.' };
  if (paperLong) {
    return decision.exit ? { ...result, signal: 'SELL', status: 'ready', reason: 'The closed candle triggered an exit for the simulated long.' }
      : { ...result, reason: 'The strategy did not trigger an exit for the simulated long.' };
  }
  if (!decision.volumeOk) result.reason = 'Volume did not confirm the setup or usable volume is missing.';
  if (decision.stop === undefined) return result;
  const plan = makePlan(close, decision.stop, strategy, instrument, costs, snapshot.latestClosedAt + 2 * seconds * 1000, budget);
  if (!plan) return { ...result, reason: 'No valid stop and target geometry after rounding and costs.' };
  return { ...result, status: 'ready', signal: 'BUY', plan, reason: 'Closed-bar setup with a reference entry and a time-limited trigger.' };
}
