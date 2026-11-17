import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function loadAuth(clientId, clientSecret) {
  const { outputFiles } = await build({
    entryPoints: ['src/background/antigravity-auth.ts'],
    bundle: true,
    format: 'esm',
    write: false,
    define: {
      SMITH_OAUTH_CLIENT_ID: JSON.stringify(clientId),
      SMITH_OAUTH_CLIENT_SECRET: JSON.stringify(clientSecret),
    },
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
}

const values = {};
const tabs = [];
const exchanges = [];
globalThis.chrome = {
  storage: { local: {
    get: async () => ({ ...values }),
    set: async entries => Object.assign(values, entries),
    remove: async key => { delete values[key]; },
  }},
  tabs: { create: async tab => { tabs.push(tab); } },
  runtime: { sendMessage: async () => {} },
};
globalThis.fetch = async (url, request) => {
  if (url === 'https://oauth2.googleapis.com/token') {
    exchanges.push(new URLSearchParams(request.body));
    return Response.json({ access_token: 'test-access-token', refresh_token: 'test-refresh-token' });
  }
  assert.match(url, /loadCodeAssist$/);
  return Response.json({ cloudaicompanionProject: 'fixture-project' });
};

const publicBuild = await loadAuth('', '');
await assert.rejects(publicBuild.startLogin(), /Configure Antigravity OAuth/);
assert.equal(tabs.length, 0);

const auth = await loadAuth('fixture-client.apps.googleusercontent.com', 'fixture-secret');
const { authUrl } = await auth.startLogin();
const params = new URL(authUrl).searchParams;
assert.equal(params.get('code_challenge_method'), 'S256');
assert.equal(params.get('redirect_uri'), auth.ANTIGRAVITY_REDIRECT_URI);
const state = params.get('state');
const verifier = values.antigravity_pkce.verifier;
const callback = auth.ANTIGRAVITY_REDIRECT_URI + '?code=one-time-code&state=' + state;
assert.equal(await auth.handleOAuthCallback(callback.replace('localhost', 'example.com')), false);
assert.equal(await auth.handleOAuthCallback(callback.replace(state, 'different-state')), false);
values.antigravity_pkce.timestamp -= 11 * 60_000;
assert.equal(await auth.handleOAuthCallback(callback), false);
assert.equal(exchanges.length, 0);

values.antigravity_pkce.timestamp = Date.now();
const results = await Promise.all([auth.handleOAuthCallback(callback), auth.handleOAuthCallback(callback)]);
assert.deepEqual(results.sort(), [false, true]);
assert.equal(exchanges.length, 1);
assert.equal(exchanges[0].get('code_verifier'), verifier);
assert.equal(values.antigravity_token, 'test-access-token');
assert.equal(values.antigravity_pkce, undefined);
assert.equal(await auth.handleOAuthCallback(callback), false);
console.log('Antigravity OAuth fixture passed: public build, PKCE, origin, state, expiry, and duplicate callbacks.');
