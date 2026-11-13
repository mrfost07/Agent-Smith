
import { analyze, makePlan } from './analysis';
import { fetchKraken, validateInterval, validateSymbol } from './data';
import { backtestSource, carryBacktest, changeTrading, readTrading } from './storage';
import { defaultCosts, defaultStrategy, intervals, type Analysis, type Budget, type Interval, type Snapshot } from './types';
import type { ChartCompletion } from './active-chart';

const pairPattern = /\b([A-Z0-9]{2,12}\/[A-Z0-9]{2,12})\b/i;
const intervalPattern = /\b(\d+[smhdw])\b/i;
const supportedIntervals = Object.keys(intervals).join(', ');
export const skills = {
  chart: { id: 'chart-analysis', version: 1, evidence: ['trend', 'momentum', 'levels'] },
  plan: { id: 'risk-plan', version: 1, evidence: ['setup', 'risk', 'costs'] },
  strategy: { id: 'strategy-design', version: 1, evidence: ['setup', 'trend', 'momentum'] },
  review: { id: 'backtest-review', version: 1, evidence: ['sample', 'costs', 'drawdown'] },
} as const;

function price(n: number): string {
  return n.toLocaleString('en-US', { maximumSignificantDigits: 10 });
}
export function summarize(analysis: Analysis): string {
  const { snapshot: s, features: f, plan, signal, reason, strategy, costs } = analysis;
  const source = s.instrument.venue === 'CSV' ? 'Historical CSV' : 'Kraken spot';
  const paragraphs = [
    s.instrument.symbol + ' · ' + s.interval + ' · ' + source + ' · ' + new Date(s.latestClosedAt).toISOString() + '\n\n' +
      '**' + signal + '** · ' + reason,
    'Trend ' + f.trend + '. Close ' + price(f.close) +
      (f.rsi === undefined ? '' : ', RSI ' + price(f.rsi)) +
      (f.support === undefined ? '' : ', support ' + price(f.support)) +
      (f.resistance === undefined ? '' : ', resistance ' + price(f.resistance)) + '.',
  ];
  if (s.gaps) paragraphs.push(s.gaps + ' missing intervals. Indicator warmup restarted after the last gap.');
  if (f.higher) paragraphs.push('Higher timeframe ' + f.higher.interval + ' trend ' + f.higher.trend +
    ' as of ' + new Date(f.higher.latestClosedAt).toISOString() + '.');
  if (plan) paragraphs.push(
    'Entry ' + price(plan.entry) + ' · SL ' + price(plan.stop) + ' · TP1 ' + price(plan.targets[0]) +
    ' · TP2 ' + price(plan.targets[1]) + '. Net reward/risk ' + plan.netR.map(r => r.toFixed(2) + 'R').join(' / ') +
    '. Invalidated at the stop or after ' + new Date(plan.expiresAt).toISOString() + '.',
    (plan.quantity === undefined ? '' : 'Paper quantity ' + price(plan.quantity) + '. Estimated loss ' +
      price(plan.plannedLoss!) + ' ' + s.instrument.quote + '. ') + plan.sizing,
  );
  paragraphs.push('Strategy ' + strategy.id + ' v' + strategy.version + '. Simulation costs per side are ' +
    costs.feeBps + ' bps fees and ' + costs.executionBps + ' bps execution.');
  if (analysis.explanation) paragraphs.push(analysis.explanation);
  return paragraphs.join('\n\n');
}

type Complete = ChartCompletion;

export async function explainAnalysis(analysis: Analysis, complete: Complete, signal: AbortSignal, intent: 'chart' | 'plan' | 'strategy' = 'chart') {
  const evidence = {
    trend: { primary: analysis.features.trend, higher: analysis.features.higher }, momentum: analysis.features.rsi,
    levels: { support: analysis.features.support, resistance: analysis.features.resistance },
    setup: { strategy: analysis.strategy.id, signal: analysis.signal, reason: analysis.reason },
    risk: analysis.plan ? { netR: analysis.plan.netR, sizing: analysis.plan.sizing } : undefined,
    costs: analysis.costs,
  };
  return explainEvidence(intent, evidence, complete, signal);
}

