// Recent jobs: what ran, what it was about, how it ended. Open one to see its progress, error or result, and to
// resume a half-finished one.
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { JobSummary } from '../api/types';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatDateTime, formatRelative, shortId } from '../lib/format';
import { isTerminal, jobKindLabel, summarizeProgress } from '../lib/jobText';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { AppLink } from '../ui/AppLink';
import { JobStatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { DataTable, type Column } from '../ui/DataTable';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { Async, EmptyState } from '../ui/States';
import { P, Small } from '../ui/Text';
import { space } from '../ui/theme';

export function jobTarget(job: JobSummary): { label: string; href: string } | null {
  if (job.unit_id) return { label: 'Unit', href: `/units/${job.unit_id}` };
  if (job.scheme_id) return { label: 'Scheme', href: `/schemes/${job.scheme_id}` };
  return null;
}

export default function JobsScreen(): ReactNode {
  usePageTitle('Jobs');
  const api = useApi();
  const { recheckAuth } = useRuntime();
  const { userId } = useSession();
  const [filter, setFilter] = useState('');
  const jobs = useLoad(
    () =>
      api.jobs.list({
        limit: 100,
        ...(filter === 'active'
          ? { status: ['queued' as const, 'running' as const] }
          : filter === 'failed'
            ? { status: ['failed' as const] }
            : {}),
      }),
    [api, filter],
  );

  // While something is running, keep the list fresh.
  const active = jobs.data?.some((job) => !isTerminal(job.status)) ?? false;
  const reload = jobs.reload;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
  }, [active, reload]);

  const columns: Column<JobSummary>[] = [
    {
      key: 'when',
      header: 'Created',
      width: 150,
      render: (job) => (
        <View>
          <Small>{formatDateTime(job.created_at)}</Small>
          <Small>{formatRelative(job.created_at)}</Small>
        </View>
      ),
    },
    {
      key: 'kind',
      header: 'Job',
      flex: 1.4,
      render: (job) => (
        <AppLink href={{ pathname: '/jobs/[jobId]', params: { jobId: job.id } }}>
          {jobKindLabel(job.kind)}
        </AppLink>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      render: (job) => <JobStatusBadge status={job.status} />,
    },
    {
      key: 'progress',
      header: 'Steps',
      width: 100,
      render: (job) => {
        const progress = summarizeProgress(job);
        return <Small>{progress.total > 0 ? `${progress.done} of ${progress.total}` : '–'}</Small>;
      },
    },
    {
      key: 'about',
      header: 'About',
      width: 100,
      render: (job) => {
        const target = jobTarget(job);
        return target ? (
          <AppLink href={target.href as never}>{target.label}</AppLink>
        ) : (
          <Small>–</Small>
        );
      },
    },
    {
      key: 'by',
      header: 'By',
      width: 130,
      render: (job) => (
        <Small>
          {job.created_by === null
            ? 'unknown'
            : job.created_by === userId
              ? 'You'
              : `Staff ${shortId(job.created_by)}`}
        </Small>
      ),
    },
  ];

  return (
    <View style={{ gap: space[4] }}>
      <PageHeader
        title="Jobs"
        subtitle="Everything Claude was asked to do, newest first."
        actions={
          <Button
            label="Refresh"
            variant="secondary"
            onPress={reload}
            busy={jobs.loading && jobs.data !== undefined}
          />
        }
      />
      <View style={{ width: 220 }}>
        <Select
          label="Show"
          value={filter}
          options={[
            { value: '', label: 'All jobs' },
            { value: 'active', label: 'Running or queued' },
            { value: 'failed', label: 'Failed' },
          ]}
          onChange={setFilter}
        />
      </View>
      <Async state={jobs} onSignInAgain={() => void recheckAuth()}>
        {(rows) => (
          <DataTable
            label="Jobs"
            columns={columns}
            rows={rows}
            rowKey={(job) => job.id}
            minWidth={820}
            empty={
              <EmptyState title="No jobs yet">
                <P>
                  Jobs appear here when a scheme is read, chapters are proposed or a unit is drafted
                  or revised.
                </P>
              </EmptyState>
            }
          />
        )}
      </Async>
    </View>
  );
}
