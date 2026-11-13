import type { OpenCodeSignInMethod, ProviderConfig, ProviderId, ProviderModel } from '../background/model-providers';

interface OpenCodeSignInReply {
  methods?: OpenCodeSignInMethod[];
  pending?: { mode: 'auto' | 'code'; instructions: string };
}

interface ProviderReply extends OpenCodeSignInReply {
  activeId: ProviderId;
  settings: Omit<ProviderConfig, 'key'>;
  hasKey: boolean;
  models?: ProviderModel[];
}

async function send(type: string, extra: object = {}): Promise<ProviderReply> {
  const reply = await chrome.runtime.sendMessage({ type, ...extra });
  if (!reply?.success) throw new Error(reply?.error || 'Could not reach the extension background.');
  return reply;
}

export function initProviderSettings(): void {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const fields = byId<HTMLFieldSetElement>('provider-fields');
  const provider = byId<HTMLSelectElement>('settings-provider');
  const model = byId<HTMLSelectElement>('settings-model-select');
  const key = byId<HTMLInputElement>('provider-key');
  const endpoint = byId<HTMLInputElement>('provider-endpoint');
  const note = byId('provider-status');
  const vision = byId<HTMLInputElement>('provider-vision');
  const clear = byId<HTMLButtonElement>('provider-clear');
  const dropdown = byId('custom-model-dropdown');
  const pill = byId<HTMLButtonElement>('model-pill-btn');
  const pillLabel = byId('model-pill-label');
  const menu = byId('custom-model-menu');
  const search = byId<HTMLInputElement>('model-search');
  const list = byId('model-menu-list');
  let settings: ProviderReply | undefined;
  let catalog: ProviderModel[] = [];
  let active: ProviderReply['settings'] | undefined;
  let activeCatalog: ProviderModel[] = [];
  let signInMethods: OpenCodeSignInMethod[] = [];
  const signInSection = byId('opencode-sign-in');
  const signInMethod = byId<HTMLSelectElement>('opencode-sign-in-method');
  const startSignIn = byId<HTMLButtonElement>('opencode-start-sign-in');
  const authCode = byId<HTMLInputElement>('opencode-auth-code');
  const authInstructions = byId('opencode-sign-in-instructions');
  const pendingSignInSection = byId('opencode-sign-in-pending');

  function label(entry: ProviderModel): string {
    return entry.name + (entry.free ? ' · Free' : '') + (entry.vision ? ' · Vision' : '');
  }

  function renderMenu(): void {
    const term = search.value.trim().toLowerCase();
    const entries = activeCatalog.filter(item => (item.name + ' ' + item.id).toLowerCase().includes(term));
    list.replaceChildren(...entries.map(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'custom-model-item';
      button.dataset.model = entry.id;
      button.classList.toggle('active', entry.id === active?.model?.id);
      button.setAttribute('aria-pressed', String(entry.id === active?.model?.id));
      button.textContent = label(entry);
      button.title = entry.id;
      return button;
    }));
    if (!entries.length) {
      const hint = document.createElement('p');
      hint.className = 'model-menu-hint';
      hint.textContent = term ? 'No models match.' : 'Load models in Settings.';
      list.append(hint);
    }
    pillLabel.textContent = active?.model?.name || 'Choose model';
    const activeOption = Array.from(provider.options).find(option => option.value === active?.id);
    byId('active-provider-label').textContent = activeOption?.text ?? '';
  }

  function renderSettings(): void {
    if (!settings) return;
    const { id, model: selected } = settings.settings;
    const isCustom = id === 'custom';
    const isOpenCode = id === 'opencode';
    byId('provider-endpoint-field').hidden = !isCustom && !isOpenCode;
    byId('provider-key-field').hidden = id === 'antigravity';
    byId('opencode-help').hidden = !isOpenCode;
    byId('provider-manual').hidden = !isCustom && id !== 'nvidia';
    byId('provider-key-label').textContent = isOpenCode ? 'Server password' : 'API key';
    key.placeholder = settings.hasKey ? 'Saved on this device' : isCustom ? 'Optional' : '';
    clear.hidden = !settings.hasKey;
    const entries = [...catalog];
    if (selected && !entries.some(entry => entry.id === selected.id)) entries.unshift(selected);
    model.replaceChildren(new Option('Choose a model', ''), ...entries.map(entry => new Option(label(entry), entry.id)));
    model.disabled = !entries.length;
    model.value = selected?.id ?? '';
    vision.checked = selected?.vision === true;
    byId('provider-vision-field').hidden = !selected || id === 'antigravity' || id === 'opencode';
  }

  function renderSignIn(reply: OpenCodeSignInReply): void {
    if (reply.methods) signInMethods = reply.methods;
    signInMethod.replaceChildren(
      new Option('Choose a sign-in method', ''),
      ...signInMethods.map((entry, index) => new Option(entry.provider + ' / ' + entry.label, String(index))),
    );
    signInMethod.disabled = Boolean(reply.pending) || !signInMethods.length;
    startSignIn.disabled = true;
    pendingSignInSection.hidden = !reply.pending;
    byId('opencode-code-field').hidden = reply.pending?.mode !== 'code';
    authInstructions.textContent = reply.pending
      ? [reply.pending.instructions, 'Return here and select Finish sign-in.'].filter(Boolean).join(' ')
      : '';
    authCode.value = '';
  }

  async function loadOpenCodeSignIn(): Promise<void> {
    signInSection.hidden = settings?.settings.id !== 'opencode' || !settings.hasKey;
    renderSignIn({ methods: [] });
    if (signInSection.hidden) return;
    const reply = await send('GET_OPENCODE_SIGN_IN');
    renderSignIn(reply);
    if (!reply.pending && !reply.methods?.length && !catalog.length) {
      note.textContent = 'OpenCode has no browser sign-in methods here. Connect a provider in OpenCode and load models again.';
    }
  }

  async function loadModels(id: ProviderId): Promise<void> {
    try {
      const reply = await send('GET_PROVIDER_MODELS', { providerId: id });
      catalog = reply.models ?? [];
      if (reply.activeId === id) activeCatalog = catalog.length ? catalog : reply.settings.model ? [reply.settings.model] : [];
      note.textContent = catalog.length ? catalog.length + ' models available.' : 'No models found. Check the provider connection.';
    } catch (err) {
      note.textContent = (err as Error).message;
    }
    renderSettings();
    renderMenu();
  }

  async function perform(work: () => Promise<void>): Promise<void> {
    if (fields.disabled) return;
    fields.disabled = true;
    pill.disabled = true;
    try {
      await work();
    } catch (err) {
      note.textContent = (err as Error).message;
    } finally {
      fields.disabled = false;
      pill.disabled = false;
    }
  }

  async function loadSettings(id?: ProviderId): Promise<void> {
    note.textContent = 'Loading provider settings…';
    settings = await send('GET_PROVIDER_SETTINGS', id ? { providerId: id } : {});
    provider.value = settings.settings.id;
    endpoint.value = settings.settings.endpoint ?? (provider.value === 'opencode' ? 'http://127.0.0.1:4096' : '');
    endpoint.placeholder = 'https://example.com/v1';
    key.value = '';
    catalog = [];
    if (settings.activeId === settings.settings.id) active = settings.settings;
    renderSettings();
    if (provider.value === 'antigravity' || settings.hasKey || (provider.value === 'custom' && settings.settings.endpoint)) {
      await loadModels(settings.settings.id);
    } else {
      note.textContent = 'Save your connection to load its models.';
      renderMenu();
    }
    await loadOpenCodeSignIn();
  }

  async function selectModel(entry: ProviderModel, id: ProviderId): Promise<void> {
    const reply = await send('SAVE_PROVIDER_SETTINGS', { provider: { id, model: entry } });
    active = reply.settings;
    if (settings?.settings.id === id) {
      settings = reply;
      activeCatalog = catalog.some(item => item.id === entry.id) ? catalog : [entry, ...catalog];
      renderSettings();
    }
    note.textContent = 'Using ' + entry.name + '.';
    renderMenu();
  }

  provider.addEventListener('change', () => void perform(() => loadSettings(provider.value as ProviderId)));
  function saveConnection(removeKey = false): void {
    void perform(async () => {
      const id = provider.value as ProviderId;
      note.textContent = 'Loading models…';
      const oldId = active?.id;
      settings = await send('SAVE_PROVIDER_SETTINGS', { provider: {
        id,
        ...((id === 'custom' || id === 'opencode') ? { endpoint: endpoint.value } : {}),
        ...(removeKey ? { key: '' } : key.value ? { key: key.value } : {}),
      } });
      active = settings.settings;
      if (oldId !== id || !active.model || removeKey) activeCatalog = active.model ? [active.model] : [];
      key.value = '';
      catalog = [];
      renderSettings();
      renderMenu();
      if (removeKey) note.textContent = 'Saved key removed.';
      else await loadModels(id);
      await loadOpenCodeSignIn();
    });
  }

  signInMethod.addEventListener('change', () => { startSignIn.disabled = !signInMethod.value; });
  startSignIn.addEventListener('click', () => void perform(async () => {
    if (!signInMethod.value) return;
    const method = signInMethods[Number(signInMethod.value)];
    if (!method) return;
    const reply = await send('START_OPENCODE_SIGN_IN', { provider: method.provider, method: method.method });
    renderSignIn(reply);
  }));
  byId('opencode-finish-sign-in').addEventListener('click', () => void perform(async () => {
    await send('FINISH_OPENCODE_SIGN_IN', { code: authCode.value });
    await loadModels('opencode');
    await loadOpenCodeSignIn();
  }));
  byId('opencode-cancel-sign-in').addEventListener('click', () => void perform(async () => {
    await send('CANCEL_OPENCODE_SIGN_IN');
    await loadOpenCodeSignIn();
  }));

  byId('provider-save').addEventListener('click', () => saveConnection());
  clear.addEventListener('click', () => saveConnection(true));
  model.addEventListener('change', () => {
    const entry = catalog.find(item => item.id === model.value) ?? settings?.settings.model;
    if (entry && model.value) void perform(() => selectModel(entry, provider.value as ProviderId));
  });
  vision.addEventListener('change', () => {
    const selected = settings?.settings.model;
    if (selected) void perform(() => selectModel({ ...selected, vision: vision.checked }, provider.value as ProviderId));
  });
  byId<HTMLFormElement>('provider-manual').addEventListener('submit', event => {
    event.preventDefault();
    const id = byId<HTMLInputElement>('provider-model-id').value.trim();
    if (id) void perform(async () => {
      if (!settings || settings.activeId !== provider.value) {
        note.textContent = 'Save the provider connection first.';
        return;
      }
      await selectModel({ id, name: id }, provider.value as ProviderId);
    });
  });

  function showMenu(open: boolean): void {
    menu.style.display = open ? 'flex' : 'none';
    dropdown.classList.toggle('open', open);
    pill.setAttribute('aria-expanded', String(open));
    if (open) search.focus();
  }
  pill.addEventListener('click', () => showMenu(!dropdown.classList.contains('open')));
  search.addEventListener('input', renderMenu);
  list.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-model]');
    const entry = activeCatalog.find(item => item.id === button?.dataset.model);
    const id = active?.id;
    if (!id || !entry) return;
    showMenu(false);
    void perform(() => selectModel(entry.id === active?.model?.id ? active.model : entry, id));
  });
  dropdown.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dropdown.classList.contains('open')) {
      event.stopPropagation();
      showMenu(false);
      pill.focus();
    }
  });
  document.addEventListener('click', event => {
    if (!dropdown.contains(event.target as Node)) showMenu(false);
  });

  void perform(() => loadSettings());
}