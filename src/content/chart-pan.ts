import type { ChartPanGesture } from '../trading/active-chart';

let observed: { canvas: HTMLCanvasElement; gesture: ChartPanGesture; url: string } | undefined;

function isClear(canvas: HTMLCanvasElement, gesture: ChartPanGesture): boolean {
  if (!canvas.isConnected) return false;
  const root = canvas.getRootNode();
  if (root !== document) return false;
  // Match the interpolation points dispatched by CDPController.drag.
  return Array.from({ length: 9 }, (_, i) => gesture.startX + (gesture.endX - gesture.startX) * i / 8)
    .every(x => document.elementFromPoint(x, gesture.y) === canvas);
}

export function prepareChartPan(direction: 'earlier' | 'later'): ChartPanGesture | undefined {
  observed = undefined;
  const candidates: { canvas: HTMLCanvasElement; gesture: ChartPanGesture; area: number }[] = [];
  const canvases = document.querySelectorAll('canvas');
  for (let i = 0; i < Math.min(canvases.length, 150); i++) {
    const canvas = canvases[i];
    const rect = canvas.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    const width = right - left, height = bottom - top;
    if (width < 240 || height < 125) continue;
    const a = left + width * 0.25, b = left + width * 0.75;
    const gesture = { id: crypto.randomUUID(), startX: direction === 'earlier' ? a : b,
      endX: direction === 'earlier' ? b : a, y: top + height * 0.5 };
    if (isClear(canvas, gesture)) candidates.push({ canvas, gesture, area: width * height });
  }
  candidates.sort((a, b) => b.area - a.area);
  const [best, next] = candidates;
  if (!best || (next && next.area > best.area * 0.75)) return;
  observed = { canvas: best.canvas, gesture: best.gesture, url: location.href };
  return best.gesture;
}

export function validateChartPan(id: string): boolean {
  return Boolean(observed && observed.gesture.id === id && observed.url === location.href &&
    isClear(observed.canvas, observed.gesture));
}
