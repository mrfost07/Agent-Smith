
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({
  stdin: { contents: [
    "export * from './src/trading/data'",
    "export * from './src/trading/analysis'",
    "export * from './src/trading/backtest'",
    "export * from './src/trading/types'",
    "export * from './src/trading/runner'",
    "export * from './src/trading/paper'",
    "export * from './src/trading/storage'",
    "export * from './src/content/expertoption-demo'",
  ].join(';'), resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const t = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// The content script must identify the selected account and re-read the actual DOM
// immediately before the browser press. Exercise those checks separately from the worker mock.
{
  class Control {
    constructor(text, attributes = {}) {
      this.innerText = text;
      this.attributes = attributes;
    }
    getAttribute(key) { return this.attributes[key] ?? null; }
    getBoundingClientRect() { return { width: 100, height: 40, left: 80, top: 80, right: 180, bottom: 120 }; }
    matches(selector) {
      if (selector.includes('aria-selected')) return this.attributes['aria-selected'] === 'true';
      if (selector.includes(':disabled')) return Boolean(this.disabled);
      return selector.startsWith('button');
    }
    closest() { return null; }
    contains(element) { return this === element; }
  }
  const demo = new Control('Demo Account');
  const real = new Control('Real Account', { 'aria-selected': 'true' });
  const up = new Control('Up');
  const down = new Control('Down');
  const asset = new Control('USD/CHF (OTC)', { 'aria-label': 'Asset' });
  const amount = new Control('$1', { 'aria-label': 'Trade amount' });
  const expiry = new Control('00:30', { 'aria-label': 'Expiry' });
  const controls = [demo, real, up, down, asset, amount, expiry];
  let hit = up;
  const globals = {
    window: {}, location: { href: 'https://app.expertoption.finance/' }, innerWidth: 800, innerHeight: 600,
    document: { visibilityState: 'visible', querySelectorAll: () => controls, elementFromPoint: () => hit },
    HTMLInputElement: class {}, HTMLSelectElement: class {},
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }),
  };
  globals.window.top = globals.window;
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    assert.equal(t.readDemoAccountMode(), 'real');
    assert.match(t.prepareDemoOrder('up').problem, /Real selected/);
    demo.attributes['aria-selected'] = 'true';
    assert.equal(t.readDemoAccountMode(), 'unknown');
    assert.equal(t.prepareDemoOrder('up').order, undefined);
    delete real.attributes['aria-selected'];
    assert.equal(t.readDemoAccountMode(), 'demo');
    const { order } = t.prepareDemoOrder('up');
    assert.equal(order.asset, 'USD/CHF (OTC)');
    assert.equal(order.amount, '$1');
    assert.equal(t.validateDemoOrder(order.token), true);
    expiry.innerText = '01:00';
    assert.equal(t.validateDemoOrder(order.token), false);
    expiry.innerText = '00:30';
    hit = real;
    assert.equal(t.validateDemoOrder(order.token), false);
    hit = up;
    real.attributes['aria-selected'] = 'true';
    assert.equal(t.validateDemoOrder(order.token), false);
    globals.location.href = 'https://app.expertoption.finance.example.org/';
    assert.equal(t.prepareDemoOrder('up').order, undefined);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const start = 1_700_002_800;
const time = i => start + i * 3600;
const bar = (i, close = 100) => ({ time: time(i), open: close, high: close + 1, low: close - 1, close, volume: 100 });
const base = Array.from({ length: 25 }, (_, i) => bar(i));
const instrument = { id: 'csv:BTC/USD', symbol: 'BTC/USD', quote: 'USD', venue: 'CSV', assetClass: 'crypto',
  market: 'spot', tick: 1, step: 1, minQty: 1, minValue: 10 };
const budget = { equity: 1000, currency: 'USD', percent: 5 };
const costs = { feeBps: 0, executionBps: 0 };
const strategy = t.defaultStrategy;

assert.equal(time(0) % 3600, 0);
const flat = t.indicatorSeries(base, 3600);
assert.ok(Math.abs(flat[13].atr - 2) < 1e-12);
assert.equal(flat[14].rsi, 50);
assert.equal(flat[18].ema20, undefined);
assert.ok(Math.abs(flat[19].ema20 - 100) < 1e-12);
assert.equal(t.indicatorSeries([...base, bar(28)], 3600).at(-1).ema20, undefined);

const candles = [...base, bar(25, 110)];
const snapshot = await t.snapshot(instrument, '1h', candles);
const analysis = t.analyze(snapshot, strategy, costs, budget);
const chartBeforeRefresh = {
  sessionId: 'saved-chart',
  analysis,
  drawings: [],
  job: { id: 'paused-replay', analysisId: analysis.id, status: 'stopped', budget, holdout: true },
};
const retainedJob = t.carryBacktest(chartBeforeRefresh);
const chartAfterRefresh = {
  ...chartBeforeRefresh,
  analysis: { ...analysis, id: 'refreshed-chart' },
  job: retainedJob,
};
assert.equal(t.resumableAnalysis(chartAfterRefresh), analysis);
assert.equal(retainedJob.source.instrument.id, analysis.snapshot.instrument.id);
assert.equal(retainedJob.source.interval, analysis.snapshot.interval);
assert.equal(t.carryBacktest(chartAfterRefresh), retainedJob);
assert.equal(t.resumableAnalysis({ ...chartAfterRefresh, job: { ...retainedJob, status: 'completed' } }), undefined);
assert.equal(analysis.signal, 'BUY');
assert.deepEqual([analysis.plan.entry, analysis.plan.stop, ...analysis.plan.targets], [110, 101, 128, 137]);
assert.equal(analysis.plan.quantity, 5);
assert.equal(analysis.plan.plannedLoss, 45);
assert.equal(t.analyze({ ...snapshot, stale: true }, strategy, costs, budget).signal, 'WAIT');
assert.equal(t.analyze(snapshot, strategy, costs, { ...budget, currency: 'PHP' }).plan.quantity, undefined);
assert.equal(t.analyze(snapshot, strategy, costs, { ...budget, equity: 1 }).plan.quantity, undefined);
assert.equal(t.makePlan(100, 100, strategy, instrument, costs, 0, budget), undefined);
assert.equal(t.makePlan(100, 99, strategy, instrument, { feeBps: 500, executionBps: 500 }, 0), undefined);

const both = { ...bar(26, 110), high: 130, low: 99 };
const historical = await t.snapshot(instrument, '1h', [...candles, both, bar(27)]);
const job = t.prepareBacktest({ ...analysis, snapshot: historical }, budget, false);
assert.equal(job.advance(4), false);
const resumed = t.prepareBacktest({ ...analysis, snapshot: historical }, budget, false, structuredClone(job.state));
assert.equal(resumed.advance(100), true);
assert.equal(resumed.result().trades[0].entryTime, time(26));
assert.equal(resumed.result().trades[0].reason, 'both');
assert.equal(resumed.result().final, 955);
assert.equal(resumed.result().trades.reduce((sum, trade) => sum + trade.pnl, 0), -45);
assert.equal(resumed.result().profitFactor, 0);
const withFuture = [...historical.candles, bar(28, 500)];
const compare = t.evaluate(withFuture, 25, t.indicatorSeries(withFuture, 3600), strategy, 3600, false);
assert.equal(compare.stop, 101);
assert.equal(compare.enter, true);
assert.equal(t.confirmedPivots([bar(0), bar(1), bar(2, 115), bar(3), bar(4)], 3, 3600).length, 0);
assert.equal(t.confirmedPivots([bar(0), bar(1), bar(2, 115), bar(3), bar(4)], 4, 3600).length, 1);
const aligned = Array.from({ length: 7 }, (_, i) => ({ ...bar(i), time: 1_699_992_000 + i * 3600 }));
assert.equal(aligned[0].time % 14400, 0);
assert.equal(t.completedHigherBars(aligned, '1h', '4h').length, 1);
assert.equal(t.completedHigherBars(aligned.filter((_, i) => i !== 2), '1h', '4h').length, 0);

const csv = 'time,open,high,low,close,volume\n' + time(0) + ',100,101,99,100,\n';
assert.equal(t.parseCsv(csv)[0].volume, null);
await assert.rejects(t.snapshot(instrument, '1h', [bar(0), bar(0)]), /unique/);
await assert.rejects(t.snapshot(instrument, '1h', [bar(0)], time(0) * 1000), /unfinished/);
assert.throws(() => t.parseCsv('time,open,high,low,close\n123,1,1,1'), /column count/);

const original = globalThis.fetch;
let calls = 0;
const now = Math.floor(Date.now() / 3_600_000) * 3600;
globalThis.fetch = async url => {
  calls++;
  if (calls === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '0' } });
  const result = url.includes('AssetPairs') ? {
    XXBTZUSD: { wsname: 'XBT/USD', tick_size: '0.1', lot_decimals: 8, ordermin: '0.0001', costmin: '1' },
  } : { XXBTZUSD: [[now - 3600, '100', '102', '98', '101', '100', '3'], [now, '101', '999', '99', '900', '100', '3']], last: now };
  return Response.json({ error: [], result });
};
try {
  const fetched = await t.fetchKraken('BTC/USD', '1h', new AbortController().signal);
  assert.equal(calls, 3);
  assert.equal(fetched.candles.length, 1);
  assert.equal(fetched.candles[0].close, 101);
  assert.equal(fetched.instrument.step, 1e-8);
  globalThis.fetch = async () => Response.json({ error: ['Unknown pair'], result: {} });
  await assert.rejects(t.fetchKraken('BTC/USD', '1h', new AbortController().signal), /could not return/);
} finally { globalThis.fetch = original; }