async function explainEvidence(intent: keyof typeof skills, evidence: Record<string, unknown>, complete: Complete, signal: AbortSignal) {
  const skill = skills[intent];
  try {
    const raw = await complete(
      'Explain the supplied technical analysis briefly for a paper trader. Return one JSON object with summary (plain text, up to 500 characters) and evidence (array of supplied evidence keys). Cite the evidence in that array. Describe conditions and conflicting evidence. Avoid numbers, invented data, guaranteed outcomes, URLs, markdown, and action instructions.',
      JSON.stringify({ skill: skill.id, version: skill.version, evidence }), signal,
    );
    signal.throwIfAborted();
    const reply = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
    if (typeof reply?.summary === 'string' && reply.summary.trim().length > 0 && reply.summary.length <= 500 &&
        !/[0-9<>{}\[\]`]/.test(reply.summary) && !/https?:|guarantee/i.test(reply.summary) &&
        Array.isArray(reply.evidence) && reply.evidence.length > 0 && reply.evidence.length <= 6 &&
        reply.evidence.every((key: unknown) => typeof key === 'string' && Object.hasOwn(evidence, key) && evidence[key] !== undefined)) {
      return reply.summary.trim() + ' (Evidence: ' + Array.from(new Set(reply.evidence)).join(', ') + '.)';
    }
  } catch {
    signal.throwIfAborted();
  }
  return undefined;
}

export async function marketSnapshot(symbol: string, interval: Interval, previous: Snapshot | undefined, signal: AbortSignal) {
  const same = previous?.instrument.venue === 'Kraken' && previous.instrument.symbol === symbol && previous.interval === interval;
  const now = Date.now();
  const expected = Math.floor((now - 60_000) / (intervals[interval] * 1000)) * intervals[interval] * 1000;
  if (same && !previous.stale && previous.latestClosedAt >= expected && now - previous.retrievedAt < 60_000) return previous;
  try { return await fetchKraken(symbol, interval, signal); }
  catch (error) {
    signal.throwIfAborted();
    if (same) return { ...previous, stale: true };
    throw error;
  }
}

export async function runTrading(goal: string, sessionId: string, options: {
  signal: AbortSignal;
  progress: (stage: string) => void;
  complete: Complete;
}): Promise<string> {
  const { signal, progress, complete } = options;
  const saved = await readTrading(sessionId);
  const prior = saved?.analysis;
  signal.throwIfAborted();
  const symbol = goal.match(pairPattern)?.[1]?.toUpperCase() ?? prior?.snapshot.instrument.symbol;
  const requestedInterval = goal.match(intervalPattern)?.[1]?.toLowerCase();
  if (requestedInterval && !Object.hasOwn(intervals, requestedInterval)) {
    return 'The candle-based tools do not support ' + requestedInterval + '. Choose ' + supportedIntervals + '.';
  }
  const interval = requestedInterval as Interval | undefined;
  const timeframe = interval ?? prior?.snapshot.interval;
  if (/\bbacktest\b/i.test(goal)) {
    const job = saved?.job;
    if (job?.result && /\b(?:review|explain|interpret|results?)\b/i.test(goal)) {
      const report = job.result;
      const source = job.source ?? (job.analysisId === prior?.id ? backtestSource(prior) : undefined);
      const evidence = { sample: { trades: report.trades.length, holdout: job.holdout },
        costs: { total: report.totalCosts, assumptions: source?.costs }, drawdown: report.maxDrawdown };
      progress('Reviewing backtest');
      const explanation = await explainEvidence('review', evidence, complete, signal);
      const pct = (value: number) => (100 * value).toFixed(2) + '%';
      return 'Saved backtest' + (source ? ' · ' + source.instrument.symbol + ' · ' + source.interval : '') +
        '\n\n' + report.trades.length + ' simulated trades. Net return ' + pct(report.final / report.initial - 1) +
        ', maximum drawdown ' + pct(report.maxDrawdown) + ', buy and hold ' + pct(report.benchmark) +
        ', estimated costs ' + report.totalCosts.toFixed(2) + ' ' + (source?.instrument.quote ?? job.budget.currency) + '.' +
        (explanation ? '\n\n' + explanation : '') + '\n\nOpen **Backtests and CSV** from the side panel menu to inspect the ledger.';
    }
    return 'Open **Backtests and CSV** from the side panel menu and select **Run backtest**. You can import a historical CSV there.';
  }
  if (prior && /\bwhy no buy\b/i.test(goal) && !goal.match(pairPattern) && !interval) {
    return 'From the saved analysis\n\n' + summarize(prior);
  }
  if (!symbol || !timeframe) return 'Ask me to analyze this chart while your chart is open, or specify a spot pair and timeframe, such as BTC/USD on Kraken, 1h.';
  if (/\b(?:binance|coinbase|bybit|okx|perpetual|futures)\b/i.test(goal)) {
    return 'Ask me to analyze the chart you have open, or use Kraken spot for candle-based calculations.';
  }
  const strategy = { ...(prior?.strategy ?? defaultStrategy) };
  if (/\bpullback\b/i.test(goal)) strategy.id = 'pullback';
  if (/\bbreakout\b/i.test(goal)) strategy.id = 'breakout';
  const costs = prior?.costs ?? defaultCosts;
  let budget: Budget | undefined = prior?.budget;
  const balance = goal.match(/\b(?:paper balance|paper equity)(?: of| is)?\s+([\d,.]+)\s+([A-Z]{2,8})\b/i);
  const risk = goal.match(/\brisk\s+([\d.]+)\s*%/i);
  if (balance && risk) budget = { equity: Number(balance[1].replace(/,/g, '')), currency: balance[2].toUpperCase(), percent: Number(risk[1]) };
  else if (risk && budget) budget = { ...budget, percent: Number(risk[1]) };
  else if (balance || risk) return 'Enter both your paper balance in the quote currency and your risk percentage.';
  progress('Loading candles');
  const sameCsv = prior?.snapshot.instrument.venue === 'CSV' && symbol === prior.snapshot.instrument.symbol &&
    timeframe === prior.snapshot.interval && !/\bkraken\b/i.test(goal);
  if (prior?.snapshot.instrument.venue === 'CSV' && !sameCsv && !/\bkraken\b/i.test(goal)) {
    return 'Import CSV candles for the requested pair and timeframe, or explicitly select Kraken spot.';
  }
  let snapshot: Snapshot;
  try {
    snapshot = sameCsv ? prior.snapshot : await marketSnapshot(validateSymbol(symbol), validateInterval(timeframe), prior?.snapshot, signal);
  } catch (error) {
    signal.throwIfAborted();
    return (error instanceof Error ? error.message : 'Market data unavailable.') + ' If you have the chart open, ask me to analyze this chart.';
  }
  signal.throwIfAborted();
  progress('Calculating levels');
  const paper = saved?.paper;
  const result = analyze(snapshot, strategy, costs, budget, paper?.status === 'open' &&
    paper.instrumentId === snapshot.instrument.id && paper.interval === timeframe);
  const nextResistance = /\b(?:tp[12]?|target)\b.*\bnext resistance\b/i.test(goal);
  if (nextResistance) {
    const target = result.features.resistance;
    if (result.plan && target !== undefined) {
      const revised = makePlan(result.plan.entry, result.plan.stop, strategy, snapshot.instrument,
        costs, result.plan.expiresAt, budget, target);
      if (revised) result.plan = revised;
      else result.reason += ' The next resistance cannot serve as TP2 above TP1.';
    } else result.reason += ' No confirmed resistance is available for this target change.';
  }
  progress('Writing analysis');
  result.explanation = await explainAnalysis(result, complete, signal, balance || risk ? 'plan' : /\bstrategy\b/i.test(goal) ? 'strategy' : 'chart');
  await changeTrading(sessionId, current => {
    if (current?.analysis.id !== prior?.id) throw new Error('The chart changed during analysis. Try again with the current chart.');
    const sameMarket = current?.analysis.snapshot.instrument.id === snapshot.instrument.id &&
      current.analysis.snapshot.interval === snapshot.interval;
    return { sessionId, analysis: result, drawings: sameMarket ? current.drawings : [],
      paper: current?.paper, job: carryBacktest(current) };
  }, signal);
  return summarize(result);
}
