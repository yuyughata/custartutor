// Past turns -> model messages. Windowed to the newest N messages, starting with a child message (the API wants
// the conversation to open with the user) and with no two messages of the same role in a row (a turn whose
// reply failed leaves two child messages together).
import type { LlmMessage } from '@custar/authoring-core';

export interface HistoryItem {
  role: 'child' | 'tutor';
  text: string;
}

export function windowHistory(history: readonly HistoryItem[], maxMessages: number): HistoryItem[] {
  const usable = history.filter((item) => item.text.trim() !== '');
  const window = maxMessages <= 0 ? [] : usable.slice(-maxMessages);
  while (window.length > 0 && window[0]?.role === 'tutor') window.shift();
  return window;
}

/** History plus the child's new message, as alternating user and assistant messages ending with a user one. */
export function toMessages(history: readonly HistoryItem[], childText: string): LlmMessage[] {
  const items = [
    ...history,
    { role: 'child' as const, text: childText.trim() === '' ? '(no text)' : childText },
  ];
  const messages: LlmMessage[] = [];
  for (const item of items) {
    const role = item.role === 'child' ? 'user' : 'assistant';
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n${item.text}`;
    } else {
      messages.push({ role, content: item.text });
    }
  }
  return messages;
}
