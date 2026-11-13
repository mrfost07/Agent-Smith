
import { analyze } from './analysis';
import { parseCsv, snapshot, validateInterval, validateSymbol } from './data';
import { TradingPlot } from './plot';
import { marketSnapshot, summarize } from './runner';
import { backtestSource, carryBacktest, changeTrading, readTrading, resumableAnalysis, type Drawing, type SavedJob, type TradingState } from './storage';
import { savePaper, updatePaper } from './paper';
import type { BacktestResult, Checkpoint } from './backtest';
import { intervals, type Analysis, type Budget, type Costs, type Instrument, type Strategy } from './types';

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => get<HTMLInputElement>(id);
const button = (id: string) => get<HTMLButtonElement>(id);
const value = (id: string) => input(id).value.trim();
const num = (id: string) => input(id).valueAsNumber;
const selected = new URLSearchParams(location.search).get('session');
const sessionId = selected && /^[a-f0-9-]{36}$/i.test(selected) ? selected : 'workspace';
const status = (text: string) => { get('status').textContent = text; };
let state: TradingState | undefined;
let active: AbortController | undefined;
let worker: Worker | undefined;
let jobId: string | undefined;
let writes: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work);
  writes = next.catch(() => {});
  return next;
}
function showError(error: unknown) { status(error instanceof Error ? error.message : 'Trading operation failed.'); }
function busy(value: boolean) {
  button('stop').disabled = !value;
  for (const element of document.querySelectorAll<HTMLButtonElement>('form button, #paper, #paper-update, #backtest, #resume')) element.disabled = value;
  input('csv').disabled = value;
  if (!value) refreshControls();
}
function refreshControls() {
  const paper = state?.paper;
  const plan = state?.analysis.plan;
  button('paper').disabled = Boolean(active || worker || !plan?.quantity || state?.analysis.snapshot.instrument.venue !== 'Kraken' ||
    plan.expiresAt <= Date.now() || (paper && ['pending', 'open'].includes(paper.status)));
  button('paper-update').disabled = Boolean(active || worker || !paper || !['pending', 'open'].includes(paper.status));
  button('paper-cancel').disabled = Boolean(active || worker || paper?.status !== 'pending');
  button('resume').disabled = Boolean(active || worker || !resumableAnalysis(state));
}
const plot = new TradingPlot(get<HTMLCanvasElement>('chart'), anchors => void addDrawing(anchors));
function strategy(): Strategy {
  return { id: value('strategy') as Strategy['id'], version: 1, lookback: num('lookback'),
    atrMultiple: num('atr'), reward: num('reward'), volumeFilter: input('volume').checked };
}
function costs(): Costs { return { feeBps: num('fee'), executionBps: num('execution') }; }
function budget(quote: string): Budget | undefined {
  if (!value('equity') && !value('risk')) return;
  const currency = value('currency').toUpperCase();
  if (currency !== quote) throw new Error('Enter the paper balance currency as ' + quote + '.');
  return { equity: num('equity'), percent: num('risk'), currency };
}
function metadata(symbol: string): Instrument {
  const optional = (id: string, positive: boolean) => {
    if (!value(id)) return undefined;
    const n = num(id);
    if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) throw new Error('Invalid CSV order metadata.');
    return n;
  };
  return { id: 'csv:' + symbol, symbol, venue: 'CSV', assetClass: value('asset') as Instrument['assetClass'], market: 'spot',
    quote: symbol.split('/')[1], tick: optional('tick', true), step: optional('qty-step', true),
    minQty: optional('qty-min', false), minValue: optional('notional', false) };
}

