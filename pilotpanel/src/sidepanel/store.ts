/**
 * PilotPanel: Sidepanel UI State Store (Zustand)
 * Manages conversation history, step cards, agent status, and active mode.
 */

import { create } from 'zustand';
import { AgentMode, AgentStatus, ChatMessage, PilotPanelSettings, StepCardData } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';

interface SidepanelState {
  messages: ChatMessage[];
  status: AgentStatus;
  mode: AgentMode;
  settings: PilotPanelSettings;
  activeGoal: string;
  addMessage: (msg: ChatMessage) => void;
  appendStreamContent: (msgId: string, delta: string) => void;
  addStepCard: (messageId: string, card: StepCardData) => void;
  updateStepCard: (cardId: string, update: Partial<StepCardData>) => void;
  setStatus: (status: AgentStatus) => void;
  setMode: (mode: AgentMode) => void;
  setSettings: (settings: PilotPanelSettings) => void;
  setActiveGoal: (goal: string) => void;
  clearMessages: () => void;
}

export const useStore = create<SidepanelState>((set) => ({
  messages: [],
  status: 'idle',
  mode: 'ask',
  settings: DEFAULT_SETTINGS,
  activeGoal: '',

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  appendStreamContent: (msgId, delta) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === msgId ? { ...m, content: m.content + delta } : m
      ),
    })),

  addStepCard: (messageId, card) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id === messageId) {
          const cards = m.stepCards ? [...m.stepCards, card] : [card];
          return { ...m, stepCards: cards };
        }
        return m;
      }),
    })),

  updateStepCard: (cardId, update) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (!m.stepCards) return m;
        return {
          ...m,
          stepCards: m.stepCards.map((c) => (c.id === cardId ? { ...c, ...update } : c)),
        };
      }),
    })),

  setStatus: (status) => set({ status }),

  setMode: (mode) => set({ mode }),

  setSettings: (settings) => set({ settings }),

  setActiveGoal: (activeGoal) => set({ activeGoal }),

  clearMessages: () => set({ messages: [], activeGoal: '', status: 'idle' }),
}));
