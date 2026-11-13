import { animateReply } from './reply-animation';
import { storedAssistantReply } from '../shared/chat-reply';
import { initProviderSettings } from './provider-settings';
import { summarizeActions, type ActionOutcome } from './action-summary';
import type { AgentStepLog } from '../background/agent-engine';
/**
 * Side Panel Controller - Agent Smith
 * 
 * Professional UI Pass & HalftoneAurora Living Background:
 * - Direct WebGL2 Halftone Aurora background rendered on canvas behind chat.
 * - Strict Zero Emoji Policy: All emojis stripped from UI, logs, toasts, and assistant responses.
 * - Borderless Chat Stream: Typography on living background. No cards, no bubbles, no borders.
 * - Completed browser work appears as a short paragraph.
 * - Saved Sessions continuous autosaving to IndexedDB database `pilotpanel`.
 */

import { Session, StoredMessage, SessionStatus } from '../shared/types';
import { saveSession, saveMessage } from '../shared/db';
import { initGL, createProgram, createFullScreenTriangle } from '../background-fx/gl';
import {
  VERTEX_SHADER_GLSL3,
  FRAGMENT_SHADER_GLSL3,
  VERTEX_SHADER_GLSL1,
  FRAGMENT_SHADER_GLSL1,
} from '../background-fx/shader';

interface AgentUpdateData {
  status: 'idle' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'error';
  step: number;
  thought?: string;
  requestId?: string;
  approvalId?: string;
  sessionId?: string | null;
  activity?: string;
  action?: AgentStepLog['action'];
  logs: Array<{ action: Pick<AgentStepLog['action'], 'type' | 'url'>; success: boolean }>;
  summary?: string;
  chartReply?: string;
  error?: string;
}

// ============================================================================
// State
// ============================================================================
const PANEL_SESSION_KEY = 'smith_sidepanel_session';
let activeSessionId: string | null = null;
document.getElementById('btn-trading')?.addEventListener('click', () => {
  void startAgent('Analyze this chart.');
});
document.getElementById('menu-item-trading-tools')?.addEventListener('click', () => {
  const url = new URL(chrome.runtime.getURL('dist/trading/chart.html'));
  if (activeSessionId) url.searchParams.set('session', activeSessionId);
  void chrome.tabs.create({ url: url.href }).catch(error => console.error('[Trading] Could not open workspace:', error));
});
let sessionViewRevision = 0;
let currentRequestId: string | undefined;
let stopPending: Promise<void> = Promise.resolve();
let activeSession: Session | null = null;
let allSessions: Session[] = [];
let activeFilter = 'all';
let searchQuery = '';
let searchDebounceTimer: any = null;

let undoTimeoutTimer: any = null;
let deletedSessionBackup: { session: Session; messages: StoredMessage[] } | null = null;

let visionEnabled = false;
let safetyGate = true;
let isRunning = false;

let currentAgentMessageEl: HTMLElement | null = null;
let currentProgressEl: HTMLElement | null = null;
let currentActionSummaryEl: HTMLElement | null = null;
let currentResponseBodyEl: HTMLElement | null = null;
let finishReplyAnimation: (() => void) | undefined;
let currentConfirmationCardEl: HTMLElement | null = null;

// Lightbox state
let lightboxScreenshots: { url?: string; ts?: number; dataUrl: string; step: number }[] = [];
let currentLightboxIndex = 0;

// Halftone Aurora WebGL state
let bgGL: WebGLRenderingContext | WebGL2RenderingContext | null = null;
let bgProgram: WebGLProgram | null = null;
let bgBuffer: WebGLBuffer | null = null;
let bgUniforms: Record<string, WebGLUniformLocation | null> = {};
let bgIntensity = 0.95;
let bgGlowHeight = 0.52;
let bgCellSize = 8;
let bgShape = 2; // 2 = diamond (matches Google Gemini reference)
let bgCurrentColor1 = [0.55, 0.32, 1.0]; // vibrant violet #8B5CF6
let bgCurrentColor2 = [0.92, 0.25, 0.88]; // vibrant magenta #E840DF
let bgCurrentColor3 = [0.18, 0.48, 1.0]; // electric royal blue #2F7BFF
let bgTime = 0;
let bgAnimId: number | null = null;
let bgLastTime = performance.now();
const reduceAuroraMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ============================================================================
// DOM Elements
// ============================================================================
const auroraCanvas = document.getElementById('halftone-aurora-canvas') as HTMLCanvasElement;
const chatContainer = document.getElementById('chat-container') as HTMLElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const conversationFeed = document.getElementById('conversation-feed') as HTMLElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const btnSend = document.getElementById('btn-send') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const toggleTurbo = document.getElementById('toggle-turbo') as HTMLElement;
const modeText = document.getElementById('mode-text') as HTMLElement;
const btnNewChat = document.getElementById('btn-new-chat') as HTMLButtonElement;
const btnOpenSettings = document.getElementById('btn-open-settings') as HTMLButtonElement;
const btnCloseSettings = document.getElementById('btn-close-settings') as HTMLButtonElement;
const settingsDrawer = document.getElementById('settings-drawer') as HTMLElement;
const btnRelogin = document.getElementById('btn-relogin') as HTMLButtonElement;
const btnLogout = document.getElementById('btn-logout') as HTMLButtonElement;

// Session Header & Inline Title
const btnOpenHistory = document.getElementById('btn-open-history') as HTMLButtonElement;
const sessionTitleText = document.getElementById('session-title-text') as HTMLElement;
const sessionTitleInput = document.getElementById('session-title-input') as HTMLInputElement;

// Session Menu
const btnSessionMenu = document.getElementById('btn-session-menu') as HTMLButtonElement;
const sessionDropdownMenu = document.getElementById('session-dropdown-menu') as HTMLElement;
const menuItemPin = document.getElementById('menu-item-pin') as HTMLButtonElement;
const pinLabel = document.getElementById('pin-label') as HTMLElement;
const menuItemRename = document.getElementById('menu-item-rename') as HTMLButtonElement;
const menuItemBranch = document.getElementById('menu-item-branch') as HTMLButtonElement;
const menuItemExportMd = document.getElementById('menu-item-export-md') as HTMLButtonElement;
const menuItemExportJson = document.getElementById('menu-item-export-json') as HTMLButtonElement;
const menuItemCopyPrompt = document.getElementById('menu-item-copy-prompt') as HTMLButtonElement;
const menuItemDelScreens = document.getElementById('menu-item-del-screens') as HTMLButtonElement;
const menuItemDelete = document.getElementById('menu-item-delete') as HTMLButtonElement;