function render(next: TradingState, fillInputs = false) {
  state = next;
  const { analysis, drawings, job, paper } = next;
  const { snapshot: s } = analysis;
  if (fillInputs) {
    const fields: Record<string, string | number | undefined> = {
      symbol: s.instrument.symbol, interval: s.interval, strategy: analysis.strategy.id,
      lookback: analysis.strategy.lookback, atr: analysis.strategy.atrMultiple, reward: analysis.strategy.reward,
      fee: analysis.costs.feeBps, execution: analysis.costs.executionBps,
      equity: analysis.budget?.equity, risk: analysis.budget?.percent,
      currency: analysis.budget?.currency,
    };
    if (s.instrument.venue === 'CSV') Object.assign(fields, { tick: s.instrument.tick, 'qty-step': s.instrument.step,
      'qty-min': s.instrument.minQty, notional: s.instrument.minValue, asset: s.instrument.assetClass });
    for (const [id, v] of Object.entries(fields)) input(id).value = v === undefined ? '' : String(v);
    input('volume').checked = analysis.strategy.volumeFilter;
  }
  get('workspace').hidden = false;
  const intervalMs = intervals[s.interval] * 1000;
  const stale = s.instrument.venue === 'Kraken' &&
    (s.stale || s.latestClosedAt < Math.floor((Date.now() - 60_000) / intervalMs) * intervalMs);
  const visible: Analysis = stale ? { ...analysis, plan: undefined, signal: 'WAIT', status: 'stale_data',
    explanation: undefined, reason: 'Saved candles are stale. Refresh Kraken before evaluating a new setup.' } : analysis;
  plot.set(visible, drawings);
  get('analysis').replaceChildren(...summarize(visible).split('\n\n').map(text => {
    const p = document.createElement('p'); p.textContent = text.replace(/\*\*/g, ''); return p;
  }));
  get('drawings').replaceChildren(...drawings.map(drawing => {
    const li = document.createElement('li');
    li.textContent = drawing.anchors.filter(anchor => anchor !== undefined).map(anchor => anchor.price.toPrecision(8) +
      (drawing.anchors[1] ? ' at ' + new Date(anchor.time * 1000).toISOString() : '')).join(' to ');
    const remove = document.createElement('button'); remove.textContent = 'Delete';
    remove.addEventListener('click', () => void editDrawings(items => items.filter(item => item.id !== drawing.id)));
    li.append(remove); return li;
  }));
  get('paper-status').textContent = paper
    ? 'Paper ' + paper.status + '. ' + (paper.status === 'pending' ? 'First eligible bar ' : 'Evaluated through ') +
      new Date(paper.observedThrough).toISOString() + '. ' +
      (paper.entry ? 'Simulated entry ' + paper.entry.price.toPrecision(8) + ', quantity ' + paper.entry.quantity + '. ' : '') +
      (paper.exit ? 'Exit ' + paper.exit.price.toPrecision(8) + ', P/L ' + paper.exit.pnl.toFixed(2) + ' (' + paper.exit.reason + '). ' : '') +
      'Select Evaluate paper setup to replay new closed bars.'
    : 'Paper setups are evaluated manually using closed candles.';
  refreshControls();
  if (job?.result) renderReport(job);
  else get('report').hidden = true;
}

async function replaceAnalysis(analysis: Analysis, controller: AbortController, previousId?: string) {
  const next = await enqueue(() => changeTrading(sessionId, current => {
    if (current?.analysis.id !== previousId) throw new Error('The saved analysis changed. Reload Trading before replacing it.');
    const same = current?.analysis.snapshot.instrument.id === analysis.snapshot.instrument.id &&
      current.analysis.snapshot.interval === analysis.snapshot.interval;
    return { sessionId, analysis, drawings: same ? current.drawings : [], paper: current?.paper, job: carryBacktest(current) };
  }, controller.signal));
  if (active === controller && next) render(next, true);
}
async function run(work: (controller: AbortController) => Promise<void>) {
  if (active || worker) return;
  const controller = new AbortController();
  active = controller;
  busy(true);
  try { await work(controller); }
  catch (error) { if (!controller.signal.aborted) showError(error); }
  finally { if (active === controller) { active = undefined; busy(false); } }
}

