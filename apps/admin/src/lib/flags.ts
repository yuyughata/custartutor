// Flags are advisory notes for the human reviewer (scheme extraction, chapter plan, unit review). Sorting and
// grouping live here so every screen lists them the same way: concerns first, then notes.
import type { Flag } from '@custar/authoring-core';

const SEVERITY_ORDER: Record<Flag['severity'], number> = { concern: 0, note: 1 };

export function sortFlags(flags: readonly Flag[]): Flag[] {
  return flags
    .map((flag, index) => ({ flag, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.flag.severity] - SEVERITY_ORDER[b.flag.severity] ||
        (a.flag.week_no ?? 99) - (b.flag.week_no ?? 99) ||
        a.index - b.index,
    )
    .map((entry) => entry.flag);
}

export function countFlags(flags: readonly Flag[]): { concerns: number; notes: number } {
  const concerns = flags.filter((flag) => flag.severity === 'concern').length;
  return { concerns, notes: flags.length - concerns };
}

export function flagsForWeek(flags: readonly Flag[], weekNo: number): Flag[] {
  return sortFlags(flags.filter((flag) => flag.week_no === weekNo));
}

export function severityLabel(severity: Flag['severity']): string {
  return severity === 'concern' ? 'Concern' : 'Note';
}

/** `code` -> "Reading level" (the engine uses snake_case codes such as `reading_level`). */
export function flagCodeLabel(code: string): string {
  const spaced = code.replace(/[_-]+/g, ' ').trim();
  return spaced === '' ? code : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
