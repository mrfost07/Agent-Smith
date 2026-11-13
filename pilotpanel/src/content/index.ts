/**
 * PilotPanel: Content Script Entry Point
 * Listens for perception and overlay commands, connects to PageRefRegistry.
 */

import { PageOverlay } from './overlay';
import { PageRefRegistry, buildElementTree } from './a11yTree';
import { extractPageText } from './pageText';
import { BackgroundToContentMessage } from '../shared/messages';

chrome.runtime.onMessage.addListener(
  (message: BackgroundToContentMessage, _sender, sendResponse: (res: unknown) => void) => {
    try {
      switch (message.type) {
        case 'SET_OVERLAY_VISIBLE':
          PageOverlay.setVisible(message.visible);
          sendResponse({ ok: true });
          break;

        case 'CLEANUP_OVERLAY':
          PageOverlay.remove();
          PageRefRegistry.clear();
          sendResponse({ ok: true });
          break;

        case 'GET_PAGE_DIMENSIONS':
          sendResponse({
            ok: true,
            content: {
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio || 1,
            },
          });
          break;

        case 'READ_PAGE': {
          try {
            const tree = buildElementTree({
              filter: message.filter,
              refId: message.refId,
              maxDepth: message.maxDepth,
              maxChars: message.maxChars,
            });
            sendResponse({ ok: true, content: tree });
          } catch (treeErr: unknown) {
            const msg = treeErr instanceof Error ? treeErr.message : String(treeErr);
            sendResponse({ ok: false, error: msg });
          }
          break;
        }

        case 'GET_PAGE_TEXT': {
          try {
            const text = extractPageText();
            sendResponse({ ok: true, content: text });
          } catch (textErr: unknown) {
            const msg = textErr instanceof Error ? textErr.message : String(textErr);
            sendResponse({ ok: false, error: msg });
          }
          break;
        }

        case 'GET_REF_BOUNDS': {
          const el = PageRefRegistry.getElement(message.ref);
          if (!el) {
            sendResponse({
              ok: false,
              error: `Ref "${message.ref}" not found in current page registry or was removed from DOM.`,
            });
            break;
          }
          const rect = el.getBoundingClientRect();
          sendResponse({
            ok: true,
            content: {
              ref: message.ref,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type in content script' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error: msg });
    }

    return true; // Keep sendResponse channel open for async returns
  }
);
