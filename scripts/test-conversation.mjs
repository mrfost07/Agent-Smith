import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: "export { AgentEngine } from './src/background/agent-engine'; export * from './src/background/conversation-context';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [{
    name: 'mock-stored-sessions',
    setup(builder) {
      builder.onResolve({ filter: /^(\.\/sessions|\.\.\/shared\/db)$/ }, args => ({
        path: args.path, namespace: 'test-storage',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'test-storage' }, () => ({
        contents: 'export const getSessionMessages = id => globalThis.sessions.messages.get(id) ?? [];\n' +
          'export const getDb = async () => ({ get: async (store, id) => globalThis.tradingStates?.get(id), transaction: () => ({ done: Promise.resolve(), objectStore: name => ({ get: async id => name === "sessions" ? { id } : globalThis.tradingStates?.get(id), put: async row => globalThis.tradingStates.set(row.sessionId, row) }) }) });\n' +
          'export const SessionManager = { getInstance: () => globalThis.sessions };',
      }));
    },
  }],
});

const { AgentEngine, sessionContext, requiresWebResearch } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const messages = new Map();
globalThis.sessions = {
  messages,
  appendMessage: async (sessionId, entry) => {
    const list = messages.get(sessionId) ?? [];
    list.push({ ...entry, ts: list.length + 1, seq: list.length + 1 });
    messages.set(sessionId, list);
  },
  recordDomain: async () => {},
  updateStatus: async (id, status) => { sessionStates.set(id, status); },
};

const activePage = 'https://foony.com/games/chess';
const source = 'https://bitcoin.org/bitcoin.pdf';
const query = 'Satoshi Nakamoto Bitcoin whitepaper';
const tabReads = [];
const opened = [];
const observations = [];
const pageMessages = [];
const sessionStates = new Map();
const tabListeners = new Set();
let createSearchTab;
let probeDocument;
const tabs = new Map([[1, { id: 1, url: activePage, status: 'complete' }]]);
const storage = {
  smith_provider: 'openrouter',
  smith_provider_openrouter: { key: 'test-key', model: { id: 'test-model', name: 'Test' } },
};

globalThis.chrome = {
  storage: { local: { get: async keys => Object.fromEntries([keys].flat().map(key => [key, storage[key]])) } },
  tabs: {
    get: async id => {
      tabReads.push(id);
      if (!tabs.has(id)) throw new Error('Tab closed');
      return tabs.get(id);
    },
    create: async ({ url }) => {
      const tab = { id: tabs.size + 1, url, status: 'complete', ...createSearchTab?.(url) };
      tabs.set(tab.id, tab);
      opened.push(url);
      return tab;
    },
    sendMessage: async (id, { type, state }) => {
      pageMessages.push({ id, type, state });
      if (type === 'CHECK_ACTION_REVIEW') return { required: false };
      if (type !== 'GET_PAGE_STATE') return {};
      observations.push(id);
      return {
        success: true,
        state: {
          url: tabs.get(id).url,
          title: id === 1 ? 'Foony Chess' : 'Bitcoin research',
          observationId: 'observed-' + id,
          visibleTextSummary: id === 1 ? 'Play chess online' : 'Bitcoin: A Peer-to-Peer Electronic Cash System, by Satoshi Nakamoto',
          interactiveElements: id === 1 ? [] : [{ index: 19, tag: 'a', text: 'Bitcoin whitepaper', href: source }],
        },
      };
    },
    onUpdated: {
      addListener: listener => tabListeners.add(listener),
      removeListener: listener => tabListeners.delete(listener),
    },
  },
  scripting: { executeScript: async ({ target }) => [{ result: await probeDocument?.(target.tabId) }] },
};

