// Usage & settings: what the model calls cost (never "0" where there is no price), and the controls around them:
// kill switch, caps, model names and prices. Super admins edit; everyone else with access reads. Every save
// goes through set_app_setting and nothing is shown as saved until it resolved.
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { AiSettings } from '@custar/authoring-core';
import type { UsageBucket, UsageSummary } from '../api/types';
import { useAction } from '../hooks/useAction';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatCost, formatDateTime, formatTokens, pluralize } from '../lib/format';
import { can, whyNot } from '../lib/roles';
import {
  RANGE_LABELS,
  capText,
  emptyPriceRow,
  modelsMissingPrice,
  parseCap,
  pricesEqual,
  pricesFromRows,
  rowsFromPrices,
  usageRange,
  validatePriceRows,
  type PriceRow,
  type RangePreset,
} from '../lib/usage';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { useUnsavedChanges } from '../runtime/UnsavedGuard';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Row, Section } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { TextField, Toggle } from '../ui/Fields';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { Async, EmptyState } from '../ui/States';
import { P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';

function Tile({ label, value, note }: { label: string; value: string; note?: string }): ReactNode {
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flexGrow: 1,
        flexBasis: 150,
        minWidth: 150,
        maxWidth: 260,
        padding: space[3],
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.white,
        gap: 2,
      }}
    >
      <Text style={{ fontSize: 24, lineHeight: 30, fontWeight: '800', color: colors.primaryDark }}>
        {value}
      </Text>
      <Text style={{ fontSize: 13, color: colors.textSoft }}>{label}</Text>
      {note ? <Text style={{ fontSize: 12, color: colors.subtle }}>{note}</Text> : null}
    </View>
  );
}

function bucketColumns<Row extends UsageBucket>(
  name: string,
  key: (row: Row) => string,
): Column<Row>[] {
  return [
    { key: 'name', header: name, flex: 1.6, render: (row) => <P>{key(row)}</P> },
    {
      key: 'calls',
      header: 'Calls',
      width: 80,
      align: 'right',
      render: (row) => <P>{row.calls}</P>,
    },
    {
      key: 'in',
      header: 'Input',
      width: 100,
      align: 'right',
      render: (row) => <P>{formatTokens(row.input_tokens)}</P>,
    },
    {
      key: 'out',
      header: 'Output',
      width: 100,
      align: 'right',
      render: (row) => <P>{formatTokens(row.output_tokens)}</P>,
    },
    {
      key: 'cr',
      header: 'Cache read',
      width: 110,
      align: 'right',
      render: (row) => <P>{formatTokens(row.cache_read_tokens)}</P>,
    },
    {
      key: 'cw',
      header: 'Cache write',
      width: 110,
      align: 'right',
      render: (row) => <P>{formatTokens(row.cache_creation_tokens)}</P>,
    },
    {
      key: 'cost',
      header: 'Est. cost',
      width: 150,
      align: 'right',
      render: (row) => <P>{formatCost(row.est_cost_usd, row.unpriced_calls)}</P>,
    },
  ];
}

function UsageTables({ summary }: { summary: UsageSummary }): ReactNode {
  return (
    <View style={{ gap: space[4] }}>
      <Section title="By day">
        <DataTable
          label="Usage by day"
          columns={bucketColumns<UsageSummary['by_day'][number]>('Day', (row) => row.day)}
          rows={summary.by_day}
          rowKey={(row) => row.day}
          minWidth={760}
          empty={<Small>No calls in this period.</Small>}
        />
      </Section>
      <Section title="By model">
        <DataTable
          label="Usage by model"
          columns={bucketColumns<UsageSummary['by_model'][number]>('Model', (row) => row.model)}
          rows={summary.by_model}
          rowKey={(row) => row.model}
          minWidth={760}
          empty={<Small>No calls in this period.</Small>}
        />
      </Section>
      <Section title="By kind of job">
        <DataTable
          label="Usage by kind"
          columns={bucketColumns<UsageSummary['by_kind'][number]>('Kind', (row) =>
            row.kind.replace(/_/g, ' '),
          )}
          rows={summary.by_kind}
          rowKey={(row) => row.kind}
          minWidth={760}
          empty={<Small>No calls in this period.</Small>}
        />
      </Section>
    </View>
  );
}

