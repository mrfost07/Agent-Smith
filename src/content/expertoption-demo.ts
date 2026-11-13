import { demoExpiryPattern, isExpertOptionTerminal, validDemoOrder,
  type DemoAccountMode, type DemoDeal, type DemoDirection, type DemoOrder } from '../trading/demo-order';

const controlsSelector = 'button, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="option"], [aria-current="true"], [tabindex="0"], input, select';
const demoLabel = /^(?:demo(?: account)?|practice account)(?:\s*[:–-]?\s*[$€£]?\s*[\d,.]+(?:\s+[A-Z]{3})?)?$/i;
const realLabel = /^(?:real|live)(?: account)?(?:\s*[:–-]?\s*[$€£]?\s*[\d,.]+(?:\s+[A-Z]{3})?)?$/i;
const labels = {
  up: /^(?:up|call|buy|higher|trade up)(?:\s*\(\s*demo\s*\))?$/i,
  down: /^(?:down|put|sell|lower|trade down)(?:\s*\(\s*demo\s*\))?$/i,
};

let prepared: { order: DemoOrder; target: HTMLElement; mode: HTMLElement; url: string } | undefined;

function normalized(value?: string | null): string {
  return value?.replace(/[\u200e\u200f\ue000-\uf8ff]/g, '').trim().replace(/\s+/g, ' ') ?? '';
}

function name(element: HTMLElement): string {
  return normalized(element.getAttribute('aria-label') || element.getAttribute('title') ||
    (element instanceof HTMLInputElement ? Array.from(element.labels ?? []).map(label => label.innerText).join(' ') : element.innerText));
}

function visible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && rect.left < innerWidth && rect.top < innerHeight &&
    rect.right > 0 && rect.bottom > 0 && style.visibility === 'visible' && style.opacity !== '0' &&
    !element.closest('[hidden],[inert],[aria-hidden="true"]');
}

function selected(element: HTMLElement): boolean {
  return element.matches('[aria-selected="true"],[aria-checked="true"],[aria-pressed="true"],[aria-current="true"]') ||
    (element instanceof HTMLInputElement && element.type === 'radio' && element.checked);
}

