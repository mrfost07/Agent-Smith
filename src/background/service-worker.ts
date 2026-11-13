/**
 * Background Service Worker
 * Manages extension state, CDP file uploading, tab screenshots, controls AgentEngine,
 * and handles Google Antigravity OAuth PKCE loopback authentication.
 */

import { AgentEngine } from './agent-engine';
import { browserUrl, disallowsBrowsing, quickChatReply } from './conversation-context';
import { CDPController } from './cdp-controller';
import { runOperation } from './run-operation';
import {
  cancelOpenCodeSignIn, finishOpenCodeSignIn, getOpenCodeSignIn, listOpenCodeSignInMethods,
  listProviderModels, readProvider, saveProvider, startOpenCodeSignIn,
} from './model-providers';
import { startLogin, handleOAuthCallback, signOut } from './antigravity-auth';
import { SessionManager } from './sessions';
import {
  getAllSessions,
  getSession,
  getSessionMessages,
  deleteSessionFull,
  deleteSessionScreenshots,
  getStorageStats,
  cleanupExpiredSessions,
  clearAllData,
} from '../shared/db';

const engine = new AgentEngine();
let startGeneration = 0;
let pendingStart: number | undefined;
let startSetup: Promise<void> = Promise.resolve();
const privateStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void privateStorage.catch(() => {});

// Auto-recover any interrupted sessions on service worker startup
const sessionsReady = SessionManager.getInstance().initOnStartup().catch(() => {});

// Broadcast engine updates to popup / sidepanel
engine.setUpdateListener((data) => {
  chrome.runtime.sendMessage({
    type: 'AGENT_UPDATE',
    data,
  }).catch(() => {
    // Popup or sidepanel might be closed, perfectly normal
  });
});

/**
 * Captures the current visible viewport screenshot as base64 JPEG.
 */
export async function captureTabScreenshot(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.windowId < 0) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 75,
    });
    const current = await chrome.tabs.get(tabId);
    return current.active && current.windowId === tab.windowId && current.url === tab.url ? dataUrl : null;
  } catch (err) {
    console.warn('[ServiceWorker] captureTabScreenshot failed:', err);
    return null;
  }
}

/**
 * Uploads a file from disk into an <input type="file"> via Chrome DevTools Protocol (CDP).
 * This completely bypasses the OS file-picker modal.
 */
export async function uploadFileViaCDP(
  tabId: number, selector: string, filePath: string, isCurrent: () => boolean,
): Promise<boolean> {
  if (!await CDPController.attach(tabId) || !isCurrent()) return false;
  const root = await CDPController.command(tabId, 'DOM.getDocument') as { root?: { nodeId: number } } | undefined;
  if (!root?.root || !isCurrent()) return false;
  const result = await CDPController.command(tabId, 'DOM.querySelector', {
    nodeId: root.root.nodeId, selector,
  }) as { nodeId?: number } | undefined;
  if (!result?.nodeId || !isCurrent()) return false;
  await CDPController.command(tabId, 'DOM.setFileInputFiles', {
    files: [filePath], nodeId: result.nodeId,
  });
  return true;
}

// Pass screenshot & CDP capabilities to engine
engine.setEnvironmentHandlers({
  captureScreenshot: captureTabScreenshot,
  uploadFileViaCDP: uploadFileViaCDP,
});

