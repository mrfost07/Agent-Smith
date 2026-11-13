
import { indicatorSeries } from './analysis';
import type { Anchor, Drawing } from './storage';
import { intervals, type Analysis } from './types';

export class TradingPlot {
  private view?: Analysis;
  private drawings: Drawing[] = [];
  private size = 100;
  private end = 0;
  private projection?: { left: number; right: number; top: number; bottom: number; time: number; high: number; low: number; dx: number; seconds: number };
  private drag?: { x: number; end: number };
  private mode?: 'price' | 'trend';
  private first?: Anchor;
  private indicators?: ReturnType<typeof indicatorSeries>;

  constructor(private canvas: HTMLCanvasElement, private add: (anchors: Drawing['anchors']) => void) {
    new ResizeObserver(() => this.paint()).observe(canvas);
    canvas.addEventListener('wheel', event => { event.preventDefault(); this.zoom(event.deltaY > 0 ? 1.2 : 0.8); }, { passive: false });
    canvas.addEventListener('pointerdown', event => {
      if (this.mode && this.projection) {
        const p = this.projection;
        const x = event.offsetX, y = event.offsetY;
        if (x < p.left || x > p.right || y < p.top || y > p.bottom) return;
        const anchor = { time: p.time + Math.floor((x - p.left) / p.dx) * p.seconds,
          price: p.high - (y - p.top) * (p.high - p.low) / (p.bottom - p.top) };
        if (this.mode === 'price') this.add([anchor]);
        else if (!this.first) { this.first = anchor; this.paint(); }
        else if (this.first.time !== anchor.time) { this.add([this.first, anchor]); this.first = undefined; }
        return;
      }
      this.drag = { x: event.clientX, end: this.end };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (this.drag && this.projection) {
        this.end = this.drag.end - Math.round((event.clientX - this.drag.x) / this.projection.dx);
        this.paint();
      }
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { this.drag = undefined; });
  }

  set(analysis: Analysis, drawings: Drawing[]) {
    if (this.view?.snapshot.hash !== analysis.snapshot.hash) {
      const { candles, interval } = analysis.snapshot;
      this.end = (candles.at(-1)!.time - candles[0].time) / intervals[interval] + 1;
      this.indicators = indicatorSeries(candles, intervals[interval]);
      this.first = undefined;
    }
    this.view = analysis;
    this.drawings = drawings;
    this.paint();
  }
  drawMode(mode?: 'price' | 'trend') { this.mode = mode; this.first = undefined; this.paint(); }
  zoom(factor: number) { this.size = Math.max(12, Math.min(600, Math.round(this.size * factor))); this.paint(); }
  pan(direction: number) { this.end += direction * Math.max(1, Math.round(this.size / 4)); this.paint(); }

  private paint() {
    const view = this.view;
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !view || width < 140 || height < 120) return;
    const scale = Math.min(devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    ctx.scale(scale, scale);
    const { candles, interval } = view.snapshot;
    const seconds = intervals[interval];
    const latest = candles.at(-1)!.time;
    const earliest = candles[0].time;
    const total = Math.floor((latest - earliest) / seconds) + 1;
    const count = Math.min(total, this.size);
    this.end = Math.max(count, Math.min(total, this.end));
    const time = earliest + (this.end - count) * seconds;
    const visible = candles.filter(bar => bar.time >= time && bar.time < time + count * seconds);
    const left = 12, right = width - 90, top = 14, bottom = height - 78;
    const dx = (right - left) / count;
    const values = visible.flatMap(bar => [bar.low, bar.high]);
    const newest = visible.at(-1)?.time === latest;
    if (newest && view.plan) values.push(view.plan.stop, ...view.plan.targets);
    if (!values.length) {
      this.projection = undefined;
      ctx.fillStyle = '#aabbb2'; ctx.fillText('No candles in this interval. Pan or zoom to another interval.', 15, 30);
      return;
    }
    const rawHigh = Math.max(...values), rawLow = Math.min(...values);
    const padding = Math.max((rawHigh - rawLow) * 0.06, rawHigh * 0.0001);
    const high = rawHigh + padding, low = rawLow - padding;
    const x = (t: number) => left + ((t - time) / seconds + 0.5) * dx;
    const y = (price: number) => top + (high - price) / (high - low) * (bottom - top);
    this.projection = { left, right, top, bottom, time, high, low, dx, seconds };
    const line = (x1: number, y1: number, x2: number, y2: number, color: string) => {
      ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    ctx.font = '11px system-ui';
    ctx.fillStyle = '#aabbb2';
    for (let i = 0; i <= 5; i++) {
      const p = low + (high - low) * i / 5;
      line(left, y(p), right, y(p), '#263a31');
      ctx.fillText(p.toPrecision(7), right + 6, y(p) + 3);
    }
    const volume = Math.max(0, ...visible.map(bar => bar.volume ?? 0));
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, right - left, height - top - 24); ctx.clip();
    const plan = newest ? view.plan : undefined;
    if (plan) {
      ctx.fillStyle = '#163929'; ctx.fillRect(left, y(plan.targets[0]), right - left, y(plan.entry) - y(plan.targets[0]));
      ctx.fillStyle = '#3b2229'; ctx.fillRect(left, y(plan.entry), right - left, y(plan.stop) - y(plan.entry));
    }
    for (const bar of visible) {
      const color = bar.close >= bar.open ? '#66d6a1' : '#e98391';
      line(x(bar.time), y(bar.high), x(bar.time), y(bar.low), color);
      const body = Math.max(1, dx * 0.64);
      ctx.fillStyle = color;
      ctx.fillRect(x(bar.time) - body / 2, y(Math.max(bar.open, bar.close)), body, Math.max(1, Math.abs(y(bar.close) - y(bar.open))));
      if (bar.volume !== null && volume) {
        const h = bar.volume / volume * 36;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x(bar.time) - body / 2, height - 24 - h, body, h);
        ctx.globalAlpha = 1;
      }
    }
    const series = this.indicators!;
    for (const [key, color] of [['ema20', '#f2c46d'], ['ema50', '#8aaafd'], ['ema200', '#c9a0fa']] as const) {
      for (let i = 1; i < candles.length; i++) {
        if (candles[i].time < time || candles[i - 1].time >= time + count * seconds || candles[i].time - candles[i - 1].time !== seconds) continue;
        const a = series[i - 1][key], b = series[i][key];
        if (a !== undefined && b !== undefined) line(x(candles[i - 1].time), y(a), x(candles[i].time), y(b), color);
      }
    }
    const level = (price: number | undefined, title: string, color: string) => {
      if (price === undefined || price < low || price > high) return;
      ctx.setLineDash([4, 4]); line(left, y(price), right, y(price), color); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.fillText(title, left + 4, y(price) - 4);
    };
    level(view.features.support, 'Support', '#80b59e');
    level(view.features.resistance, 'Resistance', '#d9ad84');
    level(plan?.entry, 'Entry', '#c2d7eb');
    level(plan?.stop, 'SL', '#ff9aaa');
    level(plan?.targets[0], 'TP1', '#83e4b3');
    level(plan?.targets[1], 'TP2', '#83e4b3');
    for (const drawing of this.drawings) {
      const [a, b] = drawing.anchors;
      if (b) line(x(a.time), y(a.price), x(b.time), y(b.price), '#a8baff');
      else level(a.price, 'Manual', '#a8baff');
    }
    if (this.first) {
      ctx.fillStyle = '#a8baff'; ctx.fillRect(x(this.first.time) - 3, y(this.first.price) - 3, 6, 6);
    }
    if (newest && view.signal !== 'WAIT') {
      ctx.fillStyle = view.signal === 'BUY' ? '#83e4b3' : '#ff9aaa';
      ctx.textAlign = 'right';
      ctx.fillText(view.signal, Math.min(right - 3, x(latest) - 2), Math.max(top + 12, y(view.features.close) - 8));
    }
    ctx.restore();
    ctx.fillStyle = '#aabbb2';
    for (let i = 0; i < 3; i++) {
      const barTime = time + Math.floor(i * (count - 1) / 3) * seconds;
      ctx.fillText(new Date(barTime * 1000).toISOString().slice(5, 16).replace('T', ' '), x(barTime), height - 6);
    }
    ctx.fillText('UTC', right + 6, height - 6);
  }
}