function UsagePanel(): ReactNode {
  const api = useApi();
  const { runtime } = useRuntime();
  const [preset, setPreset] = useState<RangePreset>('30d');
  const range = usageRange(preset);
  const summary = useLoad(() => api.usage.summary(range), [api, range.from, range.to]);
  return (
    <Section
      title="Usage"
      testID="usage-panel"
      action={
        <View style={{ minWidth: 200 }}>
          <Select
            label="Period"
            hideLabel
            value={preset}
            options={(Object.keys(RANGE_LABELS) as RangePreset[]).map((value) => ({
              value,
              label: RANGE_LABELS[value],
            }))}
            onChange={(value) => setPreset(value as RangePreset)}
          />
        </View>
      }
    >
      {runtime.mode === 'demo' ? (
        <Banner tone="warning" title="Demo usage">
          <P>
            These are the calls the stand-in model reported during this demo session. They are not
            real Claude usage or cost.
          </P>
        </Banner>
      ) : null}
      <Async state={summary} loadingLabel="Loading usage…">
        {(data) => (
          <View style={{ gap: space[4] }}>
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}
              testID="usage-totals"
            >
              <Tile label="Model calls" value={String(data.totals.calls)} />
              <Tile label="Input tokens" value={formatTokens(data.totals.input_tokens)} />
              <Tile label="Output tokens" value={formatTokens(data.totals.output_tokens)} />
              <Tile label="Cache read tokens" value={formatTokens(data.totals.cache_read_tokens)} />
              <Tile
                label="Cache write tokens"
                value={formatTokens(data.totals.cache_creation_tokens)}
              />
              <Tile
                label="Estimated cost"
                value={formatCost(data.totals.est_cost_usd, data.totals.unpriced_calls)}
                note={
                  data.totals.est_cost_usd === null
                    ? 'No price entered for the model(s) used'
                    : undefined
                }
              />
            </View>
            {Object.keys(data.totals.jobs_by_status).length > 0 ? (
              <Small>
                Jobs:{' '}
                {Object.entries(data.totals.jobs_by_status)
                  .map(([status, count]) => `${pluralize(count, 'job')} ${status}`)
                  .join(', ')}
              </Small>
            ) : null}
            {data.totals.calls === 0 ? (
              <EmptyState title="No model calls in this period">
                <P>Calls appear here after a scheme is read or a unit is drafted.</P>
              </EmptyState>
            ) : (
              <UsageTables summary={data} />
            )}
            <Small>
              Cost shows “unknown” where no price has been entered for the model. Unknown is not
              zero: it means the cost cannot be worked out.
            </Small>
          </View>
        )}
      </Async>
    </Section>
  );
}

// --- settings --------------------------------------------------------------------------------------

function SavedLine({
  busy,
  dirty,
  savedAt,
}: {
  busy: boolean;
  dirty: boolean;
  savedAt: Date | null;
}): ReactNode {
  return (
    <Small>
      {busy
        ? 'Saving…'
        : dirty
          ? 'Unsaved changes.'
          : savedAt
            ? `Saved at ${formatDateTime(savedAt.toISOString())}.`
            : 'Up to date.'}
    </Small>
  );
}

function KillSwitch({
  settings,
  editable,
  onSaved,
}: {
  settings: AiSettings;
  editable: boolean;
  onSaved: () => void;
}): ReactNode {
  const api = useApi();
  const save = useAction(async (value: boolean) => {
    await api.settings.set('ai.kill_switch', value);
    onSaved();
  });
  return (
    <Section title="Kill switch" testID="kill-switch">
      <Toggle
        label="Stop all AI jobs"
        value={settings.kill_switch}
        onChange={(value) => void save.run(value)}
        disabled={!editable || save.busy}
        hint="When on, no new Claude call is made by any job. Running jobs stop at their next step."
      />
      <P>
        {settings.kill_switch
          ? 'The kill switch is ON: AI drafting is stopped.'
          : 'The kill switch is off: AI drafting is allowed.'}
      </P>
      {save.error ? (
        <Banner tone="danger" title="The kill switch was not changed">
          <P>{save.error.message}</P>
        </Banner>
      ) : null}
    </Section>
  );
}