// Status Banner
const sessionStatusBanner = document.getElementById('session-status-banner') as HTMLElement;
const statusBannerText = document.getElementById('status-banner-text') as HTMLElement;
const statusBannerAction = document.getElementById('status-banner-action') as HTMLButtonElement;

// History Drawer
const historyDrawer = document.getElementById('history-drawer') as HTMLElement;
const historyBackdrop = document.getElementById('history-backdrop') as HTMLElement;
const btnCloseHistory = document.getElementById('btn-close-history') as HTMLButtonElement;
const historySearchInput = document.getElementById('history-search-input') as HTMLInputElement;
const historyList = document.getElementById('history-list') as HTMLElement;
const historyTotalCount = document.getElementById('history-total-count') as HTMLElement;
const filterChips = document.querySelectorAll('.filter-chip');

// Undo Toast
const undoToast = document.getElementById('undo-toast') as HTMLElement;
const undoToastText = document.getElementById('undo-toast-text') as HTMLElement;
const btnUndoAction = document.getElementById('btn-undo-action') as HTMLButtonElement;

// Screenshot Lightbox
const screenshotLightbox = document.getElementById('screenshot-lightbox') as HTMLElement;
const lightboxBackdrop = document.getElementById('lightbox-backdrop') as HTMLElement;
const lightboxClose = document.getElementById('lightbox-close') as HTMLButtonElement;
const lightboxImage = document.getElementById('lightbox-image') as HTMLImageElement;
const lightboxStepLabel = document.getElementById('lightbox-step-label') as HTMLElement;
const lightboxCounter = document.getElementById('lightbox-counter') as HTMLElement;
const lightboxPrev = document.getElementById('lightbox-prev') as HTMLButtonElement;
const lightboxNext = document.getElementById('lightbox-next') as HTMLButtonElement;
const lightboxUrl = document.getElementById('lightbox-url') as HTMLElement;
const lightboxTime = document.getElementById('lightbox-time') as HTMLElement;

// Storage Settings
const settingsRetention = document.getElementById('settings-retention') as HTMLSelectElement;
const settingsSendScreenshots = document.getElementById('settings-send-screenshots') as HTMLInputElement;
const storageUsageText = document.getElementById('storage-usage-text') as HTMLElement;
const storageProgressFill = document.getElementById('storage-progress-fill') as HTMLElement;
const btnClearAllSessions = document.getElementById('btn-clear-all-sessions') as HTMLButtonElement;

