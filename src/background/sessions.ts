/**
 * Session Lifecycle Manager (Background)
 * Manages creation, autosave, status transitions, recovery on worker restart,
 * branching, and export of Agent Smith sessions.
 */

import {
  Session,
  StoredMessage,
  SessionStatus,
  ActiveRunState,
  Permission,
} from '../shared/types';
import {
  saveSession,
  editSession,
  appendSessionMessage,
  getSession,
  getAllSessions,
  saveMessage,
  getSessionMessages,
  deleteSessionFull,
  saveModelContext,
  getModelContext,
  cleanupExpiredSessions,
} from '../shared/db';
import { CDPController } from './cdp-controller';
import { runOperation } from './run-operation';

export class SessionManager {
  private static instance: SessionManager;
  private currentSessionId: string | null = null;
  private statusWrites: Promise<unknown> = Promise.resolve();

  static getInstance(): SessionManager {
    if (!this.instance) {
      this.instance = new SessionManager();
    }
    return this.instance;
  }

  /**
   * Recovers interrupted runs on service worker startup.
   */
  async initOnStartup(): Promise<void> {
    try {
      // 1. Check activeRun in chrome.storage.session
      const { activeRun } = (await chrome.storage.session.get('activeRun')) as {
        activeRun?: ActiveRunState;
      };

      // Session storage can disappear on browser shutdown. IndexedDB is the fallback.
      for (const session of await getAllSessions()) {
        if (session.status === 'running' || session.status.startsWith('awaiting_')) {
          console.warn('[SessionManager] Detected interrupted session from previous run:', session.id);
          session.status = 'interrupted';
          session.updatedAt = Date.now();
          await saveSession(session);

          // Append system note
          await this.appendMessage(session.id, {
            kind: 'system_note',
            text: 'Run was interrupted by browser or service worker restart. Send a message to continue.',
          });

        }
      }
      if (activeRun?.tabId !== undefined) {
        const tabId = activeRun.tabId;
        await Promise.allSettled([
          runOperation(() => chrome.tabs.sendMessage(tabId, { type: 'CLEAR_BADGES' }, { frameId: 0 }), 1000, 'Clearing interrupted task'),
          CDPController.detach(tabId, true),
        ]);
        await chrome.storage.session.remove('activeRun');
      }

      // 2. Retention cleanup (default 90 days)
      const { retention_days } = await chrome.storage.local.get(['retention_days']);
      const days = typeof retention_days === 'number' ? retention_days : 90;
      await cleanupExpiredSessions(days).catch(() => {});
    } catch (err) {
      console.warn('[SessionManager] initOnStartup error:', err);
    }
  }

  /**
   * Creates a new session on the first user message.
   */
  async createSession(goal: string, tabId?: number, startUrl?: string): Promise<Session> {
    const id = crypto.randomUUID();
    const now = Date.now();

    // Auto-generate title from first 6-8 words of the goal
    const words = goal.trim().split(/\s+/);
    const initialTitle = words.slice(0, 7).join(' ') || 'New Session';

    let domain = '';
    if (startUrl) {
      try {
        domain = new URL(startUrl).hostname;
      } catch {}
    }

    const session: Session = {
      id,
      title: initialTitle,
      titleSource: 'auto',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      pinned: false,
      archived: false,
      mode: 'auto',
      goal,
      tabIds: tabId === undefined ? [] : [tabId],
      startUrl,
      domains: domain ? [domain] : [],
      stepCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      sessionGrants: [],
      schemaVersion: 1,
    };

    await saveSession(session);
    this.currentSessionId = id;

    // Broadcast session created
    this.broadcastUpdate('SESSION_CREATED', session);
    return session;
  }

  /**
   * Sets the active session ID.
   */
  setActiveSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  getActiveSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Appends a message immediately to IndexedDB (seq increments).
   */
  async appendMessage(
    sessionId: string,
    data: {
      kind: StoredMessage['kind'];
      text?: string;
      source?: StoredMessage['source'];
      thought?: string;
      step?: StoredMessage['step'];
      permission?: StoredMessage['permission'];
    }
  ): Promise<StoredMessage> {
    const msg: StoredMessage = {
      id: crypto.randomUUID(),
      sessionId,
      seq: 0,
      ts: Date.now(),
      kind: data.kind,
      text: data.text,
      source: data.source,
      thought: data.thought,
      step: data.step,
      permission: data.permission,
    };

    const session = await appendSessionMessage(msg);
    this.broadcastUpdate('SESSION_UPDATED', session);

    // Broadcast message appended to sidepanel/UI
    this.broadcastUpdate('MESSAGE_APPENDED', { sessionId, message: msg });
    return msg;
  }

  /**
   * Updates session status and persists transition immediately.
   */
  updateStatus(sessionId: string, status: SessionStatus, summary?: string, tabId?: number): Promise<void> {
    // Serialize the record and its recovery marker, including Stop and a replacement run.
    const write = this.statusWrites.then(() => this.writeStatus(sessionId, status, summary, tabId));
    this.statusWrites = write.catch(() => {});
    return write;
  }

  private async writeStatus(sessionId: string, status: SessionStatus, summary?: string, tabId?: number): Promise<void> {
    const session = await editSession(sessionId, current => {
      current.status = status;
      current.updatedAt = Date.now();
      if (summary) current.summary = summary;
    });
    if (!session) return;

    const { activeRun } = await chrome.storage.session.get('activeRun') as { activeRun?: ActiveRunState };
    if (status === 'running' && tabId !== undefined) {
      await chrome.storage.session.set({ activeRun: {
        sessionId, tabId, startedAt: activeRun?.sessionId === sessionId ? activeRun.startedAt : Date.now(),
      } });
    } else if (activeRun?.sessionId === sessionId && ['completed', 'stopped', 'failed', 'interrupted'].includes(status)) {
      await chrome.storage.session.remove('activeRun');
    }

    this.broadcastUpdate('SESSION_UPDATED', session);
  }