/**
 * Intercept Google OAuth loopback redirects on port 51121.
 * Works seamlessly whether a local bridge is running or standalone in the browser.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;

  if (
    url.includes('localhost:51121/oauth-callback') ||
    url.includes('127.0.0.1:51121/oauth-callback')
  ) {
    console.log('[ServiceWorker] Detected Antigravity OAuth callback navigation:', url);
    handleOAuthCallback(url, tabId);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    const fromPanel = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
    if (!fromPanel && (request.type !== 'STOP_AGENT' || sender.id !== chrome.runtime.id || sender.tab?.id === undefined)) {
      sendResponse({ success: false, error: 'Open the Agent Smith panel to use this command.' });
      return;
    }
    switch (request.type) {
      case 'GET_PROVIDER_SETTINGS':
      case 'SAVE_PROVIDER_SETTINGS':
      case 'GET_PROVIDER_MODELS': {
        await privateStorage;
        if (request.type === 'SAVE_PROVIDER_SETTINGS') await saveProvider(request.provider);
        const active = await readProvider();
        const config = request.providerId ? await readProvider(request.providerId) : active;
        const { key, ...settings } = config;
        const models = request.type === 'GET_PROVIDER_MODELS' ? await listProviderModels(config) : undefined;
        sendResponse({ success: true, activeId: active.id, settings, hasKey: Boolean(key), models });
        break;
      }

      case 'GET_OPENCODE_SIGN_IN':
      case 'START_OPENCODE_SIGN_IN':
      case 'FINISH_OPENCODE_SIGN_IN':
      case 'CANCEL_OPENCODE_SIGN_IN': {
        if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
          sendResponse({ success: false, error: 'OpenCode sign-in is available from the extension panel.' });
          break;
        }
        await privateStorage;
        const config = await readProvider('opencode');
        if (request.type === 'GET_OPENCODE_SIGN_IN') {
          const pending = await getOpenCodeSignIn(config);
          const methods = pending ? [] : await listOpenCodeSignInMethods(config);
          sendResponse({ success: true, methods, pending });
        } else if (request.type === 'START_OPENCODE_SIGN_IN') {
          const pending = await startOpenCodeSignIn(config, request.provider, request.method);
          sendResponse({ success: true, pending });
        } else {
          if (request.type === 'FINISH_OPENCODE_SIGN_IN') await finishOpenCodeSignIn(config, request.code);
          else await cancelOpenCodeSignIn();
          sendResponse({ success: true });
        }
        break;
      }

      case 'START_ANTIGRAVITY_LOGIN': {
        try {
          const res = await startLogin();
          sendResponse({ success: true, authUrl: res.authUrl });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'ANTIGRAVITY_LOGOUT': {
        try {
          await signOut();
          sendResponse({ success: true });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'START_AGENT': {
        if (pendingStart !== undefined || ['running', 'waiting_confirmation'].includes(engine.getStatus().status)) {
          sendResponse({ success: false, error: 'A task is already active. Stop it before starting another.' });
          break;
        }
        const generation = ++startGeneration;
        pendingStart = generation;
        const previousSetup = startSetup;
        let finishSetup!: () => void;
        startSetup = new Promise(resolve => { finishSetup = resolve; });
        try {
          await Promise.all([previousSetup, sessionsReady]);
          if (generation !== startGeneration) {
            sendResponse({ success: false, cancelled: true });
            break;
          }
          const chatOnly = disallowsBrowsing(request.goal) || Boolean(quickChatReply(request.goal));
          const tab = chatOnly ? undefined : (await runOperation(
            () => chrome.tabs.query({ active: true, currentWindow: true }), 5000, 'Finding active tab',
          ))[0];
          if (generation !== startGeneration) {
            sendResponse({ success: false, cancelled: true });
            break;
          }
          if (!chatOnly && !tab?.id) {
            sendResponse({ success: false, error: 'No active tab found.' });
            return;
          }

          // Get or create session
          let sessionId = request.sessionId;
          if (!sessionId) {
            const session = await SessionManager.getInstance().createSession(
              request.goal,
              tab?.id,
              tab?.url
            );
            sessionId = session.id;
            if (generation !== startGeneration) {
              await SessionManager.getInstance().updateStatus(sessionId, 'stopped');
              sendResponse({ success: false, cancelled: true });
              break;
            }
          } else {
            SessionManager.getInstance().setActiveSessionId(sessionId);
          }

          const activeUrl = browserUrl(tab?.url);
          void engine.start(request.goal, tab?.id ?? chrome.tabs.TAB_ID_NONE, {
            sessionId,
            requestId: request.requestId,
            visionEnabled: request.visionEnabled === true,
            safetyGate: request.safetyGate ?? true,
            activeSite: activeUrl ? new URL(activeUrl).hostname : undefined,
          }).catch(error => console.error('[AgentEngine] Could not start:', error));
          sendResponse({ success: true, sessionId });
        } finally {
          if (pendingStart === generation) pendingStart = undefined;
          finishSetup();
        }
        break;
      }

      case 'STOP_AGENT': {
        const sourceTabId = fromPanel ? undefined : sender.tab?.id;
        if (sourceTabId === undefined || sourceTabId === engine.getStatus().tabId) {
          startGeneration++;
          pendingStart = undefined;
        }
        engine.stop(sourceTabId);
        sendResponse({ success: true });
        break;
      }

      case 'CONFIRM_ACTION': {
        if (!request.approvalId || request.approvalId !== engine.getStatus().approvalId) {
          sendResponse({ success: false, error: 'This approval has expired.' });
          break;
        }
        void engine.confirmPendingAction();
        sendResponse({ success: true });
        break;
      }

      case 'GET_STATUS': {
        sendResponse({ success: true, status: engine.getStatus() });
        break;
      }

      // ========================================================================
      // Saved Sessions Handlers
      // ========================================================================
      case 'GET_ALL_SESSIONS': {
        try {
          await sessionsReady;
          const sessions = await getAllSessions();
          sendResponse({ success: true, sessions });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'GET_SESSION_DETAILS': {
        try {
          await sessionsReady;
          const session = await getSession(request.sessionId);
          const messages = await getSessionMessages(request.sessionId);
          sendResponse({ success: true, session, messages });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'RENAME_SESSION': {
        try {
          const session = await SessionManager.getInstance().renameSession(
            request.sessionId,
            request.title
          );
          sendResponse({ success: true, session });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'TOGGLE_PIN_SESSION': {
        try {
          const pinned = await SessionManager.getInstance().togglePin(request.sessionId);
          sendResponse({ success: true, pinned });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'TOGGLE_ARCHIVE_SESSION': {
        try {
          const archived = await SessionManager.getInstance().toggleArchive(request.sessionId);
          sendResponse({ success: true, archived });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'DELETE_SESSION': {
        try {
          if (engine.getStatus().sessionId === request.sessionId) engine.stop();
          await deleteSessionFull(request.sessionId);
          sendResponse({ success: true });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'DELETE_SCREENSHOTS': {
        try {
          await deleteSessionScreenshots(request.sessionId);
          sendResponse({ success: true });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'BRANCH_SESSION': {
        try {
          const session = await SessionManager.getInstance().branchSession(
            request.sessionId,
            request.upToSeq
          );
          sendResponse({ success: true, session });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'EXPORT_SESSION_MD': {
        try {
          const markdown = await SessionManager.getInstance().exportAsMarkdown(request.sessionId);
          sendResponse({ success: true, markdown });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'EXPORT_SESSION_JSON': {
        try {
          const json = await SessionManager.getInstance().exportAsJson(request.sessionId);
          sendResponse({ success: true, json });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'GET_STORAGE_STATS': {
        try {
          const stats = await getStorageStats();
          sendResponse({ success: true, stats });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'CLEAR_ALL_DATA': {
        try {
          startGeneration++;
          pendingStart = undefined;
          engine.stop();
          await startSetup;
          await clearAllData();
          await chrome.storage.session.remove('activeRun');
          sendResponse({ success: true });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  })().catch((error: unknown) => {
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'The request failed.' });
  });

  return true;
});

// Configure side panel behavior to open on action icon click (Claude style)
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// Fallback: direct action click handler to open side panel
chrome.action?.onClicked?.addListener(async (tab) => {
  try {
    if (tab?.id && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (err) {
    console.warn('[ServiceWorker] Failed to open side panel on click:', err);
  }
});

/**
 * Configure DeclarativeNetRequest to set forbidden headers:
 * - User-Agent: antigravity/2.5.5 windows/amd64
 * - X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1
 * - Client-Metadata: {"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}
 * - x-request-source: local
 * - Accept: text/event-stream, application/json
 * - Remove Origin header so Google Cloud Code doesn't block chrome-extension:// requests.
 */
