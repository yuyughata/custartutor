// The chapter planner for one approved scheme: what already exists, "Propose chapters" (a chapter_plan job),
// the editable plan and "Apply plan".
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChapterPlanResult } from '@custar/authoring-core';
import { Scheme } from '@custar/content-schema';
import type { ChapterRow, SchemeDetail } from '../api/types';
import { ChapterPlanEditor } from '../components/ChapterPlanEditor';
import { LayoutEditor } from '../components/LayoutEditor';
import { JobPanel } from '../components/JobPanel';
import { useAction } from '../hooks/useAction';
import { useCatalog, type Catalog } from '../hooks/useCatalog';
import { useJob } from '../hooks/useJob';
import { useLoad, type LoadState } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { newKey } from '../lib/ids';
import { whyNot } from '../lib/roles';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { useLeaveGuard } from '../runtime/UnsavedGuard';
import { AppLink } from '../ui/AppLink';
import { ContentStatusBadge, VersionStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card, Row, Section } from '../ui/Card';
import { PageHeader } from '../ui/PageHeader';
import { Async, EmptyState } from '../ui/States';
import { H3, P, Small } from '../ui/Text';
import { space } from '../ui/theme';
import { DEMO_MODEL_NAME } from '../demo/modelName';

function ExistingChapters({ chapters }: { chapters: ChapterRow[] }): ReactNode {
  return (
    <View style={{ gap: space[3] }} testID="existing-chapters">
      {chapters.map((chapter) => (
        <Card key={chapter.id}>
          <Row>
            <H3>{`Chapter ${chapter.number}: ${chapter.title}`}</H3>
            <ContentStatusBadge status={chapter.status} />
            <Small>{chapter.units.length} units</Small>
          </Row>
          {chapter.units.map((unit) => (
            <Row key={unit.id} gap={space[3]}>
              <AppLink href={{ pathname: '/units/[unitId]', params: { unitId: unit.id } }}>
                {`Unit ${unit.unit_no}: ${unit.title}`}
              </AppLink>
              {unit.week_no !== null ? <Small>Week {unit.week_no}</Small> : null}
              <ContentStatusBadge status={unit.status} />
              {unit.latest_version_status ? (
                <>
                  <VersionStatusBadge status={unit.latest_version_status} />
                  <Small>
                    {unit.version_count} version{unit.version_count === 1 ? '' : 's'}
                  </Small>
                </>
              ) : (
                <Small>No draft yet</Small>
              )}
            </Row>
          ))}
        </Card>
      ))}
    </View>
  );
}

