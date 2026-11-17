/**
 * Autonomous Browser Agent Engine
 * Executes the Perceive (Multimodal) -> Think -> Act (Trusted CDP) -> Verify loop.
 */

import { runOperation, waitForRun } from './run-operation';
import { AntigravityClient, AgentAction, ModelResponse } from './antigravity-client';
import { readProvider, type ProviderConfig } from './model-providers';
import { CDPController } from './cdp-controller';
import { SessionManager } from './sessions';
import { getSessionMessages } from '../shared/db';
import type { StoredMessage } from '../shared/types';
import type { ActionExecutionResult } from '../content/action-executor';
import type { InteractiveElementData } from '../content/dom-observer';
import { inspectFocusedEditor, type FocusedEditor } from './focused-editor';
import { EMBEDDED_ASSISTANT_BLOCK, isEmbeddedAssistantControl } from '../content/embedded-assistant';
import { disallowsBrowsing, explicitlyRequestsPage, quickChatReply, requiresWebResearch, sessionContext, startsWithPageAction } from './conversation-context';
import { runTrading } from '../trading/runner';
import { analyzeActiveChart, chartContext, chartPanRequest, isChartFollowUp, isTradingControlAction,
  type ChartPanGesture, type ChartPanRequest } from '../trading/active-chart';
import { demoExpirySeconds, demoOrderDescription, excludesDemoOrder, isOrderQuestion, isExpertOptionTerminal,
  sameDemoAmount, sameDemoAsset, validDemoOrder,
  type DemoAccountMode, type DemoDeal, type DemoDirection, type DemoOrder } from '../trading/demo-order';

export type AgentStatus = 'idle' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'error';

export interface AgentStepLog {
  step: number;
  thought: string;
  action: AgentAction;
  result: string;
  success: boolean;
  timestamp: number;
  targetLabel?: string;
  blockedOnPage?: string;
  blockedByAssistant?: boolean;
}

interface PageObservation {
  id: string;
  url: string;
  targetLabel?: string;
  fingerprint?: string;
  focusedEditor?: FocusedEditor;
}

interface PendingDemoOrder {
  order: DemoOrder;
  url: string;
  chartReply?: string;
}

const DEMO_ORDER_EXAMPLE = 'Place one demo Up trade with the current amount and expiry.';
const NO_ORDER = 'Order status: none submitted.';
const UNSUPPORTED_CHART_ORDER_NOTE = NO_ORDER + ' Smith does not have an order integration for this platform.';
const EXPERT_OPTION_ORDER_NOTE = NO_ORDER + ' To test a demo order, send a new request such as “' + DEMO_ORDER_EXAMPLE + '”';
const EXPERT_OPTION_CONTROL_NOTE = 'Use the ExpertOption trading page to change its controls. ' + EXPERT_OPTION_ORDER_NOTE;

const MAX_BROWSER_ACTIONS = 120;
const MAX_BROWSER_RUNTIME_MS = 15 * 60_000;
const MAX_IDLE_MS = 2 * 60_000;

function actionTargetKey(action: AgentAction): string {
  return JSON.stringify([action.type, action.targetIndex, action.focused, action.embeddedAssistant, action.selector, action.x, action.y,
    action.key, action.direction, action.amount, action.text, action.value]);
}

function pointerPlanIssue(
  action: AgentAction, indexExists: boolean, viewport: { width: number; height: number } | undefined, hasScreenshot: boolean,
): string | undefined {
  if (action.type !== 'click' && action.type !== 'hover') return;
  if (action.targetIndex !== undefined) {
    if (!indexExists) return `Control index ${action.targetIndex} is absent from the current observation. Re-select a listed control.`;
    return;
  }
  if (typeof action.selector === 'string' && action.selector.trim()) return;
  const { x, y } = action;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return 'The action omitted a valid control index or a complete coordinate pair. Choose a listed control.';
  }
  if (!hasScreenshot) return 'No screenshot was available for that coordinate action. Use a control index from the current page.';
  if (!viewport || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    return `The proposed point (${x}, ${y}) is outside the observed viewport or its dimensions are unavailable. Use a listed control or a visible point in CSS pixels.`;
  }
}

export class AgentEngine {
  private runId = 0;
  private requestId?: string;
  private timings: Record<string, number> = {};
  private activeInput?: Promise<unknown>;
  private terminalWrites: Promise<unknown> = Promise.resolve();
  private provider?: ProviderConfig;
  private runAbort?: AbortController;
  private pendingObservation?: PageObservation;
  private approvalId?: string;
  private approvalPrompt?: string;
  private client = new AntigravityClient();
  private status: AgentStatus = 'idle';
  private currentGoal = '';
  private transcript = '';
  private recentUserTasks: string[] = [];
  private embeddedAssistantDecision?: { origin: string; allowed: boolean };
  private canResumeTrade = false;
  private currentSessionId: string | null = null;
  private activeTabId: number | null = null;
  private browserCleanup?: Promise<void>;
  private history: AgentStepLog[] = [];
  private browserStartedAt = 0;
  private waitingSince?: number;
  private waitingFor?: { page: string; screenshot: string | null };
  private pendingConfirmationAction: AgentAction | null = null;
  private pendingDemoOrder?: PendingDemoOrder;
  private lastTailoredResumePath: string | null = null;

  private visionEnabled = true;
  private safetyGate = true;

  private envHandlers?: {
    captureScreenshot: (tabId: number) => Promise<string | null>;
    uploadFileViaCDP: (tabId: number, selector: string, filePath: string, isCurrent: () => boolean) => Promise<boolean>;
  };

  private onUpdateCallback?: (data: {
    status: AgentStatus;
    requestId?: string;
    approvalId?: string;
    sessionId?: string | null;
    step: number;
    thought?: string;
    activity?: string;
    action?: AgentAction;
    logs: Array<{ action: Pick<AgentAction, 'type' | 'url'>; success: boolean }>;
    summary?: string;
    chartReply?: string;
    error?: string;
  }) => void;

  setEnvironmentHandlers(handlers: typeof this.envHandlers) {
    this.envHandlers = handlers;
  }

  setUpdateListener(cb: typeof this.onUpdateCallback) {
    this.onUpdateCallback = cb;
  }

  getStatus() {
    return {
      status: this.status,
      requestId: this.requestId,
      approvalId: this.approvalId,
      summary: this.approvalPrompt,
      chartReply: this.pendingDemoOrder?.chartReply,
      action: this.pendingConfirmationAction ?? undefined,
      sessionId: this.currentSessionId,
      timings: { ...this.timings },
      currentGoal: this.currentGoal,
      tabId: this.activeTabId,
      stepCount: this.history.length,
      logs: this.history.map(({ action, success }) => ({ action: { type: action.type, url: action.url }, success })),
    };
  }

