// Plain-words text for jobs: kind and status labels, step names, progress and errors. Step names come from the
// engine (`nextStep`) and are only specified loosely, so `stepLabel` matches the shapes it knows and falls back
// to a readable version of whatever it is given.
import { MAX_STEP_ATTEMPTS, type JobError, type JobKind, type JobRow } from '@custar/authoring-core';
import type { StatusTone } from './workflow';

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  scheme_ingest: 'Read a scheme of work',
  chapter_plan: 'Propose chapters',
  unit_generate: 'Draft a unit',
  unit_revise: 'Revise a unit',
};

export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABELS[kind as JobKind] ?? kind;
}

export interface JobStatusStyle {
  label: string;
  glyph: string;
  tone: StatusTone;
}

export const JOB_STATUS_STYLE: Record<JobRow['status'], JobStatusStyle> = {
  queued: { label: 'Queued', glyph: '…', tone: 'neutral' },
  running: { label: 'Running', glyph: '▶', tone: 'info' },
  succeeded: { label: 'Done', glyph: '✓', tone: 'success' },
  failed: { label: 'Failed', glyph: '✕', tone: 'danger' },
  cancelled: { label: 'Cancelled', glyph: '■', tone: 'neutral' },
};

export function jobStatusStyle(status: string): JobStatusStyle {
  return JOB_STATUS_STYLE[status as JobRow['status']] ?? { label: status, glyph: '?', tone: 'neutral' };
}

