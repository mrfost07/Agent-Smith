import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/background/model-providers'; export { readAntigravityResponse } from './src/background/antigravity-response'; export { AntigravityClient } from './src/background/antigravity-client'; export { summarizeActions } from './src/sidepanel/action-summary';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const {
  readAntigravityResponse, listProviderModels, completeWithProvider, readProvider, saveProvider, AntigravityClient,
  listOpenCodeSignInMethods, getOpenCodeSignIn, startOpenCodeSignIn, finishOpenCodeSignIn, cancelOpenCodeSignIn,
  summarizeActions,
} =
  await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const storage = { antigravity_model: 'gemini-pro-agent' };
const sessionStorage = {};
const openedTabs = [];
globalThis.chrome = {
  tabs: { create: async ({ url }) => { openedTabs.push(url); } },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([keys].flat().map(key => [key, storage[key]])),
      set: async (values) => Object.assign(storage, values),
    },
    session: {
      get: async (key) => ({ [key]: sessionStorage[key] }),
      set: async (values) => Object.assign(sessionStorage, values),
      remove: async (key) => { delete sessionStorage[key]; },
    },
  },
};

assert.equal((await readProvider()).model.id, 'gemini-pro-agent');
await saveProvider({ id: 'nvidia', key: 'test-nim', model: { id: 'nim/text', name: 'NIM Text' } });
await saveProvider({ id: 'openrouter', key: 'test-router' });

const calls = [];
let safeAgent = true;
let extraPermission;
let signInUrl = 'https://auth.example.com/authorize';
globalThis.fetch = async (url, options) => {
  const method = options.method || 'GET';
  const body = options.body && JSON.parse(options.body);
  calls.push({ url, method, body, options });
  if (url === 'https://openrouter.ai/api/v1/models') {
    return Response.json({ data: [
      { id: 'example/text:free', name: 'Text', architecture: { input_modalities: ['text'] } },
      { id: 'example/vision', name: 'Vision', architecture: { input_modalities: ['text', 'image'] } },
    ] });
  }
  if (url.includes(':streamGenerateContent')) {
    const action = { action: { type: 'complete' }, isComplete: true, userSummary: 'Antigravity answered.' };
    const event = { response: { candidates: [{ content: { parts: [{ thought: true, text: 'Private thinking that must not become the answer.' }, { text: JSON.stringify(action).slice(0, 35) }, { text: JSON.stringify(action).slice(35) }] } }] } };
    return new Response('data: ' + JSON.stringify(event));
  }
  if (url.endsWith('/chat/completions')) {
    const action = { action: { type: 'complete' }, isComplete: true, userSummary: 'Provider answered.' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(action) } }] });
  }
  if (url.endsWith('/provider')) {
    return Response.json({ all: [
      { id: 'connected', name: 'Connected', models: { 'model/family': { name: 'Vision', capabilities: { input: { image: true } } } } },
      { id: 'offline', models: { 'other': { name: 'Offline' } } },
    ], connected: ['connected'] });
  }
  if (url.endsWith('/provider/auth')) {
    return Response.json({ example: [
      { type: 'api', label: 'API key' },
      { type: 'oauth', label: 'Browser login' },
      { type: 'oauth', label: 'Enter an instance', prompts: [{ type: 'text' }] },
      { type: 'oauth', label: 'Device login' },
    ] });
  }
  if (url.endsWith('/oauth/authorize')) {
    return Response.json({ url: signInUrl, method: body.method === 1 ? 'code' : 'auto', instructions: 'Sign in to your account.' });
  }
  if (url.endsWith('/oauth/callback')) return Response.json(true);
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'smoke-model', name: 'Smoke Model' }] });
  if (url.endsWith('/agent')) {
    return Response.json([{ name: 'agent-smith', permission: [{ permission: '*', pattern: '*', action: safeAgent ? 'deny' : 'allow' }, ...(extraPermission ? [extraPermission] : [])] }]);
  }
  if (url.endsWith('/session')) return Response.json({ id: 'test-session' });
  if (url.endsWith('/message')) return Response.json({ parts: [{ type: 'text', text: 'OpenCode answered.' }] });
  if (method === 'DELETE') return Response.json(true);
  throw new Error('Unexpected URL ' + url);
};