export async function setupDeclarativeHeaderRules(): Promise<void> {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map((r) => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: [
        {
          id: 1,
          priority: 10,
          action: {
            type: 'modifyHeaders' as any,
            requestHeaders: [
              {
                header: 'user-agent',
                operation: 'set' as any,
                value: 'antigravity/2.5.5 windows/amd64',
              },
              {
                header: 'sec-ch-ua',
                operation: 'remove' as any,
              },
              {
                header: 'sec-ch-ua-mobile',
                operation: 'remove' as any,
              },
              {
                header: 'sec-ch-ua-platform',
                operation: 'remove' as any,
              },
              {
                header: 'x-goog-api-client',
                operation: 'set' as any,
                value: 'google-cloud-sdk vscode_cloudshelleditor/0.1',
              },
              {
                header: 'client-metadata',
                operation: 'set' as any,
                value: JSON.stringify({
                  ideType: 'ANTIGRAVITY',
                  platform: 'PLATFORM_UNSPECIFIED',
                  pluginType: 'GEMINI',
                }),
              },
              {
                header: 'x-request-source',
                operation: 'set' as any,
                value: 'local',
              },
              {
                header: 'accept',
                operation: 'set' as any,
                value: 'text/event-stream, application/json',
              },
              {
                header: 'origin',
                operation: 'remove' as any,
              },
            ],
          },
          condition: {
            urlFilter: '||daily-cloudcode-pa.googleapis.com',
          },
        },
        {
          id: 2,
          priority: 10,
          action: {
            type: 'modifyHeaders' as any,
            requestHeaders: [
              {
                header: 'user-agent',
                operation: 'set' as any,
                value: 'google-api-nodejs-client/9.15.1',
              },
              {
                header: 'sec-ch-ua',
                operation: 'remove' as any,
              },
              {
                header: 'sec-ch-ua-mobile',
                operation: 'remove' as any,
              },
              {
                header: 'sec-ch-ua-platform',
                operation: 'remove' as any,
              },
              {
                header: 'x-goog-api-client',
                operation: 'set' as any,
                value: 'google-cloud-sdk vscode_cloudshelleditor/0.1',
              },
              {
                header: 'client-metadata',
                operation: 'set' as any,
                value: JSON.stringify({
                  ideType: 'ANTIGRAVITY',
                  platform: 'PLATFORM_UNSPECIFIED',
                  pluginType: 'GEMINI',
                }),
              },
              {
                header: 'origin',
                operation: 'remove' as any,
              },
            ],
          },
          condition: {
            urlFilter: '||cloudcode-pa.googleapis.com',
          },
        },
      ],
    });

    if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
        console.log('[DNR Wire Header Injected!]', info.rule.ruleId, info.request.url);
      });
    }

    console.log('[Antigravity Agent] DeclarativeNetRequest wire headers registered successfully.');
  } catch (err) {
    console.warn('[Antigravity Agent] Failed to setup DeclarativeNetRequest wire headers:', err);
  }
}

// Ensure default project ID is ALWAYS rising-fact-p41fc (Noter.ai parity)
chrome.storage.local.get(['antigravity_project']).then((data) => {
  if (data.antigravity_project === 'default-cli-project' || !data.antigravity_project) {
    chrome.storage.local.set({ antigravity_project: 'rising-fact-p41fc' });
  }
}).catch(() => {});

setupDeclarativeHeaderRules();

console.log('[Antigravity Agent] Service Worker with CDP, Vision & Google Antigravity OAuth initialized.');
