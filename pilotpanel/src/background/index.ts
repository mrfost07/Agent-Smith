/**
 * PilotPanel: Service Worker & Agent Coordinator
 * Strictly service-worker-safe (zero DOM APIs).
 * Manages streaming LLM communication, perception tool dispatch, and session history.
 */

import { logger } from '../shared/logger';
import { SidepanelToBackgroundMessage, BackgroundToSidepanelMessage } from '../shared/messages';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants';
import { PilotPanelSettings, ChatMessage, AgentStatus, StepCardData } from '../shared/types';
import { defaultGeminiProvider } from '../llm/gemini';
import { RUNTIME_SYSTEM_PROMPT } from '../llm/prompts';
import { LLMMessage } from '../llm/provider';
import { PERCEPTION_TOOLS } from '../llm/tools';
import { executePerceptionTool } from './perception';

const attachedTabs = new Set<number>();
let chatHistory: ChatMessage[] = [];
let currentStatus: AgentStatus = 'idle';
let activeAbortController: AbortController | null = null;

function broadcast(msg: BackgroundToSidepanelMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Sidepanel or options might be closed; safe to ignore
  });
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_page':
      return `Reading element tree (${args.filter || 'interactive'})`;
    case 'get_page_text':
      return 'Extracting main readable text';
    case 'find':
      return `Searching for "${args.query || ''}"`;
    case 'take_screenshot':
      return 'Capturing viewport screenshot';
    default:
      return `Invoking ${name}`;
  }
}

/**
 * Ensures clean debugger detachment when tabs are closed.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    chrome.debugger
      .detach({ tabId })
      .catch((err) => {
        logger.debug('onRemoved', 'Debugger already detached', err);
      })
      .finally(() => {
        attachedTabs.delete(tabId);
      });
  }
});

/**
 * Configure extension action to open the Side Panel.
 */
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  logger.warn('sidePanel', 'setPanelBehavior failed', err);
});

/**
 * Handle initial extension installation & settings.
 */
