// A developer aid (demo mode only): the job and error states that are hard to reach in the demo flow, drawn from
// fixed data: a queued job, a step being retried, a job that failed, a cancelled job, and the error panels for an
// authenticator code that is needed again, an ended session, a refused action and a lost connection.
import { useState, type ReactNode } from 'react';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import type { JobRow } from '@custar/authoring-core';
import { AdminApiError } from '../api/errors';
import type { UnitVersionSummary } from '../api/types';
import { JobPanel } from '../components/JobPanel';
import { ConflictPanel } from '../editor/ui/ConflictPanel';
import { setAt } from '../editor/path';
import { usePageTitle } from '../hooks/usePageTitle';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Banner } from '../ui/Banner';
import { PageHeader } from '../ui/PageHeader';
import { ErrorState } from '../ui/States';
import { H2, P } from '../ui/Text';
import { Stack } from '../ui/Card';
import { space } from '../ui/theme';

const BASE: JobRow = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'unit_generate',
  status: 'running',
  progress: {
    done: ['outline', 'section:story_opener'],
    next: 'section:concept_1',
    total: 19,
  },
  lease_until: null,
  attempts: 0,
  error: null,
  result: null,
  unit_id: null,
  scheme_id: null,
  created_by: null,
  created_at: '2026-10-12T10:00:00Z',
  updated_at: '2026-10-12T10:00:30Z',
  finished_at: null,
};

const noop = (): void => undefined;

// The conflict screen of the unit editor, drawn from the golden unit: I changed two headings, version 3 changed one of
// the same headings differently and another section, so one item is a choice and two are taken automatically.
const CONFLICT_BASE: unknown = JSON.parse(JSON.stringify(goldenUnit2));
const CONFLICT_MINE = setAt(
  setAt(CONFLICT_BASE, ['sections', 2, 'heading'], 'Places in Our School (my wording)'),
  ['sections', 5, 'heading'],
  'Staying Safe (my wording)',
);
const CONFLICT_THEIRS = setAt(
  setAt(CONFLICT_BASE, ['sections', 2, 'heading'], 'Places in Our School (their wording)'),
  ['sections', 7, 'heading'],
  'Our Places Walk (their wording)',
);
const NEWER: UnitVersionSummary = {
  id: '00000000-0000-4000-8000-0000000000a3',
  unit_id: '00000000-0000-4000-8000-0000000000a0',
  version: 3,
  schema_version: 1,
  status: 'draft',
  generated_by: 'human',
  model: null,
  prompt_version: null,
  lint_report: null,
  base_version_id: null,
  created_by: null,
  created_at: '2026-10-12T11:30:00Z',
};

function ConflictFixture(): ReactNode {
  const [merged, setMerged] = useState<string | null>(null);
  return (
    <Stack gap={space[3]}>
      <ConflictPanel
        base={CONFLICT_BASE}
        mine={CONFLICT_MINE}
        theirs={CONFLICT_THEIRS}
        newer={NEWER}
        baseVersion={2}
        onUseMerged={(unit) => {
          const sections = (unit as { sections: { heading: string }[] }).sections;
          setMerged(
            `Combined: section 3 "${sections[2]?.heading}", section 6 "${sections[5]?.heading}", section 8 "${sections[7]?.heading}".`,
          );
        }}
        onDiscardMine={() => setMerged('Started again from the newer version.')}
        onBack={() => setMerged('Went back to editing.')}
      />
      {merged ? (
        <Banner tone="success" title="What the editor would do next" testID="conflict-result">
          <P>{merged}</P>
        </Banner>
      ) : null}
    </Stack>
  );
}

export default function PreviewStatesScreen(): ReactNode {
  usePageTitle('UI states');
  const { runtime } = useRuntime();
  if (runtime.mode !== 'demo') {
    return (
      <Banner tone="info" title="Only in demo mode">
        <P>This page is a developer aid and is not part of the live admin app.</P>
      </Banner>
    );
  }
  return (
    <Stack gap={space[5]}>
      <PageHeader
        title="UI states"
        subtitle="Job and error states drawn from fixed data (not model output)."
        crumbs={[{ label: 'Fixture preview', href: '/preview' }, { label: 'UI states' }]}
      />
      <H2>Job progress</H2>
      <JobPanel
        job={{ ...BASE, status: 'queued', progress: { done: [], next: 'outline', total: 19 } }}
        driving
        error={null}
        onCancel={noop}
        onResume={noop}
      />
      <JobPanel
        job={{
          ...BASE,
          attempts: 1,
          error: {
            code: 'transport',
            message: 'The service is busy (HTTP 529)',
            step: 'section:concept_1',
            retryable: true,
          },
        }}
        driving
        error={null}
        onCancel={noop}
        onResume={noop}
        title="A step is being retried"
      />
      <JobPanel
        job={{
          ...BASE,
          status: 'failed',
          error: {
            code: 'refusal',
            message: 'The model declined to write this section',
            step: 'section:concept_1',
            retryable: false,
          },
        }}
        driving={false}
        error={null}
        title="A job that failed"
      />
      <JobPanel
        job={{ ...BASE }}
        driving={false}
        error={null}
        onCancel={noop}
        onResume={noop}
        title="A job this page is not driving (left and came back)"
      />
      <JobPanel
        job={{ ...BASE, status: 'cancelled' }}
        driving={false}
        error={null}
        title="A cancelled job"
      />
      <H2>The unit editor: a save refused because a newer version exists</H2>
      <ConflictFixture />
      <H2>Errors</H2>
      <ErrorState
        error={
          new AdminApiError(
            'mfa_required',
            'mfa_required',
            'Authenticator code required. Enter the code from your authenticator app to continue.',
          )
        }
        onSignInAgain={noop}
      />
      <ErrorState
        error={
          new AdminApiError(
            'session_expired',
            'invalid_jwt',
            'Your session has expired. Please sign in again.',
          )
        }
        onSignInAgain={noop}
      />
      <ErrorState
        error={
          new AdminApiError(
            'forbidden',
            'admin_role_required',
            'Your role is not allowed to do this. Ask a super admin if you need access.',
          )
        }
      />
      <ErrorState
        error={
          new AdminApiError(
            'network',
            'network',
            'Could not reach the server. Check your internet connection and try again.',
          )
        }
        onRetry={noop}
      />
      <ErrorState
        error={
          new AdminApiError(
            'bad_response',
            'bad_response',
            'The server sent something unexpected for the new job. If this keeps happening, tell the developers.',
          )
        }
      />
    </Stack>
  );
}