function Budgets({
  settings,
  editable,
  onSaved,
}: {
  settings: AiSettings;
  editable: boolean;
  onSaved: () => void;
}): ReactNode {
  const api = useApi();
  const [perJob, setPerJob] = useState(capText(settings.budget.max_usd_per_job));
  const [daily, setDaily] = useState(capText(settings.budget.daily_usd_cap));
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const a = parseCap(perJob);
  const b = parseCap(daily);
  const dirty =
    a.value !== settings.budget.max_usd_per_job || b.value !== settings.budget.daily_usd_cap;
  useUnsavedChanges(dirty);
  const save = useAction(async () => {
    if (a.problem || b.problem) return;
    await api.settings.set('ai.budget', { max_usd_per_job: a.value, daily_usd_cap: b.value });
    setSavedAt(new Date());
    onSaved();
  });
  return (
    <Section title="Spending caps" testID="budgets">
      <Small>
        Caps in US dollars, checked before every step. Only calls with a price entered count towards
        a cap. Leave empty for no cap.
      </Small>
      <Row align="flex-start" gap={space[4]}>
        <View style={{ width: 220 }}>
          <TextField
            label="Cap per job (USD)"
            value={perJob}
            onChangeText={setPerJob}
            keyboardType="decimal-pad"
            error={a.problem ?? null}
            editable={editable}
          />
        </View>
        <View style={{ width: 220 }}>
          <TextField
            label="Daily cap (USD)"
            value={daily}
            onChangeText={setDaily}
            keyboardType="decimal-pad"
            error={b.problem ?? null}
            editable={editable}
          />
        </View>
      </Row>
      {save.error ? (
        <Banner tone="danger" title="The caps were not saved">
          <P>{save.error.message}</P>
        </Banner>
      ) : null}
      <Row align="flex-start">
        <Button
          label="Save caps"
          onPress={() => void save.run()}
          busy={save.busy}
          disabled={!editable || !dirty || Boolean(a.problem || b.problem)}
        />
        <SavedLine busy={save.busy} dirty={dirty} savedAt={savedAt} />
      </Row>
    </Section>
  );
}

function Models({
  settings,
  editable,
  onSaved,
}: {
  settings: AiSettings;
  editable: boolean;
  onSaved: () => void;
}): ReactNode {
  const api = useApi();
  const { runtime } = useRuntime();
  const [models, setModels] = useState(settings.models);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const dirty = JSON.stringify(models) !== JSON.stringify(settings.models);
  const blank = Object.values(models).some((name) => name.trim() === '');
  useUnsavedChanges(dirty);
  const save = useAction(async () => {
    if (blank) return;
    await api.settings.set('ai.models', {
      authoring: models.authoring.trim(),
      tutor: models.tutor.trim(),
      moderation: models.moderation.trim(),
    });
    setSavedAt(new Date());
    onSaved();
  });
  return (
    <Section title="Models" testID="models">
      <Small>
        The model used for each kind of work. Authoring writes drafts, tutor talks with pupils,
        moderation checks messages.
        {runtime.mode === 'demo'
          ? ' In demo mode the stand-in model answers whatever these say.'
          : ''}
      </Small>
      <Row align="flex-start" gap={space[4]}>
        {(['authoring', 'tutor', 'moderation'] as const).map((task) => (
          <View key={task} style={{ minWidth: 220, flexGrow: 1 }}>
            <TextField
              label={`Model for ${task}`}
              value={models[task]}
              onChangeText={(value) => setModels({ ...models, [task]: value })}
              editable={editable}
              error={models[task].trim() === '' ? 'Enter a model name.' : null}
              mono
            />
          </View>
        ))}
      </Row>
      {save.error ? (
        <Banner tone="danger" title="The models were not saved">
          <P>{save.error.message}</P>
        </Banner>
      ) : null}
      <Row align="flex-start">
        <Button
          label="Save models"
          onPress={() => void save.run()}
          busy={save.busy}
          disabled={!editable || !dirty || blank}
        />
        <SavedLine busy={save.busy} dirty={dirty} savedAt={savedAt} />
      </Row>
    </Section>
  );
}

