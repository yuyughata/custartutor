import type { SyncApiErrorCode } from '../api';

/** What one push pass did. */
export interface PushReport {
  /** Rows handed to the server. */
  sent: number;
  /** Accepted or already known to the server: removed from the outbox. */
  delivered: number;
  /** Rejected this time (kept for a retry, or dead-lettered). */
  rejected: number;
  /** Rows that hit the attempt limit in this pass, or were corrupt. */
  deadLettered: number;
}

/** What one pull pass did. */
export interface PullReport {
  pages: number;
  rows: number;
  /** True when a membership-epoch change forced a wipe and a pull from the start. */
  fullResync: boolean;
}

export type SyncFailureKind = SyncApiErrorCode | 'internal';

export type SyncResult =
  | { ok: true; push: PushReport; pull: PullReport }
  | {
      ok: false;
      /** True when trying again later can work without user action (offline, server trouble). */
      retryable: boolean;
      kind: SyncFailureKind;
      message: string;
      phase: 'push' | 'pull' | 'internal';
      push: PushReport;
      pull: PullReport;
    };

export const emptyPush = (): PushReport => ({
  sent: 0,
  delivered: 0,
  rejected: 0,
  deadLettered: 0,
});
export const emptyPull = (): PullReport => ({ pages: 0, rows: 0, fullResync: false });