chrome.runtime.onInstalled.addListener(async () => {
  logger.info('Lifecycle', 'PilotPanel extension installed or updated.');
  const existing = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!existing[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
});

/**
 * Central runtime message listener for sidepanel and options.
 */
chrome.runtime.onMessage.addListener(
  (message: SidepanelToBackgroundMessage, _sender, sendResponse: (res: unknown) => void) => {
    (async () => {
      try {
        switch (message.type) {
          case 'GET_STATE': {
            const storedSettings = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
            const settings: PilotPanelSettings =
              storedSettings[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
            sendResponse({
              ok: true,
              status: currentStatus,
              settings,
              messages: chatHistory,
            });
            break;
          }

          case 'UPDATE_SETTINGS': {
            const storedSettings = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
            const current: PilotPanelSettings =
              storedSettings[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
            const updated = { ...current, ...message.settings };
            await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
            sendResponse({ ok: true, settings: updated });
            break;
          }

          case 'CLEAR_HISTORY': {
            chatHistory = [];
            currentStatus = 'idle';
            broadcast({ type: 'STATE_UPDATE', status: 'idle', mode: 'ask' });
            sendResponse({ ok: true });
            break;
          }

          case 'STOP_GOAL': {
            logger.info('Agent', 'User requested stop.');
            if (activeAbortController) {
              activeAbortController.abort();
              activeAbortController = null;
            }
            currentStatus = 'stopped';
            broadcast({ type: 'STATE_UPDATE', status: 'stopped', mode: 'ask' });
            sendResponse({ ok: true });
            break;
          }

          case 'START_GOAL': {
            const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
            const settings: PilotPanelSettings = stored[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;

            if (!settings.apiKey) {
              const errNotice: ChatMessage = {
                id: `notice-${Date.now()}`,
                role: 'assistant',
                content:
                  'Please enter your Gemini API key in **Settings** to start using PilotPanel.',
                timestamp: Date.now(),
              };
              chatHistory.push(errNotice);
              broadcast({ type: 'CHAT_MESSAGE_ADDED', message: errNotice });
              sendResponse({ ok: false, error: 'Missing API key' });
              return;
            }

            // Find active browser tab
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = activeTab?.id;

            // Record user message
            const userMsg: ChatMessage = {
              id: `user-${Date.now()}`,
              role: 'user',
              content: message.goal,
              timestamp: Date.now(),
            };
            chatHistory.push(userMsg);
            broadcast({ type: 'CHAT_MESSAGE_ADDED', message: userMsg });

            // Record assistant placeholder message
            const assistantMsgId = `asst-${Date.now()}`;
            const assistantMsg: ChatMessage = {
              id: assistantMsgId,
              role: 'assistant',
              content: '',
              stepCards: [],
              timestamp: Date.now(),
            };
            chatHistory.push(assistantMsg);
            broadcast({ type: 'CHAT_MESSAGE_ADDED', message: assistantMsg });

            currentStatus = 'thinking';
            broadcast({
              type: 'STATE_UPDATE',
              status: 'thinking',
              mode: message.mode,
              activeGoal: message.goal,
            });
            sendResponse({ ok: true });

            activeAbortController = new AbortController();

            try {
              // Construct message history for LLM
              const llmMessages: LLMMessage[] = chatHistory
                .filter((m) => m.content.length > 0 || (m.stepCards && m.stepCards.length > 0))
                .map((m) => ({
                  role: m.role === 'assistant' ? 'model' : 'user',
                  parts: [{ text: m.content || '(Action turn)' }],
                }));

              let loopCount = 0;
              const MAX_PERCEPTION_LOOPS = 6;
              let stepNumber = 1;

              while (loopCount < MAX_PERCEPTION_LOOPS) {
                if (activeAbortController?.signal.aborted) break;
                loopCount++;

                currentStatus = 'thinking';
                broadcast({ type: 'STATE_UPDATE', status: 'thinking', mode: message.mode });

                const llmResponse = await defaultGeminiProvider.streamChat(
                  llmMessages,
                  PERCEPTION_TOOLS,
                  {
                    apiKey: settings.apiKey,
                    modelId: settings.modelId,
                    systemPrompt: RUNTIME_SYSTEM_PROMPT,
                    signal: activeAbortController.signal,
                  },
                  (delta) => {
                    assistantMsg.content += delta;
                    broadcast({
                      type: 'CHAT_MESSAGE_STREAM',
                      messageId: assistantMsgId,
                      delta,
                    });
                  }
                );

                // If tool calls were requested, execute them
                if (llmResponse.functionCalls && llmResponse.functionCalls.length > 0 && tabId) {
                  currentStatus = 'acting';
                  broadcast({ type: 'STATE_UPDATE', status: 'acting', mode: message.mode });

                  for (const call of llmResponse.functionCalls) {
                    if (activeAbortController?.signal.aborted) break;

                    const stepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    const stepCard: StepCardData = {
                      id: stepId,
                      stepNumber: stepNumber++,
                      toolName: call.name,
                      summary: summarizeToolCall(call.name, call.args),
                      args: call.args,
                      timestamp: Date.now(),
                    };

                    assistantMsg.stepCards = assistantMsg.stepCards || [];
                    assistantMsg.stepCards.push(stepCard);
                    broadcast({ type: 'STEP_CARD_ADDED', messageId: assistantMsgId, step: stepCard });

                    const startTime = Date.now();
                    const toolResult = await executePerceptionTool(
                      tabId,
                      call.name,
                      call.args,
                      settings.apiKey,
                      settings.modelId
                    );
                    const durationMs = Date.now() - startTime;

                    const update: Partial<StepCardData> = {
                      result: toolResult,
                      durationMs,
                    };

                    if (
                      call.name === 'take_screenshot' &&
                      toolResult.ok &&
                      (toolResult.content as { base64?: string })?.base64
                    ) {
                      update.screenshotThumb = `data:image/jpeg;base64,${
                        (toolResult.content as { base64: string }).base64
                      }`;
                    }

                    Object.assign(stepCard, update);
                    broadcast({ type: 'STEP_CARD_UPDATED', stepId, update });

                    // Append function call and function response to message history
                    llmMessages.push({
                      role: 'model',
                      parts: [{ functionCall: { name: call.name, args: call.args } }],
                    });

                    const rawContent = toolResult.ok
                      ? typeof toolResult.content === 'string'
                        ? toolResult.content
                        : JSON.stringify(toolResult.content)
                      : `Error: ${toolResult.error}`;

                    const sanitizedContent = `<untrusted_page_content>\n${rawContent}\n</untrusted_page_content>`;

                    llmMessages.push({
                      role: 'user',
                      parts: [
                        {
                          functionResponse: {
                            name: call.name,
                            response: { result: sanitizedContent },
                          },
                        },
                      ],
                    });
                  }
                } else {
                  // No more tool calls; the model has finalized its answer
                  break;
                }
              }

              currentStatus = 'completed';
              broadcast({ type: 'STATE_UPDATE', status: 'completed', mode: message.mode });
            } catch (err: unknown) {
              if (activeAbortController?.signal.aborted) {
                assistantMsg.content += '\n\n*(Stopped by user)*';
                broadcast({
                  type: 'CHAT_MESSAGE_STREAM',
                  messageId: assistantMsgId,
                  delta: '\n\n*(Stopped by user)*',
                });
                currentStatus = 'stopped';
                broadcast({ type: 'STATE_UPDATE', status: 'stopped', mode: message.mode });
              } else {
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.error('Agent', 'Execution failed', errMsg);
                assistantMsg.content += `\n\n**Error:** ${errMsg}`;
                broadcast({
                  type: 'CHAT_MESSAGE_STREAM',
                  messageId: assistantMsgId,
                  delta: `\n\n**Error:** ${errMsg}`,
                });
                currentStatus = 'error';
                broadcast({ type: 'AGENT_ERROR', error: errMsg });
              }
            } finally {
              activeAbortController = null;
            }

            break;
          }

          default:
            sendResponse({ ok: false, error: 'Unhandled message' });
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('IPC', 'Error handling runtime message', errorMsg);
        sendResponse({ ok: false, error: errorMsg });
      }
    })();

    return true;
  }
);

logger.info('Init', 'PilotPanel background worker ready with perception tools.');
