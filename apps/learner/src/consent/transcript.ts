import type { TutorSessionSummary, TutorTranscriptMessage } from '@custar/tutor-core/client';

/** What the grown-ups transcript shows for a part that is held back for review. No reason, no category. */
export const WITHHELD_PLACEHOLDER = 'This message is not shown right now.';
export const WITHHELD_NOTE = 'A CUSTAR reviewer is looking at this part.';

export interface TranscriptLine {
  id: string;
  role: 'child' | 'tutor';
  text: string;
  withheld: boolean;
  /** The short line under a withheld message. */
  note: string | null;
  createdAt: string;
}

/**
 * Turns the server's messages into what to show. A withheld message is shown with our own neutral
 * placeholder, never with the `text` the server sent: even a mistake on the server cannot leak a held turn.
 */
export function transcriptLines(messages: readonly TutorTranscriptMessage[]): TranscriptLine[] {
  return [...messages]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.withheld ? WITHHELD_PLACEHOLDER : message.text,
      withheld: message.withheld,
      note: message.withheld ? WITHHELD_NOTE : null,
      createdAt: message.created_at,
    }));
}

export interface SessionLine {
  id: string;
  title: string;
  startedAt: string;
  turns: number;
  hasWithheld: boolean;
}

/** Newest first. `unitTitle` finds the lesson name on this device; a lesson that is not here is just "A lesson". */
export function sessionLines(
  sessions: readonly TutorSessionSummary[],
  unitTitle: (unitId: string) => string | null,
): SessionLine[] {
  return [...sessions]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map((session) => ({
      id: session.id,
      title: unitTitle(session.unit_id) ?? 'A lesson',
      startedAt: session.started_at,
      turns: session.turns,
      hasWithheld: session.has_withheld,
    }));
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
