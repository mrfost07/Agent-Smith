
import { checkSettings, evaluate, indicatorSeries, makePlan, tradeCosts } from './analysis';
import { intervals, type Analysis, type Budget } from './types';

export interface Trade {
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  quantity: number;
  pnl: number;
  fees: number;
  cost: number;
  reason: 'stop' | 'target' | 'both' | 'exit signal' | 'end';
}
interface Position { entryTime: number; rawEntry: number; entry: number; paid: number; fee: number; qty: number; stop: number; target: number; }
export interface Checkpoint {
  index: number;
  cash: number;
  position?: Position;
  trades: Trade[];
  curve: number[];
  exposureBars: number;
}
export interface BacktestResult {
  hash: string;
  initial: number;
  final: number;
  maxDrawdown: number;
  benchmark: number;
  exposure: number;
  expectancy: number | null;
  profitFactor: number | null;
  trades: Trade[];
  curve: number[];
  totalCosts: number;
  startTime: number;
  endTime: number;
}

export function prepareBacktest(analysis: Analysis, budget: Budget, holdout: boolean, saved?: Checkpoint) {
  const { snapshot, strategy, costs } = analysis;
  checkSettings(strategy, costs, budget);
  const { candles, instrument, hash, interval } = snapshot;
  if (snapshot.gaps) throw new Error('Backtesting requires contiguous candles. Fill gaps with actual historical data.');
  if (budget.currency !== instrument.quote || !instrument.tick || !instrument.step ||
      instrument.minQty === undefined || instrument.minValue === undefined) {
    throw new Error('Backtesting requires paper equity in the quote currency and order metadata. Enter simulation metadata for CSV.');
  }
  const seconds = intervals[interval];
  const series = indicatorSeries(candles, seconds);
  const first = Math.max(strategy.id === 'pullback' ? 50 : 15, strategy.lookback + 1,
    holdout ? Math.floor(candles.length * 0.8) : 0);
  if (first >= candles.length - 1) throw new Error('Not enough bars after strategy warmup.');
  const state: Checkpoint = saved ?? { index: first, cash: budget.equity, trades: [], curve: [], exposureBars: 0 };
  function exit(time: number, price: number, reason: Trade['reason']) {
    const position = state.position!;
    const sold = tradeCosts(price, costs, 'sell');
    const proceeds = sold.cash * position.qty;
    state.cash += proceeds;
    state.trades.push({ entryTime: position.entryTime, exitTime: time, entry: position.entry, exit: sold.fill,
      quantity: position.qty, pnl: proceeds - position.paid, fees: position.fee + sold.fee * position.qty,
      cost: position.paid - proceeds + (price - position.rawEntry) * position.qty, reason });
    state.position = undefined;
  }
  function advance(limit: number) {
    const end = Math.min(candles.length, state.index + limit);
    while (state.index < end) {
      const i = state.index++;
      const bar = candles[i];
      const previous = evaluate(candles, i - 1, series, strategy, seconds, snapshot.volumeUnit === 'base');
      const carried = Boolean(state.position);
      if (state.position && bar.open <= state.position.stop) exit(bar.time, bar.open, 'stop');
      else if (state.position && bar.open >= state.position.target) exit(bar.time, bar.open, 'target');
      else if (state.position && previous.exit) exit(bar.time, bar.open, 'exit signal');
      if (!carried && previous.stop !== undefined && state.cash > 0 && bar.open > previous.stop) {
        const plan = makePlan(bar.open, previous.stop, strategy, instrument, costs, 0, { ...budget, equity: state.cash });
        if (plan?.quantity) {
          const buy = tradeCosts(plan.entry, costs, 'buy');
          const paid = buy.cash * plan.quantity;
          state.cash -= paid;
          state.position = { entryTime: bar.time, rawEntry: bar.open, entry: buy.fill, paid, fee: buy.fee * plan.quantity,
            qty: plan.quantity, stop: plan.stop, target: plan.targets[0] };
        }
      }
      if (carried || state.position) state.exposureBars++;
      const position = state.position;
      if (position) {
        const stop = bar.low <= position.stop, target = bar.high >= position.target;
        if (stop) exit(bar.time, position.stop, target ? 'both' : 'stop');
        else if (target) exit(bar.time, position.target, 'target');
        else if (i === candles.length - 1) exit(bar.time + seconds, bar.close, 'end');
      }
      state.curve.push(state.cash + (state.position ? tradeCosts(bar.close, costs, 'sell').cash * state.position.qty : 0));
    }
    return state.index === candles.length;
  }
  function result(): BacktestResult {
    if (state.index !== candles.length) throw new Error('Backtest is still running.');
    let peak = budget.equity, maxDrawdown = 0, wins = 0, losses = 0, totalCosts = 0;
    for (const equity of state.curve) {
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
    for (const trade of state.trades) {
      wins += Math.max(0, trade.pnl);
      losses += Math.max(0, -trade.pnl);
      totalCosts += trade.cost;
    }
    const last = candles.at(-1)!;
    return { hash, initial: budget.equity, final: state.cash, maxDrawdown,
      benchmark: tradeCosts(last.close, costs, 'sell').cash / tradeCosts(candles[first].open, costs, 'buy').cash - 1,
      exposure: state.exposureBars / (candles.length - first),
      expectancy: state.trades.length ? (wins - losses) / state.trades.length : null,
      profitFactor: losses ? wins / losses : null, trades: state.trades, curve: state.curve, totalCosts,
      startTime: candles[first].time, endTime: last.time + seconds };
  }
  return { advance, state, result };
}
