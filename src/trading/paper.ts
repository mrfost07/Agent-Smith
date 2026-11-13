
import { evaluate, indicatorSeries, makePlan, tradeCosts } from './analysis';
import { intervals, type Analysis, type Budget, type Costs, type Plan, type Snapshot, type Strategy } from './types';

export interface PaperSetup {
  savedAt: number;
  analysisId: string;
  instrumentId: string;
  interval: Snapshot['interval'];
  observedThrough: number;
  plan: Plan;
  budget: Budget;
  costs: Costs;
  strategy: Strategy;
  status: 'pending' | 'open' | 'closed' | 'expired';
  entry?: { time: number; price: number; quantity: number; paid: number; stop: number; target: number };
  exit?: { time: number; price: number; pnl: number; reason: string };
}
export function savePaper(analysis: Analysis): PaperSetup {
  const { snapshot, plan, budget } = analysis;
  if (snapshot.instrument.venue !== 'Kraken' || snapshot.stale || !plan?.quantity || !budget ||
      plan.expiresAt <= Date.now()) throw new Error('Paper monitoring requires a fresh Kraken setup and a feasible paper quantity.');
  const savedAt = Date.now();
  const seconds = intervals[snapshot.interval] * 1000;
  const observedThrough = Math.max(snapshot.latestClosedAt, Math.ceil(savedAt / seconds) * seconds);
  if (observedThrough >= plan.expiresAt) throw new Error('The setup expires before the next eligible paper entry.');
  return { savedAt, analysisId: analysis.id, instrumentId: snapshot.instrument.id, interval: snapshot.interval,
    observedThrough,
    plan, budget, costs: analysis.costs, strategy: analysis.strategy, status: 'pending' };
}

export function updatePaper(paper: PaperSetup, snapshot: Snapshot): PaperSetup {
  if (paper.status === 'closed' || paper.status === 'expired') return paper;
  if (snapshot.stale || snapshot.instrument.id !== paper.instrumentId || snapshot.interval !== paper.interval) {
    throw new Error('Refresh the original market and timeframe to evaluate this paper setup.');
  }
  const next = { ...paper };
  const seconds = intervals[snapshot.interval];
  const series = indicatorSeries(snapshot.candles, seconds);
  // Explicit historical replay of newly available closed bars, with no assumed fills across gaps.
  for (const [i, bar] of snapshot.candles.entries()) {
    const opened = bar.time * 1000;
    if (opened < next.observedThrough) continue;
    if (opened !== next.observedThrough) throw new Error('A candle gap prevents reliable paper replay.');
    next.observedThrough = opened + seconds * 1000;
    if (next.status === 'pending') {
      const sizing = makePlan(bar.open, next.plan.stop, next.strategy, snapshot.instrument, next.costs,
        next.plan.expiresAt, next.budget);
      if (opened >= next.plan.expiresAt || !sizing?.quantity) {
        next.status = 'expired';
        break;
      }
      const buy = tradeCosts(sizing.entry, next.costs, 'buy');
      next.entry = { time: opened, price: buy.fill, quantity: sizing.quantity, paid: buy.cash * sizing.quantity,
        stop: sizing.stop, target: sizing.targets[0] };
      next.status = 'open';
    }
    const position = next.entry!;
    const previous = i > 0 ? evaluate(snapshot.candles, i - 1, series, next.strategy, seconds, true) : undefined;
    const [price, reason] = bar.open <= position.stop ? [bar.open, 'stop gap'] as const :
      bar.open >= position.target ? [bar.open, 'target gap'] as const :
      previous?.exit && opened > position.time ? [bar.open, 'exit signal'] as const :
      bar.low <= position.stop ? [position.stop, bar.high >= position.target ? 'both touched; stop first' : 'stop'] as const :
      bar.high >= position.target ? [position.target, 'target'] as const : [undefined, ''] as const;
    if (price !== undefined) {
      const sold = tradeCosts(price, next.costs, 'sell');
      next.exit = { time: opened, price: sold.fill, pnl: sold.cash * position.quantity - position.paid, reason };
      next.status = 'closed';
      break;
    }
  }
  return next;
}
