/**
 * PilotPanel: Perception Tools Coordinator
 * Implements read_page, get_page_text, take_screenshot, and semantic find.
 * Adheres to REA tool semantics: always returns { ok, content, error? } and never throws.
 */

import { ToolResult, FindResultItem } from '../shared/types';
import { logger } from '../shared/logger';
import { captureTabScreenshot, ScreenshotResult } from './screenshot';
import { defaultGeminiProvider } from '../llm/gemini';
import { LLMMessage } from '../llm/provider';

/**
 * Ensures the content script is responsive on the tab, injecting it dynamically if missing.
 */
export async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_DIMENSIONS' });
    if (res && res.ok) return true;
  } catch {
    // Attempt injection
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    // Brief settle delay
    await new Promise((r) => setTimeout(r, 60));
    return true;
  } catch (err: unknown) {
    logger.debug('Perception', `Unable to inject content script on tab ${tabId}`, err);
    return false;
  }
}

/**
 * Reads structured element tree from the active page.
 */
export async function readPage(
  tabId: number,
  filter: 'interactive' | 'all' = 'interactive',
  refId?: string,
  maxDepth = 15
): Promise<ToolResult<string>> {
  try {
    const ready = await ensureContentScript(tabId);
    if (!ready) {
      return {
        ok: false,
        content: '',
        error: 'Unable to connect to web page. Tab might be restricted (e.g. chrome:// or webstore).',
      };
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'READ_PAGE',
      filter,
      refId,
      maxDepth,
      maxChars: 50000,
    });

    if (response && response.ok) {
      return { ok: true, content: response.content as string };
    }
    return { ok: false, content: '', error: response?.error || 'Failed to read page tree.' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Perception', 'readPage failed', msg);
    return { ok: false, content: '', error: msg };
  }
}

/**
 * Extracts main clean textual content of the page.
 */
export async function getPageText(tabId: number): Promise<ToolResult<string>> {
  try {
    const ready = await ensureContentScript(tabId);
    if (!ready) {
      return {
        ok: false,
        content: '',
        error: 'Unable to connect to web page. Tab might be restricted.',
      };
    }

    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_TEXT' });
    if (response && response.ok) {
      return { ok: true, content: response.content as string };
    }
    return { ok: false, content: '', error: response?.error || 'Failed to extract page text.' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Perception', 'getPageText failed', msg);
    return { ok: false, content: '', error: msg };
  }
}

/**
 * Captures downscaled viewport screenshot and scale factors.
 */
export async function takeScreenshot(tabId: number): Promise<ToolResult<ScreenshotResult>> {
  return captureTabScreenshot(tabId);
}

/**
 * Locates elements matching a natural language description using dual-model ranking and element bounds.
 */
export async function find(
  tabId: number,
  query: string,
  apiKey: string,
  modelId = 'gemini-2.5-flash'
): Promise<ToolResult<FindResultItem[]>> {
  try {
    if (!query || !query.trim()) {
      return { ok: false, content: [], error: 'Search query cannot be empty.' };
    }

    // 1. Fetch interactive tree
    const treeResult = await readPage(tabId, 'interactive');
    if (!treeResult.ok) {
      return { ok: false, content: [], error: treeResult.error };
    }

    // 2. Query Gemini Flash to locate matching refs
    const systemPrompt =
      'You are an element finder. Given an accessibility tree of a web page and a search query, ' +
      'find up to 20 elements that best match the query.\n' +
      'Output each match on its own line in this exact format:\n' +
      'MATCH: ref_N | role | name | reason\n' +
      'Example:\n' +
      'MATCH: ref_4 | button | Submit Form | Primary submission button\n' +
      'If no elements match, output:\n' +
      'NONE';

    const userMessage: LLMMessage = {
      role: 'user',
      parts: [
        {
          text: `User query: "${query}"\n\nPage Element Tree:\n${treeResult.content}`,
        },
      ],
    };

    const response = await defaultGeminiProvider.streamChat(
      [userMessage],
      [],
      {
        apiKey,
        modelId,
        temperature: 0.1,
        maxOutputTokens: 1024,
        systemPrompt,
      }
    );

    const lines = response.text.split('\n');
    const matchedItems: FindResultItem[] = [];

    // 3. Resolve bounds for each matched ref
    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^MATCH:\s*(ref_\d+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*(.*)$/i);
      if (!match) continue;

      const [, ref, role, name, reason] = match;

      try {
        const boundsResp = await chrome.tabs.sendMessage(tabId, {
          type: 'GET_REF_BOUNDS',
          ref,
        });

        if (boundsResp && boundsResp.ok && boundsResp.content) {
          matchedItems.push({
            ref,
            role: role.trim(),
            name: name.trim(),
            x: boundsResp.content.x,
            y: boundsResp.content.y,
            reason: reason.trim(),
          });
        }
      } catch {
        // Element bounds could not be resolved
      }

      if (matchedItems.length >= 20) break;
    }

    return { ok: true, content: matchedItems };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Perception', 'find failed', msg);
    return { ok: false, content: [], error: msg };
  }
}

/**
 * Universal dispatcher for perception tool calls.
 */
export async function executePerceptionTool(
  tabId: number,
  toolName: string,
  args: Record<string, unknown>,
  apiKey: string,
  modelId?: string
): Promise<ToolResult<unknown>> {
  switch (toolName) {
    case 'read_page':
      return readPage(
        tabId,
        (args.filter as 'interactive' | 'all') || 'interactive',
        args.ref_id as string | undefined,
        typeof args.max_depth === 'number' ? args.max_depth : 15
      );

    case 'get_page_text':
      return getPageText(tabId);

    case 'take_screenshot':
      return takeScreenshot(tabId);

    case 'find':
      return find(tabId, String(args.query || ''), apiKey, modelId);

    default:
      return { ok: false, content: null, error: `Unknown perception tool: ${toolName}` };
  }
}
