// The review workflow for one version: Submit for review, Approve / Send back, and Publish. Every step is a
// separate button pressed by a person; there is no button that skips a step. Publish asks for an explicit
// confirmation, then calls publish_unit_version and the publish-pack function, and shows the pack hash or the
// error. Nothing is shown as done until the call resolved.
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { AdminApiError } from '../api/errors';
import type { PackResult, UnitVersionSummary } from '../api/types';
import { useAction } from '../hooks/useAction';
import { useLoad } from '../hooks/useLoad';
import { formatDateTime } from '../lib/format';
import { whyNot } from '../lib/roles';
import { workflowActions } from '../lib/workflow';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { VersionStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Section } from '../ui/Card';
import { ConfirmDialog } from '../ui/Dialog';
import { Mono, P, Small } from '../ui/Text';
import { colors, space } from '../ui/theme';

type PublishState =
  | { phase: 'idle' }
  | {
      phase: 'published';
      publishedUnitId: string;
      pack: PackResult | null;
      packError: AdminApiError | null;
    };

function PackInfo({ pack }: { pack: PackResult }): ReactNode {
  if (pack.demo) {
    return (
      <Banner tone="warning" title="Demo: recorded only" testID="pack-demo">
        <P>No lesson pack was built and nothing reached any learner. In live mode this step builds the pack and shows its hash.</P>
      </Banner>
    );
  }
  return (
    <Banner tone="success" title={pack.already_built ? 'Published. The pack was already built.' : 'Published and the pack is built'} testID="pack-built">
      <Small>Pack hash (SHA-256)</Small>
      <Mono>{pack.content_hash}</Mono>
      <Small>
        {pack.files !== null ? `${pack.files} files · ` : ''}manifest {pack.manifest_path}
      </Small>
    </Banner>
  );
}