function accountMode(controls: HTMLElement[]): HTMLElement | undefined {
  // Explicit current/selected state prevents an unselected Demo choice in the account picker
  // from being mistaken for the active account.
  const active = controls.filter(el => selected(el) && (demoLabel.test(name(el)) || realLabel.test(name(el))));
  if (active.length === 1) return active[0];
  if (active.length > 1) return;
  // Observed React Native layout: both labels are disabled switches, with no
  // aria-checked state. The active segment is a translated background marker.
  // Restrict this fallback to the account header and require one marker fully
  // inside exactly one segment; intermediate animation positions stay unknown.
  const headers = controls.filter(el => el.getAttribute('data-testid') === 'at_trade_room_header_balance');
  if (headers.length !== 1) return;
  const lists = headers[0].querySelectorAll<HTMLElement>('[role="tablist"]');
  if (lists.length !== 1) return;
  const list = lists[0];
  const modes = [...list.querySelectorAll<HTMLElement>('[role="switch"]')].filter(visible);
  if (modes.length !== 2 || modes.filter(el => demoLabel.test(name(el))).length !== 1 ||
      modes.filter(el => realLabel.test(name(el))).length !== 1) return;
  const markers = [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement &&
    visible(el) && !el.getAttribute('role') && getComputedStyle(el).position === 'absolute' &&
    el.style.transform !== '' && el.style.backgroundColor !== '' &&
    !['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(el).backgroundColor));
  if (markers.length !== 1) return;
  const marker = markers[0].getBoundingClientRect();
  const matched = modes.filter(el => {
    const rect = el.getBoundingClientRect();
    return marker.left >= rect.left - 2 && marker.right <= rect.right + 2 &&
      marker.top >= rect.top - 2 && marker.bottom <= rect.bottom + 2 &&
      marker.width >= rect.width * 0.8 && marker.height >= rect.height * 0.6;
  });
  if (matched.length === 1) return matched[0];
}

function terminalControls(): HTMLElement[] | undefined {
  if (!isExpertOptionTerminal(location.href) || window.top !== window ||
      document.visibilityState !== 'visible') return;
  const all = document.querySelectorAll<HTMLElement>(controlsSelector);
  if (all.length <= 1200) return [...all].filter(visible);
}

export function readDemoAccountMode(): DemoAccountMode {
  return readDemoTerminal().mode;
}

export function readDemoTerminal(): { mode: DemoAccountMode; expiry?: string } {
  const controls = terminalControls();
  const mode = controls && accountMode(controls);
  if (!mode || !controls) return { mode: 'unknown' };
  if (!demoLabel.test(name(mode))) return { mode: 'real' };
  return { mode: 'demo', expiry: expiryField(controls) };
}

function field(controls: HTMLElement[], label: RegExp, pattern: RegExp): string | undefined {
  const values = new Set<string>();
  for (const el of controls) {
    const associated = el instanceof HTMLInputElement || el instanceof HTMLSelectElement
      ? Array.from(el.labels ?? []).map(item => normalized(item.textContent)).join(' ') : '';
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map(id => normalized(document.getElementById(id)?.textContent)).join(' ');
    const hint = normalized(el.getAttribute('aria-label') || el.getAttribute('title') || labelledBy || associated);
    // Custom terminal controls expose adjacent value/label children rather than
    // aria-labels. Read only a control whose own text has exactly those two parts.
    if (!label.test(hint)) {
      const parts = (el.innerText ?? '').split(/\n/).map(normalized).filter(Boolean);
      if (parts.length === 2 && label.test(parts[1]) && pattern.test(parts[0])) values.add(parts[0]);
      continue;
    }
    const value = normalized(el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value :
      el.getAttribute('aria-valuetext') || el.innerText);
    if (pattern.test(value)) values.add(value);
  }
  return values.size === 1 ? [...values][0] : undefined;
}

function assetField(controls: HTMLElement[]): string | undefined {
  const labeled = field(controls, /^(?:asset|instrument|symbol|market|select asset)$/i, /^[\w .()/:-]{1,40}$/);
  if (labeled) return labeled;
  const candidates = controls.filter(el => el.getAttribute('tabindex') === '0' &&
    [...el.querySelectorAll<HTMLImageElement>('img')].some(img => {
      try { const url = new URL(img.src); return url.hostname === 'static.expertoption.finance' && url.pathname.startsWith('/asset-icons/'); }
      catch { return false; }
    }));
  const values = candidates.map(el => normalized(el.innerText)).filter(value => /^[\w .()/:-]{1,40}$/.test(value));
  if (values.length === 1) return values[0];
}

function expiryField(controls: HTMLElement[]): string | undefined {
  return field(controls, /^(?:trade time|deal time|duration|expiry|expiration|expiration time|deal duration|auto close)$/i, demoExpiryPattern);
}

export function readRecentDemoDeals(): DemoDeal[] | undefined {
  if (readDemoAccountMode() !== 'demo') return;
  // ExpertOption keeps these history rows mounted after the Deals panel closes.
  const rows = document.querySelectorAll<HTMLElement>('[aria-label="at_right_panel"] [aria-label="at_deals_history_item"]');
  const deals: DemoDeal[] = [];
  for (const row of [...rows].slice(0, 40)) {
    const id = row.getAttribute('data-testid') ?? '';
    const [asset, payout, time, amount, extra] = row.innerText.split(/\n/).map(normalized).filter(Boolean);
    if (!/^at_deals_history_item_[\w-]{1,70}$/.test(id) || extra !== undefined ||
        !asset || !/^[\w .()/:-]{1,40}$/.test(asset) || !/^\d{1,2}:\d{2}:\d{2}$/.test(time ?? '') ||
        !/^[+-]?[$€£]?\d{1,9}(?:[.,]\d{1,4})?$/.test(payout ?? '') ||
        !/^[$€£]?\d{1,9}(?:[.,]\d{1,4})?$/.test(amount ?? '')) continue;
    deals.push({ id, asset, payout, time, amount });
  }
  return deals.length ? deals : undefined;
}

function orderLabel(el: HTMLElement): string {
  // These two test IDs are reversed in the live layout. Never derive direction
  // from their names; strip the decorative glyph and payout, then read BUY/SELL.
  if (['at_buy_button', 'at_sell_button'].includes(el.getAttribute('data-testid') ?? '')) {
    return normalized(el.innerText).replace(/\s+\d{1,3}(?:[.,]\d+)?%$/, '');
  }
  return name(el);
}

function inspect(direction: DemoDirection, token: string) {
  const controls = terminalControls();
  if (!controls) return { problem: 'The active trading page layout could not be verified.' };
  const mode = accountMode(controls);
  if (!mode) return { problem: 'I could not verify a selected Demo account on the trading page.' };
  if (!demoLabel.test(name(mode))) return { problem: 'ExpertOption has Real selected. Switch to Demo in the account menu.' };
  const available = (el: HTMLElement) => el.matches('button,[role="button"],input[type="button"],[data-testid="at_buy_button"],[data-testid="at_sell_button"]') &&
    !el.matches(':disabled,[aria-disabled="true"]') &&
    !el.closest('[aria-disabled="true"]');
  const up = controls.filter(el => available(el) && labels.up.test(orderLabel(el)));
  const down = controls.filter(el => available(el) && labels.down.test(orderLabel(el)));
  if (up.length !== 1 || down.length !== 1) {
    return { problem: 'I could not identify one BUY and one SELL button on the trading page.' };
  }
  const target = direction === 'up' ? up[0] : down[0];
  if (mode === target || mode.contains(target)) return { problem: 'Account mode and order controls could not be distinguished.' };
  const asset = assetField(controls);
  const amount = field(controls, /^(?:amount|trade amount|investment|stake)$/i, /^(?:[$€£] ?|[A-Z]{3} )?\d{1,8}(?:[.,]\d{1,4})?(?: [A-Z]{3})?$/);
  const expiry = expiryField(controls);
  const rect = target.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  const order = { token, direction, asset, amount, expiry, x, y };
  if (!validDemoOrder(order, direction) || !hit || !target.contains(hit)) {
    return { problem: 'I could not verify the selected asset, amount, expiry, and unobstructed order button.' };
  }
  return { order, target, mode, url: location.href };
}

export function prepareDemoOrder(direction: DemoDirection): { order?: DemoOrder; problem?: string } {
  prepared = undefined;
  const result = inspect(direction, crypto.randomUUID());
  if (!result.order) return { problem: result.problem };
  prepared = result;
  return { order: result.order };
}

export function validateDemoOrder(token: unknown): boolean {
  const previous = prepared;
  if (!previous || previous.order.token !== token || previous.url !== location.href) return false;
  const result = inspect(previous.order.direction, previous.order.token);
  return Boolean(result.order && result.mode === previous.mode && result.target === previous.target &&
    JSON.stringify(result.order) === JSON.stringify(previous.order));
}