  private isRestrictedUrl(url: string): boolean {
    return (
      url.startsWith('chrome://') ||
      url.startsWith('brave://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url.startsWith('chrome-extension://')
    );
  }

  private waitForReadableTab(tabId: number, previousUrl?: string, requestedUrl?: string): Promise<string | null> {
    const signal = this.runAbort?.signal;
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(null); return; }

      let settled = false;
      let checking = false;
      const finish = (url: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(poll);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        signal?.removeEventListener('abort', onAbort);
        resolve(url);
      };
      const onAbort = () => finish(null);
      const isDestination = (url: string) => /^https?:\/\//i.test(url)
        && (!previousUrl || url !== previousUrl || url === requestedUrl);

      const check = async () => {
        if (settled || checking) return;
        checking = true;
        try {
          const tab = await chrome.tabs.get(tabId);
          if (settled || !tab.url || tab.pendingUrl || !isDestination(tab.url)) return;
          if (tab.status === 'complete') { finish(tab.url); return; }

          // Slow subresources can keep tabs.status loading after the main DOM is readable.
          const [frame] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.readyState === 'loading' ? null : location.href,
          }).catch(() => []);
          if (frame?.result === tab.url) finish(tab.url);
        } catch {
          finish(null); // The tab was closed before it could be read.
        } finally {
          checking = false;
        }
      };

      const onUpdated = (id: number) => { if (id === tabId) void check(); };
      const deadline = setTimeout(onAbort, 12000);
      const poll = setInterval(() => void check(), 250);
      chrome.tabs.onUpdated.addListener(onUpdated);
      signal?.addEventListener('abort', onAbort, { once: true });
      void check();
    });
  }

  private releaseBrowser(): Promise<void> {
    const tabId = this.activeTabId;
    this.activeTabId = null;
    if (tabId === null) return this.browserCleanup ?? Promise.resolve();

    const cleanup = Promise.allSettled([
      runOperation(() => chrome.tabs.sendMessage(tabId, { type: 'CLEAR_BADGES' }, { frameId: 0 }), 1000, 'Browser cleanup'),
      Promise.resolve(this.activeInput).catch(() => {}).then(() => CDPController.detach(tabId)),
    ]).then(() => {});
    this.browserCleanup = cleanup;
    void cleanup.then(() => {
      if (this.browserCleanup === cleanup) this.browserCleanup = undefined;
    });
    return cleanup;
  }

  private async ensureTabReady(tabId: number, signal?: AbortSignal): Promise<void> {
    const tab = await runOperation(() => chrome.tabs.get(tabId), 3000, 'Finding page', signal);
    const url = tab.url || '';

    if (this.isRestrictedUrl(url)) {
      throw new Error(
        'Cannot automate browser system pages (chrome:// or brave://). Open any website (e.g. google.com, onlinejobs.ph, upwork.com) and run the agent.'
      );
    }

    // Ping content script to test responsiveness; auto-inject if not loaded
    try {
      await runOperation(() => chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 }), 3000, 'Page connection', signal);
    } catch {
      signal?.throwIfAborted();
      console.log('[AgentEngine] Content script missing on tab, auto-injecting...', tabId);
      try {
        await runOperation(() => chrome.scripting.executeScript({
          target: { tabId },
          files: ['dist/content/content-script.js'],
        }), 5000, 'Connecting page', signal);
        await runOperation(() => chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 }), 3000, 'Page connection', signal);
      } catch (err: any) {
        throw new Error(
          `Cannot access page: ${err.message || 'Content script could not be attached. Try refreshing the web page.'}`
        );
      }
    }
  }

  async start(
    goal: string,
    tabId: number,
    options?: { sessionId?: string; requestId?: string; visionEnabled?: boolean; safetyGate?: boolean; activeSite?: string }
  ): Promise<void> {
    if (this.status === 'running' || this.status === 'waiting_confirmation') {
      throw new Error('A browser task is already active. Stop it before starting another.');
    }

    const runId = ++this.runId;
    this.requestId = options?.requestId || crypto.randomUUID();
    this.timings = {};
    this.runAbort = new AbortController();
    const signal = this.runAbort.signal;
    this.pendingConfirmationAction = null;
    this.pendingDemoOrder = undefined;
    this.pendingObservation = undefined;
    this.approvalId = undefined;
    this.approvalPrompt = undefined;
    this.currentGoal = goal;
    this.transcript = '';
    this.recentUserTasks = [goal];
    this.embeddedAssistantDecision = undefined;
    this.currentSessionId = options?.sessionId || null;
    this.activeTabId = null;
    this.status = 'running';
    this.history = [];
    this.browserStartedAt = 0;
    this.waitingSince = undefined;
    this.waitingFor = undefined;
    this.lastTailoredResumePath = null;
    this.visionEnabled = options?.visionEnabled ?? true;
    this.safetyGate = options?.safetyGate ?? true;
    this.notifyUpdate();

    try {
      await runOperation(() => this.browserCleanup ?? Promise.resolve(), 5000, 'Previous browser task cleanup', this.runAbort.signal);
      await runOperation(() => this.terminalWrites, 5000, 'Saving previous task', signal);
      if (this.runId !== runId) return;
      const sessionId = this.currentSessionId;
      const quickReply = quickChatReply(goal);
      this.canResumeTrade = false;
      if (!quickReply && sessionId) {
        const messages = await runOperation(() => getSessionMessages(sessionId), 5000, 'Reading conversation', signal);
        if (this.runId !== runId) return;
        this.transcript = sessionContext(messages, goal);
        this.recentUserTasks.unshift(...messages.filter(message => message.kind === 'user' && message.text)
          .slice(-4).map(message => message.text!.slice(0, 1000)));
        const latestTurn = messages.filter(message => ['user', 'assistant', 'error'].includes(message.kind)).at(-1);
        this.canResumeTrade = latestTurn?.source === 'active_chart_trade';
      }
      if (sessionId) {
        await SessionManager.getInstance().updateStatus(sessionId, 'running', undefined, tabId >= 0 ? tabId : undefined);
        if (this.runId !== runId) return;
        await SessionManager.getInstance().appendMessage(sessionId, { kind: 'user', text: goal });
      }
      if (this.runId !== runId) return;
      if (quickReply) {
        await this.finishTurn(runId, quickReply);
        return;
      }

      if (disallowsBrowsing(goal)) {
        const provider = await readProvider();
        signal.throwIfAborted();
        if (!provider.model) throw new Error('Choose a model for your AI provider in Settings.');
        this.notifyUpdate({ activity: 'Answering without browsing' });
        const plan = await this.measure(runId, 'model', () => runOperation(() => this.client.planNextStep(
          goal, [], null, null, provider, signal, { transcript: this.transcript, mode: 'chat' },
        ), 105000, 'Model response', signal));
        await this.finishTurn(runId, plan.userSummary);
        return;
      }

      const provider = await readProvider();
      if (this.runId !== runId) return;
      if (!provider.model) throw new Error('Choose a model for your AI provider in Settings.');
      this.provider = provider;

      const research = requiresWebResearch(goal);
      const needsPage = explicitlyRequestsPage(goal);
      if (research || needsPage || !startsWithPageAction(goal)) {
        if (needsPage) this.notifyUpdate({ activity: 'Identifying the browser task' });
        const plan = await this.measure(runId, 'model', () => runOperation(() => this.client.planNextStep(
          goal, [], null, null, provider, signal,
          { transcript: this.transcript, mode: needsPage ? 'page' : research ? 'research' : 'route',
            activeSite: options?.activeSite, canResumeTrade: this.canResumeTrade },
        ), 105000, 'Model response', signal));
        if (this.runId !== runId) return;

        if (plan.action.type === 'clarify' || (!research && plan.action.type === 'complete')) {
          await this.finishTurn(runId, plan.userSummary);
          return;
        }
        if (plan.action.type === 'search_web') {
          await this.searchWeb(runId, plan.action.text);
          if (this.runId === runId) await this.runLoop(runId);
          return;
        }
        if (plan.action.type === 'navigate') {
          await this.openTaskPage(runId, plan.action);
          if (this.runId === runId) await this.runLoop(runId);
          return;
        }
        if (await this.runTradingTool(plan.action, tabId, runId, signal)) return;
        if (this.runId !== runId) return;
        if (plan.action.type !== 'observe_page') {
          throw new Error(research
            ? 'The selected model did not provide a usable search query.'
            : 'The selected model did not return an answer or a valid browser plan.');
        }
      }

      this.activeTabId = tabId;
      const activeTab = await runOperation(() => chrome.tabs.get(tabId), 3000, 'Finding page', signal);
      if (this.runId !== runId) return;
      const activeUrl = activeTab.url || '';

      if (this.isRestrictedUrl(activeUrl)) {
        let targetUrl = 'https://www.google.com';
        const lowerGoal = goal.toLowerCase();
        if (lowerGoal.includes('onlinejobs') || lowerGoal.includes('onlinejobs.ph')) {
          targetUrl = 'https://www.onlinejobs.ph/jobseekers/jobsearch';
        } else if (lowerGoal.includes('upwork')) {
          targetUrl = 'https://www.upwork.com/nx/search/jobs/';
        } else if (lowerGoal.includes('github')) {
          targetUrl = 'https://github.com';
        } else {
          const urlMatch = goal.match(/https?:\/\/[^\s]+/);
          if (urlMatch) targetUrl = urlMatch[0];
        }

        this.notifyUpdate({
          status: 'running',
          step: 0,
          thought: `Active tab is on a browser system page. Autonomously opening ${targetUrl} to begin task...`,
          logs: [],
        });

        const newTab = await runOperation(() => chrome.tabs.create({ url: targetUrl, active: true }), 5000, 'Opening tab', signal);
        if (this.runId !== runId) return;
        if (!newTab.id) throw new Error('The new tab could not be opened.');
        this.activeTabId = newTab.id;
        if (sessionId) await SessionManager.getInstance().updateStatus(sessionId, 'running', undefined, newTab.id);
        if (this.runId !== runId) return;
        const loadedUrl = await this.waitForReadableTab(newTab.id);
        if (this.runId !== runId) return;
        if (!loadedUrl) throw new Error('The new tab did not finish loading.');

        this.history.push({
          step: 1,
          thought: `Opened web tab ${targetUrl}`,
          action: { type: 'navigate', url: targetUrl, reasoning: 'Auto-opened web page from system tab' },
          result: `Navigated to ${targetUrl}`,
          success: true,
          timestamp: Date.now(),
        });
        this.notifyUpdate();
      }

      await this.ensureTabReady(this.activeTabId!, signal);
      await this.runLoop(runId);
    } catch (error) {
      this.reportFailure(runId, error);
    }
  }

  private reportFailure(runId: number, error: unknown): void {
    if (this.runId !== runId) return;
    this.runAbort?.abort();
    this.pendingDemoOrder = undefined;
    this.approvalId = undefined;
    this.approvalPrompt = undefined;
    console.error('[AgentEngine] Run failed:', error);
    const message = error instanceof Error ? error.message : 'Agent error occurred.';
    this.status = 'error';
    if (this.currentSessionId) {
      const sessions = SessionManager.getInstance();
      this.terminalWrites = Promise.allSettled([
        sessions.appendMessage(this.currentSessionId, { kind: 'error', text: message }),
        sessions.updateStatus(this.currentSessionId, 'failed'),
      ]);
    }
    void this.releaseBrowser();
    this.notifyUpdate({ error: message });
  }

  private async runTradingTool(action: AgentAction, tabId: number, runId: number, signal: AbortSignal): Promise<boolean> {
    const goal = this.currentGoal;
    switch (action.type) {
      case 'analyze_chart':
        await this.readActiveChart(goal, tabId, runId, signal, false);
        return true;
      case 'prepare_trade': {
        if (excludesDemoOrder(goal) || isOrderQuestion(goal) || (isChartFollowUp(goal) && !this.canResumeTrade)) {
          await this.finishTurn(runId, NO_ORDER + ' This request does not authorize a new demo order.');
          return true;
        }
        const tab = await runOperation(() => chrome.tabs.get(tabId), 3000, 'Checking the active trading platform', signal);
        const demoTab = isExpertOptionTerminal(tab.url) ? tab : undefined;
        const direction = action.direction === 'up' || action.direction === 'down' ? action.direction : undefined;
        if (demoTab && direction && action.analyzeChart === false && !isChartFollowUp(goal)) {
          await this.preparePlatformDemoOrder(direction, demoTab, runId, signal);
        } else {
          await this.readActiveChart(goal, tabId, runId, signal, true, demoTab, direction);
        }
        return true;
      }
      case 'analyze_market': {
        const sessionId = this.currentSessionId;
        if (!sessionId) throw new Error('Open a session to use the market-data tools.');
        const reply = await runTrading(goal, sessionId, {
          signal,
          progress: activity => { if (this.runId === runId) this.notifyUpdate({ activity }); },
          complete: (instructions, prompt, current, image) => this.client.completeAnalysis(
            instructions, prompt, AbortSignal.any([current, AbortSignal.timeout(20000)]), image),
        });
        await this.finishTurn(runId, reply);
        return true;
      }
      default:
        return false;
    }
  }

  private async readActiveChart(
    chartGoal: string, tabId: number, runId: number, signal: AbortSignal,
    showOrderStatus: boolean, demoTab?: chrome.tabs.Tab, direction?: DemoDirection,
  ): Promise<void> {
    const chartProvider = this.visionEnabled && this.envHandlers ? await readProvider() : undefined;
    signal.throwIfAborted();
    const orderNote = showOrderStatus
      ? '\n\n' + (demoTab ? NO_ORDER : UNSUPPORTED_CHART_ORDER_NOTE) : '';
    if (chartProvider && chartProvider.model?.vision !== true) {
      const message = chartProvider.model
        ? 'The selected model is configured for text only. In Settings, choose a model that supports image inputs and enable screenshots for that model.'
        : 'Choose an image-capable model in Settings before analyzing the active chart.';
      await this.finishTurn(runId, message + orderNote);
      return;
    }
    let observedUrl: string | undefined;
    const pan = chartPanRequest(chartGoal);
    const terminal = demoTab ? await this.readPlatformDemoMode(demoTab, signal) : undefined;
    const mode = terminal?.mode;
    const result = await analyzeActiveChart(chartGoal, {
      signal,
      progress: activity => { if (this.runId === runId) this.notifyUpdate({ activity }); },
      inspect: async () => {
        const tab = await runOperation(() => chrome.tabs.get(tabId), 3000, 'Reading chart tab', signal);
        if (!tab.active || tab.pendingUrl) return;
        observedUrl = tab.url;
        return chartContext(tab.url, tab.title);
      },
      capture: this.visionEnabled && this.envHandlers
        ? async () => {
            const image = await runOperation(() => this.envHandlers!.captureScreenshot(tabId), 3000, 'Reading chart', signal);
            if (!image) return null;
            const tab = await runOperation(() => chrome.tabs.get(tabId), 3000, 'Checking chart tab', signal);
            return tab.active && !tab.pendingUrl && tab.url === observedUrl ? image : null;
          }
        : undefined,
      prepareView: pan ? () => this.panChart(tabId, observedUrl, pan, runId, signal) : undefined,
      suggestDemoDirection: mode === 'demo' && !direction,
      orderDuration: terminal?.expiry,
      complete: (instructions, prompt, current, image) => this.client.completeAnalysis(
        instructions, prompt, AbortSignal.any([current, AbortSignal.timeout(20000)]), image, chartProvider),
    });
    if (demoTab) {
      const suggestedDirection = direction ?? result.demoDirection;
      if (mode === 'demo' && suggestedDirection && result.symbol && observedUrl === demoTab.url) {
        await this.preparePlatformDemoOrder(suggestedDirection, demoTab, runId, signal, {
          reply: result.reply, symbol: result.symbol, expiry: terminal?.expiry,
        });
        return;
      }
      const orderStatus = mode === 'real' ? 'ExpertOption has Real selected. Switch to Demo to run an order test.'
        : mode === 'unknown' ? 'I couldn’t verify that the trading page has Demo selected.'
        : mode === 'demo' && result.symbol && !suggestedDirection ? 'No demo order prepared: ' + (result.demoReason || 'the chart did not support a directional test.')
        : 'A combined chart and order request needs a readable chart asset and a verified Demo account.';
      await this.finishTurn(runId, result.reply + '\n\n' + NO_ORDER + ' ' + orderStatus, 'completed', result.source ? 'active_chart_trade' : undefined);
    } else {
      await this.finishTurn(runId, result.reply + orderNote, 'completed', result.source);
    }
  }

  private async readPlatformDemoMode(tab: chrome.tabs.Tab, signal: AbortSignal): Promise<{ mode: DemoAccountMode; expiry?: string }> {
    if (!tab.active || !tab.id || tab.pendingUrl || !isExpertOptionTerminal(tab.url)) return { mode: 'unknown' };
    const tabId = tab.id;
    try {
      await this.ensureTabReady(tabId, signal);
      const result = await runOperation(
        () => chrome.tabs.sendMessage(tabId, { type: 'READ_DEMO_MODE' }, { frameId: 0 }),
        2500, 'Checking the selected ExpertOption account', signal,
      );
      const current = await runOperation(() => chrome.tabs.get(tabId), 2500, 'Checking the demo tab', signal);
      if (current.active && !current.pendingUrl && current.url === tab.url) {
        if (result?.mode === 'demo' || result?.mode === 'real') {
          const expiry = typeof result.expiry === 'string' && demoExpirySeconds(result.expiry) > 0 ? result.expiry : undefined;
          return { mode: result.mode, expiry };
        }
      }
    } catch {
      signal.throwIfAborted();
    }
    return { mode: 'unknown' };
  }

  private async preparePlatformDemoOrder(
    direction: DemoDirection, tab: chrome.tabs.Tab, runId: number, signal: AbortSignal,
    chart?: { reply: string; symbol: string; expiry?: string },
  ): Promise<void> {
    const noOrder = (reason: string) => this.finishTurn(runId,
      [chart?.reply, NO_ORDER + ' ' + reason].filter(Boolean).join('\n\n'));
    if (!tab.active || !tab.id || tab.pendingUrl || !tab.url || !isExpertOptionTerminal(tab.url)) {
      await noOrder('Bring the ExpertOption demo trading page into view before requesting the order.');
      return;
    }
    const tabId = tab.id;
    this.notifyUpdate({ activity: 'Checking demo account and order details' });
    await this.ensureTabReady(tabId, signal);
    const prepared = await runOperation(
      () => chrome.tabs.sendMessage(tabId, { type: 'PREPARE_DEMO_ORDER', direction }, { frameId: 0 }),
      3000, 'Reading the demo order controls', signal,
    ).catch(() => null);
    signal.throwIfAborted();
    const current = await runOperation(() => chrome.tabs.get(tabId), 3000, 'Checking the demo tab', signal);
    if (this.runId !== runId) return;
    if (!current.active || current.pendingUrl || current.url !== tab.url || !validDemoOrder(prepared?.order, direction)) {
      const problem = typeof prepared?.problem === 'string' ? prepared.problem.slice(0, 200) + ' ' : '';
      await noOrder(problem + 'Select Demo and keep the amount, expiry, and order buttons visible. Refresh the trading page after reloading the extension.');
      return;
    }
    const order = prepared.order;
    if (chart && !sameDemoAsset(chart.symbol, order.asset)) {
      await noOrder('The chart asset and the selected order asset could not be matched. Bring the intended chart into view and try again.');
      return;
    }
    if (chart?.expiry && demoExpirySeconds(chart.expiry) !== demoExpirySeconds(order.expiry)) {
      await noOrder('The selected expiry changed during analysis. Ask for a fresh trade analysis.');
      return;
    }
    this.activeTabId = tabId;
    const pending = { order, url: tab.url, chartReply: chart?.reply };
    if (!this.safetyGate) {
      await this.submitPlatformDemoOrder(pending, tabId, runId);
      return;
    }
    const approvalPrompt = 'Submit one ExpertOption demo order? ' + demoOrderDescription(order) + '.';
    if (this.currentSessionId) {
      await SessionManager.getInstance().appendMessage(this.currentSessionId, {
        kind: 'permission', text: approvalPrompt, permission: { type: 'demo_order', domain: new URL(tab.url).hostname, decision: 'pending' },
      });
      if (this.runId !== runId) return;
      await SessionManager.getInstance().updateStatus(this.currentSessionId, 'awaiting_permission');
    }
    if (this.runId !== runId) return;
    this.pendingDemoOrder = pending;
    this.approvalId = crypto.randomUUID();
    this.approvalPrompt = approvalPrompt;
    this.status = 'waiting_confirmation';
    this.notifyUpdate({ summary: approvalPrompt, chartReply: chart?.reply });
  }

  private async submitPlatformDemoOrder(pending: PendingDemoOrder, tabId: number, runId: number) {
    const signal = this.runAbort?.signal;
    const isCurrent = () => this.runId === runId && this.status === 'running' && this.activeTabId === tabId && !signal?.aborted;
    const { order, url, chartReply } = pending;
    const finish = (status: string) => this.finishTurn(runId, [chartReply, status].filter(Boolean).join('\n\n'),
      'completed', chartReply ? 'active_chart' : undefined);
    const validate = async () => {
      if (!isCurrent()) return false;
      const tab = await runOperation(() => chrome.tabs.get(tabId), 2500, 'Checking the demo trading page', signal);
      if (!tab.active || tab.pendingUrl || tab.url !== url || !isExpertOptionTerminal(tab.url)) return false;
      const reply = await runOperation(
        () => chrome.tabs.sendMessage(tabId, { type: 'VALIDATE_DEMO_ORDER', token: order.token }, { frameId: 0 }),
        2500, 'Rechecking demo and order details', signal,
      );
      return reply?.success === true && isCurrent();
    };
    let sent: boolean;
    let baseline: DemoDeal[] | undefined;
    try {
      const [valid, before] = await Promise.all([validate(), this.readDemoDeals(tabId, signal)]);
      if (!valid) {
        await finish(NO_ORDER + ' The demo account, order details, or active tab changed.');
        return;
      }
      baseline = before;
      if (!isCurrent()) return;
      this.notifyUpdate({ activity: 'Submitting demo order: ' + demoOrderDescription(order) });
      const input = CDPController.click(tabId, order.x, order.y, validate);
      this.activeInput = input;
      try { sent = await input; }
      finally { if (this.activeInput === input) this.activeInput = undefined; }
    } catch {
      await finish('Order status could not be confirmed. Check ExpertOption’s demo trade history before retrying.');
      return;
    }
    if (!sent) {
      await finish(NO_ORDER + ' The order controls changed or browser input was unavailable.');
      return;
    }
    const deal = baseline && await this.watchDemoDeal(order, baseline, tabId, url, runId, signal);
    await finish(deal
      ? 'ExpertOption reported a new matching demo deal for ' + demoOrderDescription(order) +
        '. Listed payout: ' + deal.payout + ' at ' + deal.time + '.'
      : 'Sent one demo order click for ' + demoOrderDescription(order) + '. Check ExpertOption’s demo trade history for acceptance.');
  }

  private async readDemoDeals(tabId: number, signal?: AbortSignal): Promise<DemoDeal[] | undefined> {
    const result = await runOperation(
      () => chrome.tabs.sendMessage(tabId, { type: 'READ_DEMO_DEALS' }, { frameId: 0 }),
      750, 'Reading recent demo deals', signal,
    ).catch(() => undefined);
    signal?.throwIfAborted();
    return Array.isArray(result?.deals) ? result.deals : undefined;
  }

  private async watchDemoDeal(order: DemoOrder, baseline: DemoDeal[], tabId: number, url: string,
    runId: number, signal?: AbortSignal): Promise<DemoDeal | undefined> {
    const previous = new Set(baseline.map(deal => deal.id));
    const expiry = demoExpirySeconds(order.expiry) * 1000;
    const started = Date.now();
    const deadline = started + Math.min(expiry + 3500, 60_000);
    let activity = '';
    while (this.runId === runId && !signal?.aborted && Date.now() < deadline) {
      const current = await runOperation(() => chrome.tabs.get(tabId), 750, 'Checking the demo tab', signal).catch(() => undefined);
      if (!current?.active || current.pendingUrl || current.url !== url) return;
      const remaining = Math.ceil((started + expiry - Date.now()) / 1000);
      const nextActivity = remaining > 0
        ? `Demo order sent. Checking history · ${order.asset} · ${remaining}s to selected expiry`
        : 'Checking demo deal result';
      if (nextActivity !== activity && this.runId === runId) this.notifyUpdate({ activity: nextActivity });
      activity = nextActivity;
      const deals = await this.readDemoDeals(tabId, signal);
      if (!deals) return;
      const added = deals.filter(deal => !previous.has(deal.id));
      if (added.length === 1 && deals[0] === added[0] && deals[1]?.id === baseline[0]?.id &&
          sameDemoAsset(added[0].asset, order.asset) && sameDemoAmount(added[0].amount, order.amount)) return added[0];
      if (added.length) return;
      await waitForRun(500, signal);
    }
  }

  private async panChart(tabId: number, url: string | undefined, request: ChartPanRequest,
    runId: number, signal: AbortSignal): Promise<string> {
    let count = 0;
    const isCurrent = () => this.runId === runId && this.status === 'running' && !signal.aborted;
    const sameTab = async () => {
      const tab = await runOperation(() => chrome.tabs.get(tabId), 2500, 'Checking chart tab', signal);
      return tab.active && tab.url === url;
    };
    const send = (message: Record<string, unknown>) => runOperation(
      () => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), 2500, 'Finding the chart surface', signal,
    );
    try {
      if (!await sameTab()) return 'The chart tab changed before panning.';
      await this.ensureTabReady(tabId, signal);
      for (let i = 0; i < request.attempts && isCurrent(); i++) {
        if (!await sameTab()) break;
        const { gesture } = await send({ type: 'PREPARE_CHART_PAN', direction: request.direction }) as { gesture?: ChartPanGesture };
        if (!gesture || typeof gesture.id !== 'string' ||
            ![gesture.startX, gesture.endX, gesture.y].every(Number.isFinite) ||
            Math.abs(gesture.startX - gesture.endX) < 60 || !isCurrent()) break;
        this.activeTabId = tabId;
        this.notifyUpdate({ activity: request.direction === 'earlier' ? 'Panning toward earlier candles' : 'Panning toward newer candles' });
        const input = CDPController.drag(tabId, gesture.startX, gesture.y, gesture.endX, gesture.y, isCurrent,
          async () => isCurrent() && await sameTab() &&
            Boolean((await send({ type: 'VALIDATE_CHART_PAN', id: gesture.id }))?.success) && isCurrent());
        this.activeInput = input;
        try {
          if (!await input) break;
          count++;
        } finally {
          if (this.activeInput === input) this.activeInput = undefined;
        }
        await waitForRun(300, signal);
      }
    } catch { signal.throwIfAborted(); }
    signal.throwIfAborted();
    if (!count) return 'I couldn’t safely drag a visible chart surface. Pan the chart manually to bring the history into view.';
    const direction = request.direction === 'earlier' ? 'earlier' : 'newer';
    return 'I sent ' + count + (count === 1 ? ' drag' : ' drags') + ' toward ' + direction +
      ' candles. The reading covers the visible chart after the drag. The platform’s history boundary is unverified.';
  }

  private async finishTurn(runId: number, answer?: string, status: 'completed' | 'stopped' = 'completed',
    source?: StoredMessage['source']): Promise<void> {
    if (this.runId !== runId) return;
    const summary = answer?.trim();
    if (!summary) throw new Error('The selected model did not return a user-facing answer.');

    const sessionId = this.currentSessionId;
    if (sessionId) {
      const sessions = SessionManager.getInstance();
      const write = (async () => {
        await sessions.appendMessage(sessionId, { kind: 'assistant', text: summary, source });
        if (this.runId === runId) await sessions.updateStatus(sessionId, status, summary);
      })();
      this.terminalWrites = write.catch(() => {});
      await write;
    }
    if (this.runId !== runId) return;
    this.status = 'completed';
    void this.releaseBrowser();
    this.notifyUpdate({ summary });
  }

  private async searchWeb(runId: number, text: string | undefined): Promise<void> {
    const query = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
    if (!query || query.length > 300) throw new Error('The selected model did not provide a usable search query.');
    const search = new URL('https://www.google.com/search');
    search.searchParams.set('q', query);
    if (this.history.some(entry => entry.action.type === 'search_web' && entry.action.url === search.href)) {
      throw new Error('The selected model repeated the same search without finding an answer.');
    }

    await this.openTaskPage(runId, { type: 'search_web', url: search.href, reasoning: 'Searched the web.' });
  }

  private async openTaskPage(runId: number, action: AgentAction): Promise<void> {
    const signal = this.runAbort?.signal;
    if (!action.url) throw new Error('The selected model did not provide a website URL.');
    const url = new URL(action.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Opening a website needs an HTTP or HTTPS URL without credentials.');
    }
    const isSearch = action.type === 'search_web';
    this.notifyUpdate({ activity: isSearch ? 'Searching…' : 'Opening website…' });
    await this.releaseBrowser();
    if (this.runId !== runId) return;

    const startedAt = Date.now();
    const tab = await runOperation(() => chrome.tabs.create({ url: url.href, active: true }), 5000,
      isSearch ? 'Opening search tab' : 'Opening website', signal);
    if (this.runId !== runId) return;
    if (!tab.id) throw new Error(isSearch ? 'Could not open a tab for the search.' : 'Could not open a tab for the requested website.');
    this.activeTabId = tab.id;
    const sessionId = this.currentSessionId;
    if (sessionId) await SessionManager.getInstance().updateStatus(sessionId, 'running', undefined, tab.id);
    if (this.runId !== runId) return;

    const loadedUrl = await this.waitForReadableTab(tab.id, 'about:blank', url.href);
    if (this.runId !== runId) return;
    if (!loadedUrl) throw new Error(isSearch
      ? 'The search results could not be read. Check whether the search tab is still open and try again.'
      : 'The requested website did not finish loading.');
    const destination = new URL(loadedUrl);
    if (isSearch && (destination.origin !== url.origin || destination.pathname !== url.pathname ||
        destination.searchParams.get('q')?.trim().replace(/\s+/g, ' ') !== url.searchParams.get('q'))) {
      throw new Error('Google did not open the search results. Check the new tab and try again.');
    }
    await this.ensureTabReady(tab.id, signal);
    if (this.runId !== runId) return;

    const result = isSearch ? 'Opened the search results page.' : 'Opened ' + destination.hostname + '.';
    this.history.push({
      step: this.history.length + 1, thought: action.reasoning, action, result, success: true, timestamp: Date.now(),
    });
    if (sessionId) {
      const sessions = SessionManager.getInstance();
      await sessions.recordDomain(sessionId, loadedUrl);
      if (this.runId !== runId) return;
      await sessions.appendMessage(sessionId, {
        kind: 'step',
        step: { tool: action.type, args: action, result: { ok: true, content: result },
          summary: action.reasoning, durationMs: Date.now() - startedAt, url: loadedUrl },
      });
    }
    if (this.runId === runId) this.notifyUpdate();
  }

  stop(sourceTabId?: number): void {
    if (this.status !== 'running' && this.status !== 'waiting_confirmation') return;
    if (sourceTabId !== undefined && sourceTabId !== this.activeTabId) return;
    const chartReply = this.pendingDemoOrder?.chartReply;
    this.runId++;
    this.runAbort?.abort();
    this.pendingConfirmationAction = null;
    this.pendingDemoOrder = undefined;
    this.pendingObservation = undefined;
    this.approvalId = undefined;
    this.approvalPrompt = undefined;
    this.status = 'idle';
    if (this.currentSessionId) {
      const sessionId = this.currentSessionId;
      this.terminalWrites = this.terminalWrites.then(async () => {
        const sessions = SessionManager.getInstance();
        if (chartReply) await sessions.appendMessage(sessionId, { kind: 'assistant', text: chartReply + '\n\n' + NO_ORDER });
        await sessions.updateStatus(sessionId, 'stopped');
      }).catch(() => {});
    }
    void this.releaseBrowser();
    this.notifyUpdate();
  }

  async confirmPendingAction(): Promise<void> {
    if (this.status !== 'waiting_confirmation' || !this.activeTabId) return;
    const demo = this.pendingDemoOrder;
    if (demo) {
      const tabId = this.activeTabId, runId = this.runId;
      this.pendingDemoOrder = undefined;
      this.approvalId = undefined;
      this.approvalPrompt = undefined;
      this.status = 'running';
      this.notifyUpdate({ activity: 'Checking the approved demo order' });
      try {
        if (this.currentSessionId) await SessionManager.getInstance().updateStatus(this.currentSessionId, 'running', undefined, tabId);
        await this.submitPlatformDemoOrder(demo, tabId, runId);
      } catch (error) { this.reportFailure(runId, error); }
      return;
    }
    if (!this.pendingConfirmationAction) return;

    this.status = 'running';
    if (this.currentSessionId) {
      SessionManager.getInstance().updateStatus(this.currentSessionId, 'running').catch(() => {});
    }
    const runId = this.runId;
    const action = this.pendingConfirmationAction;
    const observation = this.pendingObservation;
    this.pendingConfirmationAction = null;
    this.pendingObservation = undefined;
    this.approvalId = undefined;
    this.approvalPrompt = undefined;

    try {
      if (observation) {
        const signal = this.runAbort?.signal;
        const page = await runOperation(() => chrome.tabs.sendMessage(this.activeTabId!, {
          type: 'VALIDATE_OBSERVATION', observationId: observation.id,
        }, { frameId: 0 }), 3000, 'Checking approved page', signal).catch(() => null);
        if (this.runId !== runId) return;
        if (!page?.success) {
          await this.finishTurn(runId, 'The page changed before approval. Send your request again to review the current page.', 'stopped');
          return;
        }
      }
      const stepStart = Date.now();
      const res = await this.trackInput(action, runId, observation);
      if (this.runId !== runId) return;

      const sessionId = this.currentSessionId;
      if (sessionId) {
        await SessionManager.getInstance().appendMessage(sessionId, {
          kind: 'step',
          step: {
            tool: action.type,
            args: action,
            result: { ok: res.success, content: res.message },
            summary: 'User approved action.',
            durationMs: Date.now() - stepStart,
            url: observation?.url,
            targetLabel: observation?.targetLabel,
          },
        });
      }

      if (this.runId !== runId) return;
      this.history.push({
        step: this.history.length + 1,
        thought: 'User approved action.',
        action,
        result: res.message || 'Action executed.',
        success: res.success,
        timestamp: Date.now(),
        targetLabel: observation?.targetLabel,
        blockedOnPage: this.blockedPage(res, observation),
        blockedByAssistant: res.failure === 'embedded_assistant',
      });

      this.notifyUpdate();
      await this.waitForActionSettle(this.activeTabId!, action.type, runId, this.runAbort?.signal);
      await this.runLoop(runId);
    } catch (error) {
      this.reportFailure(runId, error);
    }
  }

  private async runLoop(runId: number): Promise<void> {
    if (this.runId !== runId) return;
    this.browserStartedAt ||= Date.now();
    let recovery: { message: string; fingerprint: string; blocked?: true } | undefined;
    let rejectedTargetPlans = 0;
    let requestedCompletionEvidence = false;
    while (this.status === 'running' && this.runId === runId) {
      const last = this.history.at(-1);
      const reason = this.history.length >= MAX_BROWSER_ACTIONS ? 'the action limit'
        : Date.now() - this.browserStartedAt >= MAX_BROWSER_RUNTIME_MS ? 'the 15-minute run limit'
        : this.waitingSince !== undefined && Date.now() - this.waitingSince >= MAX_IDLE_MS ? 'the two-minute page wait limit'
        : this.history.slice(-5).filter(step => !step.success).length === 5 ? 'five consecutive unsuccessful actions'
        : undefined;
      if (reason) {
        const lastResult = last ? ` Last recorded result: ${last.result}` : '';
        await this.finishTurn(runId, `I paused after ${this.history.length} browser actions due to ${reason}.${lastResult} Send “continue” to pick up from the current page.`, 'stopped');
        return;
      }

      if (!this.activeTabId) break;
      const tabId = this.activeTabId;
      const signal = this.runAbort?.signal;
      const capture = this.visionEnabled && this.provider?.model?.vision && this.envHandlers?.captureScreenshot;
      const readPage = () => this.measure(runId, 'page', () => runOperation(
        () => chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATE', hideOverlay: Boolean(capture) }, { frameId: 0 }),
        5000, 'Reading page', signal,
      ));

      this.notifyUpdate({ activity: 'Reading page…' });

      // 1. PERCEIVE: DOM State + Visual Viewport Screenshot
      let pageStateResponse: any;
      try {
        pageStateResponse = await readPage();
      } catch (err) {
        if (this.runId !== runId) return;
        await this.ensureTabReady(tabId, signal);

        if (this.runId !== runId) return;
        pageStateResponse = await readPage();
      }

      if (this.runId !== runId) return;
      if (!pageStateResponse?.success) {
        throw new Error('Failed to retrieve DOM state from active page.');
      }

      const pageState = pageStateResponse.state;
      const observation = { id: pageState.observationId, url: pageState.url };

      // An unindexed click can focus an editor inside a frame the page snapshot cannot list.
      let focusedEditor: FocusedEditor | undefined;
      if (last?.success && last.action.type === 'click' && last.action.targetIndex === undefined &&
          !last.action.selector && !this.isRestrictedUrl(observation.url)) {
        const frames = await runOperation(() => chrome.scripting.executeScript({
          target: { tabId, allFrames: true }, func: inspectFocusedEditor,
        }), 1500, 'Checking the editor focused by the click', signal).catch(() => []);
        if (this.runId !== runId) return;
        const editors = frames.filter(frame => frame.documentId && frame.result?.token);
        if (editors.length === 1) {
          focusedEditor = { documentId: editors[0].documentId, token: editors[0].result!.token, label: editors[0].result!.label };
        }
      }

      // Capture screenshot if vision enabled (briefly hide glow so screenshot is pristine)
      let screenshotBase64: string | null = null;
      if (capture) {
        screenshotBase64 = await this.measure(runId, 'screenshot', () => runOperation(
          () => capture(tabId), 5000, 'Capturing page', signal,
        ));
        if (this.runId !== runId) return;
      }
      let fingerprint: string | undefined;
      const pageFingerprint = () => fingerprint ??= JSON.stringify([pageState.url, pageState.viewport, pageState.visibleTextSummary, pageState.interactiveElements]);
      if (recovery && recovery.fingerprint !== pageFingerprint()) recovery = undefined;
      if (this.waitingFor && this.waitingFor.screenshot === screenshotBase64 && this.waitingFor.page === pageFingerprint()) {
        await waitForRun(capture ? 1500 : 900, signal);
        continue;
      }
      void chrome.tabs.sendMessage(tabId, { type: 'SHOW_GLOW', state: 'thinking', statusText: 'Thinking...' }).catch(() => {});

      if (this.runId !== runId) return;

      this.notifyUpdate({ activity: 'Thinking…' });

      // 2. THINK: Reason with Antigravity / Gemini Multimodal Model
      const modelPlan: ModelResponse = await this.measure(runId, 'model', () => runOperation(() => this.client.planNextStep(
        this.currentGoal,
        this.history,
        pageState,
        screenshotBase64, this.provider, signal,
        { transcript: this.transcript, mode: 'browser', canResumeTrade: this.canResumeTrade, recovery: recovery?.message,
          focusedEditor: focusedEditor?.label },
      ), 105000, 'Model response', signal));
      if (this.runId !== runId) return;
      if (Date.now() - this.browserStartedAt >= MAX_BROWSER_RUNTIME_MS) continue;

      if (modelPlan.action.type === 'wait') {
        this.waitingSince ??= Date.now();
        // A missing screenshot cannot prove that a canvas or video stayed unchanged.
        this.waitingFor = capture && !screenshotBase64 ? undefined : { page: pageFingerprint(), screenshot: screenshotBase64 };
        this.notifyUpdate({ activity: 'Waiting for the page to change.' });
        const delay = Number.isFinite(modelPlan.action.amount) ? Math.min(3000, Math.max(500, modelPlan.action.amount!)) : 1000;
        await waitForRun(delay, signal);
        continue;
      }
      this.waitingSince = undefined;
      this.waitingFor = undefined;

      if (modelPlan.action.type === 'complete') {
        const lastDelegation = this.history.reduce((lastIndex, step, index) => step.blockedByAssistant ? index : lastIndex, -1);
        if (lastDelegation >= 0) {
          const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
          const visible = normalize([pageState.visibleTextSummary, ...pageState.interactiveElements.map(
            (control: InteractiveElementData) => [control.text, control.ariaLabel, control.controlState].filter(Boolean).join(' '),
          )].join('\n'));
          const evidence = new Set(modelPlan.browserEvidence?.map(normalize).filter(value => value.length >= 8 && visible.includes(value)));
          const acted = this.history.slice(lastDelegation + 1).some(step => step.success && this.requiresDirectInput(step.action));
          if (!acted || evidence.size < 2) {
            if (requestedCompletionEvidence) {
              await this.finishTurn(runId, 'I stopped before I could verify the requested configuration on the page.', 'stopped');
              return;
            }
            requestedCompletionEvidence = true;
            recovery = { message: 'The requested configuration has not been verified. Use the visible application controls, then cite exact evidence of the configured object and its requested parts.',
              fingerprint: pageFingerprint() };
            continue;
          }
        }
        await this.finishTurn(runId, modelPlan.userSummary);
        break;
      }

      if (['clarify', 'ask_user'].includes(modelPlan.action.type)) {
        await this.finishTurn(runId, modelPlan.userSummary);
        break;
      }

      if (modelPlan.action.type === 'search_web') {
        await this.searchWeb(runId, modelPlan.action.text);
        continue;
      }

      if (await this.runTradingTool(modelPlan.action, tabId, runId, signal!)) return;
      if (this.runId !== runId) return;

      if (isExpertOptionTerminal(pageState.url) && isTradingControlAction(modelPlan.action.type)) {
        await this.finishTurn(runId, EXPERT_OPTION_CONTROL_NOTE);
        return;
      }

      const controls: InteractiveElementData[] = pageState.interactiveElements;
      const action = modelPlan.action;
      const selectorMatches = action.type === 'type' && action.targetIndex === undefined && action.selector
        ? controls.filter(control => control.selector === action.selector) : [];
      const target = action.targetIndex !== undefined ? controls.find(control => control.index === action.targetIndex)
        : selectorMatches.length === 1 ? selectorMatches[0] : undefined;
      const useFocusedEditor = action.type === 'type' && action.focused === true;
      const targetIssue = action.type === 'type'
        ? typeof action.text !== 'string' ? 'The type action omitted the text to enter.'
          : useFocusedEditor ? !focusedEditor || action.targetIndex !== undefined || action.selector || action.x !== undefined || action.y !== undefined
            ? 'Focused typing needs a verified focused editor and no other target. Click the intended field and observe it first.' : undefined
          : target?.editable !== true ? 'The type action did not identify a current editable field. Choose a listed control marked editable by its index.'
            : undefined
        : pointerPlanIssue(action, Boolean(target), pageState.viewport, Boolean(screenshotBase64));
      if (targetIssue) {
        if (++rejectedTargetPlans >= 3) {
          await this.finishTurn(runId, `I paused because the model repeatedly returned an unusable browser target. ${targetIssue}`, 'stopped');
          return;
        }
        recovery = { message: 'Action rejected before input. ' + targetIssue, fingerprint: pageFingerprint() };
        this.notifyUpdate({ activity: 'Finding a valid browser control…' });
        continue;
      }
      rejectedTargetPlans = 0;
      requestedCompletionEvidence = false;
      if (action.type === 'type' && target) action.targetIndex = target.index;
      const label = useFocusedEditor ? focusedEditor?.label : target?.ariaLabel || target?.text;
      const targetLabel = label ? (target?.dialog ? `${label} in ${target.dialog}` : label).slice(0, 150) : undefined;
      const blocked = this.history.slice(-8).reverse().find(step => step.blockedOnPage &&
        actionTargetKey(step.action) === actionTargetKey(modelPlan.action) && step.blockedOnPage === pageFingerprint());
      const retryTarget = blocked && !blocked.blockedByAssistant && await runOperation(() => chrome.tabs.sendMessage(tabId, {
        type: 'CHECK_ACTION_TARGET', action: modelPlan.action, observationId: observation.id,
      }, { frameId: 0 }), 1500, 'Checking the blocked control', signal).catch(() => null);
      if (this.runId !== runId) return;
      if (blocked && (!retryTarget || retryTarget.ready !== true)) {
        const message = `${targetLabel || 'The requested control'} is still unavailable. ${blocked.result}`;
        if (recovery?.blocked && recovery.fingerprint === pageFingerprint()) {
          await this.finishTurn(runId, `I paused on the current page. ${message}`, 'stopped');
          return;
        }
        recovery = { message: `Repeated action skipped. ${message} Inspect another control, wait for a change, or report the blocker.`,
          fingerprint: pageFingerprint(), blocked: true };
        this.notifyUpdate({ activity: 'Replanning around the blocked control…' });
        continue;
      }
      recovery = undefined;
      const needsReview = this.requiresApproval(modelPlan.action);
      const actionObservation = {
        ...observation, targetLabel,
        focusedEditor: useFocusedEditor ? focusedEditor : undefined,
        // Preserve the state used for a pending approval. Turbo only needs it on a targeting failure.
        fingerprint: needsReview ? pageFingerprint() : undefined,
      };

      // Check human confirmation requirement
      if (needsReview) {
        const host = new URL(pageState.url).hostname;
        const prompt = 'Allow ' + modelPlan.action.type.replaceAll('_', ' ') + (label ? ' (' + label.slice(0, 120) + ')' : '') + ' on ' + host + '?';
        this.status = 'waiting_confirmation';
        this.pendingConfirmationAction = modelPlan.action;
        this.pendingObservation = actionObservation;
        this.approvalId = crypto.randomUUID();
        this.approvalPrompt = prompt;
        void chrome.tabs.sendMessage(this.activeTabId, {
          type: 'SHOW_GLOW',
          state: 'waiting-approval',
          statusText: 'Waiting for approval',
        }).catch(() => {});

        if (this.runId !== runId) return;

        if (this.currentSessionId) {
          let domain = '';
          try { domain = new URL(pageState.url).hostname; } catch {}
          await SessionManager.getInstance().appendMessage(this.currentSessionId, {
            kind: 'permission',
            text: prompt,
            permission: {
              type: modelPlan.action.type,
              domain,
              decision: 'pending',
            },
          });
          if (this.runId !== runId) return;
          await SessionManager.getInstance().updateStatus(this.currentSessionId, 'awaiting_permission');
        }

        if (this.runId === runId) this.notifyUpdate({ summary: prompt, action: modelPlan.action });
        break;
      }

      // 3. ACT: Execute the decided action with acting glow + CDP dispatch
      void chrome.tabs.sendMessage(this.activeTabId, {
        type: 'SHOW_GLOW',
        state: 'acting',
        statusText: `Acting · ${modelPlan.action.type}`,
      }).catch(() => {});

      const stepStart = Date.now();
      const actionResult = await this.trackInput(modelPlan.action, runId, actionObservation);
      if (this.runId !== runId) return;
      const stepDuration = Date.now() - stepStart;

      const sessionId = this.currentSessionId;
      if (sessionId) {
        if (pageState.url) {
          await SessionManager.getInstance().recordDomain(sessionId, pageState.url);
        }
        if (this.runId !== runId) return;
        await SessionManager.getInstance().appendMessage(sessionId, {
          kind: 'step',
          thought: modelPlan.thought,
          step: {
            tool: modelPlan.action.type,
            args: modelPlan.action,
            result: { ok: actionResult.success, content: actionResult.message },
            summary: modelPlan.thought || modelPlan.action.type,
            durationMs: stepDuration,
            url: pageState.url,
            targetLabel,
          },
        });
      }

      if (this.runId !== runId) return;
      this.history.push({
        step: this.history.length + 1,
        thought: modelPlan.thought,
        action: modelPlan.action,
        result: actionResult.message || 'Action executed.',
        success: actionResult.success,
        timestamp: Date.now(),
        targetLabel,
        blockedOnPage: this.blockedPage(actionResult, actionObservation, pageFingerprint),
        blockedByAssistant: actionResult.failure === 'embedded_assistant',
      });

      this.notifyUpdate({
        thought: modelPlan.thought,
        action: modelPlan.action,
      });

      // Observe sooner on stable pages while allowing ongoing transitions to finish.
      if (actionResult.failure !== 'stale_target' && actionResult.failure !== 'stale_observation' &&
          actionResult.failure !== 'disabled_target' && actionResult.failure !== 'embedded_assistant') {
        await this.waitForActionSettle(tabId, modelPlan.action.type, runId, signal);
      }
    }
  }

  private blockedPage(result: ActionExecutionResult, observation?: PageObservation, fingerprint?: () => string): string | undefined {
    if (result.failure === 'disabled_target' || result.failure === 'unreachable_target' || result.failure === 'embedded_assistant') {
      return observation?.fingerprint ?? fingerprint?.();
    }
  }

  private async authorizeEmbeddedAssistant(action: AgentAction, runId: number, pageUrl?: string, signal?: AbortSignal): Promise<boolean> {
    if (action.embeddedAssistant !== true || !pageUrl || !signal || !this.provider) return false;
    const origin = new URL(pageUrl).origin;
    if (this.embeddedAssistantDecision?.origin === origin) return this.embeddedAssistantDecision.allowed;
    const decision = await runOperation(() => this.client.completeAnalysis(
      'Determine only whether the user explicitly requested using the website’s built-in AI builder, generator, or assistant. ' +
      'Return ASSISTANT only for that explicit method. Requests to create, configure, or continue browser work normally mean operate the app directly. ' +
      'A later request to do the work directly overrides earlier permission. Return DIRECT when uncertain. Output one word.',
      JSON.stringify({ site: origin, userMessages: this.recentUserTasks }), signal, undefined, this.provider,
    ), 15000, 'Checking which builder the user requested', signal).catch(() => 'DIRECT');
    if (this.runId !== runId || signal.aborted) return false;
    const allowed = decision.trim() === 'ASSISTANT';
    this.embeddedAssistantDecision = { origin, allowed };
    return allowed;
  }

  private async waitForActionSettle(tabId: number, actionType: AgentAction['type'], runId: number, signal?: AbortSignal): Promise<void> {
    if (actionType === 'navigate') return;
    await this.measure(runId, 'settle', () => runOperation(
      () => chrome.tabs.sendMessage(tabId, { type: 'WAIT_FOR_PAGE_SETTLE', actionType }, { frameId: 0 }),
      1000, 'Waiting for page', signal,
    ).catch(() => {}));
  }

  private async trackInput(action: AgentAction, runId: number, observation?: PageObservation) {
    const input = this.executeActionOnTarget(action, runId, observation);
    this.activeInput = input;
    try { return await input; }
    finally { if (this.activeInput === input) this.activeInput = undefined; }
  }

  private async measure<T>(runId: number, stage: string, operation: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const progress = stage === 'model' ? setInterval(() => {
      if (this.runId === runId && this.status === 'running') {
        const seconds = Math.floor((performance.now() - start) / 1000);
        this.notifyUpdate({ activity: `Thinking... ${seconds}s` });
      }
    }, 1000) : undefined;
    try { return await operation(); }
    finally {
      clearInterval(progress);
      if (this.runId === runId) {
        const ms = Math.round(performance.now() - start);
        this.timings[stage] = ms;
        console.debug('[AgentTiming]', stage, ms + 'ms');
      }
    }
  }

  private async executeActionOnTarget(
    action: AgentAction,
    runId: number,
    observation?: PageObservation,
  ): Promise<ActionExecutionResult> {
    const activities: Record<string, string> = {
      navigate: 'Navigating…', click: 'Clicking…', type: 'Typing…',
      scroll: 'Scrolling…', wait: 'Waiting…', select: 'Selecting…',
      press_key: 'Pressing key…', search_web: 'Searching…',
    };
    const tabId = this.activeTabId;
    const isCurrent = () => this.runId === runId && this.status === 'running' && this.activeTabId === tabId;
    if (!tabId || !isCurrent()) return { success: false, message: 'The browser run is no longer active.' };
    this.notifyUpdate({ activity: activities[action.type] || 'Working…' });
    const signal = this.runAbort?.signal;
    const observationId = observation?.id;
    const sendToPage = (message: Record<string, unknown>) =>
      runOperation(() => chrome.tabs.sendMessage(tabId, { ...message, observationId }, { frameId: 0 }),
        5000, 'Page action', signal).catch(() => null);

    if (action.type === 'type' && action.focused === true) {
      const editor = observation?.focusedEditor;
      const tab = await runOperation(() => chrome.tabs.get(tabId), 2000, 'Checking the focused tab', signal).catch(() => null);
      if (!editor || typeof action.text !== 'string' || !isCurrent() || !tab?.active || tab.pendingUrl || tab.url !== observation.url) {
        return { success: false, failure: 'stale_observation', message: 'The focused editor or its tab changed before typing.' };
      }
      const [context] = await runOperation(() => chrome.scripting.executeScript({
        target: { tabId, documentIds: [editor.documentId] }, func: isEmbeddedAssistantControl,
      }), 1500, 'Checking the focused editor’s purpose', signal).catch(() => []);
      if (!isCurrent() || typeof context?.result !== 'boolean') {
        return { success: false, failure: 'stale_target', message: 'The focused editor’s context could not be verified.' };
      }
      if (context.result && !await this.authorizeEmbeddedAssistant(action, runId, observation.url, signal)) {
        return { success: false, failure: 'embedded_assistant', message: EMBEDDED_ASSISTANT_BLOCK };
      }
      if (!isCurrent()) return { success: false, message: 'The browser run stopped.' };
      const [frame] = await runOperation(() => chrome.scripting.executeScript({
        target: { tabId, documentIds: [editor.documentId] }, func: inspectFocusedEditor,
        args: [{ token: editor.token, text: action.text! }],
      }), 3000, 'Typing into the verified focused editor', signal).catch(() => []);
      if (!frame?.result) return { success: false, failure: 'stale_target', message: 'The same editable field is no longer focused or its frame could not be reached.' };
      return frame.result.written ? { success: true, message: 'Entered and verified text in the focused editor.' }
        : { success: false, message: 'The focused editor did not retain the text.' };
    }

    // Special Action 1: Tailor Resume on Local Bridge
    if (action.type === 'tailor_resume') {
      try {
        const { smith_bridge_token: bridgeToken } = await chrome.storage.local.get('smith_bridge_token');
        if (typeof bridgeToken !== 'string' || !bridgeToken) {
          return { success: false, message: 'Set the local resume bridge token in Agent Smith settings.' };
        }
        const deadline = AbortSignal.timeout(25_000);
        const res = await fetch(`http://127.0.0.1:51121/v1/resume/tailor`, {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridgeToken },
          body: JSON.stringify({
            jobTitle: action.jobTitle || 'Software Engineer',
            company: action.company || 'Client',
            requirements: action.requirements || action.text || '',
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (isCurrent()) this.lastTailoredResumePath = data.filePath;
          return {
            success: true,
            message: `Generated tailored PDF resume: ${data.filePath}`,
          };
        } else {
          return { success: false, message: 'Bridge failed to tailor resume.' };
        }
      } catch (err: any) {
        return { success: false, message: `Tailor resume error: ${err.message}` };
      }
    }

    // Special Action 2: CDP File Upload
    if (action.type === 'upload_file') {
      const filePath = this.lastTailoredResumePath;
      if (!filePath) {
        return { success: false, message: 'No resume file available to upload.' };
      }

      if (this.envHandlers?.uploadFileViaCDP) {
        const valid = await sendToPage({ type: 'VALIDATE_OBSERVATION' });
        if (!valid?.success || !isCurrent()) return { success: false, message: 'The upload page changed. Observe it again.' };
        const ok = await this.envHandlers.uploadFileViaCDP(
          tabId,
          action.selector || 'input[type="file"]',
          filePath,
          isCurrent,
        );
        return {
          success: ok,
          message: ok ? `Uploaded file "${filePath}" via Chrome DevTools Protocol.` : 'Failed CDP upload.',
        };
      }
      return { success: false, message: 'CDP handler not initialized.' };
    }

    if (action.type === 'navigate') {
      let url: URL;
      try {
        if (!action.url) throw new Error('Missing URL');
        url = new URL(action.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL scheme');
      } catch {
        return { success: false, message: 'Navigation needs an absolute HTTP or HTTPS URL.' };
      }

      try {
        const before = await runOperation(() => chrome.tabs.get(tabId), 3000, 'Finding page', signal);
        if (!isCurrent() || (observation && before.url !== observation.url)) {
          return { success: false, message: 'The tab changed before navigation. Observe it again.' };
        }
        await runOperation(() => chrome.tabs.update(tabId, { url: url.href }), 4000, 'Navigating', signal);
        if (!isCurrent()) return { success: false, message: 'Run stopped.' };
        const destination = await this.waitForReadableTab(tabId, before.url, url.href);
        if (!destination || !isCurrent()) {
          return { success: false, message: 'Navigation did not finish while the run was active.' };
        }
        await this.ensureTabReady(tabId, signal);
        return { success: true, message: 'Loaded ' + destination };
      } catch {
        return { success: false, message: 'The tab could not navigate to the requested URL.' };
      }
    }

    if (action.type === 'drag') {
      const startX = action.startX ?? action.x;
      const startY = action.startY ?? action.y;
      const { endX, endY } = action;
      if (typeof startX !== 'number' || typeof startY !== 'number' || typeof endX !== 'number' || typeof endY !== 'number') {
        return { success: false, message: 'Drag requires start and end coordinates.' };
      }
      const validated = await sendToPage({ type: 'VALIDATE_POINTER', startX, startY, endX, endY });
      if (!validated?.success || !isCurrent()) {
        return { success: false, message: 'Drag points do not match the observed viewport.' };
      }
      void sendToPage({ type: 'POINTER_FEEDBACK', x: startX, y: startY });
      const dragged = await CDPController.drag(tabId, startX, startY, endX, endY, isCurrent, async () =>
        Boolean((await sendToPage({ type: 'VALIDATE_POINTER', startX, startY, endX, endY }))?.success) && isCurrent(),
      );
      if (dragged && isCurrent()) void sendToPage({ type: 'POINTER_FEEDBACK', x: endX, y: endY });
      return { success: dragged, message: dragged ? 'Drag dispatched.' : 'Chrome could not dispatch the drag.' };
    }

    let allowEmbeddedAssistant = false;
    let prepared = await sendToPage({ type: 'EXECUTE_ACTION', action });
    if (prepared?.failure === 'embedded_assistant' &&
        await this.authorizeEmbeddedAssistant(action, runId, observation?.url, signal) && isCurrent()) {
      allowEmbeddedAssistant = true;
      prepared = await sendToPage({ type: 'EXECUTE_ACTION', action, allowEmbeddedAssistant });
    }
    if (!isCurrent()) return { success: false, message: 'The browser run stopped.' };
    if (!prepared) return { success: false, message: 'The page could not respond to this action.' };
    if (!prepared.success) return prepared;

    if (action.type === 'press_key') {
      const key = action.key || 'Enter';
      const sent = await CDPController.pressKey(tabId, key, isCurrent);
      return { success: sent, message: sent ? 'Pressed ' + key : 'Chrome could not dispatch the key.' };
    }

    if (action.type === 'click' || action.type === 'hover' || action.type === 'scroll') {
      const { x, y } = prepared.coords ?? {};
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, message: 'The page did not resolve a usable pointer location.' };
      }
      if (action.type === 'click') {
        const sent = await CDPController.click(tabId, x, y, async () => {
          if (!isCurrent()) return false;
          const point = await sendToPage({ type: 'CHECK_CLICK_POINT', x, y, allowEmbeddedAssistant });
          return Boolean(point?.success) && isCurrent();
        });
        if (sent && isCurrent()) void sendToPage({ type: 'POINTER_FEEDBACK', x, y, click: true });
        return { success: sent, message: sent ? 'Clicked at (' + Math.round(x) + ', ' + Math.round(y) + ').' : 'The click was blocked, the target moved, or Chrome could not dispatch it.' };
      }
      if (action.type === 'hover') {
        const sent = await CDPController.move(tabId, x, y, isCurrent);
        return { success: sent, message: sent ? 'Moved the pointer over the target.' : 'Chrome could not move the pointer.' };
      }
      const amount = Number.isFinite(action.amount) ? Math.min(Math.abs(action.amount!), 2400) : 450;
      const sent = await CDPController.scroll(tabId, action.direction === 'up' ? -amount : amount, x, y, isCurrent);
      return { success: sent, message: sent ? 'Scroll dispatched.' : 'Chrome could not dispatch the scroll.' };
    }

    return prepared;
  }

  private requiresApproval(action: AgentAction): boolean {
    return this.safetyGate && this.requiresDirectInput(action);
  }

  private requiresDirectInput(action: AgentAction): boolean {
    return ['click', 'drag', 'press_key', 'type', 'select', 'upload_file', 'tailor_resume'].includes(action.type);
  }

  private notifyUpdate(extra?: Partial<Parameters<NonNullable<AgentEngine['onUpdateCallback']>>[0]>) {
    if (this.onUpdateCallback) {
      this.onUpdateCallback({
        status: this.status,
        requestId: this.requestId,
        approvalId: this.approvalId,
        sessionId: this.currentSessionId,
        step: this.history.length,
        logs: this.history.map(({ action, success }) => ({ action: { type: action.type, url: action.url }, success })),
        ...extra,
      });
    }
  }
}