get('market').addEventListener('submit', event => {
  event.preventDefault();
  void run(async controller => {
    const symbol = validateSymbol(value('symbol')), interval = validateInterval(value('interval'));
    const options = [strategy(), costs(), budget(symbol.split('/')[1])] as const;
    const previous = state?.analysis;
    status('Loading Kraken candles');
    const data = await marketSnapshot(symbol, interval, previous?.snapshot, controller.signal);
    controller.signal.throwIfAborted();
    status('Calculating levels');
    await replaceAnalysis(analyze(data, ...options, state?.paper?.status === 'open' &&
      state.paper.instrumentId === data.instrument.id && state.paper.interval === interval), controller, previous?.id);
    status(data.stale ? 'Showing stale Kraken data' : 'Closed candles loaded');
  });
});
input('csv').addEventListener('change', () => {
  const file = input('csv').files?.[0];
  input('csv').value = '';
  if (!file) return;
  void run(async controller => {
    if (file.size > 4_000_000) throw new Error('CSV is larger than 4 MB.');
    const instrument = metadata(validateSymbol(value('symbol')));
    const interval = validateInterval(value('interval'));
    const previous = state?.analysis.id;
    const options = [strategy(), costs(), budget(instrument.quote)] as const;
    status('Reading historical candles');
    const data = await snapshot(instrument, interval, parseCsv(await file.text()));
    await replaceAnalysis(analyze(data, ...options), controller, previous);
    status('Historical CSV loaded');
  });
});
get('settings').addEventListener('submit', event => {
  event.preventDefault();
  void run(async controller => {
    const previous = state?.analysis;
    if (!previous) throw new Error('Load candles before applying strategy settings.');
    const s = previous.snapshot;
    const data = s.instrument.venue === 'CSV' ? await snapshot(metadata(s.instrument.symbol), s.interval, s.candles) : s;
    const fresh = s.instrument.venue === 'Kraken' ? await marketSnapshot(s.instrument.symbol, s.interval, data, controller.signal) : data;
    const paper = state?.paper;
    await replaceAnalysis(analyze(fresh, strategy(), costs(), budget(fresh.instrument.quote),
      paper?.status === 'open' && paper.instrumentId === fresh.instrument.id && paper.interval === fresh.interval), controller, previous.id);
    status('Strategy settings applied');
  });
});

async function editDrawings(edit: (drawings: Drawing[]) => Drawing[]) {
  const id = state?.analysis.id;
  try {
    const next = await enqueue(() => changeTrading(sessionId, current => {
      if (!current || current.analysis.id !== id) throw new Error('The chart changed. Reload before editing its drawings.');
      return { ...current, drawings: edit(current.drawings).slice(-100) };
    }));
    if (next) render(next);
  } catch (error) { showError(error); }
}
async function addDrawing(anchors: Drawing['anchors']) {
  if (anchors.some(anchor => !anchor || !Number.isFinite(anchor.price) || anchor.price <= 0 ||
      !Number.isSafeInteger(anchor.time) || Math.abs(anchor.time) > 8.64e12)) {
    status('Enter a positive price and valid UTC timestamps.');
    return;
  }
  if (anchors[1]?.time === anchors[0].time) { status('Trendline anchors need different timestamps.'); return; }
  await editDrawings(items => [...items, { id: crypto.randomUUID(), createdAt: Date.now(), anchors }]);
}
const plotActions: Record<string, () => void> = {
  'zoom-in': () => plot.zoom(0.8), 'zoom-out': () => plot.zoom(1.2),
  earlier: () => plot.pan(-1), later: () => plot.pan(1),
  undo: () => void editDrawings(items => items.slice(0, -1)),
};
for (const [id, action] of Object.entries(plotActions)) button(id).addEventListener('click', action);
for (const [id, mode] of [['horizontal', 'price'], ['trendline', 'trend']] as const) {
  button(id).addEventListener('click', () => {
    const on = button(id).getAttribute('aria-pressed') !== 'true';
    button('horizontal').setAttribute('aria-pressed', String(on && mode === 'price'));
    button('trendline').setAttribute('aria-pressed', String(on && mode === 'trend'));
    plot.drawMode(on ? mode : undefined);
    status(on ? mode === 'price' ? 'Select a price on the chart' : 'Select two points on the chart' : 'Drawing mode off');
  });
}
get('drawing').addEventListener('submit', event => {
  event.preventDefault();
  const fallback = state?.analysis.snapshot.candles.at(-1)?.time ?? NaN;
  const utc = (id: string) => /Z$/i.test(value(id)) ? Date.parse(value(id)) / 1000 : NaN;
  const a = { time: value('time-a') ? utc('time-a') : fallback, price: num('price-a') };
  void addDrawing(value('price-b') || value('time-b') ? [a, { time: utc('time-b'), price: num('price-b') }] : [a]);
});

