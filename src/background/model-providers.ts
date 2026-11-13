/** Provider settings and transports used by the browser planner. */
const compatibleEndpoints = {
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
} as const;

export type ProviderId = 'antigravity' | 'opencode' | 'custom' | keyof typeof compatibleEndpoints;

export interface ProviderModel {
  id: string;
  name: string;
  vision?: boolean;
  free?: boolean;
  providerID?: string;
  modelID?: string;
}

export interface ProviderSettings {
  endpoint?: string;
  key?: string;
  model?: ProviderModel;
}

export interface ProviderConfig extends ProviderSettings {
  id: ProviderId;
}

export const antigravityModels: ProviderModel[] = [
  { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash High', vision: true },
  { id: 'gemini-3.7-flash-tiered', name: 'Gemini 3.7 Flash', vision: true },
  { id: 'gemini-3.6-flash-tiered', name: 'Gemini 3.6 Flash', vision: true },
  { id: 'gemini-pro-agent', name: 'Gemini 3.1 Pro', vision: true },
];

function providerId(value: unknown): ProviderId {
  if (value === 'antigravity' || value === 'opencode' || value === 'custom' ||
      (typeof value === 'string' && Object.hasOwn(compatibleEndpoints, value))) return value as ProviderId;
  throw new Error('Unknown AI provider.');
}

const storageKey = (id: ProviderId) => 'smith_provider_' + id;

export async function readProvider(id?: ProviderId): Promise<ProviderConfig> {
  if (!id) {
    const active = (await chrome.storage.local.get('smith_provider')).smith_provider;
    id = providerId(active ?? 'antigravity');
  }
  id = providerId(id);
  const key = storageKey(id);
  const data = await chrome.storage.local.get([key, 'antigravity_model']);
  const settings = (data[key] ?? {}) as ProviderSettings;
  const legacyModel = data.antigravity_model as string | undefined;
  if (id === 'antigravity') {
    const model = legacyModel
      ? antigravityModels.find(entry => entry.id === legacyModel) ?? { id: legacyModel, name: legacyModel, vision: true }
      : antigravityModels[0];
    return { id, model };
  }
  return { ...settings, id };
}

export async function saveProvider(input: ProviderConfig): Promise<void> {
  const id = providerId(input.id);
  const previous = await readProvider(id);
  const settings: ProviderSettings = { endpoint: previous.endpoint, key: previous.key, model: previous.model };
  if (input.endpoint !== undefined) {
    const endpoint = input.endpoint.trim() || undefined;
    if (endpoint !== settings.endpoint && (id === 'custom' || id === 'opencode')) {
      settings.model = undefined;
      settings.key = undefined;
    }
    settings.endpoint = endpoint;
  }
  if (input.key !== undefined) settings.key = input.key.trim() || undefined;
  if (input.model) {
    if (typeof input.model.id !== 'string' || !input.model.id.trim()) throw new Error('Choose a model.');
    settings.model = input.model;
  }
  if (id === 'custom' || id === 'opencode') baseUrl({ id, ...settings });
  await chrome.storage.local.set({
    smith_provider: id,
    [storageKey(id)]: settings,
    ...(id === 'antigravity' && settings.model ? { antigravity_model: settings.model.id } : {}),
  });
}

function baseUrl(config: ProviderConfig): string {
  if (config.id === 'antigravity') throw new Error('Use the Antigravity connection for this provider.');
  if (config.id !== 'custom' && config.id !== 'opencode') return compatibleEndpoints[config.id];
  let url: URL;
  try {
    url = new URL(config.endpoint || (config.id === 'opencode' ? 'http://127.0.0.1:4096' : ''));
  } catch {
    throw new Error('Enter a valid API base URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (config.id === 'opencode' && (!loopback || (url.pathname !== '/'))) ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error(config.id === 'opencode'
      ? 'Enter the root URL of a local OpenCode server.'
      : 'Use an HTTPS API base URL or HTTP on localhost.');
  }
  return url.href.replace(/\/+$/, '');
}

async function request(
  config: ProviderConfig,
  path: string,
  options: RequestInit = {},
  timeout = 25_000,
): Promise<any> {
  const headers = new Headers(options.headers);
  if (config.id === 'opencode') {
    if (!config.key) throw new Error('Enter your OpenCode server password.');
    const credential = new TextEncoder().encode('opencode:' + config.key);
    headers.set('Authorization', 'Basic ' + btoa(String.fromCharCode(...credential)));
  } else if (config.key) {
    headers.set('Authorization', 'Bearer ' + config.key);
  } else if (config.id !== 'custom') {
    throw new Error('Add the provider API key in Settings.');
  }
  if (options.body) headers.set('Content-Type', 'application/json');
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(baseUrl(config) + path, {
    ...options,
    headers,
    credentials: 'omit',
    redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Provider access denied (' + response.status + '). Check your credentials and model access.');
    }
    throw new Error('Provider request failed (' + response.status + ').');
  }
  if (response.status === 204) return undefined;
  return response.json();
}

interface OpenCodeCatalog {
  connected: string[];
  all: Array<{
    id: string;
    name?: string;
    models: Record<string, {
      id?: string;
      name?: string;
      capabilities?: { input?: { image?: boolean }; output?: { text?: boolean } };
      modalities?: { input?: string[] };
    }>;
  }>;
}

export async function listProviderModels(config: ProviderConfig): Promise<ProviderModel[]> {
  if (config.id === 'antigravity') return antigravityModels;
  if (config.id === 'opencode') {
    const catalog = await request(config, '/provider') as OpenCodeCatalog;
    if (!Array.isArray(catalog.all) || !Array.isArray(catalog.connected)) {
      throw new Error('This OpenCode server did not return a compatible model catalog.');
    }
    return catalog.all.filter(provider => catalog.connected.includes(provider.id)).flatMap(provider =>
      Object.entries(provider.models ?? {})
        .filter(([, model]) => model.capabilities?.output?.text !== false)
        .map(([key, model]) => {
          const modelID = model.id ?? key;
          return {
            id: provider.id + '/' + modelID,
            name: (provider.name || provider.id) + ' / ' + (model.name || modelID),
            providerID: provider.id,
            modelID,
            vision: model.capabilities?.input?.image ?? model.modalities?.input?.includes('image') ?? false,
          };
        }));
  }

  const catalog = await request(config, '/models');
  if (!Array.isArray(catalog?.data)) throw new Error('The provider did not return a model list.');
  const models = new Map<string, ProviderModel>();
  for (const model of catalog.data) {
    if (typeof model?.id !== 'string' || !model.id) continue;
    const inputs = model.architecture?.input_modalities ?? model.modalities?.input;
    const free = config.id === 'openrouter' && (model.id.endsWith(':free') || model.id === 'openrouter/free');
    models.set(model.id, {
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      vision: Array.isArray(inputs) ? inputs.includes('image') : undefined,
      free,
    });
  }
  if (config.id === 'openrouter' && !models.has('openrouter/free')) {
    models.set('openrouter/free', { id: 'openrouter/free', name: 'OpenRouter Free Router', free: true });
  }
  return [...models.values()].sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.name.localeCompare(b.name));
}

