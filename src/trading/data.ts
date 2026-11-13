
import { intervals, type Candle, type Instrument, type Interval, type Snapshot } from './types';

export const MAX_BARS = 20_000;
export function validateSymbol(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-z0-9]{2,12}\/[a-z0-9]{2,12}$/i.test(raw.trim())) {
    throw new Error('Enter the base/quote symbol, such as BTC/USD.');
  }
  return raw.trim().toUpperCase();
}
export function validateInterval(raw: unknown): Interval {
  if (typeof raw !== 'string' || !Object.hasOwn(intervals, raw)) throw new Error('Choose 15m, 1h, 4h or 1d.');
  return raw as Interval;
}
function number(raw: unknown): number {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw))) return NaN;
  return Number(raw);
}
export async function snapshot(instrument: Instrument, interval: Interval, candles: Candle[], now = Date.now()): Promise<Snapshot> {
  const step = intervals[interval];
  if (!candles.length || candles.length > MAX_BARS) throw new Error('Import between 1 and 20,000 closed candles.');
  let gaps = 0;
  let previous: number | undefined;
  for (const bar of candles) {
    const { time, open, high, low, close, volume } = bar;
    if (!Number.isSafeInteger(time) || time <= 0 || time % step !== 0 || (time + step) * 1000 > now ||
        ![open, high, low, close].every(p => Number.isFinite(p) && p > 0 && p <= 1e12) ||
        low > Math.min(open, close) || high < Math.max(open, close) ||
        (volume !== null && (!Number.isFinite(volume) || volume < 0 || volume > 1e18))) {
      throw new Error('Invalid OHLCV or unfinished candle at timestamp ' + time + '.');
    }
    if (previous !== undefined) {
      if (time <= previous) throw new Error('Candles must have unique, ascending timestamps.');
      gaps += (time - previous) / step - 1;
    }
    previous = time;
  }
  const latestClosedAt = (candles.at(-1)!.time + step) * 1000;
  const bytes = new TextEncoder().encode(JSON.stringify([instrument, interval, candles]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return {
    instrument, interval, candles, hash, gaps, latestClosedAt, retrievedAt: now,
    stale: instrument.venue === 'Kraken' && latestClosedAt < Math.floor((now - 60_000) / (step * 1000)) * step * 1000,
    volumeUnit: instrument.venue === 'Kraken' ? 'base' : 'unknown',
  };
}

export function parseCsv(csv: string): Candle[] {
  if (csv.length > 4_000_000) throw new Error('CSV is larger than 4 MB.');
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const fields = (line: string) => line.split(',').map(value => value.trim().replace(/^"([^"]*)"$/, '$1'));
  const names = fields(lines.shift() ?? '').map(name => name.toLowerCase());
  const indices = ['time', 'open', 'high', 'low', 'close', 'volume'].map(name => names.indexOf(name));
  if (indices[0] < 0) indices[0] = names.indexOf('timestamp');
  if (new Set(names).size !== names.length || indices.slice(0, 5).includes(-1) || lines.length > MAX_BARS) {
    throw new Error('Use a CSV header with time,open,high,low,close and optional volume (20,000 rows maximum).');
  }
  return lines.map((line, index) => {
    const cells = fields(line);
    if (cells.length !== names.length) throw new Error('Unexpected column count on row ' + (index + 2) + '.');
    const [stamp, open, high, low, close, volume] = indices.map(i => cells[i]);
    const time = /^\d{10}$/.test(stamp) ? Number(stamp)
      : /^\d{13}$/.test(stamp) ? Number(stamp) / 1000
      : /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(stamp)
        ? Date.parse(stamp) / 1000 : NaN;
    return { time, open: number(open), high: number(high), low: number(low), close: number(close),
      volume: volume ? number(volume) : null };
  });
}

type Payload = Record<string, unknown>;
async function kraken(endpoint: 'AssetPairs' | 'OHLC', params: URLSearchParams, signal: AbortSignal): Promise<Payload> {
  const url = 'https://api.kraken.com/0/public/' + endpoint + '?' + params.toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(6500)]),
        credentials: 'omit', redirect: 'error',
      });
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 400;
        if (!Number.isFinite(delay) || delay > 2500) throw new Error('Kraken asked to retry later.');
        await delayWithAbort(Math.max(0, delay), signal);
        continue;
      }
      if (!response.ok) throw new Error('Kraken market data returned HTTP ' + response.status + '.');
      const body = await response.json();
      if (!Array.isArray(body?.error) || body.error.length || !body.result || typeof body.result !== 'object') {
        throw new Error('Kraken could not return this market. Check the pair or import a CSV.');
      }
      return body.result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
        if (attempt === 0) continue;
        throw new Error('Kraken is unreachable. Try again or import a CSV.');
      }
      throw error;
    }
  }
  throw new Error('Kraken market data is temporarily unavailable.');
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

interface Pair { wsname?: string; altname?: string; tick_size?: string; lot_decimals?: number; ordermin?: string; costmin?: string; status?: string }
const pairAlias = (symbol: string) => symbol.toUpperCase().replace(/\bXBT\b/g, 'BTC');
export async function fetchKraken(symbol: string, interval: Interval, signal: AbortSignal): Promise<Snapshot> {
  const wanted = validateSymbol(symbol);
  const result = await kraken('AssetPairs', new URLSearchParams({ pair: wanted.replace('/', '') }), signal);
  const match = Object.entries(result).find(([, pair]) => {
    const wsname = (pair as Pair | null)?.wsname;
    return typeof wsname === 'string' && pairAlias(wsname) === pairAlias(wanted);
  });
  if (!match) throw new Error('No matching Kraken spot pair. Confirm the base and quote currencies.');
  const [key, raw] = match;
  const pair = raw as Pair;
  const tick = number(pair.tick_size);
  const minQty = number(pair.ordermin);
  const minValue = number(pair.costmin);
  const step = Number.isInteger(pair.lot_decimals) && pair.lot_decimals! >= 0 && pair.lot_decimals! <= 12
    ? 10 ** -pair.lot_decimals! : undefined;
  const instrument: Instrument = {
    id: 'kraken:' + key, symbol: wanted, venue: 'Kraken', assetClass: 'crypto', market: 'spot',
    quote: wanted.split('/')[1], tick: tick > 0 ? tick : undefined, step,
    minQty: minQty > 0 ? minQty : undefined, minValue: minValue > 0 ? minValue : undefined,
  };
  const ohlc = await kraken('OHLC', new URLSearchParams({ pair: key, interval: String(intervals[interval] / 60) }), signal);
  const rows = ohlc[key];
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('Kraken did not return closed candles for the requested pair.');
  return snapshot(instrument, interval, rows.slice(0, -1).map((row: unknown[]) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error('Kraken returned a malformed candle.');
    return { time: number(row[0]), open: number(row[1]), high: number(row[2]), low: number(row[3]),
      close: number(row[4]), volume: number(row[6]) };
  }));
}
