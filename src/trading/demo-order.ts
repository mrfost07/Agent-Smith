export type DemoDirection = 'up' | 'down';
export type DemoAccountMode = 'demo' | 'real' | 'unknown';
export const demoExpiryPattern = /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,4}\s*(?:s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?))$/i;

export interface DemoDeal {
  id: string;
  asset: string;
  amount: string;
  payout: string;
  time: string;
}

export interface DemoOrder {
  token: string;
  direction: DemoDirection;
  asset: string;
  amount: string;
  expiry: string;
  x: number;
  y: number;
}

export function isExpertOptionTerminal(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return ['https://app.expertoption.finance', 'https://app.expertoption.com'].includes(url.origin);
  } catch { return false; }
}

export function isOrderQuestion(goal: string): boolean {
  return /^\s*(?:(?:what|why|when|where|which|how|is|are|does)\b|(?:can|could|would|should|do)\s+I\b|(?:please\s+)?explain\b)/i.test(goal);
}

export function excludesDemoOrder(goal: string): boolean {
  return /\b(?:do not|don.t|never|without|instead of)\s+(?:preparing|prepare|placing|place|submitting|submit|executing|execute|trading|trade|buying|buy|selling|sell|clicking|click|tapping|tap|making|make|entering|enter|opening|open)\b|\b(?:real|live)[ -](?:money|account|funds)\b|\b(?:analysis|read)[ -]only\b/i.test(goal);
}

export function sameDemoAsset(a: string, b: string): boolean {
  const normalize = (value: string) => value.toUpperCase().replace(/\s+/g, '');
  return normalize(a) === normalize(b);
}

export function demoExpirySeconds(expiry: string): number {
  if (!demoExpiryPattern.test(expiry)) return 0;
  if (expiry.includes(':')) return expiry.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
  const unit = expiry.match(/[smh]/i)?.[0].toLowerCase();
  return parseInt(expiry, 10) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
}

export function sameDemoAmount(first: string, second: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, '').replace(',', '.').replace(/\.0+(?=[A-Z]*$)/, '');
  return normalize(first) === normalize(second);
}

export function validDemoOrder(value: unknown, direction: DemoDirection): value is DemoOrder {
  if (!value || typeof value !== 'object') return false;
  const order = value as DemoOrder;
  return order.direction === direction && typeof order.token === 'string' && /^[\w-]{1,64}$/.test(order.token) &&
    Number.isFinite(order.x) && order.x >= 0 && Number.isFinite(order.y) && order.y >= 0 &&
    typeof order.asset === 'string' && /^[\w .()/:-]{1,40}$/.test(order.asset) &&
    typeof order.amount === 'string' && /^(?:[$€£] ?|[A-Z]{3} )?\d{1,8}(?:[.,]\d{1,4})?(?: [A-Z]{3})?$/.test(order.amount) &&
    Number(order.amount.replace(/[^\d.,]/g, '').replace(',', '.')) > 0 &&
    typeof order.expiry === 'string' && demoExpirySeconds(order.expiry) > 0;
}

export function demoOrderDescription(order: DemoOrder): string {
  return (order.direction === 'up' ? 'Up' : 'Down') + ' on ' + order.asset +
    ' for ' + order.amount + ' with expiry ' + order.expiry;
}
