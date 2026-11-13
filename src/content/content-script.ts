/**
 * Content Script
 * Injected into active web pages. Bridges background agent commands to DOM interactions
 * and Closed Shadow DOM overlay visual effects.
 */

import { DOMObserver } from './dom-observer';
import { ElementAnnotator } from './element-annotator';
import { ActionExecutor } from './action-executor';
import { OverlayManager } from './overlay';
import { waitForPageSettle } from './page-settle';
import { prepareChartPan, validateChartPan } from './chart-pan';
import { prepareDemoOrder, readDemoTerminal, readRecentDemoDeals, validateDemoOrder } from './expertoption-demo';
import { isTradingControlAction } from '../trading/active-chart';
import { isExpertOptionTerminal } from '../trading/demo-order';

// Navigation can reach a readable DOM before Chrome's document_idle injection.
const pageContext = globalThis as typeof globalThis & { agentSmithContentReady?: boolean };
if (!pageContext.agentSmithContentReady) {
  registerContentScript();
  pageContext.agentSmithContentReady = true;
}

function registerContentScript(): void {
  // Listen for messages from background script or sidepanel
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      switch (request.type) {
        case 'PING': {
          sendResponse({ success: true, pong: true });
          break;
        }

        case 'SHOW_GLOW': {
          ElementAnnotator.showGlowingBorder(request.state || 'acting', request.statusText);
          sendResponse({ success: true });
          break;
        }

        case 'HIDE_GLOW': {
          ElementAnnotator.hideGlowingBorder();
          sendResponse({ success: true });
          break;
        }

        case 'SET_OVERLAY_STATE': {
          OverlayManager.setState(request.state, request.statusText);
          sendResponse({ success: true });
          break;
        }

        case 'GET_PAGE_STATE': {
          if (request.hideOverlay) ElementAnnotator.hideGlowingBorder();
          // Extract clean page state without altering host DOM
          const state = DOMObserver.extractPageState();
          sendResponse({ success: true, state });
          break;
        }

        case 'WAIT_FOR_PAGE_SETTLE': {
          await waitForPageSettle(request.actionType);
          sendResponse({ success: true });
          break;
        }

        case 'PREPARE_CHART_PAN': {
          const direction = request.direction;
          const gesture = direction === 'earlier' || direction === 'later' ? prepareChartPan(direction) : undefined;
          sendResponse({ gesture });
          break;
        }

        case 'VALIDATE_CHART_PAN': {
          sendResponse({ success: validateChartPan(request.id) });
          break;
        }

        case 'PREPARE_DEMO_ORDER': {
          if (sender.id !== chrome.runtime.id || (request.direction !== 'up' && request.direction !== 'down')) {
            sendResponse({ problem: 'Invalid demo order request.' });
            break;
          }
          sendResponse(prepareDemoOrder(request.direction));
          break;
        }

        case 'READ_DEMO_MODE': {
          sendResponse(sender.id === chrome.runtime.id ? readDemoTerminal() : { mode: 'unknown' });
          break;
        }

        case 'READ_DEMO_DEALS': {
          sendResponse({ deals: sender.id === chrome.runtime.id ? readRecentDemoDeals() : undefined });
          break;
        }

        case 'VALIDATE_DEMO_ORDER': {
          sendResponse({ success: sender.id === chrome.runtime.id && validateDemoOrder(request.token) });
          break;
        }

        case 'CHECK_ACTION_REVIEW': {
          sendResponse({ required: sender.id !== chrome.runtime.id || ActionExecutor.requiresReview(request.action, request.observationId) });
          break;
        }

        case 'EXECUTE_ACTION': {
          if (isExpertOptionTerminal(location.href) && isTradingControlAction(request.action?.type)) {
            sendResponse({ success: false, message: 'ExpertOption trade controls require the dedicated demo order review.' });
            break;
          }
          if (request.checkReview && ['click', 'press_key'].includes(request.action?.type) &&
              ActionExecutor.requiresReview(request.action, request.observationId)) {
            sendResponse({ success: false, message: 'The action now requires review. Recheck the current target.' });
            break;
          }
          const result = await ActionExecutor.execute(request.action, request.observationId);
          sendResponse(result);
          break;
        }

        case 'POINTER_FEEDBACK': {
          const { x, y, click, observationId } = request;
          if (DOMObserver.isCurrentObservation(observationId) && ActionExecutor.isViewportPoint(x, y)) {
            if (click) ElementAnnotator.playClickAnimation(x, y);
            else ElementAnnotator.moveVisualCursorTo(x, y);
          }
          sendResponse({ success: true });
          break;
        }

        case 'CHECK_CLICK_POINT': {
          const { x, y, observationId } = request;
          sendResponse({ success: ActionExecutor.validateClickPoint({ x, y }, observationId, request.checkReview === true) });
          break;
        }

        case 'VALIDATE_OBSERVATION': {
          sendResponse({ success: DOMObserver.isCurrentObservation(request.observationId) });
          break;
        }

        case 'VALIDATE_POINTER': {
          const { startX, startY, endX, endY, observationId } = request;
          const success = DOMObserver.isCurrentObservation(observationId) && DOMObserver.isObservedViewport()
            && ActionExecutor.isViewportPoint(startX, startY) && ActionExecutor.isViewportPoint(endX, endY);
          sendResponse({ success });
          break;
        }

        case 'CLEAR_BADGES': {
          ElementAnnotator.hideGlowingBorder();
          ElementAnnotator.removeVisualCursor();
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, message: 'Unknown request type' });
      }
    })().catch(() => sendResponse({ success: false, message: 'The page could not prepare or execute the action.' }));

    return true; // Keep channel open for async response
  });

  // Auto-initialize overlay container lazily
  try {
    OverlayManager.init();
  } catch {}

  console.log('[Antigravity Agent] Content script loaded on:', window.location.href);
}
