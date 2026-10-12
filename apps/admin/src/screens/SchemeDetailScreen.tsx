import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { SchemeDetail } from '../api/types';
import { SchemeDraftEditor } from '../components/SchemeDraftEditor';
import { useCatalog } from '../hooks/useCatalog';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { weekKindLabel } from '../lib/weekEdit';
import { useApi, useRuntime } from '../runtime/RuntimeProvider';
import { AppLink } from '../ui/AppLink';
import { SchemeStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Section } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { PageHeader } from '../ui/PageHeader';
import { Async } from '../ui/States';
import { P, Small } from '../ui/Text';
import { space } from '../ui/theme';

function ReadOnlyWeeks({ scheme }: { scheme: SchemeDetail }): ReactNode {
  const columns: Column<SchemeDetail['weeks'][number]>[] = [
    { key: 'week', header: 'Week', width: 70, render: (week) => <P>{week.week_no}</P> },
    {
      key: 'kind',
      header: 'Kind',
      width: 140,
      render: (week) => <P>{weekKindLabel(week.kind)}</P>,
    },
    { key: 'topic', header: 'Topic', flex: 1, render: (week) => <P>{week.topic}</P> },
    {
      key: 'subtopics',
      header: 'Subtopics',
      flex: 2,
      render: (week) => (
        <View style={{ gap: 2 }}>
          {week.subtopics.map((line, index) => (
            <Small key={index}>• {line}</Small>
          ))}
        </View>
      ),
    },
  ];
  return (
    <DataTable
      label="Scheme weeks"
      columns={columns}
      rows={scheme.weeks}
      rowKey={(week) => String(week.week_no)}
      minWidth={720}
    />
  );
}

export default function SchemeDetailScreen(): ReactNode {
  const { schemeId } = useLocalSearchParams<{ schemeId: string }>();
  const api = useApi();
  const { recheckAuth } = useRuntime();
  const catalog = useCatalog();
  const scheme = useLoad(() => api.schemes.get(schemeId), [api, schemeId]);
  usePageTitle(scheme.data ? 'Scheme' : 'Scheme');

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
                  title={title}
                  crumbs={[{ label: 'Schemes', href: '/schemes' }, { label: title }]}
                  badges={<SchemeStatusBadge status={data.status} />}
                  subtitle={data.source_note ?? undefined}
                  actions={
                    data.status === 'approved' ? (
                      <AppLink
                        href={{
                          pathname: '/schemes/[schemeId]/chapters',
                          params: { schemeId: data.id },
                        }}
                      >
                        Plan chapters and units
                      </AppLink>
                    ) : undefined
                  }
                />
                {data.status === 'draft' ? (
                  <>
                    <Banner tone="warning" title="This scheme is a draft">
                      <P>
                        It has not been approved. A reviewer or super admin approves it once the
                        weeks match the source.
                      </P>
                    </Banner>
                    <SchemeDraftEditor
                      key={`${data.id}-${data.weeks.length}`}
                      subjectId={data.subject_id}
                      subjectName={names.subjectName(data.subject_id)}
                      levelCode={data.level_code}
                      levelName={names.levelName(data.level_code)}
                      term={data.term}
                      initialWeeks={data.weeks}
                      initialSourceNote={data.source_note ?? ''}
                      flags={[]}
                      schemeId={data.id}
                      onApproved={() => scheme.reload()}
                    />
                  </>
                ) : (
                  <Section title={`Weeks (${data.teaching_week_count} teaching)`}>
                    {data.status === 'approved' ? (
                      <Banner tone="success" title="Approved">
                        <P>The weeks are fixed. Chapters and units are planned from them.</P>
                      </Banner>
                    ) : null}
                    <ReadOnlyWeeks scheme={data} />
                  </Section>
                )}
              </View>
            );
          }}
        </Async>
      )}
    </Async>
  );
}