function Planner({
  scheme,
  catalog,
  chapters,
}: {
  scheme: SchemeDetail;
  catalog: Catalog;
  chapters: LoadState<ChapterRow[]>;
}): ReactNode {
  const api = useApi();
  const { runtime } = useRuntime();
  const { role } = useSession();
  const router = useRouter();
  const guard = useLeaveGuard();
  const params = useLocalSearchParams<{ job?: string }>();
  const job = useJob(api.jobs, runtime.pollMs, {
    onCreated: (created) => router.setParams({ job: created.id }),
  });
  const [key, setKey] = useState(newKey());
  const denied = whyNot(role, 'job.start');
  const hasChapters = (chapters.data?.length ?? 0) > 0;
  const [editingLayout, setEditingLayout] = useState(false);
  const [layoutKey, setLayoutKey] = useState(0);
  const layoutDenied = whyNot(role, 'layout.apply');

  const resume = job.resume;
  const jobParam = params.job;
  useEffect(() => {
    if (jobParam) void resume(jobParam);
  }, [jobParam, resume]);

  // A plan job that was started earlier and is still running is picked up again.
  useEffect(() => {
    if (jobParam) return;
    let alive = true;
    void api.jobs
      .list({ kind: 'chapter_plan', schemeId: scheme.id, status: ['queued', 'running'], limit: 1 })
      .then((active) => {
        const first = active[0];
        if (alive && first) router.setParams({ job: first.id });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, scheme.id, jobParam, router]);

  const propose = useAction(async () => {
    const idempotencyKey = key;
    setKey(newKey());
    await job.start('chapter_plan', { scheme_id: scheme.id }, idempotencyKey);
  });

  const parsedResult =
    job.job?.status === 'succeeded' ? ChapterPlanResult.safeParse(job.job.result) : null;
  const parsedScheme = Scheme.safeParse({
    subject_slug:
      catalog.subjects.find((subject) => subject.id === scheme.subject_id)?.slug ?? 'unknown',
    level_code: scheme.level_code,
    term: scheme.term,
    weeks: scheme.weeks,
  });
  const modelNote = runtime.mode === 'demo' ? `Stand-in model: ${DEMO_MODEL_NAME}` : undefined;

  const startOver = (): void => {
    guard.confirmLeave(() => {
      job.reset();
      router.setParams({ job: undefined });
    });
  };

  return (
    <View style={{ gap: space[4] }}>
      <Section
        title="Chapters and units so far"
        testID="chapters-section"
        action={
          hasChapters && !editingLayout ? (
            <Button
              label="Edit layout"
              variant="secondary"
              testID="edit-layout"
              onPress={() => setEditingLayout(true)}
              disabled={Boolean(layoutDenied)}
              reason={layoutDenied}
            />
          ) : undefined
        }
      >
        <Async state={chapters}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title="Nothing planned yet">
                <P>Press “Propose chapters” below. Nothing is created until you apply the plan.</P>
              </EmptyState>
            ) : editingLayout ? (
              <LayoutEditor
                key={layoutKey}
                schemeId={scheme.id}
                chapters={rows}
                weeks={scheme.weeks.map((week) => ({ week_no: week.week_no, topic: week.topic }))}
                defaultStage={rows[0]?.units[0]?.stage ?? 'absorb'}
                onApplied={() => chapters.reload()}
                onReload={() => {
                  chapters.reload();
                  setLayoutKey((value) => value + 1);
                }}
                onClose={() => setEditingLayout(false)}
              />
            ) : (
              <ExistingChapters chapters={rows} />
            )
          }
        </Async>
      </Section>

      <Section title={hasChapters ? 'Plan again' : 'Propose chapters'}>
        <P>
          The weeks are grouped into chapters of 3 to 5 units. Claude names the chapters and units
          and proposes themes, you edit the plan, and nothing is created until you press “Apply
          plan”.
          {hasChapters
            ? ' Applying again updates the titles, objectives and stage of units that have no draft yet; a unit that already has a draft is left alone and the server will say so.'
            : ''}
        </P>
        {hasChapters ? (
          <Banner
            tone="warning"
            title="Planning again replaces units that have no draft"
            testID="replan-warning"
          >
            <P>
              A new plan is matched to the existing units by chapter and position, and a unit
              without any draft that the new plan does not contain is removed. Units you added by
              hand, and the new numbering, are not kept. To add, remove or reorder single units, use
              “Edit layout” above instead.
            </P>
          </Banner>
        ) : null}
        {propose.error ? (
          <Banner tone="danger" title="The job could not be started" testID="start-error">
            <P>{propose.error.message}</P>
          </Banner>
        ) : null}
        {!job.job && !jobParam ? (
          <Row>
            <Button
              label="Propose chapters"
              onPress={() => void propose.run()}
              busy={propose.busy}
              disabled={Boolean(denied)}
              reason={denied}
            />
          </Row>
        ) : null}
      </Section>

      {job.job ? (
        <JobPanel
          job={job.job}
          driving={job.driving}
          error={job.error}
          onCancel={() => void job.cancel()}
          onResume={() => void job.resume(job.job?.id ?? '')}
          canCancel={!denied}
          modelNote={modelNote}
        />
      ) : jobParam && job.error ? (
        <Banner tone="danger" title="That job could not be opened">
          <P>{job.error.message}</P>
        </Banner>
      ) : null}

      {parsedResult && !parsedResult.success ? (
        <Banner tone="danger" title="The plan could not be read">
          <P>The job finished, but its result is not a chapter plan. Start again.</P>
        </Banner>
      ) : null}

      {parsedResult?.success ? (
        <Section title="Review the plan" testID="plan-section">
          <ChapterPlanEditor
            key={job.job?.id}
            schemeId={scheme.id}
            initialPlan={parsedResult.data.plan}
            flags={parsedResult.data.flags}
            scheme={parsedScheme.success ? parsedScheme.data : null}
            onApplied={() => chapters.reload()}
          />
        </Section>
      ) : null}

      {job.job &&
      (job.job.status === 'failed' ||
        job.job.status === 'cancelled' ||
        job.job.status === 'succeeded') ? (
        <Row>
          <Button label="Start again" variant="secondary" small onPress={startOver} />
        </Row>
      ) : null}
    </View>
  );
}

export default function ChapterPlannerScreen(): ReactNode {
  usePageTitle('Chapter planner');
  const { schemeId } = useLocalSearchParams<{ schemeId: string }>();
  const api = useApi();
  const { recheckAuth } = useRuntime();
  const catalog = useCatalog();
  const scheme = useLoad(() => api.schemes.get(schemeId), [api, schemeId]);
  const chapters = useLoad(() => api.chapters.list(schemeId), [api, schemeId]);

  return (
    <Async
      state={scheme}
      loadingLabel="Loading the scheme…"
      onSignInAgain={() => void recheckAuth()}
    >
      {(data) => (
        <Async state={catalog}>
          {(names) => {
            const title = `${names.subjectName(data.subject_id)} · ${names.levelName(data.level_code)} · Term ${data.term}`;
            return (
              <View style={{ gap: space[4] }}>
                <PageHeader
                  title="Chapter planner"
                  subtitle={title}
                  crumbs={[
                    { label: 'Schemes', href: '/schemes' },
                    {
                      label: title,
                      href: { pathname: '/schemes/[schemeId]', params: { schemeId: data.id } },
                    },
                    { label: 'Chapters' },
                  ]}
                />
                {data.status !== 'approved' ? (
                  <Banner
                    tone="warning"
                    title="Approve the scheme first"
                    testID="planner-not-approved"
                  >
                    <P>
                      Chapters can only be planned from an approved scheme.{' '}
                      <AppLink
                        href={{ pathname: '/schemes/[schemeId]', params: { schemeId: data.id } }}
                      >
                        Go to the scheme
                      </AppLink>
                    </P>
                  </Banner>
                ) : (
                  <Planner scheme={data} catalog={names} chapters={chapters} />
                )}
              </View>
            );
          }}
        </Async>
      )}
    </Async>
  );
}