export function isTerminal(status: JobRow['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Words for a section id such as `come_and_explore` -> "Come and explore". */
export function humanizeId(id: string): string {
  const spaced = id
    .replace(/^(?:s|sec|section)_?\d+_/i, '')
    .replace(/[_\-.]+/g, ' ')
    .trim();
  return spaced === '' ? id : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const SIMPLE_STEPS: Record<string, string> = {
  outline: 'Planning the outline',
  plan: 'Planning the outline',
  workbook: 'Writing the workbook',
  manual: "Writing the teacher's manual",
  teacher_manual: "Writing the teacher's manual",
  assemble: 'Putting the unit together',
  lint: 'Checking the unit against the rules',
  review: 'Advisory review',
  read: 'Reading the document',
  extract: 'Reading the document',
  ingest: 'Reading the document',
  validate: 'Checking the weeks',
  classify: 'Sorting the weeks',
  group: 'Grouping weeks into chapters',
  grouping: 'Grouping weeks into chapters',
  titles: 'Naming chapters and units',
  names: 'Naming chapters and units',
  themes: 'Proposing themes',
  objectives: 'Drafting objectives',
  revise: 'Rewriting',
  finish: 'Finishing',
  save: 'Saving',
};

/** A readable name for one step of a job, for example `section:come_and_explore` -> `Writing "Come and explore"`. */
export function stepLabel(step: string): string {
  const lower = step.toLowerCase();
  const direct = SIMPLE_STEPS[lower];
  if (direct) return direct;
  const [head = '', ...rest] = step.split(/[:/]/);
  const tail = rest.join(':');
  const headKey = head.toLowerCase();
  if (tail !== '') {
    if (headKey === 'section' || headKey === 'sections' || headKey === 'write') {
      return `Writing "${humanizeId(tail)}"`;
    }
    if (headKey === 'repair' || headKey === 'fix') {
      return /^\d+$/.test(tail) ? `Fixing problems (round ${tail})` : `Fixing "${humanizeId(tail)}"`;
    }
    if (headKey === 'revise' || headKey === 'rewrite') return `Rewriting "${humanizeId(tail)}"`;
    if (headKey === 'review') return `Advisory review: ${humanizeId(tail)}`;
  }
  const repair = /^repair[_-]?(\d+)$/i.exec(step);
  if (repair) return `Fixing problems (round ${repair[1]})`;
  const section = /^(?:section|write)[_-](.+)$/i.exec(step);
  if (section?.[1]) return `Writing "${humanizeId(section[1])}"`;
  return humanizeId(step);
}

export interface ProgressSummary {
  done: number;
  total: number;
  /** 0 to 1; 0 when the total is not known yet. */
  fraction: number;
  next: string | null;
  currentLabel: string | null;
}

export function summarizeProgress(job: Pick<JobRow, 'progress' | 'status'>): ProgressSummary {
  const done = job.progress.done.length;
  const total = Math.max(job.progress.total, done);
  const finished = job.status === 'succeeded';
  return {
    done,
    total,
    fraction: finished ? 1 : total > 0 ? Math.min(1, done / total) : 0,
    next: job.progress.next,
    currentLabel: job.progress.next ? stepLabel(job.progress.next) : null,
  };
}

export interface ExplainedError {
  /** One sentence in plain words. */
  title: string;
  /** What to try, when there is something to try. */
  hint?: string;
  /** The raw message from the server, for the curious and for bug reports. */
  detail?: string;
  /** True while the client or server will try again by itself. */
  retrying: boolean;
}

const ERROR_TEXT: Record<string, { title: string; hint?: string }> = {
  refusal: {
    title: 'Claude declined to write this part.',
    hint: 'Try rewording the notes or the objective, then run it again.',
  },
  schema: {
    title: 'Claude’s answer did not have the required shape, even after one repair attempt.',
    hint: 'Run it again; if it keeps happening, ask for a simpler change.',
  },
  truncated: {
    title: 'Claude’s answer was cut off because it was too long.',
    hint: 'Ask for a smaller change, or run it again.',
  },
  transport: {
    title: 'The connection to Claude failed or the service was busy.',
    hint: 'This usually passes. It is tried again automatically.',
  },
  aborted: {
    title: 'A step took too long and was stopped.',
    hint: 'It is tried again automatically.',
  },
  invalid_input: { title: 'The job’s input was not valid.', hint: 'Check the scheme or unit and start again.' },
  internal: { title: 'Something went wrong on the server.', hint: 'Try again in a moment.' },
  kill_switch: {
    title: 'AI drafting is switched off.',
    hint: 'A super admin can switch it back on under Usage & settings.',
  },
  budget_exceeded: {
    title: 'A spending cap was reached.',
    hint: 'A super admin can raise the cap under Usage & settings.',
  },
  mfa_required: {
    title: 'The authenticator code is needed again.',
    hint: 'Sign in with your authenticator code, then resume the job.',
  },
};

/** Plain-words version of a job's error. `status` and `attempts` decide whether it is being retried. */
export function explainJobError(
  error: JobError | null,
  state: { status: JobRow['status']; attempts: number },
): ExplainedError | null {
  if (!error) return null;
  const known = ERROR_TEXT[error.code];
  const retryable = error.retryable === true;
  const retrying = state.status === 'running' && retryable && state.attempts < MAX_STEP_ATTEMPTS;
  const detail = error.message && error.message !== error.code ? error.message : undefined;
  const base = known ?? { title: error.message || 'The job hit a problem.' };
  const title =
    retrying && state.attempts > 0
      ? `${base.title} Trying again (attempt ${Math.min(state.attempts + 1, MAX_STEP_ATTEMPTS)} of ${MAX_STEP_ATTEMPTS}).`
      : base.title;
  return {
    title,
    ...(base.hint && !retrying ? { hint: base.hint } : {}),
    ...(detail && known ? { detail } : {}),
    retrying,
  };
}

/** One line for lists: "Draft a unit · 3 of 9 steps". */
export function jobHeadline(job: Pick<JobRow, 'kind' | 'progress' | 'status'>): string {
  const progress = summarizeProgress(job);
  const steps =
    progress.total > 0 && job.status !== 'queued' ? ` · ${progress.done} of ${progress.total} steps` : '';
  return `${jobKindLabel(job.kind)}${steps}`;
}
