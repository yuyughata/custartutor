import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { SchemeSummary } from '../api/types';
import { useCatalog, type Catalog } from '../hooks/useCatalog';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatDate } from '../lib/format';
import { whyNot } from '../lib/roles';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { AppLink } from '../ui/AppLink';
import { SchemeStatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Row } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { Select } from '../ui/Select';
import { Async, EmptyState } from '../ui/States';
import { P } from '../ui/Text';
import { PageHeader } from '../ui/PageHeader';
import { useGuardedRouter } from '../runtime/UnsavedGuard';
import { space } from '../ui/theme';

function SchemeTable({ schemes, catalog }: { schemes: SchemeSummary[]; catalog: Catalog }): ReactNode {
  const columns: Column<SchemeSummary>[] = [
    {
      key: 'subject',
      header: 'Subject',
      flex: 2,
      render: (scheme) => (
        <AppLink href={{ pathname: '/schemes/[schemeId]', params: { schemeId: scheme.id } }}>
          {catalog.subjectName(scheme.subject_id)}
        </AppLink>
      ),
    },
    { key: 'level', header: 'Level', width: 120, render: (scheme) => <P>{catalog.levelName(scheme.level_code)}</P> },
    { key: 'term', header: 'Term', width: 80, render: (scheme) => <P>Term {scheme.term}</P> },
    { key: 'status', header: 'Status', width: 130, render: (scheme) => <SchemeStatusBadge status={scheme.status} /> },
    {
      key: 'weeks',
      header: 'Weeks',
      width: 150,
      render: (scheme) => (
        <P>
          {scheme.teaching_week_count} teaching / {scheme.week_count}
        </P>
      ),
    },
    { key: 'created', header: 'Created', width: 120, render: (scheme) => <P>{formatDate(scheme.created_at)}</P> },
    {
      key: 'open',
      header: 'Open',
      width: 150,
      render: (scheme) =>
        scheme.status === 'approved' ? (
          <AppLink href={{ pathname: '/schemes/[schemeId]/chapters', params: { schemeId: scheme.id } }}>
            Chapters
          </AppLink>
        ) : (
          <AppLink href={{ pathname: '/schemes/[schemeId]', params: { schemeId: scheme.id } }}>Review draft</AppLink>
        ),
    },
  ];
  return (
    <DataTable
      label="Schemes of work"
      columns={columns}
      rows={schemes}
      rowKey={(scheme) => scheme.id}
      minWidth={820}
      empty={
        <EmptyState title="No schemes match">
          <P>Change the filters to see more.</P>
        </EmptyState>
      }
    />
  );
}

export default function SchemesScreen(): ReactNode {
  usePageTitle('Schemes');
  const api = useApi();
  const { role } = useSession();
  const router = useGuardedRouter();
  const { runtime } = useRuntime();
  const catalog = useCatalog();
  const schemes = useLoad(() => api.schemes.list(), [api]);
  const [subject, setSubject] = useState('');
  const [status, setStatus] = useState('');
  const denied = whyNot(role, 'job.start');

  return (
    <View style={{ gap: space[4] }}>
      <PageHeader
        title="Schemes of work"
        subtitle="The NERDC base layer for each subject, level and term. A scheme is read from a document, checked by a person, approved, and only then turned into chapters and units."
        actions={
          <Button
            label="New scheme from a document"
            onPress={() => router.push('/schemes/new')}
            disabled={Boolean(denied)}
            reason={denied}
          />
        }
      />
      <Async state={catalog}>
        {(loaded) => (
          <Async state={schemes}>
            {(all) => {
              if (all.length === 0) {
                return (
                  <EmptyState
                    title="No schemes yet"
                    action={
                      denied ? undefined : (
                        <Button label="New scheme from a document" onPress={() => router.push('/schemes/new')} />
                      )
                    }
                  >
                    <P>
                      Upload a scheme of work (PDF, Word or pasted text) and Claude will draft the weeks for you to check.
                      {runtime.mode === 'demo' ? ' In this demo the stand-in model returns sample content.' : ''}
                    </P>
                  </EmptyState>
                );
              }
              const shown = all
                .filter((scheme) => subject === '' || scheme.subject_id === subject)
                .filter((scheme) => status === '' || scheme.status === status)
                .sort(
                  (a, b) =>
                    loaded.subjectName(a.subject_id).localeCompare(loaded.subjectName(b.subject_id)) ||
                    a.level_code.localeCompare(b.level_code) ||
                    a.term - b.term,
                );
              return (
                <View style={{ gap: space[3] }}>
                  <Row gap={space[4]} align="flex-end">
                    <View style={{ minWidth: 220 }}>
                      <Select
                        label="Subject"
                        value={subject}
                        options={[
                          { value: '', label: 'All subjects' },
                          ...loaded.subjects
                            .filter((entry) => all.some((scheme) => scheme.subject_id === entry.id))
                            .map((entry) => ({ value: entry.id, label: entry.name })),
                        ]}
                        onChange={setSubject}
                      />
                    </View>
                    <View style={{ minWidth: 180 }}>
                      <Select
                        label="Status"
                        value={status}
                        options={[
                          { value: '', label: 'Any status' },
                          { value: 'draft', label: 'Draft' },
                          { value: 'approved', label: 'Approved' },
                        ]}
                        onChange={setStatus}
                      />
                    </View>
                    <Text accessibilityLiveRegion="polite" style={{ fontSize: 13 }}>
                      {shown.length} of {all.length} scheme{all.length === 1 ? '' : 's'}
                    </Text>
                  </Row>
                  <SchemeTable schemes={shown} catalog={loaded} />
                </View>
              );
            }}
          </Async>
        )}
      </Async>
    </View>
  );
}
