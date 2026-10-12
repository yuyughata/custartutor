// Every version of a unit with its provenance (who made it, which model, which prompt version, when) and a
// section-level diff between any two versions.
import { useMemo, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { UnitVersionSummary } from '../api/types';
import { useLoad } from '../hooks/useLoad';
import { diffUnits } from '../lib/diff';
import { formatDateTime } from '../lib/format';
import { DEMO_MODEL_ID } from '../demo/modelName';
import { useApi } from '../runtime/RuntimeProvider';
import { Badge, VersionStatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Section } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { Select } from '../ui/Select';
import { ErrorState, Loading } from '../ui/States';
import { P, Small } from '../ui/Text';
import { space } from '../ui/theme';
import { DiffView } from './DiffView';

function lintCounts(report: unknown): { errors: number; warnings: number } | null {
  if (typeof report !== 'object' || report === null) return null;
  const record = report as { errors?: unknown; warnings?: unknown };
  return {
    errors: Array.isArray(record.errors) ? record.errors.length : 0,
    warnings: Array.isArray(record.warnings) ? record.warnings.length : 0,
  };
}

function ModelCell({ version }: { version: UnitVersionSummary }): ReactNode {
  if (version.generated_by === 'human' && !version.model) return <Small>none (human)</Small>;
  return (
    <View style={{ gap: 2 }}>
      <Text selectable style={{ fontSize: 13, fontFamily: 'monospace' }}>
        {version.model ?? 'unknown'}
      </Text>
      {version.model === DEMO_MODEL_ID ? (
        <Badge label="stand-in, not Claude" tone="warning" glyph="⚑" />
      ) : null}
    </View>
  );
}

function VersionDiff({
  fromId,
  toId,
  labels,
}: {
  fromId: string;
  toId: string;
  labels: { from: string; to: string };
}): ReactNode {
  const api = useApi();
  const from = useLoad(() => api.units.version(fromId), [api, fromId]);
  const to = useLoad(() => api.units.version(toId), [api, toId]);
  const diff = useMemo(
    () => (from.data && to.data ? diffUnits(from.data.content, to.data.content) : null),
    [from.data, to.data],
  );
  if (from.error || to.error) {
    return (
      <ErrorState
        error={from.error ?? to.error}
        onRetry={() => {
          from.reload();
          to.reload();
        }}
      />
    );
  }
  if (!diff) return <Loading label="Comparing…" />;
  return <DiffView diff={diff} fromLabel={labels.from} toLabel={labels.to} />;
}

export function VersionHistory({
  versions,
  selectedId,
  onSelect,
}: {
  versions: UnitVersionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  const selected = versions.find((version) => version.id === selectedId) ?? versions[0];
  const defaultFrom =
    versions.find((version) => selected && version.version === selected.version - 1)?.id ?? '';
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const from = fromId ?? defaultFrom;
  const to = toId ?? selected?.id ?? '';
  const fromVersion = versions.find((version) => version.id === from);
  const toVersion = versions.find((version) => version.id === to);

  const columns: Column<UnitVersionSummary>[] = [
    {
      key: 'version',
      header: 'Version',
      width: 130,
      render: (version) => (
        <Text style={{ fontWeight: version.id === selected?.id ? '800' : '600', fontSize: 15 }}>
          {`v${version.version}${version.id === selected?.id ? ' (viewing)' : ''}`}
        </Text>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      render: (version) => <VersionStatusBadge status={version.status} />,
    },
    {
      key: 'by',
      header: 'Made by',
      width: 90,
      render: (version) => <P>{version.generated_by === 'ai' ? 'AI draft' : 'Human'}</P>,
    },
    {
      key: 'model',
      header: 'Model',
      flex: 1.4,
      render: (version) => <ModelCell version={version} />,
    },
    {
      key: 'prompt',
      header: 'Prompt',
      width: 90,
      render: (version) => <Small>{version.prompt_version ?? '–'}</Small>,
    },
    {
      key: 'time',
      header: 'Created',
      width: 140,
      render: (version) => <Small>{formatDateTime(version.created_at)}</Small>,
    },
    {
      key: 'lint',
      header: 'Lint',
      width: 100,
      render: (version) => {
        const counts = lintCounts(version.lint_report);
        return counts ? (
          <Small>
            {counts.errors} errors · {counts.warnings} warnings
          </Small>
        ) : (
          <Small>–</Small>
        );
      },
    },
    {
      key: 'view',
      header: '',
      width: 80,
      render: (version) => (
        <Button
          label="View"
          accessibilityLabel={`View version ${version.version}`}
          variant="secondary"
          small
          disabled={version.id === selected?.id}
          onPress={() => onSelect(version.id)}
        />
      ),
    },
  ];

  const options = versions.map((version) => ({
    value: version.id,
    label: `Version ${version.version} (${version.status.replace('_', ' ')})`,
  }));

  return (
    <Section title="Version history" testID="version-history">
      <DataTable
        label="Versions"
        columns={columns}
        rows={versions}
        rowKey={(version) => version.id}
        minWidth={820}
      />
      {versions.length < 2 ? (
        <Small>Only one version so far. Once there are two, you can compare them here.</Small>
      ) : (
        <View style={{ gap: space[3] }}>
          <View
            style={{
              flexDirection: 'row',
              gap: space[4],
              flexWrap: 'wrap',
              alignItems: 'flex-end',
            }}
          >
            <View style={{ minWidth: 240 }}>
              <Select
                label="Compare"
                value={from}
                options={options}
                placeholder="Choose a version"
                onChange={setFromId}
              />
            </View>
            <View style={{ minWidth: 240 }}>
              <Select
                label="with"
                value={to}
                options={options}
                placeholder="Choose a version"
                onChange={setToId}
              />
            </View>
          </View>
          {fromVersion && toVersion && fromVersion.id !== toVersion.id ? (
            <VersionDiff
              key={`${fromVersion.id}-${toVersion.id}`}
              fromId={fromVersion.id}
              toId={toVersion.id}
              labels={{
                from: `Version ${fromVersion.version}`,
                to: `Version ${toVersion.version}`,
              }}
            />
          ) : (
            <Small>Choose two different versions to see what changed, section by section.</Small>
          )}
        </View>
      )}
    </Section>
  );
}
