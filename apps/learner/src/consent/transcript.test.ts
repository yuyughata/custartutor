import { describe, expect, it } from 'vitest';
import type { TutorSessionSummary, TutorTranscriptMessage } from '@custar/tutor-core/client';
import {
  WITHHELD_NOTE,
  WITHHELD_PLACEHOLDER,
  formatWhen,
  sessionLines,
  transcriptLines,
} from './transcript';

const message = (
  id: string,
  role: 'child' | 'tutor',
  text: string,
  at: string,
  withheld = false,
): TutorTranscriptMessage => ({ id, role, text, created_at: at, withheld });

describe('transcriptLines', () => {
  it('orders messages by time and keeps visible text as it is', () => {
    const lines = transcriptLines([
      message('2', 'tutor', 'A fish lives in water.', '2026-10-12T08:01:00Z'),
      message('1', 'child', 'Where does a fish live?', '2026-10-12T08:00:00Z'),
    ]);
    expect(lines.map((l) => [l.role, l.text, l.withheld, l.note])).toEqual([
      ['child', 'Where does a fish live?', false, null],
      ['tutor', 'A fish lives in water.', false, null],
    ]);
  });

  it('keeps the server order for messages with the same time or an unreadable one', () => {
    const lines = transcriptLines([
      message('a', 'child', 'one', '2026-10-12T08:00:00Z'),
      message('b', 'tutor', 'two', '2026-10-12T08:00:00Z'),
      message('c', 'child', 'three', 'not a time'),
      message('d', 'tutor', 'four', '2026-10-12T08:00:00Z'),
    ]);
    expect(lines.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shows ONLY a neutral placeholder for a withheld message, never the text the server sent', () => {
    const lines = transcriptLines([
      message(
        '1',
        'child',
        'SECRET WORDS THE SERVER SHOULD NOT HAVE SENT',
        '2026-10-12T08:00:00Z',
        true,
      ),
      message('2', 'tutor', 'Another secret', '2026-10-12T08:00:01Z', true),
    ]);
    for (const line of lines) {
      expect(line.text).toBe(WITHHELD_PLACEHOLDER);
      expect(line.note).toBe(WITHHELD_NOTE);
      expect(JSON.stringify(line)).not.toMatch(/SECRET|secret/);
    }
  });

  it('does not explain or hint at why a part is withheld', () => {
    expect(`${WITHHELD_PLACEHOLDER} ${WITHHELD_NOTE}`).not.toMatch(
      /safe|harm|abuse|danger|upset|distress|flag|risk|worr|concern|report/i,
    );
    expect(WITHHELD_NOTE).toBe('A CUSTAR reviewer is looking at this part.');
  });
});

describe('sessionLines', () => {
  const sessions: TutorSessionSummary[] = [
    { id: 's1', unit_id: 'u1', started_at: '2026-10-11T08:00:00Z', turns: 3, has_withheld: false },
    { id: 's2', unit_id: 'u2', started_at: '2026-10-12T08:00:00Z', turns: 5, has_withheld: true },
  ];

  it('lists the newest first and names the lesson when it is on this phone', () => {
    const lines = sessionLines(sessions, (id) => (id === 'u1' ? 'Our Environment' : null));
    expect(lines.map((l) => [l.id, l.title, l.hasWithheld])).toEqual([
      ['s2', 'A lesson', true],
      ['s1', 'Our Environment', false],
    ]);
  });
});

describe('formatWhen', () => {
  it('formats a date and survives a bad one', () => {
    expect(formatWhen('2026-10-12T08:05:00Z')).toMatch(/2026/);
    expect(formatWhen('not a date')).toBe('');
  });
});
