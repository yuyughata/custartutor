// One job: its progress, error and result. A job that is not finished can be resumed from here: this page then
// drives it with runJob, exactly like the screen that started it.
import { useEffect, type ReactNode } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import {
  SchemeIngestResult,
  ChapterPlanResult,
  UnitDraftResult,
  type JobRow,
} from '@custar/authoring-core';
import { JobPanel } from '../components/JobPanel';
import { useJob } from '../hooks/useJob';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatDateTime } from '../lib/format';
import { isTerminal, jobKindLabel } from '../lib/jobText';
import { whyNot } from '../lib/roles';
import { DEMO_MODEL_NAME } from '../demo/modelName';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { AppLink } from '../ui/AppLink';
import { Banner } from '../ui/Banner';
import { Section } from '../ui/Card';
import { PageHeader } from '../ui/PageHeader';
import { Async } from '../ui/States';
import { P, Small } from '../ui/Text';
import { space } from '../ui/theme';

function ResultSummary({ job }: { job: JobRow }): ReactNode {
  if (job.status !== 'succeeded') return null;
  if (job.kind === 'scheme_ingest') {
    const parsed = SchemeIngestResult.safeParse(job.result);
    return (
      <Section title="Result">
        {parsed.success ? (
          <>
            <P>
              A draft with {parsed.data.scheme.weeks.length} weeks and {parsed.data.flags.length}{' '}
              note
              {parsed.data.flags.length === 1 ? '' : 's'}. It is saved nowhere until a person saves
              it.
            </P>
            <AppLink href={{ pathname: '/schemes/new', params: { job: job.id } }}>
              Open the draft
            </AppLink>
          </>
        ) : (
          <P>The result could not be read.</P>
        )}
      </Section>
    );
  }
  if (job.kind === 'chapter_plan') {
    const parsed = ChapterPlanResult.safeParse(job.result);
    return (
      <Section title="Result">
        {parsed.success ? (
          <>
            <P>
              A plan with {parsed.data.plan.chapters.length} chapters and {parsed.data.flags.length}{' '}
              note
              {parsed.data.flags.length === 1 ? '' : 's'}.
            </P>
            {job.scheme_id ? (
              <AppLink
                href={{
                  pathname: '/schemes/[schemeId]/chapters',
                  params: { schemeId: job.scheme_id, job: job.id },
                }}
              >
                Open the plan
              </AppLink>
            ) : null}
          </>
        ) : (
          <P>The result could not be read.</P>
        )}
      </Section>
    );
  }
  const parsed = UnitDraftResult.safeParse(job.result);
  return (
    <Section title="Result">
      {parsed.success ? (
        <>
          <P>
            Version {parsed.data.version} was saved as a draft. {parsed.data.summary}
          </P>
          <Small>
            Lint: {parsed.data.lint.errors} errors, {parsed.data.lint.warnings} warnings ·{' '}
            {parsed.data.review.length} review note
            {parsed.data.review.length === 1 ? '' : 's'}.
          </Small>
          {job.unit_id ? (
            <AppLink href={{ pathname: '/units/[unitId]', params: { unitId: job.unit_id } }}>
              Open the unit
            </AppLink>
          ) : null}
        </>
      ) : (
        <P>The result could not be read.</P>
      )}
    </Section>
  );
}

export default function JobDetailScreen(): ReactNode {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const api = useApi();
  const { runtime, recheckAuth } = useRuntime();
  const { role } = useSession();
  const first = useLoad(() => api.jobs.get(jobId), [api, jobId]);
  const job = useJob(api.jobs, runtime.pollMs);
  usePageTitle('Job');
  const denied = whyNot(role, 'job.start');

  // The page shows the live row once it is being driven, and the first read until then.
  const current = job.job ?? first.data;
  const reloadFirst = first.reload;
  useEffect(() => {
    if (job.job && isTerminal(job.job.status)) reloadFirst();
  }, [job.job?.status, job.job, reloadFirst]);

  return (
    <Async state={first} loadingLabel="Opening the job…" onSignInAgain={() => void recheckAuth()}>
      {(initial) => {
        const row = current ?? initial;
        return (
          <View style={{ gap: space[4] }}>
            <PageHeader
              title={jobKindLabel(row.kind)}
              subtitle={`Started ${formatDateTime(row.created_at)}`}
              crumbs={[{ label: 'Jobs', href: '/jobs' }, { label: jobKindLabel(row.kind) }]}
            />
            {runtime.mode === 'demo' ? (
              <Banner
                tone="warning"
                title={`Demo: the stand-in model (${DEMO_MODEL_NAME}) ran this job`}
              />
            ) : null}
            <JobPanel
              job={row}
              driving={job.driving}
              error={job.error}
              onCancel={denied ? undefined : () => void job.cancel()}
              onResume={denied ? undefined : () => void job.resume(row.id)}
              canCancel={!denied}
              modelNote={runtime.mode === 'demo' ? `Stand-in model: ${DEMO_MODEL_NAME}` : undefined}
            />
            {denied && !isTerminal(row.status) ? (
              <Banner tone="info" title="You can watch this job but not drive it">
                <P>{denied}</P>
              </Banner>
            ) : null}
            <ResultSummary job={row} />
          </View>
        );
      }}
    </Async>
  );
}
