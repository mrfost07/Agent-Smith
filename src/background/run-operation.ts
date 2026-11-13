/** Bound a browser request and stop waiting as soon as its run is cancelled. */
export function runOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => finish(signal?.reason ?? new Error('Run stopped.'));
    const timer = setTimeout(() => finish(new Error(label + ' timed out.')), timeoutMs);
    let settled = false;
    function finish(error?: unknown, value?: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return operation();
    }).then(value => finish(undefined, value), error => finish(error));
  });
}

export function waitForRun(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
