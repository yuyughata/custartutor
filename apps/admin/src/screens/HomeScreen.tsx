import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { HomeSummary, ReviewItem, SchemeSummary } from '../api/types';
import { useCatalog, schemeLabel, type Catalog } from '../hooks/useCatalog';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatRelative, pluralize } from '../lib/format';
import { jobHeadline } from '../lib/jobText';
import { can, roleLabel } from '../lib/roles';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { AppLink } from '../ui/AppLink';
import { JobStatusBadge, VersionStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Card, Row, Section } from '../ui/Card';
import { PageHeader } from '../ui/PageHeader';
import { Async, EmptyState } from '../ui/States';
import { H3, P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';

function CountTile({ label, value, tone }: { label: string; value: number; tone?: 'attention' }): ReactNode {
  const attention = tone === 'attention' && value > 0;
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flexGrow: 1,
        flexBasis: 140,
        minWidth: 140,
        maxWidth: 240,
        padding: space[3],
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: attention ? colors.amber : colors.border,
        backgroundColor: attention ? colors.amberTint : colors.white,
        gap: 2,
      }}
    >
      <Text style={{ fontSize: 28, lineHeight: 34, fontWeight: '800', color: colors.primaryDark }}>{value}</Text>
      <Text style={{ fontSize: 13, color: colors.textSoft }}>{label}</Text>
    </View>
  );
}

function SchemeItem({ scheme, catalog }: { scheme: SchemeSummary; catalog: Catalog }): ReactNode {
  return (
    <Row>
      <AppLink href={{ pathname: '/schemes/[schemeId]', params: { schemeId: scheme.id } }}>
        {schemeLabel(catalog, scheme)}
      </AppLink>
      <Small>{pluralize(scheme.teaching_week_count, 'teaching week')}</Small>
    </Row>
  );
}

function VersionItem({ item }: { item: ReviewItem }): ReactNode {
  return (
    <Row>
      <AppLink href={{ pathname: '/units/[unitId]', params: { unitId: item.unit_id } }}>
        {`Unit ${item.unit_no}: ${item.unit_title}`}
      </AppLink>
      <Small>version {item.version}</Small>
      <VersionStatusBadge status={item.status} />
      <Small>{formatRelative(item.created_at)}</Small>
    </Row>
  );
}

function TodoList({ summary, catalog }: { summary: HomeSummary; catalog: Catalog }): ReactNode {
  const { schemesAwaitingApproval, versionsInReview, versionsReadyToPublish, jobsNeedingAttention } = summary;
  const nothing =
    schemesAwaitingApproval.length +
      versionsInReview.length +
      versionsReadyToPublish.length +
      jobsNeedingAttention.length ===
    0;
  if (nothing) {
    return (
      <EmptyState title="Nothing needs your attention">
        <P>No schemes are waiting for approval, no units are waiting for review and no jobs are running or failed.</P>
      </EmptyState>
    );
  }
  return (
    <View style={{ gap: space[4] }}>
      {schemesAwaitingApproval.length > 0 ? (
        <Section title={`Schemes awaiting approval (${schemesAwaitingApproval.length})`} testID="todo-schemes">
          {schemesAwaitingApproval.map((scheme) => (
            <SchemeItem key={scheme.id} scheme={scheme} catalog={catalog} />
          ))}
        </Section>
      ) : null}
      {versionsInReview.length > 0 ? (
        <Section title={`Units awaiting review (${versionsInReview.length})`} testID="todo-review">
          {versionsInReview.map((item) => (
            <VersionItem key={item.version_id} item={item} />
          ))}
        </Section>
      ) : null}
      {versionsReadyToPublish.length > 0 ? (
        <Section title={`Approved and ready to publish (${versionsReadyToPublish.length})`} testID="todo-publish">
          {versionsReadyToPublish.map((item) => (
            <VersionItem key={item.version_id} item={item} />
          ))}
        </Section>
      ) : null}
      {jobsNeedingAttention.length > 0 ? (
        <Section title={`Jobs running or failed (${jobsNeedingAttention.length})`} testID="todo-jobs">
          {jobsNeedingAttention.map((job) => (
            <Row key={job.id}>
              <AppLink href={{ pathname: '/jobs/[jobId]', params: { jobId: job.id } }}>{jobHeadline(job)}</AppLink>
              <JobStatusBadge status={job.status} />
              <Small>{formatRelative(job.created_at)}</Small>
            </Row>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

export default function HomeScreen(): ReactNode {
  usePageTitle('Home');
  const api = useApi();
  const { runtime, recheckAuth } = useRuntime();
  const { role, email } = useSession();
  const canSeeContent = can(role, 'content.view');
  const catalog = useCatalog();
  const summary = useLoad(() => (canSeeContent ? api.home.summary() : Promise.resolve(null)), [api, canSeeContent]);

  return (
    <View style={{ gap: space[5] }}>
      <PageHeader
        title="Home"
        subtitle={`Signed in as ${email} (${roleLabel(role)}).`}
      />

      {!canSeeContent ? (
        <Banner tone="info" title="Your role has no content screens">
          <P>
            {can(role, 'usage.view')
              ? 'You can see AI usage and cost under Usage & settings.'
              : 'Ask a super admin if you need access to content or usage.'}
          </P>
          {can(role, 'usage.view') ? <AppLink href="/usage">Open Usage & settings</AppLink> : null}
        </Banner>
      ) : (
        <Async state={summary} loadingLabel="Loading your to-do list…" onSignInAgain={() => void recheckAuth()}>
          {(data) =>
            data === null ? null : (
              <>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }} testID="home-counts">
                  <CountTile label="Schemes" value={data.counts.schemes} />
                  <CountTile label="Approved schemes" value={data.counts.schemesApproved} />
                  <CountTile label="Units" value={data.counts.units} />
                  <CountTile label="Awaiting review" value={data.counts.versionsInReview} tone="attention" />
                  <CountTile label="Ready to publish" value={data.counts.versionsReadyToPublish} tone="attention" />
                  <CountTile label="Jobs running" value={data.counts.jobsRunning} />
                  <CountTile label="Jobs failed" value={data.counts.jobsFailed} tone="attention" />
                </View>
                <View style={{ gap: space[2] }}>
                  <H3>To do</H3>
                  <Async state={catalog}>{(loaded) => <TodoList summary={data} catalog={loaded} />}</Async>
                </View>
              </>
            )
          }
        </Async>
      )}

      <Card>
        <H3>Quick links</H3>
        <Row gap={space[5]}>
          {can(role, 'job.start') ? <AppLink href="/schemes/new">New scheme from a document</AppLink> : null}
          {canSeeContent ? <AppLink href="/schemes">Schemes</AppLink> : null}
          {canSeeContent ? <AppLink href="/characters">Characters</AppLink> : null}
          {canSeeContent ? <AppLink href="/jobs">Jobs</AppLink> : null}
          {can(role, 'usage.view') || can(role, 'settings.view') ? <AppLink href="/usage">Usage & settings</AppLink> : null}
          {runtime.mode === 'demo' ? <AppLink href="/preview">Dev: fixture preview</AppLink> : null}
        </Row>
      </Card>
    </View>
  );
}
