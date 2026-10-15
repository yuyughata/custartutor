// The unit workspace: draft with Claude, watch it work, read the draft exactly as the learner app will render it,
// see the lint and the advisory AI review, ask for changes, compare versions, and move the version through
// review to publication. A person does every step after the draft.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { UnitDraftResult } from '@custar/authoring-core';
import type { UnitContext, UnitVersionSummary } from '../api/types';
import { JobPanel } from '../components/JobPanel';
import { LintPanel } from '../components/LintPanel';
import { ReviseBox } from '../components/ReviseBox';
import { UnitPreview, type PreviewJump } from '../components/UnitPreview';
import { VersionHistory } from '../components/VersionHistory';
import { WorkflowBar } from '../components/WorkflowBar';
import { DEMO_MODEL_ID, DEMO_MODEL_NAME } from '../demo/modelName';
import { useAction } from '../hooks/useAction';
import { useCatalog } from '../hooks/useCatalog';
import { useJob } from '../hooks/useJob';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatDateTime } from '../lib/format';
import { newKey } from '../lib/ids';
import { isTerminal } from '../lib/jobText';
import { buildLintView, parseVersionContent } from '../lib/lint';
import type { JumpTarget } from '../lib/lintPaths';
import { can, whyNot } from '../lib/roles';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { useGuardedRouter } from '../runtime/UnsavedGuard';
import { Badge, ContentStatusBadge, VersionStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card, Row, Section } from '../ui/Card';
import { TextField } from '../ui/Fields';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { Async, EmptyState, ErrorState, Loading } from '../ui/States';
import { P, Small } from '../ui/Text';
import { colors, space } from '../ui/theme';

const TWO_COLUMNS = 1180;

function versionOption(version: UnitVersionSummary): { value: string; label: string } {
  const by = version.generated_by === 'ai' ? 'AI draft' : 'human';
  return {
    value: version.id,
    label: `Version ${version.version} · ${version.status.replace('_', ' ')} · ${by} · ${formatDateTime(version.created_at)}`,
  };
}