button('paper').addEventListener('click', () => void run(async controller => {
  const id = state?.analysis.id;
  const next = await changeTrading(sessionId, current => {
    if (!current || current.analysis.id !== id || (current.paper && ['pending', 'open'].includes(current.paper.status))) {
      throw new Error('The saved analysis changed or a paper setup is already active.');
    }
    return { ...current, paper: savePaper(current.analysis) };
  }, controller.signal);
  if (next) render(next);
  status('Paper setup saved. Use Evaluate paper setup after the next candle closes.');
}));
button('paper-update').addEventListener('click', () => void run(async controller => {
  const paper = state?.paper;
  const current = state?.analysis;
  if (!paper || !current) return;
  status('Loading candles for paper replay');
  if (paper.instrumentId !== current.snapshot.instrument.id) throw new Error('Open the original paper market before replay.');
  const data = await marketSnapshot(current.snapshot.instrument.symbol, paper.interval, current.snapshot, controller.signal);
  const next = await changeTrading(sessionId, saved => {
    if (!saved?.paper || saved.paper.savedAt !== paper.savedAt) throw new Error('The saved paper setup changed.');
    return { ...saved, paper: updatePaper(saved.paper, data) };
  }, controller.signal);
  if (next) render(next);
  status('Paper replay evaluated');
}));
button('paper-cancel').addEventListener('click', () => void run(async controller => {
  const id = state?.paper?.savedAt;
  const next = await changeTrading(sessionId, current => {
    if (!current || current.paper?.status !== 'pending' || current.paper.savedAt !== id) {
      throw new Error('The pending paper setup has changed.');
    }
    return { ...current, paper: { ...current.paper, status: 'expired' } };
  }, controller.signal);
  if (next) render(next);
  status('Pending paper setup canceled');
}));

