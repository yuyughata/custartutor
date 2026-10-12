// Live progress of one job: the steps done, the step running now, attempts, the error in plain words, and the
// buttons to cancel or resume. It only displays; the job is driven by `useJob`.
import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { JobRow } from '@custar/authoring-core';
import type { AdminApiError } from '../api/errors';
import { explainJobError, isTerminal, jobKindLabel, stepLabel, summarizeProgress } from '../lib/jobText';
import { scrollToTestId } from '../platform/scroll';
import { Badge, JobStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ErrorState } from '../ui/States';
import { H3, P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';

export interface JobPanelProps {
  job: JobRow;
  /** This screen is driving the job right now. */
  driving: boolean;
  /** A failure of the API or the loop (not the job's own error). */
  error: AdminApiError | null;
  onCancel?: (() => void) | undefined;
  onResume?: (() => void) | undefined;
  /** Allow the person to cancel (needs the right to start jobs). */
  canCancel?: boolean;
  /** "demo-fixture-model": shown so nothing the stand-in model writes can pass for Claude. */
  modelNote?: string | undefined;
  /** A short word for what the job is doing, shown above the steps. */
  title?: string | undefined;
}

function ProgressBar({ fraction, label }: { fraction: number; label: string }): ReactNode {
  return (
    <View
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      style={{ height: 10, borderRadius: radii.pill, backgroundColor: colors.border, overflow: 'hidden' }}
    >
      <View
        style={{
          width: `${Math.round(fraction * 100)}%`,
          height: '100%',
          backgroundColor: colors.primary,
        }}
      />
    </View>
  );
}

export function JobPanel({
  job,
  driving,
  error,
  onCancel,
  onResume,
  canCancel = true,
  modelNote,
  title,
}: JobPanelProps): ReactNode {
  const progress = summarizeProgress(job);
  const terminal = isTerminal(job.status);
  const explained = explainJobError(job.error, { status: job.status, attempts: job.attempts });
  const label = title ?? jobKindLabel(job.kind);

  // When the panel appears (a job was started or reopened) bring it into view.
  useEffect(() => {
    const timer = setTimeout(() => scrollToTestId('job-panel'), 120);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Card tone="muted" testID="job-panel">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], flexWrap: 'wrap' }}>
        <H3>{label}</H3>
        <JobStatusBadge status={job.status} />
        {driving && !terminal ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Small>Working. Keep this page open.</Small>
          </View>
        ) : null}
        {modelNote ? <Badge label={modelNote} tone="warning" glyph="⚑" /> : null}
      </View>

      <ProgressBar
        fraction={progress.fraction}
        label={`${label}: ${progress.done} of ${progress.total || '?'} steps done`}
      />
      <Small testID="job-progress-count">
        {progress.total > 0
          ? `${progress.done} of ${progress.total} steps done`
          : job.status === 'queued'
            ? 'Waiting to start'
            : `${progress.done} steps done`}
      </Small>

      <View role="list" aria-label="Steps" style={{ gap: space[1] }}>
        {job.progress.done.map((step) => (
          <View key={`done-${step}`} role="listitem" style={{ flexDirection: 'row', gap: space[2] }}>
            <Text aria-hidden style={{ color: colors.success, width: 16, fontWeight: '700' }}>
              ✓
            </Text>
            <Text style={{ color: colors.textSoft, fontSize: 14 }}>{stepLabel(step, job.kind)}</Text>
            <Text style={{ color: colors.subtle, fontSize: 12 }}>done</Text>
          </View>
        ))}
        {job.progress.next && !terminal ? (
          <View role="listitem" style={{ flexDirection: 'row', gap: space[2], alignItems: 'center' }}>
            <Text aria-hidden style={{ color: colors.primary, width: 16, fontWeight: '700' }}>
              ▶
            </Text>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>{stepLabel(job.progress.next, job.kind)}</Text>
            <Text style={{ color: colors.subtle, fontSize: 12 }}>
              {job.attempts > 0 ? `attempt ${job.attempts + 1}` : 'in progress'}
            </Text>
          </View>
        ) : null}
        {job.progress.done.length === 0 && !job.progress.next ? <Small>No steps yet.</Small> : null}
      </View>

      {explained ? (
        <Banner
          tone={job.status === 'failed' ? 'danger' : explained.retrying ? 'warning' : 'warning'}
          title={
            job.status === 'failed'
              ? `Stopped${job.error?.step ? ` at “${stepLabel(job.error.step, job.kind)}”` : ''}`
              : 'A step had a problem'
          }
          testID="job-error"
        >
          <P>{explained.title}</P>
          {explained.hint ? <P>{explained.hint}</P> : null}
          {explained.detail ? <Small>Details: {explained.detail}</Small> : null}
        </Banner>
      ) : null}

      {error ? <ErrorState error={error} title="Lost touch with the job" {...(onResume ? { onRetry: onResume } : {})} /> : null}

      {job.status === 'cancelled' ? (
        <Banner tone="info" title="This job was cancelled">
          Nothing was saved from it.
        </Banner>
      ) : null}

      {!terminal ? (
        <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
          {!driving && onResume ? <Button label="Resume job" onPress={onResume} /> : null}
          {onCancel && canCancel ? <Button label="Cancel job" variant="secondary" onPress={onCancel} /> : null}
          {!driving && onResume ? (
            <Small>This page is not driving the job right now. The job keeps its place; press Resume to continue.</Small>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
