
import { prepareBacktest, type Checkpoint } from './backtest';
import type { Analysis, Budget } from './types';

self.onmessage = (event: MessageEvent<{ jobId: string; analysis: Analysis; budget: Budget; holdout: boolean; checkpoint?: Checkpoint }>) => {
  const { jobId, analysis, budget, holdout, checkpoint } = event.data;
  try {
    const job = prepareBacktest(analysis, budget, holdout, checkpoint);
    const step = () => {
      try {
        if (job.advance(500)) self.postMessage({ jobId, result: job.result() });
        else {
          self.postMessage({ jobId, checkpoint: job.state });
          setTimeout(step, 0);
        }
      } catch (error) {
        self.postMessage({ jobId, error: error instanceof Error ? error.message : 'Backtest failed.' });
      }
    };
    step();
  } catch (error) {
    self.postMessage({ jobId, error: error instanceof Error ? error.message : 'Backtest failed.' });
  }
};