const router = await readProvider();
const catalog = await listProviderModels(router);
assert.equal(catalog.length, 3);
assert.equal(catalog.find(model => model.id === 'example/text:free').free, true);
assert.equal(catalog.find(model => model.id === 'example/vision').vision, true);
assert.equal(calls.at(-1).options.headers.get('Authorization'), 'Bearer test-router');
await saveProvider({ id: 'openrouter', model: catalog.find(model => model.id === 'example/text:free') });
const planner = new AntigravityClient();
const page = { url: 'https://example.com', title: 'Demo', visibleTextSummary: '', interactiveElements: [] };
const result = await planner.planNextStep('Say hello.', [], page, 'data:image/jpeg;base64,YQ==');
assert.equal(result.userSummary, 'Provider answered.');
assert.equal(calls.at(-1).body.model, 'example/text:free');
assert.equal(typeof calls.at(-1).body.messages[1].content, 'string');
assert.doesNotMatch(calls.at(-1).body.messages[0].content, /@gmail\.com/);
await saveProvider({ id: 'openrouter', model: catalog.find(model => model.id === 'example/vision') });
await planner.planNextStep('Say hello.', [], page, 'data:image/jpeg;base64,YQ==');
assert.equal(calls.at(-1).body.messages[1].content[1].type, 'image_url');

await saveProvider({ id: 'nvidia' });
assert.equal((await readProvider()).key, 'test-nim');
await planner.planNextStep('Say hello.', [], page);
assert.equal(calls.at(-1).url, 'https://integrate.api.nvidia.com/v1/chat/completions');
await saveProvider({ id: 'custom', endpoint: 'https://example.com/v1', key: 'custom-key', model: { id: 'custom-model', name: 'Custom' } });
await saveProvider({ id: 'custom', endpoint: 'https://another.example/v1' });
assert.equal((await readProvider()).model, undefined);
assert.equal((await readProvider()).key, undefined);
await assert.rejects(saveProvider({ id: 'custom', endpoint: 'http://another.example/v1' }), /HTTPS/);

const opencode = { id: 'opencode', key: 'local-pass', endpoint: 'http://127.0.0.1:4096' };
const [opencodeModel, ...otherModels] = await listProviderModels(opencode);
assert.equal(otherModels.length, 0);
assert.equal(opencodeModel.modelID, 'model/family');
assert.equal(calls.at(-1).options.headers.get('Authorization'), 'Basic ' + btoa('opencode:local-pass'));
extraPermission = { permission: 'external_directory', pattern: '/home/user/opencode/tool-output/*', action: 'allow' };
assert.equal(await completeWithProvider({ ...opencode, model: opencodeModel }, 'system', 'prompt'), 'OpenCode answered.');
assert.deepEqual(calls.at(-3).body.permission, [{ permission: '*', pattern: '*', action: 'deny' }]);
assert.deepEqual(calls.at(-2).body.model, { providerID: 'connected', modelID: 'model/family' });
assert.equal(calls.at(-1).method, 'DELETE');
extraPermission = { permission: 'bash', pattern: '*', action: 'allow' };
await assert.rejects(completeWithProvider({ ...opencode, model: opencodeModel }, 'system', 'prompt'), /tool-disabled/);
extraPermission = undefined;
safeAgent = false;
await assert.rejects(completeWithProvider({ ...opencode, model: opencodeModel }, 'system', 'prompt'), /tool-disabled/);
assert.match(calls.at(-1).url, /\/agent$/);
const endpoints = [
  ['nvidia', 'https://integrate.api.nvidia.com/v1'],
  ['openai', 'https://api.openai.com/v1'],
  ['groq', 'https://api.groq.com/openai/v1'],
  ['custom', 'https://another.example/v1'],
];
for (const [id, endpoint] of endpoints) {
  const config = { id, key: 'mock-key', ...(id === 'custom' ? { endpoint } : {}) };
  const [model] = await listProviderModels(config);
  assert.equal(calls.at(-1).url, endpoint + '/models');
  assert.equal(calls.at(-1).options.headers.get('Authorization'), 'Bearer mock-key');
  const answer = await completeWithProvider({ ...config, model }, 'System', 'Ping');
  assert.match(answer, /Provider answered/);
  assert.equal(calls.at(-1).url, endpoint + '/chat/completions');
}
assert.ok((await listProviderModels({ id: 'antigravity' })).some(model => model.id === 'gemini-pro-agent'));
storage.antigravity_token = 'mock-antigravity-token';
storage.antigravity_expires_at = Date.now() + 120_000;
storage.antigravity_project = 'mock-project';
await saveProvider({ id: 'antigravity' });
assert.equal((await planner.planNextStep('Say hello.', [], page)).userSummary, 'Antigravity answered.');
assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer mock-antigravity-token');
assert.equal(calls.at(-1).body.project, 'mock-project');

