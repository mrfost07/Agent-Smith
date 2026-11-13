import { storedAssistantReply } from '../shared/chat-reply';
import type { StoredMessage } from '../shared/types';

const MAX_TRANSCRIPT = 6500;
const COMMON_WORDS = new Set('about after again also and are can could for from have how just last please previous show tell that the their them then there these this those was were what when where which who will with would you your'.split(' '));

export type PlanningMode = 'chat' | 'route' | 'page' | 'research' | 'browser';

export function excerpt(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const head = Math.floor((limit - 5) * 0.7);
  return text.slice(0, head) + ' … ' + text.slice(-(limit - head - 5));
}

function keywords(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !COMMON_WORDS.has(word)));
}

export function relevance(words: ReadonlySet<string>, text: string): number {
  let score = 0;
  for (const word of keywords(text)) {
    if (words.has(word)) score++;
  }
  return score;
}

export function quickChatReply(goal: string): string | undefined {
  const greeting = goal.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  if (/^(?:hi|hey|hello)(?:,? (?:agent )?smith| there)?$/.test(greeting)) return 'Hi! How can I help?';
  if (/^(?:good morning|good afternoon|good evening)$/.test(greeting)) {
    return greeting[0].toUpperCase() + greeting.slice(1) + '! How can I help?';
  }
  if (/^(?:kumusta|kamusta)(?: ka)?$/.test(greeting)) return 'Mabuti naman. Paano kita matutulungan?';
  if (/^(?:thanks|thank you)(?:,? (?:agent )?smith)?$/.test(greeting)) return 'You’re welcome.';
  return undefined;
}

export function disallowsBrowsing(goal: string): boolean {
  return /\b(?:without|no)\s+(?:web\s+)?(?:browsing|searching|browser(?:\s+use)?|web\s+search)\b|\b(?:do\s+not|don['’]t|never|please\s+avoid)\s+(?:browse|search(?:\s+(?:the\s+)?(?:web|online|internet))?|use\s+(?:the\s+)?browser|open\s+(?:any\s+|a\s+|new\s+)?tabs?)\b|\bchat[- ]only\b/i.test(goal);
}

export function requiresWebResearch(goal: string): boolean {
  if (/\b(?:this|current|active) (?:page|tab|site|website)\b|\b(?:on|in) (?:this|my) (?:page|tab)\b/i.test(goal)) return false;
  if (disallowsBrowsing(goal)) return false;
  if (/^(?:please\s+)?(?:what(?:'s| is| are)|who(?:'s| is)|how much is|show me|tell me)\b[^.!?\n]{0,120}\b(?:latest|current|today['’]s)\s+(?:news|headlines?|prices?|exchange rates?|weather|scores?|versions?|releases?)\b/i.test(goal)) return true;
  return /\b(?:search|browse|research)\s+(?:on\s+)?(?:the\s+)?(?:web|internet|online)\b/i.test(goal) ||
    /\b(?:find|look|research|search|verify|check)\b[^.!?\n]{0,180}\b(?:online|(?:in|on|using|via)\s+(?:the\s+)?(?:web|internet|browser))\b(?!\s+(?:history|settings|tabs|bookmarks))/i.test(goal);
}

export function startsWithPageAction(goal: string): boolean {
  return /^(?:please\s+)?(?:click|tap|press|scroll|hover|drag)\s+/i.test(goal.trim()) ||
    /^(?:please\s+)?play\s+(?:this\s+game|(?:the\s+)?chess)\b/i.test(goal.trim());
}

export function explicitlyRequestsPage(goal: string): boolean {
  return /^(?:please\s+)?(?:use|look (?:at|in)|go (?:to|into)|check|inspect|open)\s+(?:(?:the|this|my)\s+)?(?:browser|(?:active|current|open)\s+tab)\b/i.test(goal.trim());
}

export function pageKeywords(goal: string, transcript: string): ReadonlySet<string> {
  const words = keywords(goal);
  return words.size > 3 ? words : keywords(goal + ' ' + transcript.slice(-1400));
}

export function browserUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (/token|password|secret|session|credential|signature|^key$|^code$|^state$/i.test(name)) {
        url.searchParams.delete(name);
      }
    }
    return url.href.length <= 550 ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function sessionContext(messages: StoredMessage[], goal: string): string {
  const ordered = messages;
  const turns = ordered.filter((message): message is StoredMessage & { text: string } =>
    message.kind === 'user' ? Boolean(message.text?.trim()) :
      message.kind === 'assistant' && Boolean(storedAssistantReply(message)));
  let priorUser = turns.length - 1;
  while (priorUser >= 0 && turns[priorUser].kind !== 'user') priorUser--;
  const words = keywords(goal);
  if (words.size < 4 && priorUser >= 0) {
    for (const word of keywords(turns[priorUser].text)) words.add(word);
  }

  const selected = new Map<number, string>();
  let remaining = MAX_TRANSCRIPT;
  const include = (index: number, limit: number) => {
    if (index < 0 || selected.has(index)) return;
    const turn = turns[index];
    const entry = JSON.stringify({ role: turn.kind, text: excerpt(turn.text, limit) });
    if (entry.length + 1 > remaining) return;
    selected.set(index, entry);
    remaining -= entry.length + 1;
  };

  // Preserve the immediate exchange, then reserve room for older constraints and relevant requests.
  include(priorUser, 1350);
  for (let index = turns.length - 1; index >= Math.max(0, turns.length - 6); index--) {
    include(index, turns[index].kind === 'user' ? 740 : 600);
  }
  if (turns.length > 6) {
    const relevant = turns.slice(0, -6).map((turn, index) => ({
      index,
      score: relevance(words, turn.text) * (turn.kind === 'user' ? 2 : 1),
    })).filter(turn => turn.score > 0).sort((a, b) => b.score - a.score || b.index - a.index);
    for (const { index } of relevant.slice(0, 4)) include(index, 480);
    include(0, 420);
    for (let index = turns.length - 7; index >= Math.max(0, turns.length - 14); index--) include(index, 420);
  }

  const evidence = ordered.filter(message => message.kind === 'step' && message.step).slice(-4).map(message => {
    const step = message.step!;
    const args = step.args as { url?: string } | undefined;
    return { action: step.tool, ok: step.result.ok, page: browserUrl(args?.url ?? step.url) };
  });

  return [
    'Earlier messages (chronological excerpts):',
    ...[...selected].sort(([a], [b]) => a - b).map(([, entry]) => entry),
    'Recent recorded browser outcomes from earlier turns:',
    ...evidence.map(entry => JSON.stringify(entry)),
  ].join('\n');
}