export async function completeWithProvider(
  config: ProviderConfig,
  system: string,
  prompt: string,
  image?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  if (!config.model) throw new Error('Choose a model for this provider in Settings.');
  const model = config.model;
  if (config.id === 'opencode') {
    if (!model.providerID || !model.modelID) throw new Error('Refresh the OpenCode catalog and select a model.');
    const agents = await request(config, '/agent', { signal });
    const planner = Array.isArray(agents) && agents.find(agent => agent.name === 'agent-smith');
    const permissions = planner?.permission;
    const denyAll = { permission: '*', pattern: '*', action: 'deny' };
    const guard = Array.isArray(permissions) ? permissions.reduce((last: number, rule: any, index: number) =>
      rule?.permission === denyAll.permission && rule.pattern === denyAll.pattern && rule.action === denyAll.action ? index : last, -1
    ) : -1;
    // OpenCode adds an internal output-directory exception after the agent rules.
    if (guard < 0 || permissions.slice(guard + 1).some((rule: any) =>
      rule?.action !== 'deny' &&
      !(rule?.permission === 'external_directory' && rule.action === 'allow' &&
        typeof rule.pattern === 'string' && /[\\/]opencode[\\/]tool-output[\\/]\*$/.test(rule.pattern))
    )) {
      throw new Error('Start OpenCode with the tool-disabled Agent Smith profile shown in Settings.');
    }
    const session = await request(config, '/session', {
      method: 'POST', signal, body: JSON.stringify({ title: 'Agent Smith planner', permission: [denyAll] }),
    });
    if (typeof session?.id !== 'string') throw new Error('OpenCode could not create a planner session.');
    const path = '/session/' + encodeURIComponent(session.id);
    try {
      const parts: object[] = [{ type: 'text', text: prompt }];
      if (image && model.vision) parts.push({ type: 'file', mime: 'image/jpeg', url: image });
      const answer = await request(config, path + '/message', {
        method: 'POST', signal,
        body: JSON.stringify({
          model: { providerID: model.providerID, modelID: model.modelID },
          agent: 'agent-smith',
          system,
          parts,
        }),
      }, 100_000);
      const text = answer?.parts?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
      if (!text?.trim()) throw new Error('OpenCode returned no model text. Check the connected provider and selected model.');
      return text;
    } catch (error) {
      await request(config, path + '/abort', { method: 'POST' }, 3000).catch(() => {});
      throw error;
    } finally {
      await request(config, path, { method: 'DELETE' }, 3000).catch(() => {});
    }
  }

  const content = image && model.vision
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }]
    : prompt;
  const answer = await request(config, '/chat/completions', {
    method: 'POST', signal,
    body: JSON.stringify({ model: model.id, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
  }, 100_000);
  const contentParts = answer?.choices?.[0]?.message?.content;
  const text = Array.isArray(contentParts)
    ? contentParts.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
    : contentParts;
  if (typeof text !== 'string' || !text.trim()) throw new Error('The provider returned no model text. Choose a chat model.');
  return text;
}
export interface OpenCodeSignInMethod {
  provider: string;
  method: number;
  label: string;
}

interface OpenCodeSignIn {
  provider: string;
  method: number;
  endpoint: string;
  mode: 'auto' | 'code';
  instructions: string;
  expiresAt: number;
}

const signInStorageKey = 'smith_opencode_sign_in';
let signInRequestInProgress = false;

async function pendingOpenCodeSignIn(config: ProviderConfig): Promise<OpenCodeSignIn | undefined> {
  const pending = (await chrome.storage.session.get(signInStorageKey))[signInStorageKey] as OpenCodeSignIn | undefined;
  if (pending && pending.endpoint === baseUrl(config) && pending.expiresAt > Date.now()) return pending;
  return undefined;
}

export async function listOpenCodeSignInMethods(config: ProviderConfig): Promise<OpenCodeSignInMethod[]> {
  const auth = await request(config, '/provider/auth');
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('This OpenCode server did not return its sign-in methods.');
  }
  return Object.entries(auth).flatMap(([provider, methods]) => Array.isArray(methods)
    ? methods.flatMap((entry, method) => entry?.type === 'oauth' && typeof entry.label === 'string' && !entry.prompts?.length
      ? [{ provider, method, label: entry.label }]
      : [])
    : []);
}

