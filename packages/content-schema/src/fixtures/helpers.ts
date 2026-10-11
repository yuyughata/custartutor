import type { Block } from '../blocks';
import type { TutorNode } from '../tutor-script';

/** Small builders that keep the fixtures readable. Not part of the public API. */

export function para(text: string): Block {
  return { type: 'paragraph', text };
}

export function bullets(...items: (string | { lead: string; text: string })[]): Block {
  return {
    type: 'bullets',
    items: items.map((item) => (typeof item === 'string' ? { text: item } : item)),
  };
}

export function illustration(brief: string, alt: string): Block {
  return { type: 'illustration', brief, alt };
}

export function callout(tone: 'info' | 'tip' | 'not_yet', text: string): Block {
  return { type: 'callout', tone, text };
}

export function ask(question_id: string): Block {
  return { type: 'question', question_id };
}

export function example(label: string, text: string): Block {
  return { type: 'example', label, text };
}

export function steps(...items: [label: string, text: string][]): Block {
  return { type: 'activity_steps', steps: items.map(([label, text]) => ({ label, text })) };
}

export function node(
  id: string,
  say: string,
  extra: Partial<Omit<TutorNode, 'id' | 'say'>> = {},
): TutorNode {
  return { id, say, on_correct: [], on_incorrect: [], hint: [], ...extra };
}