const responses = [];
const calls = [];
const complete = userSummary => ({ action: { type: 'complete' }, userSummary });
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  const { messages: wire } = JSON.parse(options.body);
  const content = wire[1].content;
  const call = { system: wire[0].content, prompt: Array.isArray(content) ? content.find(part => part.type === 'text').text : content, content };
  calls.push(call);
  const response = responses.shift();
  assert.ok(response, 'Unexpected provider call');
  const value = await response(call);
  return Response.json({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
};

const agent = new AgentEngine();
const updates = [];
agent.setUpdateListener(update => updates.push(update));
const run = (goal, sessionId = 'bitcoin') => agent.start(goal, 1, { sessionId, visionEnabled: false });

await run('hi', 'greeting');
assert.equal(updates.at(-1).summary, 'Hi! How can I help?');
assert.deepEqual([calls.length, tabReads.length, observations.length, opened.length], [0, 0, 0, 0]);

const goal = 'find me the who is the creator of bitcoin';
const answer = 'Satoshi Nakamoto created Bitcoin.';
responses.push(({ prompt }) => {
  assert.match(prompt, /No webpage has been observed/);
  assert.doesNotMatch(prompt, /Foony|Chess/);
  return complete(answer);
});
await run(goal);
assert.equal(updates.at(-1).summary, answer);
assert.equal(tabReads.length, 0);

for (const action of [{ type: 'search_web', text: 'should not run' }, { type: 'observe_page' }]) {
  const before = [opened.length, observations.length, tabReads.length, pageMessages.length];
  responses.push(({ system }) => {
    assert.match(system, /Browser tools and web search are unavailable/);
    return { action };
  }, ({ system }) => {
    assert.match(system, /Allowed action types: complete, clarify/);
    return complete('I can answer from the conversation.');
  });
  await run('Click the button without browsing.', 'chat-only');
  assert.equal(updates.at(-1).summary, 'I can answer from the conversation.');
  assert.deepEqual([opened.length, observations.length, tabReads.length, pageMessages.length], before);
}

const followUp = 'find it in the browser and show me details';
const sourcedAnswer = 'The Bitcoin whitepaper credits Satoshi Nakamoto. [Whitepaper](' + source + ')';
const search = check => responses.push(({ system, prompt }) => {
  assert.match(prompt, /No webpage has been observed/);
  assert.ok(prompt.includes(goal));
  assert.ok(prompt.includes(answer));
  check(system, prompt);
  return { action: { type: 'search_web', text: query } };
}, ({ prompt }) => {
  assert.match(prompt, /Bitcoin: A Peer-to-Peer Electronic Cash System/);
  assert.ok(prompt.includes(source));
  assert.ok(prompt.includes('"index":19'));
  assert.ok(prompt.includes('"action":"search_web","ok":true'));
  assert.doesNotMatch(prompt, /Foony|Chess/);
  return complete(sourcedAnswer);
});

search((system, prompt) => {
  assert.match(system, /Resolve the source from the latest request and conversation/);
  assert.equal(prompt.split(followUp).length, 2);
});
await run(followUp);
assert.equal(updates.at(-1).summary, sourcedAnswer);
assert.ok(updates.some(update => update.activity === 'Searching…'));
assert.ok(updates.some(update => update.activity === 'Reading page…'));
assert.ok(updates.some(update => update.activity === 'Thinking…'));
assert.deepEqual(observations, [2]);
assert.equal(new URL(opened[0]).searchParams.get('q'), query);
assert.equal(tabs.get(1).url, activePage);

const leakedThought = 'The user is asking about chess. I will summarize the page.';
messages.get('bitcoin').at(-1).text = leakedThought;
messages.get('bitcoin').at(-1).thought = leakedThought;
search((system, prompt) => {
  assert.match(system, /Continue a prior browser or research task/);
  assert.ok(prompt.includes(followUp));
  assert.ok(prompt.includes('no, my previous requests'));
  assert.doesNotMatch(prompt, /summarize the page/);
});
await run('no, my previous requests');
assert.equal(updates.at(-1).summary, sourcedAnswer);
assert.deepEqual(observations, [2, 3]);

responses.push(({ prompt }) => {
  assert.doesNotMatch(prompt, /bitcoin/i);
  return { action: { type: 'clarify' }, userSummary: 'What would you like me to continue?' };
});
await run('continue', 'other');
assert.equal(updates.at(-1).summary, 'What would you like me to continue?');
assert.equal(opened.length, 2);

responses.push(() => ({ action: { type: 'observe_page' } }), ({ prompt }) => {
  assert.match(prompt, /Foony Chess/);
  return complete('This page lets you play chess online.');
});
await run('What is on this page?', 'page');
assert.match(updates.at(-1).summary, /play chess/);
assert.deepEqual(observations, [2, 3, 1]);

const readsBeforeChat = tabReads.length;
responses.push(() => ({ thought: 'The user wants to know my capabilities.' }), ({ system }) => {
  assert.match(system, /previous response could not be used/);
  return complete('I can answer questions, write and explain things, and browse when your task needs it.');
});
await run('what can you do?', 'capabilities');
assert.match(updates.at(-1).summary, /answer questions/);
assert.equal(tabReads.length, readsBeforeChat);
assert.equal(opened.length, 2);

responses.push(() => '{"action":{"type":"complete"},"userSummary":"cut off', () => complete('Here is the complete answer.'));
await run('Explain functions in JavaScript', 'truncated');
assert.equal(updates.at(-1).summary, 'Here is the complete answer.');
assert.equal(tabReads.length, readsBeforeChat);

responses.push(() => 'I can help you draft messages, explain code, and research topics.');
await run('Tell me more about what you can do', 'plain-chat');
assert.match(updates.at(-1).summary, /draft messages/);
assert.equal(tabReads.length, readsBeforeChat);

const originalError = console.error;
try {
  console.error = () => {};
  responses.push(...Array.from({ length: 2 }, () => () => ({ action: { type: 'complete' }, thought: leakedThought, userSummary: leakedThought })));
  await run('Tell me something interesting', 'thought');
  assert.equal(updates.at(-1).status, 'error');
  assert.equal(updates.at(-1).summary, undefined);
  assert.ok(messages.get('thought').every(entry => entry.text !== leakedThought));

  responses.push(() => complete(answer), () => complete(answer));
  await run(followUp);
  assert.match(updates.at(-1).error, /incomplete reply after retrying/);
  assert.equal(opened.length, 2);
} finally {
  console.error = originalError;
}

// Reproduce a readable Google results document while Chrome still reports "loading".
const showcase = 'just do what you want, its up to you to showcase me what you can do';
const searchPlan = () => ({ action: { type: 'search_web', text: query } });
createSearchTab = () => ({ status: 'loading' });
let probes = 0;
probeDocument = tabId => ++probes === 1 ? null : tabs.get(tabId).url;
responses.push(searchPlan, ({ prompt }) => {
  assert.match(prompt, /Bitcoin: A Peer-to-Peer Electronic Cash System/);
  return complete(sourcedAnswer);
});
await run(showcase, 'slow-search');
const slowTab = observations.at(-1);
assert.equal(tabs.get(slowTab).status, 'loading');
assert.equal(probes, 2);
assert.equal(updates.at(-1).summary, sourcedAnswer);
assert.equal(sessionStates.get('slow-search'), 'completed');
assert.deepEqual(pageMessages.at(-1), { id: slowTab, type: 'CLEAR_BADGES', state: undefined });
assert.equal(tabListeners.size, 0);
agent.stop(slowTab);
assert.equal(agent.getStatus().status, 'completed');
assert.equal(sessionStates.get('slow-search'), 'completed');

try {
  console.error = () => {};
  createSearchTab = () => ({ url: 'https://consent.google.com/' });
  responses.push(searchPlan);
  const observationsBeforeRedirect = observations.length;
  await run(showcase, 'consent');
  assert.equal(updates.at(-1).status, 'error');
  assert.match(updates.at(-1).error, /Google did not open the search results/);
  assert.equal(observations.length, observationsBeforeRedirect);
  assert.equal(pageMessages.at(-1).type, 'CLEAR_BADGES');
  assert.equal(tabListeners.size, 0);

  createSearchTab = () => ({ status: 'loading' });
  probeDocument = tabId => {
    tabs.delete(tabId);
    return null;
  };
  responses.push(searchPlan);
  await run(showcase, 'closed-search');
  assert.match(updates.at(-1).error, /search results could not be read/);
  assert.equal(sessionStates.get('closed-search'), 'failed');
  assert.equal(tabListeners.size, 0);

  // The overlay has been shown by the time the model fails after observation.
  createSearchTab = undefined;
  const beforeFailure = pageMessages.length;
  responses.push(searchPlan, () => { throw new Error('Mock provider failure'); });
  await run(showcase, 'failed-after-read');
  assert.equal(updates.at(-1).status, 'error');
  assert.equal(sessionStates.get('failed-after-read'), 'failed');
  const failureMessages = pageMessages.slice(beforeFailure);
  assert.ok(failureMessages.some(msg => msg.type === 'SHOW_GLOW' && msg.state === 'thinking'));
  assert.equal(failureMessages.at(-1).type, 'CLEAR_BADGES');
  assert.ok(!failureMessages.some(msg => msg.state === 'error' || msg.state === 'done'));
} finally {
  console.error = originalError;
}

createSearchTab = () => ({ status: 'loading' });
let reachedProbe;
const probing = new Promise(resolve => { reachedProbe = resolve; });
let finishProbe;
probeDocument = tabId => new Promise(resolve => {
  finishProbe = () => resolve(tabs.get(tabId).url);
  reachedProbe(tabId);
});
responses.push(searchPlan);
const cancelledRun = run(showcase, 'cancelled-search');
const cancelledTab = await probing;
agent.stop(cancelledTab - 1);
assert.equal(agent.getStatus().status, 'running', 'An old tab cannot stop this run');
agent.stop(cancelledTab);
await cancelledRun;
assert.equal(tabListeners.size, 0, 'Stop releases navigation listeners while a probe is still pending');
finishProbe();
assert.equal(updates.at(-1).status, 'idle');
assert.equal(sessionStates.get('cancelled-search'), 'stopped');
assert.deepEqual(pageMessages.at(-1), { id: cancelledTab, type: 'CLEAR_BADGES', state: undefined });
assert.notEqual(observations.at(-1), cancelledTab);

createSearchTab = undefined;
responses.push(searchPlan, () => complete(sourcedAnswer));
await run(showcase, 'retry-search');
assert.equal(updates.at(-1).summary, sourcedAnswer);
assert.equal(pageMessages.at(-1).type, 'CLEAR_BADGES');

// A cancelled model response must never publish into the replacement White turn.
let resolveOldModel;
let modelStarted;
const oldModelStarted = new Promise(resolve => { modelStarted = resolve; });
responses.push(() => new Promise(resolve => { resolveOldModel = resolve; modelStarted(); }));
const oldRun = agent.start('Play chess as Black', 1, { sessionId: 'chess', requestId: 'black', visionEnabled: false });
await oldModelStarted;
agent.stop();
responses.push(({ prompt }) => {
  assert.match(prompt, /Latest user message:\n"Play chess as White"/);
  assert.match(prompt, /Current page observation/);
  return complete('Ready to play White on the current board.');
});
await agent.start('Play chess as White', 1, { sessionId: 'chess', requestId: 'white', visionEnabled: false });
assert.equal(updates.at(-1).requestId, 'white');
const updateCount = updates.length;
resolveOldModel(complete('Old Black reply'));
await oldRun;
assert.equal(updates.length, updateCount);
assert.equal(updates.at(-1).summary, 'Ready to play White on the current board.');
assert.ok(!messages.get('chess').some(message => message.text === 'Old Black reply'));

// Exercise one complete drag with fresh observations/screenshots before and after.
const originalSend = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = async (id, message) => message.type === 'CHECK_ACTION_REVIEW'
  ? { required: true }
  : originalSend(id, message);
responses.push(() => ({ action: { type: 'click', targetIndex: 0 } }));
await agent.start('Click the submit button', 1, { sessionId: 'turbo-submit', safetyGate: false, visionEnabled: false });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
agent.stop();
chrome.tabs.sendMessage = originalSend;

responses.push(() => ({ action: { type: 'extract' } }), ({ system }) => {
  assert.doesNotMatch(system.match(/Allowed action types:[^.]+/)?.[0] ?? '', /\bextract\b/);
  return complete('I read the page using its observation.');
});
await run('Click and inspect the test page', 'unsupported-planner-action');
assert.equal(updates.at(-1).summary, 'I read the page using its observation.');
assert.equal(messages.get('unsupported-planner-action').some(message => message.kind === 'step'), false);

responses.push(() => ({ action: { type: 'click', targetIndex: 0 } }));
await agent.start('Click the test control', 1, { sessionId: 'review', safetyGate: true, visionEnabled: false });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.ok(agent.getStatus().approvalId);
const beforeApprovedAction = pageMessages.length;
chrome.tabs.sendMessage = async (id, message) => message.type === 'VALIDATE_OBSERVATION'
  ? { success: false }
  : originalSend(id, message);
await agent.confirmPendingAction();
assert.equal(sessionStates.get('review'), 'stopped');
assert.match(updates.at(-1).summary, /page changed before approval/i);
assert.ok(!pageMessages.slice(beforeApprovedAction).some(message => message.type === 'EXECUTE_ACTION'));
chrome.tabs.sendMessage = originalSend;

let boardVersion = 0;
let captures = 0;
chrome.tabs.sendMessage = async (id, message) => {
  if (message.type === 'VALIDATE_POINTER') return { success: true };
  const result = await originalSend(id, message);
  if (message.type === 'GET_PAGE_STATE') {
    result.state.visibleTextSummary = boardVersion ? 'White pawn is on e4. Black to move.' : 'White to move. White pawn on e2.';
    result.state.viewport = { width: 800, height: 600 };
  }
  return result;
};
chrome.debugger = {
  attach: async () => {}, detach: async () => {}, onDetach: { addListener() {} },
  sendCommand: async (_, method, params) => { if (params.type === 'mouseReleased') boardVersion++; },
};
storage.smith_provider_openrouter.model.vision = true;
agent.setEnvironmentHandlers({ captureScreenshot: async () => {
  captures++;
  return 'data:image/jpeg;base64,' + Buffer.from('board-' + boardVersion).toString('base64');
} });
responses.push(({ prompt, content }) => {
  assert.match(prompt, /White to move/);
  assert.ok(content.some(part => part.type === 'image_url'));
  return { action: { type: 'drag', startX: 100, startY: 400, endX: 100, endY: 200 } };
}, ({ prompt }) => {
  assert.match(prompt, /White pawn is on e4/);
  assert.match(prompt, /"drag":\[100,400,100,200\]/);
  return complete('Moved the White pawn to e4.');
});
await agent.start('Play chess as White', 1, { sessionId: 'chess-drag', requestId: 'move', visionEnabled: true, safetyGate: false });
assert.equal(boardVersion, 1);
assert.equal(captures, 2);
assert.equal(updates.at(-1).summary, 'Moved the White pawn to e4.');
assert.ok(Number.isFinite(agent.getStatus().timings.model));

// Stop while the mouse button is down: release it before the next run can plan.
let pressed;
let releasePress;
const didPress = new Promise(resolve => { pressed = resolve; });
const heldPress = new Promise(resolve => { releasePress = resolve; });
const inputEvents = [];
chrome.debugger.sendCommand = async (_, method, params) => {
  inputEvents.push(params.type);
  if (params.type === 'mousePressed') { pressed(); await heldPress; }
};
chrome.debugger.detach = async () => { inputEvents.push('detached'); };
responses.push(() => ({ action: { type: 'drag', startX: 100, startY: 400, endX: 100, endY: 200 } }));
const interruptedDrag = agent.start('Play chess as Black', 1, { sessionId: 'drag-stop', requestId: 'old-drag', visionEnabled: false, safetyGate: false });
await didPress;
agent.stop();
let replacementPlanned = false;
responses.push(() => {
  replacementPlanned = true;
  assert.deepEqual(inputEvents.slice(-2), ['mouseReleased', 'detached']);
  return complete('Ready for the next White move.');
});
const afterDrag = agent.start('Play chess as White', 1, { sessionId: 'drag-stop', requestId: 'new-drag', visionEnabled: false });
await new Promise(resolve => setImmediate(resolve));
assert.equal(replacementPlanned, false, 'Restart must wait for the held mouse button to be released');
releasePress();
await Promise.all([interruptedDrag, afterDrag]);
assert.equal(replacementPlanned, true);
assert.equal(updates.at(-1).requestId, 'new-drag');
assert.equal(updates.at(-1).summary, 'Ready for the next White move.');
assert.equal(sessionStates.get('drag-stop'), 'completed');

// A hung mouse-down gets a best-effort release and cannot block a replacement run.
let hungPressStarted;
const didHang = new Promise(resolve => { hungPressStarted = resolve; });
const hungEvents = [];
chrome.debugger.sendCommand = async (_, method, params) => {
  hungEvents.push(params.type);
  if (params.type === 'mousePressed') {
    hungPressStarted();
    await new Promise(() => {});
  }
};
chrome.debugger.detach = async () => { hungEvents.push('detached'); };
responses.push(() => ({ action: { type: 'drag', startX: 100, startY: 400, endX: 100, endY: 200 } }));
const hung = agent.start('Play chess as Black', 1, { sessionId: 'hung-drag', safetyGate: false, visionEnabled: false });
await didHang;
agent.stop();
responses.push(() => {
  assert.deepEqual(hungEvents.slice(-2), ['mouseReleased', 'detached']);
  return complete('Replacement task is ready.');
});
await Promise.all([hung, agent.start('Play chess as White', 1, { sessionId: 'after-hung', visionEnabled: false })]);
assert.equal(updates.at(-1).summary, 'Replacement task is ready.');

chrome.tabs.sendMessage = originalSend;
storage.smith_provider_openrouter.model.vision = false;

// An unchanged board should consume neither model requests nor action slots.
let readsWhileWaiting = 0;
chrome.tabs.sendMessage = async (id, message) => {
  const result = await originalSend(id, message);
  if (message.type === 'GET_PAGE_STATE' && ++readsWhileWaiting >= 4) result.state.visibleTextSummary = 'White to move.';
  return result;
};
responses.push(() => ({ action: { type: 'wait', amount: 500 } }), ({ prompt }) => {
  assert.match(prompt, /White to move/);
  return complete('The board has changed.');
});
await run('Play chess as White', 'wait-for-board');
assert.equal(readsWhileWaiting, 4);
assert.equal(agent.getStatus().stepCount, 0);
assert.equal(updates.at(-1).summary, 'The board has changed.');
chrome.tabs.sendMessage = originalSend;

// The former 30-action cutoff is gone, and the new boundary preserves a handoff.
chrome.tabs.sendMessage = async (id, message) => message.type === 'EXECUTE_ACTION'
  ? { success: true, message: 'Updated the test control.' }
  : originalSend(id, message);
responses.push(...Array.from({ length: 120 }, () => () => ({ action: { type: 'select', targetIndex: 0, value: 'test' } })));
const originalDebug = console.debug;
try {
  console.debug = () => {};
  await agent.start('Click through the test workflow', 1, { sessionId: 'long-run', safetyGate: false, visionEnabled: false });
} finally {
  console.debug = originalDebug;
}
assert.equal(agent.getStatus().stepCount, 120);
assert.equal(sessionStates.get('long-run'), 'stopped');
assert.match(updates.at(-1).summary, /120 browser actions.*action limit.*continue/i);
chrome.tabs.sendMessage = originalSend;

const filler = Array.from({ length: 30 }, (_, index) => ({
  kind: index % 2 ? 'assistant' : 'user',
  text: 'Unrelated material '.repeat(100) + index,
}));
const longContext = sessionContext([
  { kind: 'user', text: 'Keep answers short.' },
  { kind: 'user', text: 'Atlas invoices must be organized by fiscal quarter.' },
  ...filler,
  { kind: 'user', text: 'Try Atlas invoices again.' },
  { kind: 'step', step: { tool: 'navigate', result: { ok: true }, url: 'https://example.com/report?token=private&year=2026' } },
], 'Which fiscal quarter did I specify for Atlas invoices?');
assert.ok(longContext.includes('Atlas invoices must be organized by fiscal quarter.'));
assert.ok(longContext.includes('Try Atlas invoices again.'));
assert.ok(longContext.includes('year=2026'));
assert.doesNotMatch(longContext, /token=private/);
assert.ok(longContext.length < 7600);
assert.equal(requiresWebResearch('find the login button on this page'), false);
assert.equal(requiresWebResearch('find it in the browser and show me details'), true);
assert.equal(requiresWebResearch('What is the latest price of gold?'), true);
assert.equal(requiresWebResearch('What is the current price on this page?'), false);
assert.equal(responses.length, 0);

const selectTool = (type, args = {}) => ({ action: { type, ...args } });
const startWithTool = (type, goal, tabId, options, args = {}) => {
  responses.unshift(() => selectTool(type, args));
  return agent.start(goal, tabId, options);
};

// The normal chat entry point runs the trading skill without observing the active page.
globalThis.tradingStates = new Map();
const providerFetch = globalThis.fetch;
const hour = Math.floor(Date.now() / 3_600_000) * 3600;
const rows = Array.from({ length: 28 }, (_, index) => {
  const price = index === 26 ? 110 : 100;
  return [hour + (index - 27) * 3600, price, price + 1, price - 1, price, price, 100];
});
globalThis.fetch = (url, options) => {
  if (url.startsWith('https://api.kraken.com/0/public/AssetPairs?')) return Promise.resolve(Response.json({
    error: [], result: { XXBTZUSD: { wsname: 'XBT/USD', tick_size: '1', lot_decimals: 0, ordermin: '1', costmin: '10' } },
  }));
  if (url.startsWith('https://api.kraken.com/0/public/OHLC?')) return Promise.resolve(Response.json({
    error: [], result: { XXBTZUSD: rows, last: hour },
  }));
  return providerFetch(url, options);
};
const browserCount = observations.length;
responses.push(() => ({ summary: 'The breakout met the configured rule.', evidence: ['setup'] }));
await startWithTool('analyze_market', 'Analyze BTC/USD on Kraken, 1h, and draw support and resistance', 1, { sessionId: 'trading', visionEnabled: false });
assert.match(updates.at(-1).summary, /\*\*BUY\*\*/);
assert.match(updates.at(-1).summary, /breakout met the configured rule/);
assert.equal(observations.length, browserCount);
assert.equal(globalThis.tradingStates.get('trading').analysis.snapshot.candles.length, 27);
responses.push(() => ({ summary: 'Position sizing uses the supplied paper risk budget.', evidence: ['risk'] }));
await startWithTool('analyze_market', 'Use a paper balance of 1,000 USD and risk 5%', 1, { sessionId: 'trading', visionEnabled: false });
assert.match(updates.at(-1).summary, /Paper quantity/);
assert.equal(globalThis.tradingStates.get('trading').analysis.budget.percent, 5);
assert.equal(observations.length, browserCount);

const currentTrade = globalThis.tradingStates.get('trading');
const priorTrade = { ...currentTrade.analysis, id: 'previous-market',
  snapshot: { ...currentTrade.analysis.snapshot, interval: '4h' } };
const savedBacktest = { id: 'retained-job', analysisId: priorTrade.id, status: 'completed',
  budget: currentTrade.analysis.budget, holdout: false,
  result: { initial: 1000, final: 1050, trades: [], totalCosts: 5, maxDrawdown: 0.01, benchmark: 0.03 } };
globalThis.tradingStates.set('trading', { ...currentTrade, analysis: priorTrade, job: savedBacktest });
const beforeUnsupported = calls.length;
await startWithTool('analyze_market', 'Use 5m instead', 1, { sessionId: 'trading', visionEnabled: false });
assert.match(updates.at(-1).summary, /do not support 5m/);
assert.equal(calls.length, beforeUnsupported + 1);
assert.equal(globalThis.tradingStates.get('trading').analysis.id, priorTrade.id);
responses.push(() => ({ summary: 'The rules use closed candles.', evidence: ['setup'] }));
await startWithTool('analyze_market', 'Use 1h instead', 1, { sessionId: 'trading', visionEnabled: false });
assert.equal(globalThis.tradingStates.get('trading').analysis.snapshot.interval, '1h');
assert.equal(globalThis.tradingStates.get('trading').job.id, 'retained-job');
assert.equal(globalThis.tradingStates.get('trading').job.source.interval, '4h');
responses.push(() => ({ summary: 'The sample has limited trades.', evidence: ['sample'] }));
await startWithTool('analyze_market', 'Review the saved backtest results', 1, { sessionId: 'trading', visionEnabled: false });
assert.match(updates.at(-1).summary, /Saved backtest · BTC\/USD · 4h/);

const savedTab = tabs.get(1);
const chartUrl = 'https://www.tradingview.com/chart/layout/?symbol=NASDAQ%3AAAPL&interval=60&private=secret';
const screenshot = 'data:image/jpeg;base64,dGVzdC1jaGFydA==';
const savedModel = storage.smith_provider_openrouter.model;
const openedBefore = opened.length;
const actionsBefore = pageMessages.length;
tabs.set(1, { ...savedTab, active: true, url: chartUrl, title: 'AAPL chart' });
storage.smith_provider_openrouter.model = { ...savedModel, vision: true };
let chartCaptures = 0;
agent.setEnvironmentHandlers({
  captureScreenshot: async id => {
    assert.equal(id, 1);
    chartCaptures++;
    return screenshot;
  },
  uploadFileViaCDP: async () => { throw new Error('Chart analysis should not upload files'); },
});
responses.push(({ system, prompt, content }) => {
  assert.match(system, /Base observations only on the visible candles/);
  assert.equal(JSON.parse(prompt).pageHints.symbol, 'NASDAQ:AAPL');
  assert.equal(JSON.parse(prompt).pageHints.timeframe, '60 minutes');
  assert.doesNotMatch(prompt, /private|secret/);
  assert.ok(content.some(part => part.type === 'image_url' && part.image_url.url === screenshot));
  return { status: 'chart', symbol: 'AAPL', exchange: 'NASDAQ', timeframe: '1h',
    summary: 'The visible candles show rising swing lows.', axisReadable: true,
    levels: [{ kind: 'support', from: 189.5, to: 190 }] };
});
await startWithTool('analyze_chart', 'Analyze this chart and mark support', 1, { sessionId: 'live-chart', visionEnabled: true });
assert.match(updates.at(-1).summary, /TradingView.*NASDAQ.*AAPL.*1h/);
assert.match(updates.at(-1).summary, /Support around 189\.5/);
assert.doesNotMatch(updates.at(-1).summary, /Open Trading|Kraken spot/);
assert.equal(chartCaptures, 1);
assert.equal(opened.length, openedBefore);
assert.equal(pageMessages.length, actionsBefore);
assert.equal(globalThis.tradingStates.has('live-chart'), false);

const planFromBrowser = 'Find where this move might run out of room in the browser and sketch the entry you would wait for.';
const capturesBeforePlan = chartCaptures;
responses.push(({ system, prompt, content }) => {
  assert.equal(JSON.parse(prompt).request, planFromBrowser);
  assert.equal(JSON.parse(prompt).pageHints.platform, 'TradingView');
  assert.ok(content.some(part => part.type === 'image_url' && part.image_url.url === screenshot));
  assert.doesNotMatch(system, /include demoDirection/);
  return { status: 'chart', symbol: 'AAPL', timeframe: '1h',
    summary: 'Swing lows are rising. Wait for a confirmed break above resistance. A close back inside the range invalidates the setup.' };
});
responses.unshift(({ system, prompt }) => {
  assert.match(system, /Choose by the requested outcome and evidence source/);
  assert.match(prompt, /Active tab site: "tradingview.com"/);
  return selectTool('analyze_chart');
});
await agent.start(planFromBrowser, 1, { sessionId: 'fresh-browser-trade-plan', visionEnabled: true, activeSite: 'tradingview.com' });
assert.match(updates.at(-1).summary, /Visible chart on TradingView[\s\S]*Wait for a confirmed break/);
assert.equal(chartCaptures, capturesBeforePlan + 1);
assert.equal(pageMessages.length, actionsBefore);
assert.equal(opened.length, openedBefore);
assert.equal(globalThis.tradingStates.has('fresh-browser-trade-plan'), false);

await startWithTool('analyze_chart', 'What is the trend on this chart?', 1, { sessionId: 'live-chart', visionEnabled: false });
assert.match(updates.at(-1).summary, /Enable.*Send page screenshots/);
assert.equal(chartCaptures, capturesBeforePlan + 1);

tabs.set(1, { ...savedTab, active: true, url: 'https://example.com/markets/BTCUSD' });
responses.push(({ prompt }) => {
  assert.equal(JSON.parse(prompt).pageHints.platform, 'example.com');
  return { status: 'chart', symbol: 'BTC/USD', timeframe: '15m',
    summary: 'The visible candles are consolidating.', axisReadable: false,
    levels: [{ kind: 'support', from: 1 }] };
});
await startWithTool('analyze_chart', 'Read the chart in this tab', 1, { sessionId: 'live-chart', visionEnabled: true });
assert.match(updates.at(-1).summary, /consolidating/);
assert.doesNotMatch(updates.at(-1).summary, /Support around/);

agent.setEnvironmentHandlers({
  captureScreenshot: async () => {
    tabs.set(1, { ...savedTab, active: true, url: 'https://example.com/another-chart' });
    return screenshot;
  },
  uploadFileViaCDP: async () => false,
});
const modelCallsBefore = calls.length;
await startWithTool('analyze_chart', 'Analyze the current chart', 1, { sessionId: 'live-chart', visionEnabled: true });
assert.match(updates.at(-1).summary, /couldn’t capture the active chart/);
assert.equal(calls.length, modelCallsBefore + 1);
assert.equal(responses.length, 0);
assert.equal(opened.length, openedBefore);
assert.equal(pageMessages.length, actionsBefore);

tabs.set(1, { ...savedTab, active: true, url: chartUrl });
agent.setEnvironmentHandlers({
  captureScreenshot: async () => { chartCaptures++; return screenshot; },
  uploadFileViaCDP: async () => false,
});
const chartOutput = { status: 'chart', symbol: 'AAPL', timeframe: '1h',
  summary: 'Price held its range.\nA close above the range would change the reading.' };
responses.push(() => 'Here is my reading.\n```json\n' + JSON.stringify(chartOutput) + '\n```');
await startWithTool('analyze_chart', 'Analyze this chart.', 1, { sessionId: 'chart-format', visionEnabled: true });
assert.match(updates.at(-1).summary, /Price held its range\. A close above the range/);

const beforeRetryCapture = chartCaptures;
responses.push(() => 'Price held its range.', ({ system, content }) => {
  assert.match(system, /first response could not be read/);
  assert.ok(content.some(part => part.type === 'image_url' && part.image_url.url === screenshot));
  return chartOutput;
});
await startWithTool('analyze_chart', 'Analyze this chart.', 1, { sessionId: 'chart-retry', visionEnabled: true });
assert.match(updates.at(-1).summary, /Price held its range/);
assert.equal(chartCaptures, beforeRetryCapture + 1);

responses.push(() => '{ "status":', () => 'I need more information.');
await startWithTool('analyze_chart', 'Analyze this chart.', 1, { sessionId: 'chart-bad-format', visionEnabled: true });
assert.match(updates.at(-1).summary, /unusable chart response twice/);

storage.smith_provider_openrouter.model = { ...savedModel, vision: false };
const beforeTextModel = [calls.length, chartCaptures];
await startWithTool('analyze_chart', 'Analyze this chart.', 1, { sessionId: 'chart-text-only', visionEnabled: true });
assert.match(updates.at(-1).summary, /configured for text only/);
assert.deepEqual([calls.length, chartCaptures], [beforeTextModel[0] + 1, beforeTextModel[1]]);
storage.smith_provider_openrouter.model = { ...savedModel, vision: true };

// Mixed chart navigation and demo-order requests use canvas input and a fresh screenshot.
tabs.set(1, { ...savedTab, active: true, url: 'https://app.expertoption.finance/' });
const sentMouse = [];
const historyInputs = [];
let allowPan = true;
chrome.debugger.sendCommand = async (_, method, params) => {
  if (method === 'Input.dispatchMouseEvent') sentMouse.push(params);
};
chrome.tabs.sendMessage = async (id, message) => {
  if (message.type === 'PREPARE_CHART_PAN') {
    assert.equal(id, 1);
    historyInputs.push(message.direction);
    return { gesture: { id: 'visible-chart', startX: 200, endX: 600, y: 220 } };
  }
  if (message.type === 'VALIDATE_CHART_PAN') return { success: allowPan && message.id === 'visible-chart' };
  assert.notEqual(message.type, 'EXECUTE_ACTION');
  return originalSend(id, message);
};
agent.setEnvironmentHandlers({
  captureScreenshot: async () => screenshot,
  uploadFileViaCDP: async () => false,
});
const chartReading = { status: 'chart', symbol: 'USD/CHF (OTC)', timeframe: '5s',
  summary: 'The visible range has mixed momentum.' };
responses.push(({ prompt }) => {
  assert.equal(sentMouse.filter(event => event.type === 'mouseReleased').length, 4);
  assert.match(JSON.parse(prompt).request, /scroll in the very begining/);
  return chartReading;
});
await startWithTool('prepare_trade', 'I am on Expert Option, see the chart, scroll in the very begining to analyze it, and operate buy and sell with your prediction',
  1, { sessionId: 'chart-pan', visionEnabled: true });
assert.deepEqual(historyInputs, ['earlier', 'earlier', 'earlier', 'earlier']);
assert.match(updates.at(-1).summary, /sent 4 drags toward earlier candles/);
assert.match(updates.at(-1).summary, /Order status: none submitted/);
assert.ok(sentMouse.filter(event => event.type === 'mousePressed').every(event => event.x === 200 && event.y === 220));

allowPan = false;
responses.push(() => chartReading);
await startWithTool('analyze_chart', 'use the browser deepshit', 1, { sessionId: 'chart-pan', visionEnabled: true });
assert.match(updates.at(-1).summary, /Visible chart/);
assert.equal(sentMouse.filter(event => event.type === 'mousePressed').length, 4);
assert.equal(opened.length, openedBefore);
responses.push(() => chartReading);
await startWithTool('prepare_trade', 'Place a demo order', 1, { sessionId: 'chart-order', visionEnabled: true });
assert.match(updates.at(-1).summary, /couldn’t verify.*Demo selected/);
assert.doesNotMatch(updates.at(-1).summary, /Choose one demo direction/);
const beforeOrder = calls.length;
const chartSend = chrome.tabs.sendMessage;
let demoSelected = false;
let demoMode = 'unknown';
let demoExpiry = '00:30';
let demoAsset = 'USD/CHF (OTC)';
let demoPrepares = 0;
let demoDealReads;
const demoInput = [];
chrome.debugger.sendCommand = async (_, method, params) => {
  if (method === 'Input.dispatchMouseEvent') demoInput.push(params.type);
};
chrome.tabs.sendMessage = async (id, message) => {
  if (message.type === 'READ_DEMO_MODE') return { mode: demoMode, expiry: demoExpiry };
  if (message.type === 'READ_DEMO_DEALS') return { deals: demoDealReads?.shift() };
  if (message.type === 'PREPARE_DEMO_ORDER') {
    demoPrepares++;
    return demoSelected
      ? { order: { token: 'demo-once', direction: message.direction, asset: demoAsset, amount: '$1',
        expiry: demoExpiry, x: 700, y: 300 } }
      : { problem: 'No selected Demo account.' };
  }
  if (message.type === 'VALIDATE_DEMO_ORDER') {
    return { success: demoSelected && message.token === 'demo-once' && demoExpiry === '00:30' };
  }
  return chartSend(id, message);
};
const demoGoal = 'Place one demo Up trade with the current amount and expiry';
await startWithTool('prepare_trade', demoGoal, 1, { sessionId: 'chart-order', safetyGate: false },
  { direction: 'up', analyzeChart: false });
assert.match(updates.at(-1).summary, /No selected Demo account/);
assert.equal(demoInput.length, 0);
demoSelected = true;
await startWithTool('prepare_trade', demoGoal, 1, { sessionId: 'chart-order', safetyGate: false },
  { direction: 'up', analyzeChart: false });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.match(agent.getStatus().summary, /Up on USD\/CHF \(OTC\) for \$1 with expiry 00:30/);
assert.equal(demoInput.length, 0);
demoExpiry = '01:00';
await agent.confirmPendingAction();
assert.match(updates.at(-1).summary, /order details.*changed/);
assert.equal(demoInput.length, 0);
demoExpiry = '00:30';
await startWithTool('prepare_trade', demoGoal, 1, { sessionId: 'chart-order', safetyGate: false },
  { direction: 'up', analyzeChart: false });
await Promise.all([agent.confirmPendingAction(), agent.confirmPendingAction()]);
assert.deepEqual(demoInput, ['mouseMoved', 'mousePressed', 'mouseReleased']);
assert.match(updates.at(-1).summary, /Sent one demo order click.*trade history/);
await startWithTool('prepare_trade', 'continue', 1, { sessionId: 'chart-order', safetyGate: false });
assert.match(updates.at(-1).summary, /does not authorize a new demo order/);
assert.deepEqual(demoInput, ['mouseMoved', 'mousePressed', 'mouseReleased']);
assert.equal(calls.length, beforeOrder + 4);
assert.equal(responses.length, 0);

const combinedGoal = 'analyze the current browser, and make me a trade, im on demo';
const combinedOrder = (sessionId, visionEnabled = true) =>
  startWithTool('prepare_trade', combinedGoal, 1, { sessionId, visionEnabled, safetyGate: false });
const directionReading = { ...chartReading, demoDirection: 'down' };
demoInput.length = 0;
const initialPrepares = demoPrepares;
responses.push(() => directionReading);
await startWithTool('prepare_trade', 'analyze the chart and then make a position', 1, { sessionId: 'implicit-position', visionEnabled: true });
assert.match(updates.at(-1).summary, /visible range has mixed momentum[\s\S]*Order status: none submitted/);
assert.equal(demoPrepares, initialPrepares);
assert.deepEqual(demoInput, []);

const oneMinuteGoal = 'use the browser, predict next 1 minute timeframe, and make a position';
const oneMinuteReading = { ...directionReading, timeframe: '1m', summary: 'The next-minute bias is unclear while price stays in its range.' };
responses.push(({ prompt, system, content }) => {
  assert.equal(JSON.parse(prompt).request, oneMinuteGoal);
  assert.match(system, /address the requested horizon/);
  assert.doesNotMatch(system, /include demoDirection/);
  assert.ok(content.some(part => part.type === 'image_url' && part.image_url.url === screenshot));
  return oneMinuteReading;
});
await startWithTool('prepare_trade', oneMinuteGoal, 1, { sessionId: 'implicit-position', visionEnabled: true });
assert.match(updates.at(-1).summary, /next-minute bias is unclear[\s\S]*Order status: none submitted/);
assert.equal(demoPrepares, initialPrepares);
assert.deepEqual(demoInput, []);

demoMode = 'demo';
responses.push(({ system }) => {
  assert.match(system, /include demoDirection/);
  return { ...directionReading, timeframe: '1m' };
});
await startWithTool('prepare_trade', oneMinuteGoal, 1, { sessionId: 'forecast-demo', visionEnabled: true });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.match(agent.getStatus().summary, /Down on USD\/CHF \(OTC\) for \$1 with expiry 00:30/);
assert.match(agent.getStatus().chartReply, /1m/);
assert.deepEqual(demoInput, []);
agent.stop();

// A recognized order on a supported terminal goes directly to a fresh chart.
const naturalGoal = 'Use the browser, tell me where this is headed and open one position.';
responses.push(({ prompt, content }) => {
  assert.equal(JSON.parse(prompt).request, naturalGoal);
  assert.ok(content.some(part => part.type === 'image_url'));
  return directionReading;
});
await startWithTool('prepare_trade', naturalGoal, 1, { sessionId: 'semantic-demo', visionEnabled: true });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.match(agent.getStatus().summary, /Down on USD\/CHF/);
assert.deepEqual(demoInput, []);
agent.stop();

// Exact reported paraphrases use semantic tool selection, not order phrase matching.
for (const text of ['use the browser and trade, deepshit',
  'based on your trading skill make a place yourself, why you are asking? are you an idiot?']) {
  responses.push(({ prompt, system }) => {
    assert.match(system, /prepare_trade/);
    assert.ok(prompt.includes(text));
    return { action: { type: 'prepare_trade' } };
  }, ({ prompt, system }) => {
    assert.equal(JSON.parse(prompt).request, text);
    assert.match(system, /include demoDirection/);
    return directionReading;
  });
  await agent.start(text, 1, { sessionId: 'semantic-follow-up', visionEnabled: true });
  assert.equal(agent.getStatus().status, 'waiting_confirmation');
  assert.match(agent.getStatus().summary, /Down on USD\/CHF/);
  assert.deepEqual(demoInput, []);
  agent.stop();
}

// The browser planner can hand off after inspecting the page too.
responses.push(() => ({ action: { type: 'observe_page' } }),
  () => ({ action: { type: 'prepare_trade' } }), () => directionReading);
await agent.start('Use the browser and trade based on what you see', 1,
  { sessionId: 'observed-trade', visionEnabled: true });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.deepEqual(demoInput, []);
agent.stop();

// A missing decision is retried with the same image; neutral is an explicit result.
responses.push(() => chartReading, () => ({ ...chartReading, demoReason: 'No directional setup in this range.' }));
await startWithTool('prepare_trade', 'Place a demo order', 1, { sessionId: 'neutral-decision', visionEnabled: true });
assert.match(updates.at(-1).summary, /No demo order prepared: No directional setup/);
assert.doesNotMatch(updates.at(-1).summary, /Choose|BUY or SELL/);
assert.deepEqual(demoInput, []);

// A separate chart turn can be followed by a short order request.
responses.push(() => chartReading);
await startWithTool('analyze_chart', 'Analyze this chart.', 1, { sessionId: 'chart-then-order', visionEnabled: true });
assert.equal(messages.get('chart-then-order').at(-1).source, 'active_chart');
responses.push(({ prompt, system, content }) => {
  assert.equal(JSON.parse(prompt).request, 'trade now');
  assert.equal(JSON.parse(prompt).orderDuration, '00:30');
  assert.match(system, /include demoDirection/);
  assert.match(system, /Technical analysis skill/);
  assert.ok(content.some(part => part.type === 'image_url'));
  return { ...chartReading, demoReason: 'Wait for a confirmed break.' };
});
await startWithTool('prepare_trade', 'trade now', 1, { sessionId: 'chart-then-order', visionEnabled: true });
assert.match(updates.at(-1).summary, /No demo order prepared: Wait for a confirmed break/);
responses.push(({ prompt, system }) => {
  assert.equal(JSON.parse(prompt).request, 'continue');
  assert.match(system, /include demoDirection/);
  return directionReading;
});
await startWithTool('prepare_trade', 'continue', 1, { sessionId: 'chart-then-order', visionEnabled: true });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.match(agent.getStatus().summary, /Down on USD\/CHF/);
assert.deepEqual(demoInput, []);
agent.stop();
await startWithTool('prepare_trade', 'continue', 1, { sessionId: 'chart-then-order', visionEnabled: true });
assert.match(updates.at(-1).summary, /does not authorize a new demo order/);
assert.deepEqual(demoInput, []);
// Keep the chart reply as the latest turn for the platform-switch check below.
responses.push(() => chartReading);
await startWithTool('analyze_chart', 'Analyze this chart.', 1, { sessionId: 'chart-then-order', visionEnabled: true });

// Follow-ups use the active chart even after switching from a supported terminal.
const supportedTerminal = tabs.get(1);
const preparesBeforePlatformChange = demoPrepares;
tabs.set(1, { ...savedTab, active: true, url: chartUrl });
responses.push(({ prompt, system }) => {
  assert.equal(JSON.parse(prompt).pageHints.platform, 'TradingView');
  assert.doesNotMatch(system, /include demoDirection/);
  return { ...chartReading, symbol: 'AAPL', timeframe: '1h' };
});
await startWithTool('prepare_trade', 'make a trade', 1, { sessionId: 'chart-then-order', visionEnabled: true });
assert.match(updates.at(-1).summary, /Visible chart on TradingView · AAPL/);
assert.match(updates.at(-1).summary, /does not have an order integration for this platform/);
assert.doesNotMatch(updates.at(-1).summary, /ExpertOption|Place one demo/);
assert.equal(demoPrepares, preparesBeforePlatformChange);
assert.deepEqual(demoInput, []);

// A chart reply saved by an earlier extension build still supports follow-ups.
delete messages.get('chart-then-order').at(-1).source;
responses.push(() => ({ ...chartReading, symbol: 'AAPL', timeframe: '1h' }));
await startWithTool('prepare_trade', 'open a position', 1, { sessionId: 'chart-then-order', visionEnabled: true });
assert.match(updates.at(-1).summary, /Visible chart on TradingView · AAPL/);
assert.equal(demoPrepares, preparesBeforePlatformChange);
tabs.set(1, supportedTerminal);

const preparesAfterForecast = demoPrepares;

// A model-selected trade still cannot override an explicit no-order instruction.
responses.push(() => ({ action: { type: 'prepare_trade' } }));
await agent.start('Use the browser for analysis only, do not place any order', 1,
  { sessionId: 'no-trade-override', visionEnabled: true });
assert.match(updates.at(-1).summary, /does not authorize a new demo order/);
assert.equal(demoPrepares, preparesAfterForecast);
assert.deepEqual(demoInput, []);

demoMode = 'real';
responses.push(({ system }) => {
  assert.doesNotMatch(system, /include demoDirection/);
  return directionReading;
});
await combinedOrder('real-account');
assert.match(updates.at(-1).summary, /Order status: none submitted.*Real selected/);
assert.equal(demoPrepares, preparesAfterForecast);
assert.deepEqual(demoInput, []);

demoMode = 'demo';
await combinedOrder('demo-vision-off', false);
assert.match(updates.at(-1).summary, /Enable.*Send page screenshots/);
assert.equal(demoPrepares, preparesAfterForecast);

responses.push(() => ({ ...chartReading, demoReason: 'Range compression gives no directional setup.' }));
await combinedOrder('demo-mixed-chart');
assert.match(updates.at(-1).summary, /No demo order prepared: Range compression/);
assert.equal(demoPrepares, preparesAfterForecast);

demoAsset = 'USD/CHF';
responses.push(() => directionReading);
await combinedOrder('demo-changed-asset');
assert.match(updates.at(-1).summary, /chart asset and the selected order asset could not be matched/);
assert.equal(demoPrepares, preparesAfterForecast + 1);
assert.deepEqual(demoInput, []);

demoAsset = 'USD/CHF (OTC)';
responses.push(({ system }) => {
  assert.match(system, /include demoDirection/);
  return directionReading;
});
await combinedOrder('combined-demo');
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.match(agent.getStatus().summary, /Down on USD\/CHF \(OTC\) for \$1 with expiry 00:30/);
assert.match(updates.at(-1).chartReply, /visible range has mixed momentum/);
assert.match(agent.getStatus().chartReply, /visible range has mixed momentum/);
assert.deepEqual(demoInput, []);
const oldDeal = { id: 'at_deals_history_item_1', asset: demoAsset, amount: '$1.00', payout: '+$0.00', time: '16:00:01' };
const newDeal = { ...oldDeal, id: 'at_deals_history_item_2', payout: '+$1.86', time: '16:00:02' };
demoDealReads = [[oldDeal], [oldDeal], [newDeal, oldDeal]];
await agent.confirmPendingAction();
assert.match(updates.at(-1).summary, /visible range has mixed momentum[\s\S]*new matching demo deal for Down[\s\S]*Listed payout: \+\$1.86/);
assert.ok(updates.some(update => /Demo order sent\. Checking history/.test(update.activity ?? '')));
assert.deepEqual(demoInput, ['mouseMoved', 'mousePressed', 'mouseReleased']);

demoInput.length = 0;
const preparesBeforeFollowUp = demoPrepares;
await startWithTool('prepare_trade', 'continue', 1, { sessionId: 'combined-demo', visionEnabled: true });
assert.match(updates.at(-1).summary, /does not authorize a new demo order/);
for (const followUp of ['use the browser deepshit', 'try again', 'continue', 'continue', 'retry', 'what about now']) {
  if (/browser|what about/.test(followUp)) {
    responses.push(({ system }) => {
      assert.doesNotMatch(system, /include demoDirection/);
      return directionReading;
    });
  }
  await startWithTool(/browser|what about/.test(followUp) ? 'analyze_chart' : 'prepare_trade',
    followUp, 1, { sessionId: 'combined-demo', visionEnabled: true });
  assert.match(updates.at(-1).summary, /Order status: none submitted|Visible chart/);
}
assert.equal(demoPrepares, preparesBeforeFollowUp);
assert.deepEqual(demoInput, []);

// A new browser task is independent of the earlier demo order, even in the same chat.
responses.push(({ prompt, system }) => {
  assert.match(prompt, /use the browser to summarize this page/i);
  assert.match(system, /user explicitly asked to use the browser/);
  return complete('A premature answer without looking.');
}, () => complete('Another premature answer.'), ({ prompt }) => {
  assert.match(prompt, /Current page observation/);
  return complete('This is the ExpertOption terminal.');
});
await run('Use the browser to summarize this page', 'combined-demo');
assert.equal(updates.at(-1).summary, 'This is the ExpertOption terminal.');

const modelCallsBeforeSwitch = calls.length;
tabs.set(1, { ...savedTab, active: true });
await startWithTool('prepare_trade', 'use the browser', 1, { sessionId: 'chart-order', visionEnabled: true });
assert.match(updates.at(-1).summary, /does not authorize a new demo order/);
assert.equal(calls.length, modelCallsBeforeSwitch + 1);

tabs.set(1, { ...savedTab, active: true, url: 'https://app.expertoption.finance/' });
responses.push(() => complete('A demo order uses virtual funds.'));
await run('What happens when I place a demo order?', 'demo-question');
assert.equal(updates.at(-1).summary, 'A demo order uses virtual funds.');
await startWithTool('prepare_trade', 'Place an Up or Down demo order', 1, { sessionId: 'ambiguous-demo-direction', visionEnabled: false });
assert.match(updates.at(-1).summary, /Enable.*Send page screenshots/);

responses.push(() => ({ action: { type: 'click', x: 700, y: 300 } }));
await agent.start('Click the green button', 1, { sessionId: 'generic-expertoption', safetyGate: false });
assert.match(updates.at(-1).summary, /Use the ExpertOption trading page to change its controls/);
assert.equal(demoPrepares, preparesBeforeFollowUp);
assert.deepEqual(demoInput, []);

tabs.set(1, { ...savedTab, active: true, url: 'https://www.expertoption.com/help/' });
responses.push(() => ({ action: { type: 'click', x: 100, y: 100 } }));
await agent.start('Click the help button', 1, { sessionId: 'expertoption-help', safetyGate: true, visionEnabled: false });
assert.equal(agent.getStatus().status, 'waiting_confirmation');
assert.match(agent.getStatus().summary, /Allow click on www.expertoption.com/);
agent.stop();
assert.equal(responses.length, 0);
chrome.tabs.sendMessage = originalSend;
tabs.set(1, savedTab);
storage.smith_provider_openrouter.model = savedModel;
globalThis.fetch = providerFetch;
console.log('Conversation and browser routing tests passed.');