const signal = new AbortController().signal;
assert.match(await t.explainAnalysis(analysis, async () => '{"summary":"Momentum supports the breakout.","evidence":["momentum"]}', signal), /momentum/);
assert.equal(await t.explainAnalysis(analysis, async () => '{"summary":"Buy at 900.","evidence":["setup"]}', signal), undefined);
assert.equal(await t.explainAnalysis(analysis, async () => '{"summary":"Buy now.","evidence":["invented"]}', signal), undefined);
const controller = new AbortController();
await assert.rejects(t.explainAnalysis(analysis, async () => {
  controller.abort();
  return '{"summary":"Late","evidence":["trend"]}';
}, controller.signal), { name: 'AbortError' });

const sample = Array.from({ length: 1000 }, (_, i) => bar(i, 100 + Math.sin(i / 5)));
const sampleSnapshot = await t.snapshot(instrument, '1h', sample);
const tick = performance.now();
t.analyze(sampleSnapshot, strategy, costs, budget);
const calculationMs = performance.now() - tick;

const market = { ...instrument, venue: 'Kraken', id: 'kraken:XXBTZUSD' };
const anchor = Math.floor(Date.now() / 3_600_000) * 3600;
const currentBars = candles.map((c, i) => ({ ...c, time: anchor + (i - candles.length) * 3600 }));
const fresh = await t.snapshot(market, '1h', currentBars);
const paper = t.savePaper(t.analyze(fresh, strategy, costs, budget));
assert.ok(paper.observedThrough >= paper.savedAt);
const eligible = paper.observedThrough / 1000;
const before = { ...both, time: eligible - 3600 };
const after = { ...both, time: eligible };
const unseen = [before, after].filter(c => c.time > currentBars.at(-1).time);
const replay = await t.snapshot(market, '1h', [...currentBars, ...unseen], (eligible + 3600) * 1000);
const closed = t.updatePaper(paper, replay);
assert.equal(closed.entry.time, paper.observedThrough);
assert.equal(closed.exit.pnl, -45);
assert.match(closed.exit.reason, /both touched/);
assert.throws(() => t.updatePaper(paper, { ...replay, candles: [...currentBars, { ...after, time: eligible + 3600 }] }), /gap/);
console.log('Trading tests passed. Cached 1,000-candle calculation: ' + calculationMs.toFixed(1) + ' ms.');
