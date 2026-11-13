/**
 * Shared Type Definitions for Sessions, Messages, and Storage
 */

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'awaiting_user'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'interrupted';

export interface Permission {
  type: string;
  domain: string;
  decision: 'once' | 'always' | 'denied' | 'pending';
}

export interface Session {
  id: string;                 // uuid
  title: string;              // auto-generated, user-editable
  titleSource: 'auto' | 'user';
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  pinned: boolean;
  archived: boolean;
  mode: 'ask' | 'plan' | 'auto';
  goal: string;               // first user message
  tabGroupId?: number;        // live browser tab group, if still open
  tabIds: number[];           // agent-controlled tabs
  startUrl?: string;
  domains: string[];          // every domain visited
  stepCount: number;
  tokensIn: number;
  tokensOut: number;
  summary?: string;           // 1–2 line result, written when the run ends
  plan?: { domains: string[]; approach: string[]; approved: boolean };
  sessionGrants: Permission[]; // "allow once" grants scoped to this session
  schemaVersion: number;
}

export type MessageKind =
  | 'user'
  | 'assistant'
  | 'step'
  | 'permission'
  | 'plan'
  | 'error'
  | 'system_note';

export interface StoredMessage {
  id: string;
  sessionId: string;
  seq: number;
  ts: number;
  kind: MessageKind;
  text?: string;
  source?: 'active_chart' | 'active_chart_trade';
  thought?: string;
  step?: {
    tool: string;
    args: unknown;
    result: { ok: boolean; content: string };
    summary: string;
    durationMs: number;
    screenshotId?: string;
    url?: string;
  };
  permission?: {
    type: string;
    domain: string;
    decision: 'once' | 'always' | 'denied' | 'pending';
  };
}

export interface StoredImage {
  id: string;
  sessionId: string;
  blob: Blob | string; // Blob or base64 dataUrl
  thumb: Blob | string; // small JPEG thumbnail (max 320px)
  w: number;
  h: number;
  ts: number;
}

export interface ActiveRunState {
  sessionId: string;
  tabId: number;
  startedAt: number;
  stopRequested?: boolean;
}

export interface SessionFilter {
  query?: string;
  status?: 'all' | 'running' | 'completed' | 'failed' | 'pinned' | 'archived';
}
