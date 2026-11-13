
import { getDb } from '../shared/db';
import type { BacktestResult, Checkpoint } from './backtest';
import type { Analysis, Budget, Costs, Instrument, Interval, Strategy } from './types';
import type { PaperSetup } from './paper';

export interface Anchor { time: number; price: number }
export interface Drawing { id: string; anchors: [Anchor, Anchor?]; createdAt: number }
export interface SavedJob {
  id: string;
  analysisId: string;
  budget: Budget;
  holdout: boolean;
  status: 'running' | 'stopped' | 'completed' | 'failed';
  checkpoint?: Checkpoint;
  result?: BacktestResult;
  source?: BacktestSource;
  replay?: Analysis;
}
export interface BacktestSource {
  instrument: Instrument;
  interval: Interval;
  strategy: Strategy;
  costs: Costs;
}
export interface TradingState {
  sessionId: string;
  analysis: Analysis;
  drawings: Drawing[];
  paper?: PaperSetup;
  job?: SavedJob;
}

export function backtestSource(analysis: Analysis): BacktestSource {
  return { instrument: analysis.snapshot.instrument, interval: analysis.snapshot.interval,
    strategy: analysis.strategy, costs: analysis.costs };
}

export function carryBacktest(state?: TradingState): SavedJob | undefined {
  const job = state?.job;
  if (!job || job.analysisId !== state?.analysis.id) return job;
  return {
    ...job,
    source: job.source ?? backtestSource(state.analysis),
    replay: job.status === 'running' || job.status === 'stopped' ? job.replay ?? state.analysis : undefined,
  };
}

export function resumableAnalysis(state?: TradingState): Analysis | undefined {
  const job = state?.job;
  if (job?.status !== 'running' && job?.status !== 'stopped') return;
  if (job.replay?.id === job.analysisId) return job.replay;
  if (state?.analysis.id === job.analysisId) return state.analysis;
}

export async function readTrading(sessionId: string): Promise<TradingState | undefined> {
  return (await getDb()).get('trading', sessionId);
}
export async function changeTrading(sessionId: string, update: (state?: TradingState) => TradingState | undefined,
  signal?: AbortSignal): Promise<TradingState | undefined> {
  signal?.throwIfAborted();
  const db = await getDb();
  const tx = db.transaction(['sessions', 'trading'], 'readwrite');
  const done = tx.done.catch(error => { if (!signal?.aborted) return error; });
  const abort = () => { try { tx.abort(); } catch { /* already committed */ } };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (sessionId !== 'workspace' && !await tx.objectStore('sessions').get(sessionId)) {
      throw new Error('This conversation no longer exists.');
    }
    const store = tx.objectStore('trading');
    const previous = await store.get(sessionId);
    signal?.throwIfAborted();
    const next = update(previous);
    if (next && next !== previous) await store.put(next);
    const error = await done;
    if (error) throw error;
    signal?.throwIfAborted();
    return next;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
