/**
 * PilotPanel: Core Type Definitions
 * Strict types across background, UI, and content layers.
 */

export type AgentMode = 'ask' | 'plan' | 'auto';

export type AgentStatus =
  | 'idle'
  | 'planning'
  | 'observing'
  | 'thinking'
  | 'acting'
  | 'verifying'
  | 'waiting_confirmation'
  | 'stopped'
  | 'completed'
  | 'error';

export type PermissionType =
  | 'NAVIGATE'
  | 'READ'
  | 'CLICK'
  | 'TYPE'
  | 'UPLOAD'
  | 'JAVASCRIPT'
  | 'PLAN_APPROVAL'
  | 'DOMAIN_TRANSITION';

export interface PermissionRequest {
  id: string;
  type: PermissionType;
  domain: string;
  details: string;
  timestamp: number;
}

export interface PlanProposal {
  domains: string[];
  approach: string[];
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  content: T;
  error?: string;
}

export interface StepCardData {
  id: string;
  stepNumber: number;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  screenshotThumb?: string;
  durationMs?: number;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  stepCards?: StepCardData[];
  plan?: PlanProposal;
  permissionRequest?: PermissionRequest;
}

export interface ViewportScale {
  viewportWidth: number;
  viewportHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  dpr: number;
}

export interface ElementNode {
  ref: string;
  role: string;
  name: string;
  attributes: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface FindResultItem {
  ref: string;
  role: string;
  name: string;
  x: number;
  y: number;
  reason: string;
}

export interface PilotPanelSettings {
  apiKey: string;
  modelId: string;
  maxSteps: number;
  defaultMode: AgentMode;
  javascriptAllowed: boolean;
  customBridgeUrl: string;
  domainAllowlist: string[];
  domainBlocklist: string[];
}