export function WorkflowBar({
  version,
  unitTitle,
  isLatest,
  lintBlocking,
  onChanged,
}: {
  version: UnitVersionSummary;
  unitTitle: string;
  isLatest: boolean;
  lintBlocking: boolean;
  onChanged: () => void;
}): ReactNode {
  const api = useApi();
  const { runtime } = useRuntime();
  const { role } = useSession();
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [published, setPublished] = useState<PublishState>({ phase: 'idle' });
  const actions = workflowActions({ status: version.status, role, lintBlocking, isLatest });

  const publication = useLoad(
    () => (version.status === 'published' ? api.units.publication(version.id) : Promise.resolve(null)),
    [api, version.id, version.status],
  );

  const move = useAction(async (to: 'draft' | 'in_review' | 'approved') => {
    await api.units.setVersionStatus(version.id, to);
    onChanged();
  });

  const publish = useAction(async () => {
    const { publishedUnitId } = await api.units.publishVersion(version.id);
    // The version is published as soon as this resolved, even if the pack step below fails.
    onChanged();
    let pack: PackResult | null = null;
    let packError: AdminApiError | null = null;
    try {
      pack = await api.units.buildPack(publishedUnitId);
    } catch (cause) {
      packError = cause as AdminApiError;
    }
    setPublished({ phase: 'published', publishedUnitId, pack, packError });
    publication.reload();
  });

  const retryPack = useAction(async () => {
    if (published.phase !== 'published') return;
    const pack = await api.units.buildPack(published.publishedUnitId);
    setPublished({ ...published, pack, packError: null });
    publication.reload();
  });

  const buildExisting = useAction(async () => {
    const info = publication.data;
    if (!info) return;
    await api.units.buildPack(info.id);
    publication.reload();
  });

  const modeNote = runtime.mode === 'demo' ? ' Demo: nothing is actually published.' : '';

  return (
    <Section title="Review and publish" testID="workflow-bar">
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Text style={{ fontSize: 14, color: colors.textSoft }}>Version {version.version} is</Text>
        <VersionStatusBadge status={version.status} />
      </View>
      <Small>
        Draft → In review → Approved → Published. Claude never moves a version forward: each step is a person pressing
        a button, and publishing needs an approved version.
      </Small>
      {!isLatest && ['draft', 'in_review', 'approved'].includes(version.status) ? (
        <Small>This is not the latest version, so it cannot move through the workflow. Select the latest version.</Small>
      ) : null}

      {move.error ? (
        <Banner tone="danger" title="The status was not changed" testID="move-error">
          <P>{move.error.message}</P>
        </Banner>
      ) : null}
      {publish.error ? (
        <Banner tone="danger" title="Not published" testID="publish-error">
          <P>{publish.error.message}</P>
        </Banner>
      ) : null}

      <View style={{ flexDirection: 'row', gap: space[4], flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {actions.map((action) => (
          <Button
            key={action.id}
            label={action.label}
            variant={action.tone === 'primary' ? 'primary' : 'secondary'}
            busy={action.id === 'publish' ? publish.busy : move.busy}
            disabled={!action.enabled}
            reason={action.reason}
            onPress={() => {
              if (action.id === 'publish') setConfirmPublish(true);
              else if (action.to) void move.run(action.to);
            }}
          />
        ))}
        {actions.length === 0 && version.status !== 'published' ? <Small>No workflow step is available for this version.</Small> : null}
      </View>

      {version.status === 'published' ? (
        <View style={{ gap: space[2] }} testID="publication-info">
          {publication.data ? (
            <>
              <P>
                Published {formatDateTime(publication.data.published_at)}
                {publication.data.is_current ? ' and current.' : ' (a newer version has replaced it).'}
              </P>
              {publication.data.content_hash ? (
                <View style={{ gap: 2 }}>
                  <Small>Pack hash (SHA-256)</Small>
                  <Mono>{publication.data.content_hash}</Mono>
                </View>
              ) : (
                <Banner tone="warning" title="The lesson pack is not built yet">
                  <P>Learners cannot download this version until its pack is built.</P>
                  {retryPack.error || buildExisting.error ? (
                    <P>{(buildExisting.error ?? retryPack.error)?.message}</P>
                  ) : null}
                  <Button
                    label="Build the pack"
                    small
                    onPress={() => void buildExisting.run()}
                    busy={buildExisting.busy}
                    disabled={Boolean(whyNot(role, 'version.publish'))}
                    reason={whyNot(role, 'version.publish')}
                  />
                </Banner>
              )}
            </>
          ) : publication.loading ? (
            <Small>Checking the publication…</Small>
          ) : null}
        </View>
      ) : null}

      {published.phase === 'published' ? (
        <View style={{ gap: space[2] }} testID="publish-result">
          {published.pack ? <PackInfo pack={published.pack} /> : null}
          {published.packError ? (
            <Banner tone="warning" title="Published, but the pack was not built" testID="pack-error">
              <P>{published.packError.message}</P>
              <P>The version is published. Learners cannot download it until the pack is built.</P>
              {retryPack.error ? <P>{retryPack.error.message}</P> : null}
              <Button label="Build the pack again" small onPress={() => void retryPack.run()} busy={retryPack.busy} />
            </Banner>
          ) : null}
        </View>
      ) : null}

      <ConfirmDialog
        visible={confirmPublish}
        title={`Publish version ${version.version} of “${unitTitle}”?`}
        confirmLabel={`Publish version ${version.version}`}
        busy={publish.busy}
        onConfirm={() => void publish.run().then(() => setConfirmPublish(false))}
        onCancel={() => setConfirmPublish(false)}
      >
        <View style={{ gap: space[2] }}>
          <P>This version was approved by a person. Publishing makes it the version learners’ devices download.</P>
          <P>Two steps follow: the version is published, then its lesson pack is built. If the pack step fails, the version stays published and you can build the pack again.</P>
          <P>Publishing cannot be undone here. To replace it, approve and publish a newer version.{modeNote}</P>
        </View>
      </ConfirmDialog>
    </Section>
  );
}