function renderReport(job: SavedJob) {
  const report = job.result!;
  const source = job.source ?? (state?.analysis.id === job.analysisId ? backtestSource(state.analysis) : undefined);
  const host = get('report');
  host.hidden = false;
  const title = document.createElement('h2');
  title.textContent = source ? 'Backtest · ' + source.instrument.symbol + ' · ' + source.interval : 'Backtest';
  const summary = document.createElement('p');
  const pct = (n: number) => (100 * n).toFixed(2) + '%';
  summary.textContent = [
    'Return ' + pct(report.final / report.initial - 1), 'Drawdown ' + pct(report.maxDrawdown),
    'Buy and hold ' + pct(report.benchmark), 'Exposure ' + pct(report.exposure),
    report.trades.length + ' trades', 'Costs ' + report.totalCosts.toFixed(2),
    'Expectancy ' + (report.expectancy?.toFixed(2) ?? 'N/A'), 'Profit factor ' + (report.profitFactor?.toFixed(2) ?? 'N/A'),
  ].join(' · ');
  const meta = document.createElement('p');
  meta.textContent = new Date(report.startTime * 1000).toISOString() + ' to ' + new Date(report.endTime * 1000).toISOString() +
    ' · Dataset ' + report.hash.slice(0, 12) + '. Entry at next open, exit at TP1 or stop. Stop first when both touch.';
  const table = document.createElement('table');
  const row = (cells: string[], header = false) => {
    const tr = table.insertRow();
    for (const text of cells) {
      const td = document.createElement(header ? 'th' : 'td'); td.textContent = text; tr.append(td);
    }
  };
  row(['Entry UTC', 'Exit bar UTC', 'Entry', 'Exit', 'Quantity', 'Net P/L', 'Fees', 'Exit reason'], true);
  for (const t of report.trades.slice(-200)) row([new Date(t.entryTime * 1000).toISOString(), new Date(t.exitTime * 1000).toISOString(),
    t.entry.toPrecision(8), t.exit.toPrecision(8), t.quantity.toPrecision(8), t.pnl.toFixed(2), t.fees.toFixed(2), t.reason]);
  const download = document.createElement('button'); download.textContent = 'Export full report';
  download.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ source: source?.instrument, interval: source?.interval,
      strategy: source?.strategy, costs: source?.costs, budget: job.budget, holdout: job.holdout, ...report }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'smith-backtest-' + report.hash.slice(0, 12) + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  host.replaceChildren(title, summary, meta, download, table);
}
async function saveJob(id: string, edit: (job: SavedJob) => SavedJob) {
  return enqueue(() => changeTrading(sessionId, current => current?.job?.id === id
    ? { ...current, job: edit(current.job) } : current));
}
async function runBacktest(resume: boolean) {
  if (active || worker || !state) return;
  const chartState = state;
  const analysis = resume ? resumableAnalysis(chartState) : chartState.analysis;
  if (!analysis) return;
  const controller = new AbortController();
  active = controller;
  busy(true);
  try {
    const previous = resume ? chartState.job : undefined;
    const sizing = previous?.budget ?? budget(analysis.snapshot.instrument.quote);
    if (!sizing) throw new Error('Enter paper balance and risk before running the backtest.');
    const job: SavedJob = { id: crypto.randomUUID(), analysisId: analysis.id, status: 'running',
      budget: sizing, holdout: previous?.holdout ?? input('holdout').checked, checkpoint: previous?.checkpoint,
      source: previous?.source ?? backtestSource(analysis), replay: previous?.replay };
    const next = await enqueue(() => changeTrading(sessionId, current => {
      if (!current || current.analysis.id !== chartState.analysis.id || current.job?.id !== chartState.job?.id) {
        throw new Error('Analysis or job changed. Reload Trading.');
      }
      return { ...current, job };
    }, controller.signal));
    if (controller.signal.aborted) return;
    if (next) render(next);
    const instance = new Worker(new URL('./worker.js', location.href), { type: 'module' });
    worker = instance;
    jobId = job.id;
    active = undefined;
    status('Running historical replay');
    const finish = async (error?: string, result?: BacktestResult) => {
      if (worker !== instance) return;
      instance.terminate();
      worker = undefined;
      jobId = undefined;
      active = controller;
      try {
        const latest = await saveJob(job.id, old => ({
          ...old, checkpoint: undefined, replay: undefined, status: error ? 'failed' : 'completed', result,
        }));
        if (latest?.job?.id === job.id) {
          render(latest);
          status(error ?? 'Backtest complete');
        } else status('The saved analysis changed while the backtest ran.');
      } catch (failure) { showError(failure); }
      finally { if (active === controller) { active = undefined; busy(false); } }
    };
    instance.onerror = () => void finish('The backtest worker could not run.');
    instance.onmessage = (event: MessageEvent<{ jobId: string; checkpoint?: Checkpoint; result?: BacktestResult; error?: string }>) => {
      if (worker !== instance || event.data.jobId !== job.id) return;
      const { checkpoint, result, error } = event.data;
      if (checkpoint) {
        status('Replayed ' + checkpoint.index + ' of ' + analysis.snapshot.candles.length + ' candles');
        void saveJob(job.id, old => ({ ...old, checkpoint })).catch(() => void finish('The backtest checkpoint could not be saved.'));
      } else void finish(error, result);
    };
    instance.postMessage({ jobId: job.id, analysis, budget: sizing, holdout: job.holdout, checkpoint: job.checkpoint });
  } catch (error) { if (!controller.signal.aborted) showError(error); }
  finally { if (active === controller && !worker) { active = undefined; busy(false); } }
}
button('backtest').addEventListener('click', () => void runBacktest(false));
button('resume').addEventListener('click', () => void runBacktest(true));
button('stop').addEventListener('click', () => {
  const id = jobId;
  active?.abort();
  active = undefined;
  worker?.terminate();
  worker = undefined;
  jobId = undefined;
  status('Stopped');
  busy(false);
  if (id) void saveJob(id, old => ({ ...old, status: 'stopped' })).then(next => {
    if (next?.job?.id === id && !active && !worker) render(next);
  }).catch(showError);
});
addEventListener('pagehide', () => { active?.abort(); worker?.terminate(); });
get('scope').textContent = sessionId === 'workspace' ? 'Local workspace' : 'Conversation workspace';
void readTrading(sessionId).then(saved => {
  if (saved && !active && !worker) {
    render(saved, true);
    status(saved.job?.status === 'running' ? 'Previous backtest interrupted. Resume from its saved progress.' : 'Saved analysis loaded');
  }
}).catch(showError);
