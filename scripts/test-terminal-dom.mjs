import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { build } from 'esbuild';

// Structural fixture from the visible terminal inspected on 2026-11-13.
// Geometry is supplied because linkedom does not perform browser layout.
const { window, document } = parseHTML(`<html><body>
  <div tabindex="0" data-testid="at_trade_room_header_balance" aria-label="at_trade_room_header_balance">
    <div role="tablist">
      <div id="marker" style="position:absolute;background-color:rgb(245,142,11);transform:translateX(86px)"></div>
      <div role="switch" aria-label="REAL" aria-disabled="true">REAL</div>
      <div role="switch" aria-label="DEMO" aria-disabled="true">DEMO</div>
    </div>
  </div>
  <div tabindex="0" id="asset"><img src="https://static.expertoption.finance/asset-icons/png/squared/AI_INDEX_OTC_R.png"><div>AI Index</div><div>\ue90b</div></div>
  <div tabindex="0" id="amount"><div>\u200e$500</div><div>investment</div></div>
  <div tabindex="0" id="expiry"><div>00:00:05</div><div>auto close</div></div>
  <div tabindex="0" data-testid="at_buy_button" aria-label="at_buy_button"><div>\ue981</div><div>SELL</div><div>86%</div></div>
  <div tabindex="0" data-testid="at_sell_button" aria-label="at_sell_button"><div>\ue97f</div><div>BUY</div><div>86%</div></div>
  <div aria-label="at_right_panel">
    <div aria-label="at_deals_history_item" data-testid="at_deals_history_item_123_456"><div>\ue90b</div><div>AI Index</div><div>+\u200e$930.00</div><div>16:25:11</div><div>\u200e$500.00</div></div>
  </div>
</body></html>`);
Object.assign(globalThis, { window, document, location: { href: 'https://app.expertoption.finance/' },
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLSelectElement: window.HTMLSelectElement,
  innerWidth: 1000, innerHeight: 800,
  getComputedStyle: el => ({ visibility: 'visible', opacity: '1', position: el.style.position,
    backgroundColor: el.style.backgroundColor }),
});
window.top = window;
document.visibilityState = 'visible';
const box = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
for (const el of document.querySelectorAll('*')) el.getBoundingClientRect = () => box(10, 10, 100, 30);
const real = document.querySelector('[aria-label="REAL"]');
const demo = document.querySelector('[aria-label="DEMO"]');
const marker = document.querySelector('#marker');
real.getBoundingClientRect = () => box(10, 10, 86, 20);
demo.getBoundingClientRect = () => box(96, 10, 86, 20);
let markerLeft = 98;
marker.getBoundingClientRect = () => box(markerLeft, 12, 82, 16);
const buy = document.querySelector('[data-testid="at_sell_button"]');
const sell = document.querySelector('[data-testid="at_buy_button"]');
buy.getBoundingClientRect = () => box(500, 600, 200, 60);
sell.getBoundingClientRect = () => box(300, 600, 200, 60);
let obstructed = false;
document.elementFromPoint = x => obstructed ? document.body : x === 600 ? buy : sell;
const { outputFiles } = await build({ entryPoints: ['src/content/expertoption-demo.ts'], bundle: true,
  format: 'esm', platform: 'node', write: false });
const terminal = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
assert.equal(terminal.readDemoAccountMode(), 'demo');
assert.deepEqual(terminal.readDemoTerminal(), { mode: 'demo', expiry: '00:00:05' });
assert.deepEqual(terminal.readRecentDemoDeals(), [{ id: 'at_deals_history_item_123_456', asset: 'AI Index',
  payout: '+$930.00', time: '16:25:11', amount: '$500.00' }]);
const up = terminal.prepareDemoOrder('up');
assert.ok(up.order, up.problem);
assert.equal(up.order.asset, 'AI Index');
assert.equal(up.order.amount, '$500');
assert.equal(up.order.expiry, '00:00:05');
assert.equal(up.order.x, 600, 'Up must use visible BUY, despite the reversed test ID');
assert.equal(terminal.validateDemoOrder(up.order.token), true);
document.querySelector('#amount div').textContent = '$501';
assert.equal(terminal.validateDemoOrder(up.order.token), false);
document.querySelector('#amount div').textContent = '\u200e$500';
assert.equal(terminal.prepareDemoOrder('down').order.x, 400);
obstructed = true;
assert.equal(terminal.prepareDemoOrder('up').order, undefined);
obstructed = false;
markerLeft = 12;
assert.equal(terminal.readDemoAccountMode(), 'real');
assert.equal(terminal.readRecentDemoDeals(), undefined);
assert.match(terminal.prepareDemoOrder('up').problem, /Real selected/);
markerLeft = 55;
assert.equal(terminal.readDemoAccountMode(), 'unknown', 'An in-motion marker cannot authorize a trade');
markerLeft = 98;
marker.remove();
assert.equal(terminal.readDemoAccountMode(), 'unknown', 'A Demo label alone is insufficient');
demo.setAttribute('aria-checked', 'true');
assert.equal(terminal.readDemoAccountMode(), 'demo');
real.setAttribute('aria-checked', 'true');
assert.equal(terminal.readDemoAccountMode(), 'unknown');
console.log('Terminal DOM checks passed: actual markup, reversed IDs, fields, mode transitions and obstruction.');
