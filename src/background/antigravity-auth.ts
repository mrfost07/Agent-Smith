/**
 * Antigravity Authentication Module
 * Implements Google Antigravity OAuth 2.0 PKCE flow for the browser extension.
 * Allows 1-click Google Sign-in to connect Antigravity without copying API keys.
 */

declare const SMITH_OAUTH_CLIENT_ID: string;
declare const SMITH_OAUTH_CLIENT_SECRET: string;

const ANTIGRAVITY_CLIENT_ID = typeof SMITH_OAUTH_CLIENT_ID === 'string' ? SMITH_OAUTH_CLIENT_ID : '';
const ANTIGRAVITY_CLIENT_SECRET = typeof SMITH_OAUTH_CLIENT_SECRET === 'string' ? SMITH_OAUTH_CLIENT_SECRET : '';
export const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback';
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
export const ANTIGRAVITY_PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const GOOGLE_API_USER_AGENT = 'google-api-nodejs-client/9.15.1';
export const ANTIGRAVITY_SETUP_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1';
export const ANTIGRAVITY_CLIENT_METADATA = JSON.stringify({
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
});
export const ANTIGRAVITY_USER_AGENT = 'antigravity/2.5.5 windows/amd64';

export const ANTIGRAVITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const;

function extractProjectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

export async function discoverAndOnboardProject(accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': GOOGLE_API_USER_AGENT,
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
      ideType: 'ANTIGRAVITY',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  };

  const loadRes = await fetch(`${ANTIGRAVITY_PROD_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
  });

  if (!loadRes.ok) {
    const text = await loadRes.text();
    console.warn('[AntigravityAuth] loadCodeAssist error:', loadRes.status, text);
    throw new Error(`loadCodeAssist failed (${loadRes.status}): ${text}`);
  }

  const loaded = await loadRes.json();
  const existing = extractProjectId(loaded?.cloudaicompanionProject);
  if (existing) {
    console.log('[AntigravityAuth] Discovered existing companion project:', existing);
    return existing;
  }

  // Attempt user onboarding for companion project with standard-tier (Noter.ai parity)
  const tierId = 'standard-tier';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const onboardRes = await fetch(`${ANTIGRAVITY_PROD_ENDPOINT}/v1internal:onboardUser`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tierId,
          metadata: {
            ideType: 'ANTIGRAVITY',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
      });

      if (onboardRes.ok) {
        const onboarded = await onboardRes.json();
        const project = onboarded?.done === true
          ? extractProjectId(onboarded?.response?.cloudaicompanionProject)
          : extractProjectId(onboarded?.cloudaicompanionProject);
        if (project) {
          console.log('[AntigravityAuth] Onboarded project successfully:', project);
          return project;
        }
      }
    } catch (e) {
      console.warn('[AntigravityAuth] Onboard attempt failed:', e);
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log('[AntigravityAuth] Using DefaultAntigravityProjectID:', ANTIGRAVITY_DEFAULT_PROJECT_ID);
  return ANTIGRAVITY_DEFAULT_PROJECT_ID;
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.byteLength; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function generatePkce(): Promise<{
  verifier: string;
  challenge: string;
  state: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64UrlEncode(bytes);

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const challenge = base64UrlEncode(new Uint8Array(hash));

  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = base64UrlEncode(stateBytes);

  return { verifier, challenge, state };
}

export function buildAuthorizationUrl(pkce: { challenge: string; state: string }): string {
  const params = new URLSearchParams([
    ['client_id', ANTIGRAVITY_CLIENT_ID],
    ['response_type', 'code'],
    ['redirect_uri', ANTIGRAVITY_REDIRECT_URI],
    ['scope', ANTIGRAVITY_SCOPES.join(' ')],
    ['code_challenge', pkce.challenge],
    ['code_challenge_method', 'S256'],
    ['state', pkce.state],
    ['access_type', 'offline'],
    ['prompt', 'consent'],
  ]);
  return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`;
}

export async function startLogin(): Promise<{ authUrl: string }> {
  if (!ANTIGRAVITY_CLIENT_ID || !ANTIGRAVITY_CLIENT_SECRET) {
    throw new Error('Configure Antigravity OAuth in .smith.local.json and rebuild, or select another provider.');
  }
  const pkce = await generatePkce();
  await chrome.storage.local.set({
    antigravity_pkce: {
      verifier: pkce.verifier,
      state: pkce.state,
      timestamp: Date.now(),
    },
  });
  const authUrl = buildAuthorizationUrl(pkce);
  await chrome.tabs.create({ url: authUrl });
  return { authUrl };
}

