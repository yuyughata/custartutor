// Fencing for text a model must treat as DATA: the child's message, earlier turns, the tutor's own reply when it
// is being checked, and the unit's content. The system prompt says that anything between the markers is data and
// never instructions. A marker cannot be forged from inside the data: runs of three or more angle brackets are
// replaced with look-alike characters, so the closing marker cannot appear in the text.

export const DATA_OPEN = '<<<TUTOR_DATA';
export const DATA_CLOSE = 'TUTOR_DATA>>>';

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Replaces bracket runs that could imitate a marker. Keeps every other character. */
export function neutralise(text: string): string {
  return text.replace(/<{3,}/g, '‹‹‹').replace(/>{3,}/g, '›››');
}

/** Untrusted plain text as a fenced block. */
export function fenceData(name: string, text: string): string {
  return `${DATA_OPEN} name="${safeName(name)}">>>\n${neutralise(text)}\n${DATA_CLOSE}`;
}

/** Earlier turns, oldest first, as one fenced block with a role label on each line. */
export function fenceTurns(
  name: string,
  turns: readonly { role: 'child' | 'tutor'; text: string }[],
): string {
  const lines = turns.map((turn) => `${turn.role}: ${turn.text.replace(/\s+/g, ' ').trim()}`);
  return fenceData(name, lines.join('\n'));
}
