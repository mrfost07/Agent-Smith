/**
 * PilotPanel: Inter-Process Communication Contract
 * Single typed Message union connecting background, sidepanel, content script, and options.
 */

import {
  AgentMode,
  AgentStatus,
  ChatMessage,
  PilotPanelSettings,
  PermissionRequest,
  PlanProposal,
  StepCardData,
} from './types';

export type BackgroundToSidepanelMessage =
  | { type: 'STATE_UPDATE'; status: AgentStatus; mode: AgentMode; activeGoal?: string }
  | { type: 'CHAT_MESSAGE_ADDED'; message: ChatMessage }
  | { type: 'CHAT_MESSAGE_STREAM'; messageId: string; delta: string }
  | { type: 'STEP_CARD_ADDED'; messageId: string; step: StepCardData }
  | { type: 'STEP_CARD_UPDATED'; stepId: string; update: Partial<StepCardData> }
  | { type: 'PERMISSION_REQUESTED'; request: PermissionRequest }
  | { type: 'PLAN_PROPOSED'; plan: PlanProposal }
  | { type: 'AGENT_ERROR'; error: string };

export type SidepanelToBackgroundMessage =
  | { type: 'START_GOAL'; goal: string; mode: AgentMode }
  | { type: 'STOP_GOAL' }
  | { type: 'PAUSE_GOAL' }
  | { type: 'RESUME_GOAL' }
  | { type: 'RESOLVE_PERMISSION'; requestId: string; approved: boolean; rememberAlways?: boolean }
  | { type: 'RESOLVE_PLAN'; approved: boolean; editedPlan?: PlanProposal }
  | { type: 'GET_STATE' }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<PilotPanelSettings> }
  | { type: 'CLEAR_HISTORY' };

export type ContentToBackgroundMessage =
  | { type: 'DOM_SETTLED'; url: string }
  | { type: 'STOP_CLICKED_IN_PAGE' };

export type BackgroundToContentMessage =
  | { type: 'SET_OVERLAY_VISIBLE'; visible: boolean }
  | { type: 'SHOW_STOP_PILL'; visible: boolean }
  | { type: 'CLEANUP_OVERLAY' }
  | { type: 'READ_PAGE'; filter?: 'interactive' | 'all'; refId?: string; maxDepth?: number; maxChars?: number }
  | { type: 'GET_PAGE_TEXT' }
  | { type: 'GET_PAGE_DIMENSIONS' }
  | { type: 'GET_REF_BOUNDS'; ref: string };

export type AppMessage =
  | BackgroundToSidepanelMessage
  | SidepanelToBackgroundMessage
  | ContentToBackgroundMessage
  | BackgroundToContentMessage;