  /**
   * Updates visited domains for this session.
   */
  async recordDomain(sessionId: string, url: string): Promise<void> {
    try {
      const domain = new URL(url).hostname;
      if (!domain) return;

      const session = await editSession(sessionId, current => {
        if (!current.domains.includes(domain)) {
          current.domains.push(domain);
          current.updatedAt = Date.now();
        }
      });
      if (session) this.broadcastUpdate('SESSION_UPDATED', session);
    } catch {}
  }

  /**
   * Renames a session. Marks titleSource as "user" so auto-titler never overwrites it.
   */
  async renameSession(sessionId: string, newTitle: string): Promise<Session | null> {
    const session = await editSession(sessionId, current => {
      current.title = newTitle.trim() || current.title;
      current.titleSource = 'user';
      current.updatedAt = Date.now();
    });
    if (!session) return null;

    this.broadcastUpdate('SESSION_UPDATED', session);
    return session;
  }

  /**
   * Auto-titles session with a smart 3-6 word summary after first reply.
   */
  async autoTitle(sessionId: string, smartTitle: string): Promise<void> {
    const session = await getSession(sessionId);
    if (!session || session.titleSource === 'user') return;

    session.title = smartTitle.trim();
    session.updatedAt = Date.now();
    await saveSession(session);
    this.broadcastUpdate('SESSION_UPDATED', session);
  }

  /**
   * Pins or unpins a session.
   */
  async togglePin(sessionId: string): Promise<boolean> {
    const session = await editSession(sessionId, current => {
      current.pinned = !current.pinned;
      current.updatedAt = Date.now();
    });
    if (!session) return false;
    this.broadcastUpdate('SESSION_UPDATED', session);
    return session.pinned;
  }

  /**
   * Archives or unarchives a session.
   */
  async toggleArchive(sessionId: string): Promise<boolean> {
    const session = await editSession(sessionId, current => {
      current.archived = !current.archived;
      current.updatedAt = Date.now();
    });
    if (!session) return false;
    this.broadcastUpdate('SESSION_UPDATED', session);
    return session.archived;
  }

  /**
   * Branches session up to a specific message sequence into a new session.
   */
  async branchSession(sessionId: string, upToSeq: number): Promise<Session | null> {
    const parent = await getSession(sessionId);
    if (!parent) return null;

    const allMessages = await getSessionMessages(sessionId);
    const branchMessages = allMessages.filter((m) => m.seq <= upToSeq);

    const newId = crypto.randomUUID();
    const now = Date.now();

    const branchedSession: Session = {
      ...parent,
      id: newId,
      title: `${parent.title} (Branch)`,
      titleSource: 'user',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      stepCount: branchMessages.filter((m) => m.kind === 'step').length,
    };

    await saveSession(branchedSession);

    // Copy messages
    for (const m of branchMessages) {
      await saveMessage({
        ...m,
        id: crypto.randomUUID(),
        sessionId: newId,
      });
    }

    this.broadcastUpdate('SESSION_CREATED', branchedSession);
    return branchedSession;
  }

  /**
   * Exports session as Markdown transcript.
   */
  async exportAsMarkdown(sessionId: string): Promise<string> {
    const session = await getSession(sessionId);
    if (!session) throw new Error('Session not found.');

    const messages = await getSessionMessages(sessionId);

    let md = `# ${session.title}\n\n`;
    md += `- **Date**: ${new Date(session.createdAt).toLocaleString()}\n`;
    md += `- **Status**: ${session.status}\n`;
    md += `- **Goal**: ${session.goal}\n`;
    if (session.domains.length > 0) {
      md += `- **Domains**: ${session.domains.join(', ')}\n`;
    }
    if (session.summary) {
      md += `- **Summary**: ${session.summary}\n`;
    }
    md += `\n---\n\n## Transcript\n\n`;

    for (const msg of messages) {
      const timeStr = new Date(msg.ts).toLocaleTimeString();
      if (msg.kind === 'user') {
        md += `### User (${timeStr})\n\n${msg.text}\n\n`;
      } else if (msg.kind === 'assistant') {
        if (msg.thought) {
          md += `> *Thought: ${msg.thought}*\n\n`;
        }
        md += `${msg.text}\n\n`;
      } else if (msg.kind === 'step' && msg.step) {
        md += `**[Step ${msg.seq}] ${msg.step.summary || msg.step.tool}**\n`;
        if (msg.step.result.content) {
          md += `Result: \`${msg.step.result.content}\`\n\n`;
        }
      } else if (msg.kind === 'system_note') {
        md += `*Note: ${msg.text}*\n\n`;
      }
    }

    return md;
  }

  /**
   * Exports full session as JSON.
   */
  async exportAsJson(sessionId: string): Promise<string> {
    const session = await getSession(sessionId);
    if (!session) throw new Error('Session not found.');

    const messages = await getSessionMessages(sessionId);
    return JSON.stringify({ session, messages }, null, 2);
  }

  private broadcastUpdate(type: string, data: any): void {
    chrome.runtime.sendMessage(type === 'SESSION_UPDATED' ? { type, session: data } : { type, data }).catch(() => {
      // Panel might not be active, perfectly fine
    });
  }
}
