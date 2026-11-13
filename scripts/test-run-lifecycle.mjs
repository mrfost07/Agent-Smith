import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';

async function bundle(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, format: 'esm', platform: 'node', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Expected event did not arrive');
}

const { runOperation, waitForRun } = await bundle('src/background/run-operation.ts');
const { browserUrl, disallowsBrowsing, quickChatReply } = await bundle('src/background/conversation-context.ts');
const abort = new AbortController();
const blocked = runOperation(() => new Promise(() => {}), 1000, 'Page', abort.signal);
abort.abort();
await assert.rejects(blocked, /abort/i);
await assert.rejects(runOperation(() => new Promise(() => {}), 10, 'Page'), /Page timed out/);
await waitForRun(3000, abort.signal);

// Run the real service-worker message dispatcher with controlled asynchronous storage.
const worker = ts.createSourceFile('worker.ts', await readFile('src/background/service-worker.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const dispatcher = worker.statements.find(node => node.getText(worker).startsWith('chrome.runtime.onMessage.addListener'));
assert.ok(dispatcher);
let handler;
let tabQuery;
let createSession;
const starts = [];
const states = [];
let status = 'idle';
const engine = {
  getStatus: () => ({ status, tabId: 1 }),
  start: async (goal, tabId, options) => { status = 'running'; starts.push({ goal, tabId, ...options }); },
  stop: () => { status = 'idle'; },
};
const context = vm.createContext({
  console, URL, engine, runOperation, browserUrl, disallowsBrowsing, quickChatReply,
  SessionManager: { getInstance: () => ({
    createSession: (...args) => createSession(...args),
    setActiveSessionId() {},
    updateStatus: async (id, state) => states.push({ id, state }),
  }) },
  chrome: { tabs: { TAB_ID_NONE: -1, query: () => tabQuery() }, runtime: { id: "test", getURL: () => "chrome-extension://test/", onMessage: { addListener: listener => { handler = listener; } } } },
});
vm.runInContext('let startGeneration = 0, pendingStart; let startSetup = Promise.resolve(); const sessionsReady = Promise.resolve();\n' +
  ts.transpileModule(dispatcher.getText(worker), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const send = request => new Promise(resolve => handler(request, { id: "test", url: "chrome-extension://test/panel" }, resolve));
const begin = requestId => send({ type: 'START_AGENT', goal: 'Play chess as White', requestId });
const waitingTab = deferred();
let tabRequested = false;
tabQuery = () => { tabRequested = true; return waitingTab.promise; };
createSession = async () => ({ id: 'fresh' });
const first = begin('cancel-before-tab');
await until(() => tabRequested);
assert.equal((await begin('busy')).success, false);
await send({ type: 'STOP_AGENT' });
const second = begin('after-stop');
waitingTab.resolve([{ id: 1, url: 'https://example.test/chess' }]);
assert.equal((await first).cancelled, true);
assert.equal((await second).success, true);
assert.deepEqual(starts.map(run => run.requestId), ['after-stop']);
assert.equal(starts[0].activeSite, 'example.test');

await send({ type: 'STOP_AGENT' });
const pendingSession = deferred();
let sessionRequested = false;
createSession = () => { sessionRequested = true; return pendingSession.promise; };
const third = begin('cancel-during-save');
await until(() => sessionRequested);
await send({ type: 'STOP_AGENT' });
createSession = async () => ({ id: 'next' });
const fourth = begin('latest');
pendingSession.resolve({ id: 'cancelled-session' });
assert.equal((await third).cancelled, true);
assert.equal((await fourth).success, true);
assert.equal(starts.at(-1).requestId, 'latest');
assert.deepEqual(states.at(-1), { id: 'cancelled-session', state: 'stopped' });

const sendFromPage = request => new Promise(resolve => handler(request, {
  id: 'test', url: 'https://example.test/chess', tab: { id: 1 },
}, resolve));
assert.equal((await sendFromPage({ type: 'START_AGENT', goal: 'unexpected task' })).success, false);
assert.equal((await sendFromPage({ type: 'CONFIRM_ACTION', approvalId: 'anything' })).success, false);
assert.equal((await sendFromPage({ type: 'STOP_AGENT' })).success, true);
let approvals = 0;
engine.getStatus = () => ({ status, tabId: 1, approvalId: 'current' });
engine.confirmPendingAction = async () => { approvals++; };
assert.equal((await send({ type: 'CONFIRM_ACTION', approvalId: 'stale' })).success, false);
assert.equal((await send({ type: 'CONFIRM_ACTION', approvalId: 'current' })).success, true);
assert.equal(approvals, 1);
let chatTabQueries = 0;
tabQuery = () => { chatTabQueries++; return []; };
await send({ type: 'STOP_AGENT' });
assert.equal((await send({ type: 'START_AGENT', goal: 'Answer without browsing', requestId: 'chat-only' })).success, true);
assert.equal(chatTabQueries, 0);
assert.equal(starts.at(-1).tabId, -1);
assert.equal(starts.at(-1).activeSite, undefined);

// Reproduce the old recovery-record race against the real session manager.
const records = new Map();
const recoveryNotes = [];
let recovery;
const stopping = deferred();
const canFinishStop = deferred();
globalThis.testSessionStorage = {
  saveSession: async session => { records.set(session.id, structuredClone(session)); },
  getAllSessions: async () => [...records.values()].map(session => structuredClone(session)),
  editSession: async (id, edit) => {
    const session = structuredClone(records.get(id));
    edit(session);
    if (session.status === 'stopped') {
      stopping.resolve();
      await canFinishStop.promise;
    }
    records.set(id, session);
    return session;
  },
  appendSessionMessage: async message => {
    recoveryNotes.push(message);
    return records.get(message.sessionId);
  },
  cleanupExpiredSessions: async () => {},
};
globalThis.chrome = {
  storage: {
    session: {
      get: async () => ({ activeRun: recovery }),
      set: async ({ activeRun }) => { recovery = activeRun; },
      remove: async () => { recovery = undefined; },
    },
    local: { get: async () => ({}) },
  },
  runtime: { sendMessage: async () => {} },
};
const { outputFiles: sessionBundle } = await build({
  entryPoints: ['src/background/sessions.ts'], bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{
    name: 'test-session-db',
    setup(builder) {
      builder.onResolve({ filter: /shared\/db$/ }, () => ({ path: 'db', namespace: 'session-fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'session-fixture' }, () => ({
        contents: 'export const { saveSession, editSession, getSession, getAllSessions, saveMessage, appendSessionMessage, getSessionMessages, deleteSessionFull, saveModelContext, getModelContext, cleanupExpiredSessions } = globalThis.testSessionStorage;',
      }));
    },
  }],
});
const { SessionManager } = await import('data:text/javascript;base64,' + Buffer.from(sessionBundle[0].text).toString('base64'));
const manager = SessionManager.getInstance();
const oldSession = await manager.createSession('Old task', 1);
await manager.updateStatus(oldSession.id, 'running', undefined, 1);
const oldStop = manager.updateStatus(oldSession.id, 'stopped');
await stopping.promise;
const newSession = await manager.createSession('Replacement task', 2);
const newStart = manager.updateStatus(newSession.id, 'running', undefined, 2);
canFinishStop.resolve();
await Promise.all([oldStop, newStart]);
assert.equal(recovery.sessionId, newSession.id);
await manager.updateStatus(oldSession.id, 'failed');
assert.equal(recovery.sessionId, newSession.id);
recovery = undefined; // Browser restart clears session storage.
await manager.initOnStartup();
assert.equal(records.get(newSession.id).status, 'interrupted');
assert.equal(recoveryNotes.at(-1).sessionId, newSession.id);
console.log('Session recovery tests passed: late Stop, existing sessions, and browser restart.');

// A Stop during debugger attachment must still detach after attachment finishes.
const { CDPController } = await bundle('src/background/cdp-controller.ts');
const attaching = deferred();
let attachments = 0;
let detachments = 0;
globalThis.chrome = { debugger: {
  attach: () => { attachments++; return attaching.promise; },
  detach: async () => { detachments++; },
  onDetach: { addListener() {} },
} };
const attachOne = CDPController.attach(1);
const attachTwo = CDPController.attach(1);
const detach = CDPController.detach(1);
attaching.resolve();
await Promise.all([attachOne, attachTwo, detach]);
assert.equal(attachments, 1);
assert.equal(detachments, 1);
console.log('Run lifecycle tests passed: pending starts, rapid Stop/restart, timeouts, cancellation, and debugger cleanup.');

// Verify settling time with a deterministic clock, including constantly animated pages.
const settleCode = ts.transpileModule(await readFile('src/content/page-settle.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
let now = 0;
let timerId = 0;
const timers = new Map();
let observer;
const setTimer = (fn, ms, interval = false) => {
  const id = ++timerId;
  timers.set(id, { fn, ms, at: now + ms, interval });
  return id;
};
function advance(end) {
  while (timers.size) {
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (timer.at > end) break;
    now = timer.at;
    if (timer.interval) timer.at += timer.ms;
    else timers.delete(id);
    timer.fn();
  }
  now = end;
}
class PageElement { closest() { return null; } }
const settleContext = vm.createContext({
  exports: {}, performance: { now: () => now }, Element: PageElement,
  document: { documentElement: {} },
  MutationObserver: class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {} disconnect() { this.disconnected = true; }
  },
  setTimeout: (fn, ms) => setTimer(fn, ms), clearTimeout: id => timers.delete(id),
  setInterval: (fn, ms) => setTimer(fn, ms, true), clearInterval: id => timers.delete(id),
});
vm.runInContext(settleCode, settleContext);
for (const [action, duration] of [['click', 180], ['type', 120], ['drag', 280], ['scroll', 280]]) {
  const started = now;
  const settled = settleContext.exports.waitForPageSettle(action);
  advance(started + duration - 1);
  assert.equal(observer.disconnected, undefined);
  advance(started + duration);
  await settled;
  assert.equal(observer.disconnected, true);
  assert.equal(timers.size, 0);
}
const started = now;
const animated = settleContext.exports.waitForPageSettle('click');
for (let ms = 20; ms < 500; ms += 20) {
  advance(started + ms);
  observer.callback([{ target: new PageElement() }]);
}
advance(started + 500);
await animated;
assert.equal(observer.disconnected, true);
assert.equal(timers.size, 0);
console.log('Page settling tests passed: stable pages wait 120–280ms; continuously changing pages stop waiting at 500ms.');

// Execute the panel's actual handlers to verify Stop acknowledgement and stale updates.
const panelSource = ts.createSourceFile('panel.ts', await readFile('src/sidepanel/sidepanel.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const handlers = panelSource.statements.filter(node =>
  ts.isFunctionDeclaration(node) && ['startAgent', 'stopCurrentRun', 'selectPanelSession'].includes(node.name?.text) ||
  node.getText(panelSource).startsWith('chrome.runtime.onMessage.addListener'));
const stopAck = deferred();
const startAck = deferred();
const panelRequests = [];
const panelUpdates = [];
let panelListener;
let requestSequence = 0;
const noop = () => {};
const panel = vm.createContext({
  console, crypto: { randomUUID: () => 'request-' + ++requestSequence },
  chrome: {
    storage: { local: { set: async () => {} } },
    runtime: {
      onMessage: { addListener: listener => { panelListener = listener; } },
      sendMessage: message => {
        panelRequests.push(message);
        if (message.type === 'STOP_AGENT') return stopAck.promise;
        if (message.type === 'START_AGENT') return startAck.promise;
        return Promise.resolve({ success: true });
      },
    },
  },
  setRunningState: value => { panel.isRunning = value; },
  stripEmoji: value => value, appendUserMessageElement: noop, autoResizeInput: noop,
  stopReplyAnimation: noop, updateHeaderSessionTitle: noop,
  updateAgentProgress: data => panelUpdates.push(data),
  promptInput: { value: '' }, isRunning: true, visionEnabled: true, safetyGate: false,
});
vm.runInContext(`
  const PANEL_SESSION_KEY = 'test-view';
  let activeSessionId = 'chess', activeSession, sessionViewRevision = 0;
  let currentRequestId = 'old', stopPending = Promise.resolve();
  let currentProgressEl, currentConfirmationCardEl;
` + ts.transpileModule(handlers.map(node => node.getText(panelSource)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, panel);
panel.stopCurrentRun();
const nextReply = panel.startAgent('Play chess as White');
assert.deepEqual(panelRequests.map(message => message.type), ['STOP_AGENT']);
panelListener({ type: 'AGENT_UPDATE', data: { requestId: 'old', status: 'completed' } });
assert.equal(panelUpdates.length, 0);
stopAck.resolve({ success: true });
await until(() => panelRequests.length === 2);
assert.equal(panelRequests[1].requestId, 'request-1');
panelListener({ type: 'AGENT_UPDATE', data: { requestId: 'request-1', status: 'running' } });
assert.equal(panelUpdates.length, 1);
startAck.resolve({ success: true, sessionId: 'chess' });
await nextReply;
console.log('Panel lifecycle tests passed: restart awaits Stop, and cancelled-run updates are ignored.');

const markdownFunctions = panelSource.statements.filter(node =>
  ts.isFunctionDeclaration(node) && ['stripEmoji', 'escapeHtml', 'renderMarkdown'].includes(node.name?.text));
const markdownPanel = vm.createContext({});
vm.runInContext(ts.transpileModule(markdownFunctions.map(node => node.getText(panelSource)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, markdownPanel);
assert.equal(markdownPanel.renderMarkdown('**Approximate levels**\n\n- Support around 131.111\n- Resistance around 131.116'),
  '<p><strong>Approximate levels</strong></p><ul><li>Support around 131.111</li><li>Resistance around 131.116</li></ul>');
assert.equal(markdownPanel.renderMarkdown('1. First\n2. Second\n\n- A bullet'),
  '<ol><li>First</li><li>Second</li></ol><ul><li>A bullet</li></ul>');

const { outputFiles: actionBundle } = await build({
  entryPoints: ['src/content/action-executor.ts'], bundle: true, format: 'iife',
  globalName: 'pageActions', write: false,
});
const form = {};
class Control {
  constructor(label, type, owner) {
    this.textContent = label;
    this.type = type;
    this.form = owner;
  }
  closest(selector) { return selector === 'form' ? this.form : null; }
  getAttribute() { return null; }
  matches(selector) { return selector.startsWith('button,'); }
  getRootNode() { return null; }
}
class Button extends Control {}
class Input extends Control {}
let hit = new Button('Continue', 'submit', form);
const page = vm.createContext({
  window: { innerWidth: 800, innerHeight: 600 },
  document: { elementFromPoint: () => hit, get activeElement() { return hit; } },
  HTMLButtonElement: Button, HTMLInputElement: Input, ShadowRoot: class {},
});
vm.runInContext(actionBundle[0].text, page);
const { ActionExecutor } = page.pageActions;
const click = { type: 'click', x: 20, y: 30 };
assert.equal(ActionExecutor.requiresReview(click), true, 'Native submit works even with a generic label');
hit = new Button('View details', 'button');
assert.equal(ActionExecutor.requiresReview(click), false, 'Routine button click can run in Turbo');
hit = new Button('Submit application', 'button');
assert.equal(ActionExecutor.requiresReview(click), true, 'Recognizes a custom submit button by its label');
hit = new Input('', 'text', form);
assert.equal(ActionExecutor.requiresReview({ type: 'press_key', key: 'Enter' }), true);
assert.equal(ActionExecutor.requiresReview({ type: 'press_key', key: 'ArrowDown' }), false);
