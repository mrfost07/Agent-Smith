/**
 * PilotPanel: System Constants & Default Configurations
 */

import { PilotPanelSettings } from './types';

export const STORAGE_KEYS = {
  SETTINGS: 'pilotpanel_settings',
  SESSION_STATE: 'pilotpanel_session_state',
  CHAT_HISTORY: 'pilotpanel_chat_history',
  DOMAIN_PERMISSIONS: 'pilotpanel_domain_permissions',
} as const;

export const DEFAULT_SETTINGS: PilotPanelSettings = {
  apiKey: '',
  modelId: 'gemini-2.5-flash',
  maxSteps: 40,
  defaultMode: 'ask',
  javascriptAllowed: false,
  customBridgeUrl: 'http://127.0.0.1:51121',
  domainAllowlist: [],
  domainBlocklist: [],
};

export const PERCEPTION_LIMITS = {
  MAX_TREE_CHARS: 50000,
  MAX_TREE_DEPTH: 15,
  MAX_SCREENSHOT_DIMENSION: 1568,
  FIND_MAX_RESULTS: 20,
  PAGE_SETTLE_IDLE_MS: 500,
  PAGE_SETTLE_TIMEOUT_MS: 1500,
  MAX_LOOP_REPEATS_HINT: 3,
  MAX_LOOP_REPEATS_ABORT: 5,
} as const;

export const ALWAYS_CONFIRM_ACTIONS = [
  'payment',
  'purchase',
  'checkout',
  'transfer',
  'delete',
  'remove',
  'password',
  'credentials',
  'email_send',
  'message_send',
  'government',
  'financial',
] as const;

export const UNTRUSTED_TAGS = {
  START: '<untrusted_page_content>',
  END: '</untrusted_page_content>',
} as const;