assert.deepEqual((await listOpenCodeSignInMethods(opencode)).map(method => method.method), [1, 3]);
await assert.rejects(startOpenCodeSignIn(opencode, 'example', 0), /supported/);
await startOpenCodeSignIn(opencode, 'example', 1);
assert.deepEqual(calls.at(-1).body, { method: 1 });
assert.deepEqual(openedTabs, [signInUrl]);
assert.equal((await getOpenCodeSignIn(opencode)).mode, 'code');
await assert.rejects(startOpenCodeSignIn(opencode, 'example', 1), /Finish or cancel/);
await assert.rejects(finishOpenCodeSignIn(opencode), /authorization code/);
await assert.rejects(finishOpenCodeSignIn({ ...opencode, endpoint: 'http://127.0.0.1:4097' }, 'example'), /expired/);
await finishOpenCodeSignIn(opencode, ' mock-code ');
assert.deepEqual(calls.at(-1).body, { method: 1, code: 'mock-code' });
assert.equal(await getOpenCodeSignIn(opencode), undefined);

await startOpenCodeSignIn(opencode, 'example', 3);
await finishOpenCodeSignIn(opencode);
assert.deepEqual(calls.at(-1).body, { method: 3 });
await startOpenCodeSignIn(opencode, 'example', 3);
await cancelOpenCodeSignIn();
assert.equal(await getOpenCodeSignIn(opencode), undefined);
signInUrl = 'http://insecure.example.com';
await assert.rejects(startOpenCodeSignIn(opencode, 'example', 1), /invalid browser sign-in/);

assert.equal(summarizeActions([]), '');
assert.equal(summarizeActions([
  { type: 'navigate', url: 'https://example.com/path?token=private', success: true },
  { type: 'type', text: 'private', success: true },
  { type: 'click', success: false },
  { type: 'complete', success: true },
]), 'I entered text and opened example.com. One action could not be completed.');
console.log('Provider and action-summary tests passed (mocked catalogs, routing, OAuth, and action outcomes).');

const delta = text => ({ candidates: [{ content: { parts: [{ text }] } }] });
assert.equal(readAntigravityResponse('data: ' + JSON.stringify(delta('Hello ')) + '\r\n\r\ndata: ' + JSON.stringify(delta('world'))), 'Hello world');
assert.equal(readAntigravityResponse(JSON.stringify([delta('one'), delta('two')])), 'onetwo');
assert.equal(readAntigravityResponse(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }] } }] })), '');
console.log('Antigravity stream tests passed, including thinking parts and final events without a newline.');

const savedFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: [
    { type: 'reasoning', text: 'Private provider reasoning' },
    { type: 'text', text: 'Visible ' }, { type: 'text', text: 'answer.' },
  ] } }] });
  assert.equal(await completeWithProvider({
    id: 'openrouter', key: 'mock', model: { id: 'blocks', name: 'Blocks' },
  }, 'System', 'Hello'), 'Visible answer.');
} finally {
  globalThis.fetch = savedFetch;
}
