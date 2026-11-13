import type { StoredMessage } from './types';

export function storedAssistantReply(message: StoredMessage): string | undefined {
  const reply = message.text?.trim();
  return reply && reply !== message.thought?.trim() ? reply : undefined;
}
