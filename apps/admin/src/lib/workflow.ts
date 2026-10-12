// The review workflow of a unit version: which status moves exist and which buttons a person may press.
// Pure and role-aware. The database enforces the same rules (set_unit_version_status, publish_unit_version
// and the guard trigger); this module only decides what to SHOW. There is deliberately no action that
// skips a step: nothing publishes without submit, approve and an explicit publish.
import { can, whyNot, type AdminRole, type Capability } from './roles';

export const VERSION_STATUSES = ['draft', 'in_review', 'approved', 'published', 'superseded'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusStyle {
  label: string;
  /** A glyph, so the status is never carried by colour alone. */
  glyph: string;
  tone: StatusTone;
}

export const VERSION_STATUS_STYLE: Record<VersionStatus, StatusStyle> = {
  draft: { label: 'Draft', glyph: '✎', tone: 'neutral' },
  in_review: { label: 'In review', glyph: '◔', tone: 'info' },
  approved: { label: 'Approved', glyph: '✓', tone: 'success' },
  published: { label: 'Published', glyph: '●', tone: 'success' },
  superseded: { label: 'Superseded', glyph: '↷', tone: 'neutral' },
};

export type WorkflowActionId = 'submit' | 'approve' | 'send_back' | 'publish';

export interface WorkflowAction {
  id: WorkflowActionId;
  label: string;
  /** The status the version moves to, when the action is a status move. */
  to?: Exclude<VersionStatus, 'published' | 'superseded'>;
  enabled: boolean;
  /** Why the button is disabled, in plain words. */
  reason?: string;
  tone: 'primary' | 'secondary' | 'danger';
}

export interface WorkflowInput {
  status: VersionStatus;
  role: AdminRole | null | undefined;
  /** The deterministic lint (stored report merged with a fresh client run) has errors, or the content does not parse. */
  lintBlocking: boolean;
  /** Only the latest version moves through the workflow. */
  isLatest: boolean;
}

function gate(
  role: AdminRole | null | undefined,
  capability: Capability,
  extra: { ok: boolean; reason: string }[],
): { enabled: boolean; reason?: string } {
  const denied = whyNot(role, capability);
  if (denied) return { enabled: false, reason: denied };
  const blocked = extra.find((entry) => !entry.ok);
  return blocked ? { enabled: false, reason: blocked.reason } : { enabled: true };
}

/**
 * The buttons for one version. `[]` means the version has no workflow moves left (published, superseded, or
 * not the latest version).
 */
export function workflowActions(input: WorkflowInput): WorkflowAction[] {
  const { status, role, lintBlocking, isLatest } = input;
  if (!isLatest || status === 'published' || status === 'superseded') return [];
  const lintReason = 'Fix the lint errors first (ask Claude to revise the draft).';

  if (status === 'draft') {
    return [
      {
        id: 'submit',
        label: 'Submit for review',
        to: 'in_review',
        tone: 'primary',
        ...gate(role, 'version.submit', [{ ok: !lintBlocking, reason: lintReason }]),
      },
    ];
  }
  if (status === 'in_review') {
    return [
      {
        id: 'approve',
        label: 'Approve',
        to: 'approved',
        tone: 'primary',
        ...gate(role, 'version.review', [{ ok: !lintBlocking, reason: lintReason }]),
      },
      {
        id: 'send_back',
        label: 'Send back to draft',
        to: 'draft',
        tone: 'secondary',
        ...gate(role, 'version.review', []),
      },
    ];
  }
  // approved
  return [
    {
      id: 'publish',
      label: 'Publish to learners',
      tone: 'primary',
      ...gate(role, 'version.publish', [{ ok: !lintBlocking, reason: lintReason }]),
    },
  ];
}

/** Revising or redrafting makes a NEW draft, so it is open to whoever may start jobs, whatever the status. */
export function canStartDraftJob(role: AdminRole | null | undefined): boolean {
  return can(role, 'job.start');
}

export function versionStatusStyle(status: string): StatusStyle {
  return (
    VERSION_STATUS_STYLE[status as VersionStatus] ?? { label: status, glyph: '?', tone: 'neutral' }
  );
}