export async function getOpenCodeSignIn(config: ProviderConfig) {
  const pending = await pendingOpenCodeSignIn(config);
  return pending ? { mode: pending.mode, instructions: pending.instructions } : undefined;
}

export async function startOpenCodeSignIn(config: ProviderConfig, provider: string, method: number) {
  if (signInRequestInProgress) throw new Error('Another OpenCode sign-in request is in progress.');
  signInRequestInProgress = true;
  try {
    if (await pendingOpenCodeSignIn(config)) throw new Error('Finish or cancel the current OpenCode sign-in first.');
    const methods = await listOpenCodeSignInMethods(config);
    if (!methods.some(entry => entry.provider === provider && entry.method === method)) {
      throw new Error('Choose a supported OpenCode browser sign-in method.');
    }

    const auth = await request(config, '/provider/' + encodeURIComponent(provider) + '/oauth/authorize', {
      method: 'POST', body: JSON.stringify({ method }),
    });
    const url = new URL(auth?.url ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || (auth.method !== 'auto' && auth.method !== 'code')) {
      throw new Error('OpenCode returned an invalid browser sign-in request.');
    }
    const pending: OpenCodeSignIn = {
      provider,
      method,
      endpoint: baseUrl(config),
      mode: auth.method,
      instructions: typeof auth.instructions === 'string' ? auth.instructions : '',
      expiresAt: Date.now() + 10 * 60_000,
    };
    await chrome.storage.session.set({ [signInStorageKey]: pending });
    try {
      await chrome.tabs.create({ url: url.href });
    } catch (error) {
      await chrome.storage.session.remove(signInStorageKey);
      throw error;
    }
    return { mode: pending.mode, instructions: pending.instructions };
  } finally {
    signInRequestInProgress = false;
  }
}

export async function finishOpenCodeSignIn(config: ProviderConfig, code?: string): Promise<void> {
  if (signInRequestInProgress) throw new Error('Another OpenCode sign-in request is in progress.');
  signInRequestInProgress = true;
  try {
    const pending = await pendingOpenCodeSignIn(config);
    if (!pending) throw new Error('The OpenCode sign-in expired. Start a new browser sign-in.');
    const authorizationCode = typeof code === 'string' ? code.trim() : '';
    if (pending.mode === 'code' && !authorizationCode) throw new Error('Enter the authorization code from the provider.');
    const ok = await request(config, '/provider/' + encodeURIComponent(pending.provider) + '/oauth/callback', {
      method: 'POST',
      body: JSON.stringify({ method: pending.method, ...(pending.mode === 'code' ? { code: authorizationCode } : {}) }),
    }, 90_000);
    if (ok !== true) throw new Error('OpenCode did not confirm the sign-in.');
    await chrome.storage.session.remove(signInStorageKey);
  } finally {
    signInRequestInProgress = false;
  }
}

export async function cancelOpenCodeSignIn(): Promise<void> {
  if (signInRequestInProgress) throw new Error('Wait for the current OpenCode sign-in request to finish.');
  await chrome.storage.session.remove(signInStorageKey);
}
