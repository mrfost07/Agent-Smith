
export const intervals = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 } as const;
export type Interval = keyof typeof intervals;
export const higherIntervals: Partial<Record<Interval, Interval>> = { '15m': '1h', '1h': '4h', '4h': '1d' };
export interface Candle {
  time: number; // UTC open, seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}
export interface Instrument {
  id: string;
  symbol: string;
  venue: 'Kraken' | 'CSV';
  assetClass: 'crypto' | 'equity' | 'forex';
  market: 'spot';
  quote: string;
  tick?: number;
  step?: number;
  minQty?: number;
  minValue?: number;
}
export interface Snapshot {
  instrument: Instrument;
  interval: Interval;
  candles: Candle[];
  hash: string;
  retrievedAt: number;
  latestClosedAt: number;
  stale: boolean;
  gaps: number;
  volumeUnit: 'base' | 'unknown';
}
export interface Strategy {
  id: 'breakout' | 'pullback';
  version: 1;
  lookback: number;
  atrMultiple: number;
  volumeFilter: boolean;
  reward: number;
}
export interface Costs { feeBps: number; executionBps: number }
export interface Budget { equity: number; percent: number; currency: string }
export interface Plan {
  entry: number;
  stop: number;
  targets: [number, number];
  expiresAt: number;
  grossR: number;
  netR: [number, number];
  riskPerUnit: number;
  quantity?: number;
  plannedLoss?: number;
  sizing: string;
}
export interface Features {
  close: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  rsi?: number;
  atr?: number;
  volumeMean?: number;
  support?: number;
  resistance?: number;
  trend: 'up' | 'down' | 'mixed';
  higher?: { interval: Interval; trend: Features['trend']; latestClosedAt: number };
  pivots: { time: number; price: number; side: 'high' | 'low' }[];
}
export interface Analysis {
  id: string;
  snapshot: Snapshot;
  strategy: Strategy;
  costs: Costs;
  budget?: Budget;
  status: 'ready' | 'no_setup' | 'stale_data' | 'insufficient_data';
  reason: string;
  features: Features;
  signal: 'BUY' | 'SELL' | 'WAIT';
  plan?: Plan;
  explanation?: string;
}
export const defaultCosts: Costs = { feeBps: 25, executionBps: 10 };
export const defaultStrategy: Strategy = {
  id: 'breakout', version: 1, lookback: 20, atrMultiple: 2, volumeFilter: false, reward: 2,
};