function Workspace({ context }: { context: UnitContext }): ReactNode {
  const api = useApi();
  const { runtime, recheckAuth } = useRuntime();
  const { role } = useSession();
  const { width } = useWindowDimensions();
  const twoColumns = width >= TWO_COLUMNS;
  const unitId = context.unit.id;

  const versions = useLoad(() => api.units.versions(unitId), [api, unitId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [key, setKey] = useState(newKey());
  const [jump, setJump] = useState<PreviewJump | null>(null);
  const [outcome, setOutcome] = useState<{
    version: number;
    summary: string;
    errors: number;
    warnings: number;
  } | null>(null);

  const list = versions.data ?? [];
  const latest = list[0];
  const selected = list.find((version) => version.id === selectedId) ?? latest;

  const job = useJob(api.jobs, runtime.pollMs, {
    onFinished: (row) => {
      if (row.status !== 'succeeded') return;
      const parsed = UnitDraftResult.safeParse(row.result);
      versions.reload();
      if (parsed.success) {
        setSelectedId(parsed.data.unit_version_id);
        setOutcome({
          version: parsed.data.version,
          summary: parsed.data.summary,
          errors: parsed.data.lint.errors,
          warnings: parsed.data.lint.warnings,
        });
        setJump(null);
      }
    },
  });

  // A draft or revision that is still running (started earlier, here or elsewhere) is picked up again.
  const resume = job.resume;
  useEffect(() => {
    let alive = true;
    void api.jobs
      .list({ unitId, status: ['queued', 'running'], limit: 1 })
      .then((active) => {
        const first = active[0];
        if (alive && first) void resume(first.id);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, unitId, resume]);

  const content = useLoad(
    () => (selected ? api.units.version(selected.id) : Promise.resolve(null)),
    [api, selected?.id],
  );
  const parsed = useMemo(
    () => (content.data ? parseVersionContent(content.data.content) : null),
    [content.data],
  );
  const lint = useMemo(
    () => (parsed && selected ? buildLintView(selected.lint_report, parsed) : null),
    [parsed, selected],
  );

  const running = job.driving || (job.job !== null && !isTerminal(job.job.status));
  const denied = whyNot(role, 'job.start');
  const isLatest = Boolean(selected && latest && selected.id === latest.id);

  const generate = useAction(async () => {
    const idempotencyKey = key;
    setKey(newKey());
    setOutcome(null);
    await job.start(
      'unit_generate',
      { unit_id: unitId, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      idempotencyKey,
    );
  });

  const revise = useAction(async (instruction: string, sectionIds: string[]) => {
    if (!latest) return;
    setOutcome(null);
    await job.start(
      'unit_revise',
      {
        unit_version_id: latest.id,
        instruction,
        ...(sectionIds.length > 0 ? { section_ids: sectionIds } : {}),
      },
      newKey(),
    );
  });

  const onJump = (target: JumpTarget): void => setJump({ target, nonce: (jump?.nonce ?? 0) + 1 });
  const modelNote = runtime.mode === 'demo' ? `Stand-in model: ${DEMO_MODEL_NAME}` : undefined;
  const reviseReason = denied
    ? denied
    : !latest
      ? 'There is no draft to revise yet.'
      : !isLatest
        ? 'Select the latest version to revise it.'
        : running
          ? 'A job is already running for this unit.'
          : null;

  return (
    <View style={{ gap: space[4] }}>
      <Card tone="core">
        <Small>NERDC objective for this unit</Small>
        <P testID="unit-objective">{context.unit.objective ?? 'No objective recorded.'}</P>
      </Card>

      <Section title="Draft with Claude" testID="draft-section">
        <P>
          {list.length === 0
            ? 'Claude drafts the whole unit from the scheme week, the objective and the cast: textbook sections, workbook, teacher’s manual and tutor scripts. The draft appears below for you to read and review.'
            : 'Draft a fresh version from the scheme again. Existing versions are kept; the new one starts as a draft and has to be reviewed and approved.'}
        </P>
        {runtime.mode === 'demo' ? (
          <Banner tone="warning" title="Demo: a stand-in model answers, not Claude">
            <P>
              It replays prepared sample content shaped for this unit. Real drafts come from Claude
              when the app runs against the live project.
            </P>
          </Banner>
        ) : null}
        <TextField
          label="Notes for Claude (optional)"
          hint="For example: keep the market story, use cassava as the example. Up to 2,000 characters."
          value={notes}
          onChangeText={setNotes}
          lines={2}
          editable={!running}
          error={notes.length > 2000 ? 'Keep the notes under 2,000 characters.' : null}
        />
        {generate.error || revise.error ? (
          <Banner tone="danger" title="The job could not be started" testID="start-error">
            <P>{(generate.error ?? revise.error)?.message}</P>
          </Banner>
        ) : null}
        <Row>
          <Button
            label="Draft with Claude"
            onPress={() => void generate.run()}
            busy={generate.busy}
            disabled={Boolean(denied) || running || notes.length > 2000}
            reason={denied ?? (running ? 'A job is already running for this unit.' : null)}
          />
        </Row>
      </Section>

      {job.job ? (
        <View style={{ gap: space[3] }}>
          <JobPanel
            job={job.job}
            driving={job.driving}
            error={job.error}
            onCancel={() => void job.cancel()}
            onResume={() => void job.resume(job.job?.id ?? '')}
            canCancel={!denied}
            modelNote={modelNote}
            title={job.job.kind === 'unit_revise' ? 'Revising the unit' : 'Drafting the unit'}
          />
          {job.job.status === 'succeeded' && outcome ? (
            <Banner
              tone="success"
              title={`Version ${outcome.version} is ready as a draft`}
              testID="draft-outcome"
            >
              <P>{outcome.summary}</P>
              <Small>
                Lint: {outcome.errors} error{outcome.errors === 1 ? '' : 's'}, {outcome.warnings}{' '}
                warning
                {outcome.warnings === 1 ? '' : 's'}. Read it below before you submit it for review.
              </Small>
            </Banner>
          ) : null}
          {isTerminal(job.job.status) ? (
            <Row>
              <Button label="Dismiss" variant="ghost" small onPress={() => job.reset()} />
            </Row>
          ) : null}
        </View>
      ) : null}

      <Async
        state={versions}
        loadingLabel="Loading versions…"
        onSignInAgain={() => void recheckAuth()}
      >
        {(all) =>
          all.length === 0 || !selected ? (
            <EmptyState title="No draft yet">
              <P>Nothing has been drafted for this unit. Press “Draft with Claude” above.</P>
            </EmptyState>
          ) : (
            <View style={{ gap: space[4] }}>
              <Section
                title={`Reading version ${selected.version}`}
                action={
                  <View style={{ minWidth: 300 }}>
                    <Select
                      label="Version"
                      hideLabel
                      value={selected.id}
                      options={all.map(versionOption)}
                      onChange={(id) => {
                        setSelectedId(id);
                        setJump(null);
                      }}
                    />
                  </View>
                }
              >
                <Row>
                  <VersionStatusBadge status={selected.status} />
                  <Badge
                    label={selected.generated_by === 'ai' ? 'AI draft' : 'Human'}
                    tone="neutral"
                  />
                  {selected.model ? (
                    <Badge
                      label={
                        selected.model === DEMO_MODEL_ID
                          ? `${selected.model} (stand-in, not Claude)`
                          : selected.model
                      }
                      tone={selected.model === DEMO_MODEL_ID ? 'warning' : 'neutral'}
                      glyph={selected.model === DEMO_MODEL_ID ? '⚑' : undefined}
                    />
                  ) : null}
                  {selected.prompt_version ? <Small>prompt {selected.prompt_version}</Small> : null}
                  <Small>{formatDateTime(selected.created_at)}</Small>
                </Row>
                {!isLatest ? (
                  <Banner tone="info" title="You are reading an older version">
                    <P>Only the latest version can be revised or moved through review.</P>
                  </Banner>
                ) : null}
                <View
                  style={{
                    flexDirection: twoColumns ? 'row' : 'column',
                    gap: space[4],
                    alignItems: 'flex-start',
                  }}
                >
                  <View
                    style={{
                      flex: twoColumns ? 3 : undefined,
                      width: twoColumns ? undefined : '100%',
                      minWidth: 0,
                      // The preview stays in view while you read the checks beside it.
                      ...(twoColumns ? { alignSelf: 'stretch' as const } : {}),
                    }}
                  >
                    <View
                      style={
                        twoColumns ? ({ position: 'sticky', top: space[3] } as object) : undefined
                      }
                    >
                      {content.error ? (
                        <ErrorState error={content.error} onRetry={content.reload} />
                      ) : !content.data || !parsed ? (
                        <Loading label="Loading the draft…" />
                      ) : parsed.unit ? (
                        <UnitPreview versionId={selected.id} unit={parsed.unit} jump={jump} />
                      ) : (
                        <Banner
                          tone="danger"
                          title="This draft cannot be previewed"
                          testID="parse-failed"
                        >
                          <P>
                            The content does not parse as a unit. The problems are listed under
                            Lint.
                          </P>
                        </Banner>
                      )}
                    </View>
                  </View>
                  <View
                    style={{
                      flex: twoColumns ? 2 : undefined,
                      width: twoColumns ? undefined : '100%',
                      gap: space[4],
                      minWidth: 0,
                    }}
                  >
                    {lint ? (
                      <LintPanel lint={lint} unit={content.data?.content} onJump={onJump} />
                    ) : (
                      <Loading label="Checking…" />
                    )}
                    <ReviseBox
                      key={`${latest?.id}`}
                      unit={parsed?.unit ?? null}
                      versionNo={selected.version}
                      busy={revise.busy || running}
                      disabledReason={reviseReason}
                      onRevise={(instruction, sectionIds) =>
                        void revise.run(instruction, sectionIds)
                      }
                    />
                  </View>
                </View>
              </Section>
              <WorkflowBar
                key={selected.id}
                version={selected}
                unitTitle={context.unit.title}
                isLatest={isLatest}
                lintBlocking={lint?.blocking ?? true}
                onChanged={() => versions.reload()}
              />
              <VersionHistory versions={all} selectedId={selected.id} onSelect={setSelectedId} />
            </View>
          )
        }
      </Async>
    </View>
  );
}

export default function UnitWorkspaceScreen(): ReactNode {
  const { unitId, saved } = useLocalSearchParams<{ unitId: string; saved?: string }>();
  const api = useApi();
  const { recheckAuth } = useRuntime();
  const { role } = useSession();
  const router = useGuardedRouter();
  const catalog = useCatalog();
  const context = useLoad(() => api.units.get(unitId), [api, unitId]);
  usePageTitle(
    context.data ? `Unit ${context.data.unit.unit_no}: ${context.data.unit.title}` : 'Unit',
  );

  return (
    <Async
      state={context}
      loadingLabel="Loading the unit…"
      onSignInAgain={() => void recheckAuth()}
    >
      {(data) => (
        <Async state={catalog}>
          {(names) => {
            const schemeTitle = `${names.subjectName(data.scheme.subject_id)} · ${names.levelName(data.scheme.level_code)} · Term ${data.scheme.term}`;
            return (
              <View style={{ gap: space[4] }}>
                <PageHeader
                  title={`Unit ${data.unit.unit_no}: ${data.unit.title}`}
                  subtitle={`Chapter ${data.chapter.number}: ${data.chapter.title}${data.unit.week_no ? ` · Week ${data.unit.week_no}` : ''} · ${schemeTitle}`}
                  crumbs={[
                    { label: 'Schemes', href: '/schemes' },
                    {
                      label: schemeTitle,
                      href: {
                        pathname: '/schemes/[schemeId]',
                        params: { schemeId: data.scheme.id },
                      },
                    },
                    {
                      label: 'Chapters',
                      href: {
                        pathname: '/schemes/[schemeId]/chapters',
                        params: { schemeId: data.scheme.id },
                      },
                    },
                    { label: `Unit ${data.unit.unit_no}` },
                  ]}
                  actions={
                    <Button
                      label={
                        can(role, 'unit.edit') ? 'Edit by hand' : 'Open the editor (read only)'
                      }
                      variant="secondary"
                      testID="edit-by-hand"
                      onPress={() =>
                        router.push({
                          pathname: '/units/[unitId]/edit',
                          params: { unitId: data.unit.id },
                        })
                      }
                    />
                  }
                  badges={
                    <>
                      <ContentStatusBadge status={data.unit.status} />
                      <Text style={{ fontSize: 12, color: colors.subtle }}>
                        {data.unit.kind.replace(/_/g, ' ')} · stage {data.unit.stage}
                      </Text>
                    </>
                  }
                />
                {saved ? (
                  <Banner
                    tone="success"
                    title={`Saved as version ${saved}, a draft written by a person`}
                    testID="saved-banner"
                  >
                    <P>
                      Nothing is approved or published yet. Read it below, then submit it for review
                      like any other draft.
                    </P>
                  </Banner>
                ) : null}
                <Workspace key={data.unit.id} context={data} />
              </View>
            );
          }}
        </Async>
      )}
    </Async>
  );
}