function Prices({
  settings,
  editable,
  onSaved,
}: {
  settings: AiSettings;
  editable: boolean;
  onSaved: () => void;
}): ReactNode {
  const api = useApi();
  const [rows, setRows] = useState<PriceRow[]>(rowsFromPrices(settings.prices));
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const validation = validatePriceRows(rows);
  const dirty = !pricesEqual(rows, settings.prices);
  const missing = modelsMissingPrice(settings.models, settings.prices);
  useUnsavedChanges(dirty);
  const save = useAction(async () => {
    if (!validation.ok) return;
    await api.settings.set('ai.prices', pricesFromRows(rows));
    setSavedAt(new Date());
    onSaved();
  });
  const patch = (index: number, change: Partial<PriceRow>): void =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  const fields: { key: keyof Omit<PriceRow, 'model'>; label: string }[] = [
    { key: 'input', label: 'Input' },
    { key: 'output', label: 'Output' },
    { key: 'cacheRead', label: 'Cache read' },
    { key: 'cacheWrite', label: 'Cache write' },
  ];
  return (
    <Section
      title="Prices"
      testID="prices"
      action={
        <Button
          label="Add a model"
          variant="secondary"
          small
          disabled={!editable}
          onPress={() =>
            setRows([
              ...rows,
              emptyPriceRow(
                missing.find((model) => !rows.some((row) => row.model === model)) ?? '',
              ),
            ])
          }
        />
      }
    >
      <Banner tone="info" title="Prices are entered by the owner">
        <P>
          US dollars per million tokens. Nothing is built in, so cost estimates are only as right as
          these numbers; a model with no price shows its cost as “unknown”.
        </P>
      </Banner>
      {missing.length > 0 ? (
        <Small>
          No price yet for: {missing.join(', ')}. Their calls are counted but their cost is unknown.
        </Small>
      ) : null}
      {rows.length === 0 ? <Small>No prices entered.</Small> : null}
      {rows.map((row, index) => (
        <View
          key={index}
          style={{
            gap: space[2],
            padding: space[3],
            borderRadius: radii.md,
            borderWidth: 1,
            borderColor: validation.rows[index] ? colors.danger : colors.border,
          }}
        >
          <Row align="flex-start" gap={space[3]}>
            <View style={{ minWidth: 220, flexGrow: 1 }}>
              <TextField
                label={`Model name, price row ${index + 1}`}
                visibleLabel="Model name"
                value={row.model}
                onChangeText={(model) => patch(index, { model })}
                editable={editable}
                mono
              />
            </View>
            {fields.map((field) => (
              <View key={field.key} style={{ width: 120 }}>
                <TextField
                  label={`${field.label} per million tokens, row ${index + 1}`}
                  visibleLabel={`${field.label} $/M`}
                  value={row[field.key]}
                  onChangeText={(value) => patch(index, { [field.key]: value })}
                  keyboardType="decimal-pad"
                  editable={editable}
                />
              </View>
            ))}
            <Button
              label="Remove"
              accessibilityLabel={`Remove price row ${index + 1}`}
              variant="secondary"
              small
              disabled={!editable}
              onPress={() => setRows(rows.filter((_, at) => at !== index))}
            />
          </Row>
          {validation.rows[index] ? (
            <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13 }}>
              ✕ {validation.rows[index]}
            </Text>
          ) : null}
        </View>
      ))}
      {save.error ? (
        <Banner tone="danger" title="The prices were not saved">
          <P>{save.error.message}</P>
        </Banner>
      ) : null}
      <Row align="flex-start">
        <Button
          label="Save prices"
          onPress={() => void save.run()}
          busy={save.busy}
          disabled={!editable || !dirty || !validation.ok}
        />
        <SavedLine busy={save.busy} dirty={dirty} savedAt={savedAt} />
      </Row>
    </Section>
  );
}

function SettingsPanel(): ReactNode {
  const api = useApi();
  const { role } = useSession();
  const settings = useLoad(() => api.settings.get(), [api]);
  const editable = can(role, 'settings.edit');
  return (
    <View style={{ gap: space[4] }} testID="settings-panel">
      {!editable ? (
        <Banner tone="info" title="You can read these settings but not change them">
          <P>{whyNot(role, 'settings.edit')}</P>
        </Banner>
      ) : null}
      <Async state={settings} loadingLabel="Loading settings…">
        {(data) => (
          <View style={{ gap: space[4] }}>
            <KillSwitch settings={data} editable={editable} onSaved={settings.reload} />
            <Budgets settings={data} editable={editable} onSaved={settings.reload} />
            <Models settings={data} editable={editable} onSaved={settings.reload} />
            <Prices settings={data} editable={editable} onSaved={settings.reload} />
            <Small>Prompt version: {data.prompt_version}</Small>
          </View>
        )}
      </Async>
    </View>
  );
}

export default function UsageScreen(): ReactNode {
  usePageTitle('Usage & settings');
  const { role } = useSession();
  return (
    <View style={{ gap: space[4] }}>
      <PageHeader
        title="Usage & settings"
        subtitle="What Claude calls cost, and the switches around them."
      />
      {can(role, 'usage.view') ? (
        <UsagePanel />
      ) : (
        <Banner tone="info" title="Your role cannot see usage totals">
          <P>{whyNot(role, 'usage.view')}</P>
        </Banner>
      )}
      {can(role, 'settings.view') ? <SettingsPanel /> : null}
    </View>
  );
}
