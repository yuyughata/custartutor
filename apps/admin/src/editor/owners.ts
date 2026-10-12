// Which field a problem is shown beside. The schema and the lint report locate problems by path, sometimes deeper
// than the editor draws a separate field (`questions.q_name.answer.blanks[0].accepted[1]` is one answer editor in
// the app). `ownerOf` cuts a path at the depth the editor shows, so every problem lands on a field or card that
// exists; the summary panel lists them all regardless, so none can be lost.
import type { Path } from './path';

/** The deepest path the editor renders a separate field or row for, by first segment. */
const MAX_DEPTH: Record<string, number> = {
  header: 3,
  sections: 8,
  questions: 5,
  session_plan: 5,
  workbook: 5,
  teacher_manual: 6,
  tutor_script: 6,
  steps: 3,
  materials: 2,
  rubric: 5,
  evidence_options: 2,
  reflection_prompts: 2,
  scoring: 2,
};

export function ownerOf(path: Path): Path {
  const root = path[0];
  if (root === undefined) return [];
  if (typeof root !== 'string') return path.slice(0, 1);
  // The whole answer of a question is one editor.
  if (root === 'questions' && path[2] === 'answer') return path.slice(0, 3);
  const depth = MAX_DEPTH[root] ?? 2;
  return path.slice(0, depth);
}

/** What was cut off, for the message ("blanks[0].accepted[1]"). */
export function remainder(path: Path, owner: Path): string {
  return path
    .slice(owner.length)
    .reduce<string>(
      (out, segment) =>
        typeof segment === 'number' ? `${out}[${segment + 1}]` : out === '' ? segment : `${out}.${segment}`,
      '',
    );
}