export async function handleOAuthCallback(url: string, tabId?: number): Promise<boolean> {
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.pathname.includes('/oauth-callback')) return false;

    const code = parsedUrl.searchParams.get('code');
    const state = parsedUrl.searchParams.get('state');
    const error = parsedUrl.searchParams.get('error');

    if (error) {
      console.error('[AntigravityAuth] OAuth error reported from Google:', error);
      return false;
    }
    if (!code) return false;

    const stored = await chrome.storage.local.get(['antigravity_pkce']);
    const pkce = stored.antigravity_pkce;
    if (!pkce || !pkce.verifier) {
      console.warn('[AntigravityAuth] No active PKCE session found, attempting token exchange anyway');
    }

    // Exchange authorization code for tokens
    const bodyParams = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    });
    if (pkce?.verifier) {
      bodyParams.append('code_verifier', pkce.verifier);
    }

    const tokenRes = await fetch(ANTIGRAVITY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': GOOGLE_API_USER_AGENT,
      },
      body: bodyParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[AntigravityAuth] Token exchange failed:', errText);
      return false;
    }

    const bundle = await tokenRes.json();
    const accessToken = bundle.access_token;
    const refreshToken = bundle.refresh_token;
    const expiresIn = bundle.expires_in || 3600;

    // Discover or onboard Cloud AI companion project
    let projectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
    try {
      projectId = await discoverAndOnboardProject(accessToken);
    } catch (e: any) {
      console.warn('[AntigravityAuth] Onboarding failed, using default project:', e.message);
    }

    // Persist credentials
    await chrome.storage.local.set({
      antigravity_token: accessToken,
      antigravity_refresh_token: refreshToken || '',
      antigravity_expires_at: Date.now() + expiresIn * 1000,
      antigravity_project: projectId,
      antigravity_mode: 'token',
    });
    await chrome.storage.local.remove(['antigravity_pkce']);

    // Redirect tab to friendly success page
    if (tabId) {
      chrome.tabs.update(tabId, {
        url: chrome.runtime.getURL('dist/popup/auth-success.html'),
      }).catch(() => {});
    }

    // Broadcast success
    chrome.runtime.sendMessage({
      type: 'ANTIGRAVITY_AUTH_CHANGED',
      signedIn: true,
      projectId,
    }).catch(() => {});

    console.log('[AntigravityAuth] Successfully logged in with Antigravity account!');
    return true;
  } catch (err) {
    console.error('[AntigravityAuth] handleOAuthCallback failed:', err);
    return false;
  }
}

export async function getValidAccessToken(): Promise<string | null> {
  const data = await chrome.storage.local.get([
    'antigravity_token',
    'antigravity_refresh_token',
    'antigravity_expires_at',
  ]);

  const token = data.antigravity_token;
  const refreshToken = data.antigravity_refresh_token;
  const expiresAt = data.antigravity_expires_at || 0;

  if (!token && !refreshToken) return null;

  // Still valid for > 60 seconds
  if (token && expiresAt - Date.now() > 60_000) {
    return token;
  }

  if (!refreshToken || !ANTIGRAVITY_CLIENT_ID || !ANTIGRAVITY_CLIENT_SECRET) return token || null;

  // Refresh token
  try {
    const res = await fetch(ANTIGRAVITY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': GOOGLE_API_USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: refreshToken.trim(),
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!res.ok) {
      console.warn('[AntigravityAuth] Refresh token request rejected');
      return null;
    }

    const bundle = await res.json();
    const newAccessToken = bundle.access_token;
    const newRefreshToken = bundle.refresh_token || refreshToken;
    const expiresIn = bundle.expires_in || 3600;

    await chrome.storage.local.set({
      antigravity_token: newAccessToken,
      antigravity_refresh_token: newRefreshToken,
      antigravity_expires_at: Date.now() + expiresIn * 1000,
    });

    return newAccessToken;
  } catch (err) {
    console.error('[AntigravityAuth] Failed to refresh token:', err);
    return null;
  }
}

export async function signOut(): Promise<void> {
  await chrome.storage.local.remove([
    'antigravity_token',
    'antigravity_refresh_token',
    'antigravity_expires_at',
    'antigravity_project',
  ]);
  await chrome.storage.local.set({ antigravity_mode: 'bridge' });
  chrome.runtime.sendMessage({
    type: 'ANTIGRAVITY_AUTH_CHANGED',
    signedIn: false,
  }).catch(() => {});
}