// ============================================================================
// Zero Emoji Policy Sanitizer
// ============================================================================
function stripEmoji(text: string): string {
  if (!text) return '';
  return text.replace(/[\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF]/gu, '').trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatRelativeTime(ts: number): string {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderMarkdown(md: string): string {
  if (!md) return '';
  let html = escapeHtml(stripEmoji(md)).replace(/\r\n?/g, '\n');

  // Fenced code blocks (no borders, clean syntax formatting)
  html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (_, lang, code) => {
    return `<div class="gemini-code-block"><div class="code-lang">${lang || 'code'}</div><code>${code.trim()}</code></div>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="gemini-inline-code">$1</code>');

  // Headers (size and weight only)
  html = html.replace(/^### (.*$)/gim, '<h3 class="gemini-h3">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="gemini-h2">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="gemini-h1">$1</h1>');

  // Bold & Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Wrap each run once, retaining the source list type.
  html = html.replace(/^(?:[ \t]*[-*][ \t]+[^\n]+(?:\n|$))+|^(?:[ \t]*\d+\.[ \t]+[^\n]+(?:\n|$))+/gm, block => {
    const tag = /^\s*\d+\./.test(block) ? 'ol' : 'ul';
    const items = block.trimEnd().split('\n').map(line =>
      '<li>' + line.replace(/^[ \t]*(?:[-*]|\d+\.)[ \t]+/, '') + '</li>').join('');
    return '\n\n<' + tag + '>' + items + '</' + tag + '>\n\n';
  });

  // Paragraphs
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<h1') ||
        trimmed.startsWith('<h2') ||
        trimmed.startsWith('<h3') ||
        trimmed.startsWith('<div class="gemini-code-block"') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<ol')
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');

  return html;
}

function autoResizeInput(): void {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
}

function scrollToBottom(): void {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function setRunningState(running: boolean): void {
  isRunning = running;
  const chartButton = document.getElementById('btn-trading') as HTMLButtonElement | null;
  if (chartButton) chartButton.disabled = running;
  if (running) {
    btnSend.style.display = 'none';
    btnStop.style.display = 'flex';
    promptInput.disabled = true;
    updateHalftoneColors('acting');
  } else {
    btnSend.style.display = 'flex';
    btnStop.style.display = 'none';
    promptInput.disabled = false;
    promptInput.focus();
    updateHalftoneColors('idle');
  }
}

// ============================================================================
// Living Halftone Aurora Engine (Mounted on Canvas)
// ============================================================================
function initHalftoneAurora(): void {
  if (!auroraCanvas) return;

  const glResult = initGL(auroraCanvas);
  if (!glResult) {
    console.warn('[HalftoneAurora] WebGL not available, falling back to CSS aurora gradient.');
    auroraCanvas.style.display = 'none';
    return;
  }

  const { gl, isWebGL2 } = glResult;
  bgGL = gl;

  const vertSrc = isWebGL2 ? VERTEX_SHADER_GLSL3 : VERTEX_SHADER_GLSL1;
  const fragSrc = isWebGL2 ? FRAGMENT_SHADER_GLSL3 : FRAGMENT_SHADER_GLSL1;
  const program = createProgram(gl, vertSrc, fragSrc);
  if (!program) {
    console.warn('[HalftoneAurora] Failed to compile shaders, using CSS gradient fallback.');
    auroraCanvas.style.display = 'none';
    return;
  }
  bgProgram = program;

  const buffer = createFullScreenTriangle(gl);
  bgBuffer = buffer;

  const aPosLoc = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPosLoc);
  gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

  bgUniforms = {
    uRes: gl.getUniformLocation(program, 'uRes'),
    uTime: gl.getUniformLocation(program, 'uTime'),
    uCell: gl.getUniformLocation(program, 'uCell'),
    uGlowH: gl.getUniformLocation(program, 'uGlowH'),
    uAmp: gl.getUniformLocation(program, 'uAmp'),
    uIntensity: gl.getUniformLocation(program, 'uIntensity'),
    uShape: gl.getUniformLocation(program, 'uShape'),
    uRibbons: gl.getUniformLocation(program, 'uRibbons'),
    uC1: gl.getUniformLocation(program, 'uC1'),
    uC2: gl.getUniformLocation(program, 'uC2'),
    uC3: gl.getUniformLocation(program, 'uC3'),
  };

  startAuroraLoop();
  document.addEventListener('visibilitychange', startAuroraLoop);
  reduceAuroraMotion.addEventListener('change', startAuroraLoop);

  window.addEventListener('resize', () => {
    renderHalftoneFrame();
  });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      renderHalftoneFrame();
    });
    ro.observe(document.body);
  }
}

function startAuroraLoop(): void {
  if (bgAnimId !== null) cancelAnimationFrame(bgAnimId);
  bgAnimId = null;
  if (document.hidden) return;
  renderHalftoneFrame();
  if (reduceAuroraMotion.matches) return;

  bgLastTime = performance.now();
  function tick(now: number) {
    const elapsed = now - bgLastTime;
    if (elapsed >= 1000 / 30 - 1) {
      bgTime += Math.min(elapsed * 0.001, 0.1);
      bgLastTime = now;
      renderHalftoneFrame();
    }
    bgAnimId = requestAnimationFrame(tick);
  }
  bgAnimId = requestAnimationFrame(tick);
}

function renderHalftoneFrame(): void {
  const gl = bgGL;
  const program = bgProgram;
  const canvas = auroraCanvas;
  if (!gl || !program || !canvas) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const clientW = canvas.clientWidth || window.innerWidth || 360;
  const clientH = canvas.clientHeight || window.innerHeight || 600;
  const width = Math.max(1, Math.round(clientW * dpr));
  const height = Math.max(1, Math.round(clientH * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  gl.viewport(0, 0, width, height);
  gl.useProgram(program);

  if (bgUniforms.uRes) gl.uniform2f(bgUniforms.uRes, width, height);
  if (bgUniforms.uTime) gl.uniform1f(bgUniforms.uTime, bgTime);
  if (bgUniforms.uCell) gl.uniform1f(bgUniforms.uCell, bgCellSize * dpr);
  if (bgUniforms.uGlowH) gl.uniform1f(bgUniforms.uGlowH, bgGlowHeight);
  if (bgUniforms.uAmp) gl.uniform1f(bgUniforms.uAmp, 1.0);
  if (bgUniforms.uIntensity) gl.uniform1f(bgUniforms.uIntensity, bgIntensity);
  if (bgUniforms.uShape) gl.uniform1i(bgUniforms.uShape, bgShape);
  if (bgUniforms.uRibbons) gl.uniform1f(bgUniforms.uRibbons, 1);
  if (bgUniforms.uC1) gl.uniform3fv(bgUniforms.uC1, bgCurrentColor1);
  if (bgUniforms.uC2) gl.uniform3fv(bgUniforms.uC2, bgCurrentColor2);
  if (bgUniforms.uC3) gl.uniform3fv(bgUniforms.uC3, bgCurrentColor3);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function updateHalftoneColors(stateName: string): void {
  switch (stateName) {
    case 'thinking':
      bgCurrentColor1 = [0.388, 0.400, 0.945]; // indigo #6366F1
      bgCurrentColor2 = [0.133, 0.827, 0.933]; // cyan #22D3EE
      bgCurrentColor3 = [0.545, 0.361, 0.965]; // purple #8B5CF6
      break;
    case 'acting':
      bgCurrentColor1 = [0.231, 0.510, 0.965]; // blue #3B82F6
      bgCurrentColor2 = [0.659, 0.333, 0.969]; // purple #A855F7
      bgCurrentColor3 = [0.957, 0.447, 0.714]; // pink #F472B6
      break;
    case 'waiting':
      bgCurrentColor1 = [0.961, 0.620, 0.043]; // amber #F59E0B
      bgCurrentColor2 = [0.984, 0.443, 0.522]; // rose #FB7185
      bgCurrentColor3 = [0.545, 0.361, 0.965]; // violet #8B5CF6
      break;
    case 'error':
      bgCurrentColor1 = [0.937, 0.267, 0.267]; // red #EF4444
      bgCurrentColor2 = [0.624, 0.071, 0.224]; // crimson #9F1239
      bgCurrentColor3 = [0.298, 0.114, 0.584]; // deep purple #4C1D95
      break;
    case 'completed':
      bgCurrentColor1 = [0.204, 0.827, 0.600]; // emerald #34D399
      bgCurrentColor2 = [0.133, 0.827, 0.933]; // cyan #22D3EE
      bgCurrentColor3 = [0.231, 0.510, 0.965]; // blue #3B82F6
      break;
    case 'idle':
    default:
      bgCurrentColor1 = [0.55, 0.32, 1.0]; // vibrant violet #8B5CF6
      bgCurrentColor2 = [0.92, 0.25, 0.88]; // vibrant magenta #E840DF
      bgCurrentColor3 = [0.18, 0.48, 1.0]; // electric royal blue #2F7BFF
      break;
  }
  if (reduceAuroraMotion.matches) renderHalftoneFrame();
}

function updateContrastForMessages(hasMessages: boolean): void {
  if (hasMessages) {
    bgIntensity = 0.85;
    bgGlowHeight = 0.48;
  } else {
    bgIntensity = 0.95;
    bgGlowHeight = 0.52;
  }
  if (reduceAuroraMotion.matches) renderHalftoneFrame();
}

// ============================================================================
// Header & Session Title Management
// ============================================================================
function updateHeaderSessionTitle(title: string): void {
  const cleanTitle = stripEmoji(title) || 'New Session';
  sessionTitleText.textContent = cleanTitle;
  sessionTitleText.title = 'Click to rename session';
  sessionTitleInput.value = cleanTitle;
}

sessionTitleText.addEventListener('click', () => {
  sessionTitleText.style.display = 'none';
  sessionTitleInput.style.display = 'block';
  sessionTitleInput.focus();
  sessionTitleInput.select();
});

sessionTitleInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    await saveEditedTitle();
  } else if (e.key === 'Escape') {
    sessionTitleInput.style.display = 'none';
    sessionTitleText.style.display = 'block';
  }
});

sessionTitleInput.addEventListener('blur', async () => {
  await saveEditedTitle();
});

async function saveEditedTitle(): Promise<void> {
  const newTitle = stripEmoji(sessionTitleInput.value).trim();
  sessionTitleInput.style.display = 'none';
  sessionTitleText.style.display = 'block';

  if (newTitle && activeSessionId) {
    updateHeaderSessionTitle(newTitle);
    await chrome.runtime.sendMessage({
      type: 'RENAME_SESSION',
      sessionId: activeSessionId,
      title: newTitle,
    });
    if (activeSession) {
      activeSession.title = newTitle;
      activeSession.titleSource = 'user';
    }
  }
}

// ============================================================================
// Session Status Banner
// ============================================================================
function updateSessionStatusBanner(status: SessionStatus): void {
  if (status === 'interrupted') {
    sessionStatusBanner.style.display = 'flex';
    statusBannerText.textContent = 'Session interrupted by service worker restart. Send a message to resume.';
    statusBannerAction.style.display = 'inline-block';
    statusBannerAction.textContent = 'Resume';
    statusBannerAction.onclick = () => promptInput.focus();
  } else if (status === 'awaiting_permission') {
    sessionStatusBanner.style.display = 'flex';
    statusBannerText.textContent = 'Execution paused waiting for your confirmation below.';
    statusBannerAction.style.display = 'none';
  } else {
    sessionStatusBanner.style.display = 'none';
  }
}

// ============================================================================
// Session Menu Dropdown
// ============================================================================
btnSessionMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = sessionDropdownMenu.style.display === 'flex';
  sessionDropdownMenu.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen && activeSession) {
    pinLabel.textContent = activeSession.pinned ? 'Unpin session' : 'Pin session';
  }
});

document.addEventListener('click', () => {
  sessionDropdownMenu.style.display = 'none';
});

menuItemPin.addEventListener('click', async () => {
  sessionDropdownMenu.style.display = 'none';
  if (!activeSessionId) return;
  const res = await chrome.runtime.sendMessage({
    type: 'TOGGLE_PIN_SESSION',
    sessionId: activeSessionId,
  });
  if (res?.success && activeSession) {
    activeSession.pinned = res.pinned;
    pinLabel.textContent = activeSession.pinned ? 'Unpin session' : 'Pin session';
  }
});

menuItemRename.addEventListener('click', () => {
  sessionDropdownMenu.style.display = 'none';
  sessionTitleText.click();
});

menuItemBranch.addEventListener('click', async () => {
  sessionDropdownMenu.style.display = 'none';
  if (!activeSessionId) return;
  const res = await chrome.runtime.sendMessage({
    type: 'BRANCH_SESSION',
    sessionId: activeSessionId,
  });
  if (res?.success && res.session) {
    await loadSession(res.session.id);
  }
});

menuItemExportMd.addEventListener('click', async () => {
  sessionDropdownMenu.style.display = 'none';
  if (!activeSessionId) return;
  const res = await chrome.runtime.sendMessage({
    type: 'EXPORT_SESSION_MD',
    sessionId: activeSessionId,
  });
  if (res?.success && res.markdown) {
    const filename = `${stripEmoji(activeSession?.title || 'session').replace(/[^a-z0-9_-]/gi, '_')}.md`;
    downloadTextFile(filename, res.markdown, 'text/markdown');
  }
});

menuItemExportJson.addEventListener('click', async () => {
  sessionDropdownMenu.style.display = 'none';
  if (!activeSessionId) return;
  const res = await chrome.runtime.sendMessage({
    type: 'EXPORT_SESSION_JSON',
    sessionId: activeSessionId,
  });
  if (res?.success && res.json) {
    const filename = `${stripEmoji(activeSession?.title || 'session').replace(/[^a-z0-9_-]/gi, '_')}.json`;
    downloadTextFile(filename, res.json, 'application/json');
  }
});

menuItemCopyPrompt.addEventListener('click', () => {
  sessionDropdownMenu.style.display = 'none';
  if (activeSession?.goal) {
    navigator.clipboard.writeText(stripEmoji(activeSession.goal));
    sessionTitleText.textContent = 'Copied goal';
    setTimeout(() => {
      sessionTitleText.textContent = activeSession?.title || 'New Session';
    }, 1500);
  }
});

menuItemDelScreens.addEventListener('click', async () => {
  sessionDropdownMenu.style.display = 'none';
  if (!activeSessionId) return;
  await chrome.runtime.sendMessage({
    type: 'DELETE_SCREENSHOTS',
    sessionId: activeSessionId,
  });
  refreshStorageStats();
});

menuItemDelete.addEventListener('click', async () => {
  sessionDropdownMenu.style.display = 'none';
  if (!activeSessionId) return;
  await deleteSessionWithUndo(activeSessionId);
});

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// 10-Second Undo Toast
// ============================================================================
async function deleteSessionWithUndo(sessionId: string): Promise<void> {
  const res = await chrome.runtime.sendMessage({
    type: 'GET_SESSION_DETAILS',
    sessionId,
  });

  if (res?.success && res.session) {
    deletedSessionBackup = {
      session: res.session,
      messages: res.messages || [],
    };
  }

  await chrome.runtime.sendMessage({
    type: 'DELETE_SESSION',
    sessionId,
  });

  if (sessionId === activeSessionId) {
    resetFeed();
  }

  undoToast.style.display = 'flex';
  undoToastText.textContent = `Session "${stripEmoji(res?.session?.title || 'item')}" deleted.`;

  if (undoTimeoutTimer) clearTimeout(undoTimeoutTimer);
  undoTimeoutTimer = setTimeout(() => {
    undoToast.style.display = 'none';
    deletedSessionBackup = null;
    refreshHistoryList();
    refreshStorageStats();
  }, 10000);

  refreshHistoryList();
  refreshStorageStats();
}

btnUndoAction.addEventListener('click', async () => {
  if (undoTimeoutTimer) clearTimeout(undoTimeoutTimer);
  undoToast.style.display = 'none';

  if (deletedSessionBackup) {
    await saveSession(deletedSessionBackup.session);
    for (const msg of deletedSessionBackup.messages) {
      await saveMessage(msg);
    }
    const restoredId = deletedSessionBackup.session.id;
    deletedSessionBackup = null;
    await loadSession(restoredId);
    refreshHistoryList();
    refreshStorageStats();
  }
});

// ============================================================================
// History Drawer & Search
// ============================================================================
btnOpenHistory.addEventListener('click', openHistoryDrawer);
btnCloseHistory.addEventListener('click', closeHistoryDrawer);
historyBackdrop.addEventListener('click', closeHistoryDrawer);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (historyDrawer.classList.contains('open')) closeHistoryDrawer();
    else openHistoryDrawer();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    btnNewChat.click();
  } else if (e.key === 'Escape') {
    if (screenshotLightbox.style.display !== 'none') closeLightbox();
    else if (historyDrawer.classList.contains('open')) closeHistoryDrawer();
    else if (settingsDrawer.classList.contains('open')) settingsDrawer.classList.remove('open');
  }
});

function openHistoryDrawer(): void {
  historyDrawer.classList.add('open');
  historyBackdrop.classList.add('open');
  historySearchInput.focus();
  refreshHistoryList();
}

function closeHistoryDrawer(): void {
  historyDrawer.classList.remove('open');
  historyBackdrop.classList.remove('open');
}

historySearchInput.addEventListener('input', () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchQuery = historySearchInput.value.trim().toLowerCase();
    renderFilteredSessions();
  }, 200);
});

filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    filterChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = (chip as HTMLElement).dataset.filter || 'all';
    renderFilteredSessions();
  });
});

async function refreshHistoryList(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_SESSIONS' });
  if (res?.success && Array.isArray(res.sessions)) {
    allSessions = res.sessions;
    historyTotalCount.textContent = String(allSessions.length);
    renderFilteredSessions();
  }
}

function renderFilteredSessions(): void {
  historyList.innerHTML = '';
  let filtered = allSessions.slice();

  if (activeFilter === 'running') {
    filtered = filtered.filter((s) => s.status === 'running' || s.status.startsWith('awaiting_'));
  } else if (activeFilter === 'completed') {
    filtered = filtered.filter((s) => s.status === 'completed');
  } else if (activeFilter === 'failed') {
    filtered = filtered.filter((s) => s.status === 'failed' || s.status === 'interrupted');
  } else if (activeFilter === 'pinned') {
    filtered = filtered.filter((s) => s.pinned);
  } else if (activeFilter === 'archived') {
    filtered = filtered.filter((s) => s.archived);
  } else {
    filtered = filtered.filter((s) => !s.archived);
  }

  if (searchQuery) {
    filtered = filtered.filter((s) => {
      const matchTitle = s.title.toLowerCase().includes(searchQuery);
      const matchGoal = s.goal.toLowerCase().includes(searchQuery);
      const matchDomain = (s.domains || []).some((d) => d.toLowerCase().includes(searchQuery));
      return matchTitle || matchGoal || matchDomain;
    });
  }

  if (filtered.length === 0) {
    historyList.innerHTML = `
      <div style="text-align: center; padding: 30px 10px; color: var(--text-tertiary); font-size: 12px;">
        No sessions found.
      </div>
    `;
    return;
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const yesterdayStart = todayStart - oneDayMs;
  const sevenDaysAgo = todayStart - 7 * oneDayMs;

  const pinnedGroup: Session[] = [];
  const todayGroup: Session[] = [];
  const yesterdayGroup: Session[] = [];
  const last7DaysGroup: Session[] = [];
  const olderGroup: Session[] = [];

  for (const s of filtered) {
    if (s.pinned && activeFilter !== 'pinned') {
      pinnedGroup.push(s);
      continue;
    }
    const t = s.updatedAt || s.createdAt;
    if (t >= todayStart) todayGroup.push(s);
    else if (t >= yesterdayStart) yesterdayGroup.push(s);
    else if (t >= sevenDaysAgo) last7DaysGroup.push(s);
    else olderGroup.push(s);
  }

  const renderGroup = (title: string, sessions: Session[]) => {
    if (sessions.length === 0) return;
    const titleEl = document.createElement('div');
    titleEl.className = 'history-section-title';
    titleEl.textContent = title;
    historyList.appendChild(titleEl);

    sessions.forEach((s) => {
      const card = createSessionCardElement(s);
      historyList.appendChild(card);
    });
  };

  renderGroup('Pinned', pinnedGroup);
  renderGroup('Today', todayGroup);
  renderGroup('Yesterday', yesterdayGroup);
  renderGroup('Last 7 Days', last7DaysGroup);
  renderGroup('Older', olderGroup);
}

function createSessionCardElement(s: Session): HTMLElement {
  const card = document.createElement('div');
  card.className = `session-card ${s.id === activeSessionId ? 'is-current' : ''}`;

  const cleanTitle = stripEmoji(s.title);
  const summary = s.summary?.trim();
  const preview = summary && !/^\s*(?:\x60{3}(?:json)?\s*)?\{\s*"/i.test(summary) ? summary : s.goal;
  const cleanSub = stripEmoji(preview).replace(/^[#>\s]+|[*_\x60]/g, '').replace(/\s+/g, ' ').trim();

  card.innerHTML = `
    <div class="session-card-top">
      <span class="session-card-title">${escapeHtml(cleanTitle)}</span>
      ${s.pinned ? '<span style="font-size:10px; color:var(--accent-amber);">Pinned</span>' : ''}
    </div>
    <div class="session-card-sub">${escapeHtml(cleanSub)}</div>
    <div class="session-card-bottom">
      <span>${s.stepCount ? `${s.stepCount} ${s.stepCount === 1 ? 'step' : 'steps'}` : ''}</span>
      <span>${formatRelativeTime(s.updatedAt || s.createdAt)}</span>
    </div>
  `;

  card.addEventListener('click', () => {
    loadSession(s.id);
    closeHistoryDrawer();
  });

  return card;
}

// ============================================================================
// Load and Render Session Transcript (Borderless Typography Stream)
// ============================================================================
function selectPanelSession(sessionId: string | null): void {
  activeSessionId = sessionId;
  sessionViewRevision++;
  void chrome.storage.local.set({ [PANEL_SESSION_KEY]: sessionId }).catch(error => {
    console.warn('[SidePanel] Could not save selected session:', error);
  });
}

async function loadSession(sessionId: string): Promise<void> {
  currentRequestId = undefined;
  selectPanelSession(sessionId);
  const revision = sessionViewRevision;
  const res = await chrome.runtime.sendMessage({
    type: 'GET_SESSION_DETAILS',
    sessionId,
  });

  if (revision !== sessionViewRevision || currentRequestId !== undefined) return;
  if (!res?.success || !res.session) {
    resetFeed();
    return;
  }

  activeSession = res.session;
  updateHeaderSessionTitle(res.session.title);
  updateSessionStatusBanner(res.session.status);

  renderFullTranscript(res.messages || []);
  const running = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (revision !== sessionViewRevision || currentRequestId !== undefined) return;
  const state = running?.status;
  const belongsHere = state?.sessionId === sessionId;
  currentRequestId = belongsHere ? state.requestId : undefined;
  setRunningState(belongsHere && ['running', 'waiting_confirmation'].includes(state.status));
  if (belongsHere && currentRequestId) updateAgentProgress({ ...state, step: state.stepCount });
}

function renderFullTranscript(messages: StoredMessage[]): void {
  stopReplyAnimation();
  emptyState.style.display = 'none';
  conversationFeed.style.display = 'flex';
  conversationFeed.innerHTML = '';

  currentAgentMessageEl = null;
  currentProgressEl = null;
  currentActionSummaryEl = null;
  currentResponseBodyEl = null;
  currentConfirmationCardEl = null;

  updateContrastForMessages(messages.length > 0);

  let outcomes: ActionOutcome[] = [];
  const flushActions = () => {
    if (outcomes.length && currentActionSummaryEl) currentActionSummaryEl.textContent = summarizeActions(outcomes);
    outcomes = [];
  };

  messages.forEach((msg) => {
    if (msg.kind === 'user') {
      flushActions();
      appendUserMessageElement(msg.text || '');
    } else if (msg.kind === 'step') {
      if (msg.step) {
        if (!currentAgentMessageEl) createAgentResponseShell();
        const args = msg.step.args as { url?: string } | undefined;
        outcomes.push({ type: msg.step.tool, url: args?.url ?? msg.step.url, success: msg.step.result.ok });
      }
    } else if (msg.kind === 'assistant') {
      flushActions();
      if (!currentAgentMessageEl) createAgentResponseShell();

      if (currentResponseBodyEl) {
        const reply = storedAssistantReply(msg);
        currentResponseBodyEl.innerHTML = reply ? renderMarkdown(reply) : 'No reply was returned.';
      }
    } else if (msg.kind === 'system_note') {
      flushActions();
      const noteEl = document.createElement('div');
      noteEl.className = 'session-status-banner';
      noteEl.innerHTML = `<span>${escapeHtml(stripEmoji(msg.text || ''))}</span>`;
      conversationFeed.appendChild(noteEl);
    } else if (msg.kind === 'error') {
      flushActions();
      if (!currentAgentMessageEl) createAgentResponseShell();
      if (currentResponseBodyEl) {
        currentResponseBodyEl.innerHTML = `
          <div style="color: var(--accent-red); font-size: 13.5px; line-height: 1.5; padding: 4px 0;">
            <strong>Error:</strong> ${escapeHtml(stripEmoji(msg.text || 'An unexpected error occurred.'))}
          </div>
        `;
      }
    }
  });

  flushActions();
  scrollToBottom();
}

// ============================================================================
// Feed & Message Creation (Borderless Typography Stream)
// ============================================================================
function resetFeed(): void {
  currentRequestId = undefined;
  stopReplyAnimation();
  conversationFeed.innerHTML = '';
  conversationFeed.style.display = 'none';
  emptyState.style.display = 'flex';
  selectPanelSession(null);
  activeSession = null;
  updateHeaderSessionTitle('New Session');
  updateSessionStatusBanner('idle');
  currentAgentMessageEl = null;
  currentProgressEl = null;
  currentActionSummaryEl = null;
  currentResponseBodyEl = null;
  currentConfirmationCardEl = null;
  setRunningState(false);
  updateContrastForMessages(false);
}

function appendUserMessageElement(text: string): void {
  emptyState.style.display = 'none';
  conversationFeed.style.display = 'flex';
  updateContrastForMessages(true);

  const cleanText = stripEmoji(text);
  const userBubble = document.createElement('div');
  userBubble.className = 'message-user';
  userBubble.innerHTML = `
    <span>${escapeHtml(cleanText)}</span>
    <span class="message-user-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
  `;
  conversationFeed.appendChild(userBubble);

  createAgentResponseShell();
}

function createAgentResponseShell(): void {
  stopReplyAnimation();
  const agentShell = document.createElement('div');
  agentShell.className = 'message-agent';
  conversationFeed.appendChild(agentShell);
  currentAgentMessageEl = agentShell;

  const progress = document.createElement('p');
  progress.className = 'thinking-indicator';
  progress.textContent = 'Thinking…';
  progress.setAttribute('role', 'status');
  progress.hidden = !isRunning;
  agentShell.appendChild(progress);
  currentProgressEl = progress;

  const actionSummary = document.createElement('p');
  actionSummary.className = 'action-summary';
  agentShell.appendChild(actionSummary);
  currentActionSummaryEl = actionSummary;

  const responseBody = document.createElement('div');
  responseBody.className = 'gemini-response-body';
  agentShell.appendChild(responseBody);
  currentResponseBodyEl = responseBody;
}

function stopReplyAnimation(): void {
  finishReplyAnimation?.();
  finishReplyAnimation = undefined;
}

function updateAgentProgress(data: AgentUpdateData): void {
  if (!currentAgentMessageEl) return;

  if (currentProgressEl) {
    currentProgressEl.hidden = data.status !== 'running';
    if (data.status === 'running') currentProgressEl.textContent = data.activity || 'Thinking…';
  }

  if (currentActionSummaryEl && data.status !== 'running') {
    currentActionSummaryEl.textContent = summarizeActions((data.logs || []).map(log => ({
      type: log.action.type,
      url: log.action.url,
      success: log.success,
    })));
  }

  if (data.status !== 'waiting_confirmation' && currentConfirmationCardEl) {
    currentConfirmationCardEl.remove();
    currentConfirmationCardEl = null;
  }

  if (data.status === 'idle') {
    currentConfirmationCardEl?.remove();
    currentConfirmationCardEl = null;
    setRunningState(false);
  }

  // 3. Human Confirmation (Inline Line, Single Primary Pill Action)
  if (data.status === 'waiting_confirmation') {
    if (!currentConfirmationCardEl) {
      if (data.chartReply && currentResponseBodyEl) {
        currentResponseBodyEl.innerHTML = renderMarkdown(data.chartReply);
      }
      const confirmRow = document.createElement('div');
      confirmRow.className = 'permission-inline';
      confirmRow.innerHTML = `
        <div class="permission-text-line">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-amber)" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span>${escapeHtml(stripEmoji(data.summary || 'Confirm before proceeding.'))}</span>
        </div>
        <div class="permission-actions">
          <button class="btn-allow-pill" id="btn-confirm-action">Allow once</button>
          <button class="btn-text-action" id="btn-deny-action">Deny</button>
        </div>
      `;
      currentAgentMessageEl.appendChild(confirmRow);
      currentConfirmationCardEl = confirmRow;

      const allowButton = confirmRow.querySelector<HTMLButtonElement>('#btn-confirm-action');
      allowButton?.addEventListener('click', async () => {
        allowButton.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ type: 'CONFIRM_ACTION', approvalId: data.approvalId });
          if (!response?.success) throw new Error(response?.error || 'Could not send approval.');
          if (currentConfirmationCardEl === confirmRow) {
            confirmRow.remove();
            currentConfirmationCardEl = null;
          }
        } catch (error) {
          if (currentConfirmationCardEl !== confirmRow) return;
          const label = confirmRow.querySelector('.permission-text span') ?? confirmRow.querySelector('span');
          if (label) label.textContent = error instanceof Error ? error.message : 'Could not send approval.';
          allowButton.disabled = false;
        }
      });

      confirmRow.querySelector('#btn-deny-action')?.addEventListener('click', () => {
        stopCurrentRun();
        confirmRow.remove();
        currentConfirmationCardEl = null;
        setRunningState(false);
      });
    }
    updateHalftoneColors('waiting');
  }

  if (data.status === 'completed') {
    if (data.summary && currentResponseBodyEl) {
      stopReplyAnimation();
      const progress = currentProgressEl;
      if (progress) { progress.textContent = 'Writing…'; progress.hidden = false; }
      finishReplyAnimation = animateReply(
        currentResponseBodyEl, renderMarkdown(data.summary), chatContainer,
        () => { if (progress) progress.hidden = true; },
      );
    }

    setRunningState(false);
    updateHalftoneColors('completed');
    refreshHistoryList();
    refreshStorageStats();
  }

  if (data.status === 'error') {
    stopReplyAnimation();
    if (currentResponseBodyEl) {
      currentResponseBodyEl.innerHTML = `
        <div style="color: var(--accent-red); font-size: 13.5px; line-height: 1.5; padding: 4px 0;">
          <strong>Error:</strong> ${escapeHtml(stripEmoji(data.error || 'An unexpected error occurred.'))}
        </div>
      `;
    }

    setRunningState(false);
    updateHalftoneColors('error');
  }

  scrollToBottom();
}

// ============================================================================
// Agent Start / Stop
// ============================================================================
async function startAgent(goal: string): Promise<void> {
  const trimmed = stripEmoji(goal).trim();
  if (!trimmed || isRunning) return;

  const revision = sessionViewRevision;
  const requestId = crypto.randomUUID();
  currentRequestId = requestId;
  setRunningState(true);
  appendUserMessageElement(trimmed);
  promptInput.value = '';
  autoResizeInput();

  try {
    const stopping = stopPending;
    try { await stopping; } finally {
      if (stopPending === stopping) stopPending = Promise.resolve();
    }
    if (revision !== sessionViewRevision || currentRequestId !== requestId) return;
    const response = await chrome.runtime.sendMessage({
      type: 'START_AGENT',
      requestId,
      goal: trimmed,
      sessionId: activeSessionId,
      visionEnabled,
      safetyGate,
    });

    if (revision !== sessionViewRevision || currentRequestId !== requestId) return;
    if (response?.success && response.sessionId) {
      selectPanelSession(response.sessionId);
      const selectedRevision = sessionViewRevision;
      chrome.runtime.sendMessage({
        type: 'GET_SESSION_DETAILS',
        sessionId: activeSessionId,
      }).then((res) => {
        if (selectedRevision === sessionViewRevision && res?.session && activeSessionId === res.session.id) {
          activeSession = res.session;
          updateHeaderSessionTitle(res.session.title);
        }
      });
    }

    if (!response?.success) {
      updateAgentProgress({
        status: 'error',
        step: 0,
        logs: [],
        error: response?.error || 'Failed to start agent. Please refresh the page and try again.',
      });
    }
  } catch (err: any) {
    if (revision !== sessionViewRevision || currentRequestId !== requestId) return;
    updateAgentProgress({
      status: 'error',
      step: 0,
      logs: [],
      error: err.message || 'Communication error with background service worker.',
    });
  }
}

// ============================================================================
// Lightbox (Screenshots)
// ============================================================================
function closeLightbox(): void {
  screenshotLightbox.style.display = 'none';
}

lightboxClose.addEventListener('click', closeLightbox);
lightboxBackdrop.addEventListener('click', closeLightbox);

lightboxPrev.addEventListener('click', () => {
  if (currentLightboxIndex > 0) showLightboxIndex(currentLightboxIndex - 1);
});

lightboxNext.addEventListener('click', () => {
  if (currentLightboxIndex < lightboxScreenshots.length - 1) showLightboxIndex(currentLightboxIndex + 1);
});

function showLightboxIndex(idx: number): void {
  currentLightboxIndex = idx;
  const item = lightboxScreenshots[idx];
  if (!item) return;

  lightboxImage.src = item.dataUrl;
  lightboxStepLabel.textContent = `Step ${item.step} Screenshot`;
  lightboxCounter.textContent = `${idx + 1} / ${lightboxScreenshots.length}`;
  lightboxUrl.textContent = item.url || '';
  lightboxTime.textContent = item.ts ? new Date(item.ts).toLocaleTimeString() : '';
  lightboxPrev.disabled = idx === 0;
  lightboxNext.disabled = idx === lightboxScreenshots.length - 1;
}

// ============================================================================
// Storage & Retention
// ============================================================================
async function refreshStorageStats(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STORAGE_STATS' });
  if (res?.success && res.stats) {
    const usedMb = (res.stats.usedBytes / (1024 * 1024)).toFixed(1);
    const quotaMb = (res.stats.quotaBytes / (1024 * 1024)).toFixed(0);
    storageUsageText.textContent = `${usedMb} MB / ${quotaMb} MB (${res.stats.percent}%)`;
    storageProgressFill.style.width = `${Math.min(res.stats.percent, 100)}%`;
  }
}

settingsRetention.addEventListener('change', async () => {
  const days = parseInt(settingsRetention.value, 10);
  await chrome.storage.local.set({ retention_days: days });
});

settingsSendScreenshots.addEventListener('change', async () => {
  visionEnabled = settingsSendScreenshots.checked;
  await chrome.storage.local.set({ smith_send_screenshots: visionEnabled });
});

btnClearAllSessions.addEventListener('click', async () => {
  if (confirm('Are you sure you want to delete all saved sessions and data?')) {
    await chrome.runtime.sendMessage({ type: 'CLEAR_ALL_DATA' });
    resetFeed();
    refreshHistoryList();
    refreshStorageStats();
  }
});

// ============================================================================
// Runtime Message Listener
// ============================================================================
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AGENT_UPDATE') {
    if (!currentRequestId || message.data.requestId !== currentRequestId) return;
    updateAgentProgress(message.data);
  }
  if (message.type === 'SESSION_UPDATED') {
    if (message.session && activeSessionId === message.session.id) {
      activeSession = message.session;
      updateHeaderSessionTitle(message.session.title);
      updateSessionStatusBanner(message.session.status);
    }
    if (historyDrawer.classList.contains('open')) {
      refreshHistoryList();
    }
  }
  if (message.type === 'ANTIGRAVITY_AUTH_CHANGED') {
    checkConnectionStatus();
  }
});

// ============================================================================
// Event Listeners
// ============================================================================
btnSend.addEventListener('click', () => {
  startAgent(promptInput.value);
});

function stopCurrentRun(): void {
  currentRequestId = undefined;
  stopReplyAnimation();
  currentProgressEl?.setAttribute('hidden', '');
  currentConfirmationCardEl?.remove();
  currentConfirmationCardEl = null;
  stopPending = chrome.runtime.sendMessage({ type: 'STOP_AGENT' }).then(response => {
    if (!response?.success) throw new Error(response?.error || 'Could not stop the previous task.');
  });
  void stopPending.catch(error => console.warn('[SidePanel] Stop failed:', error));
  setRunningState(false);
}
btnStop.addEventListener('click', stopCurrentRun);

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    startAgent(promptInput.value);
  }
});

promptInput.addEventListener('input', autoResizeInput);

toggleTurbo.addEventListener('click', () => {
  safetyGate = !safetyGate;
  if (safetyGate) {
    modeText.textContent = 'Review';
    toggleTurbo.title = 'Review Mode: Prompts before entering input';
  } else {
    modeText.textContent = 'Turbo';
    toggleTurbo.title = 'Turbo Mode: Routine actions run automatically. Recognized submissions still ask for review.';
  }
});

btnNewChat.addEventListener('click', () => {
  if (isRunning) {
    stopCurrentRun();
  }
  resetFeed();
});

btnOpenSettings.addEventListener('click', () => {
  settingsDrawer.classList.add('open');
  refreshStorageStats();
});

btnCloseSettings.addEventListener('click', () => {
  settingsDrawer.classList.remove('open');
});

btnRelogin.addEventListener('click', async () => {
  try {
    btnRelogin.textContent = 'Connecting...';
    await chrome.runtime.sendMessage({ type: 'START_ANTIGRAVITY_LOGIN' });
  } finally {
    await checkConnectionStatus();
  }
});

btnLogout.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'ANTIGRAVITY_LOGOUT' });
  checkConnectionStatus();
});

async function checkConnectionStatus(): Promise<void> {
  const data = await chrome.storage.local.get([
    'antigravity_token',
    'retention_days',
    'smith_send_screenshots',
  ]);

  const connected = Boolean(data.antigravity_token);
  document.getElementById('antigravity-account-status')!.textContent = connected ? 'Connected' : 'Signed out';
  btnRelogin.textContent = connected ? 'Reconnect' : 'Sign in';
  btnLogout.hidden = !connected;

  if (typeof data.retention_days === 'number') {
    settingsRetention.value = String(data.retention_days);
  }

  if (typeof data.smith_send_screenshots === 'boolean') {
    visionEnabled = data.smith_send_screenshots;
    settingsSendScreenshots.checked = visionEnabled;
  }
}

// Startup Init
async function initStartup(): Promise<void> {
  initHalftoneAurora();
  initProviderSettings();
  const bridgeToken = document.getElementById('bridge-token') as HTMLInputElement;
  bridgeToken.addEventListener('change', () => {
    void chrome.storage.local.set({ smith_bridge_token: bridgeToken.value.trim() }).then(() => {
      bridgeToken.value = '';
      bridgeToken.placeholder = 'Saved';
    }).catch(console.warn);
  });
  checkConnectionStatus();
  autoResizeInput();
  refreshStorageStats();

  const revision = sessionViewRevision;
  try {
    const saved = await chrome.storage.local.get(PANEL_SESSION_KEY);
    if (revision !== sessionViewRevision) return;
    const selected = saved[PANEL_SESSION_KEY];
    // Explicitly opening a blank chat takes priority over saved transcripts.
    if (selected === null) return;
    if (typeof selected === 'string' && selected) {
      await loadSession(selected);
      return;
    }

    const { activeRun } = (await chrome.storage.session.get('activeRun')) as {
      activeRun?: { sessionId: string };
    };
    if (revision !== sessionViewRevision) return;
    if (activeRun?.sessionId) {
      await loadSession(activeRun.sessionId);
      return;
    }

    const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_SESSIONS' });
    if (revision === sessionViewRevision && res?.success && Array.isArray(res.sessions) && res.sessions.length > 0) {
      await loadSession(res.sessions[0].id);
    }
  } catch (err) {
    console.warn('[SidePanel] Startup restore error:', err);
  }
}

initStartup();
