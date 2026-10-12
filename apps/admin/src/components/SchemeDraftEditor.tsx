// The editable scheme draft: the flags, the source note, the weeks table, and the buttons that save and approve.
// Nothing is claimed as saved until the RPC resolved, and leaving with unsaved edits asks first.
import { useMemo, useState, type ReactNode } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import type { Flag } from '@custar/authoring-core';
import { WEEK_KINDS, type LevelCode, type SchemeWeek } from '@custar/content-schema';
import { useAction } from '../hooks/useAction';
import { formatDateTime } from '../lib/format';
import { flagsForWeek, sortFlags } from '../lib/flags';
import { whyNot } from '../lib/roles';
import {
  addWeek,
  countByKind,
  hasErrors,
  issuesForRow,
  normalizeWeeks,
  removeWeek,
  subtopicsToText,
  textToSubtopics,
  updateWeek,
  validateWeeks,
  weekKindLabel,
  weeksEqual,
} from '../lib/weekEdit';
import { useApi, useSession } from '../runtime/RuntimeProvider';
import { useUnsavedChanges } from '../runtime/UnsavedGuard';
import type { TermNumber } from '../api/types';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/Dialog';
import { Section } from '../ui/Card';
import { NumberField, TextField } from '../ui/Fields';
import { Select } from '../ui/Select';
import { Label, P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';
import { FlagList } from './FlagList';

export interface SchemeDraftEditorProps {
  subjectId: string;
  subjectName: string;
  levelCode: LevelCode;
  levelName: string;
  term: TermNumber;
  initialWeeks: SchemeWeek[];
  initialSourceNote: string;
  flags: readonly Flag[];
  /** The id of the saved draft, when this is an already saved scheme. Null for a fresh extraction. */
  schemeId: string | null;
  onSaved?: (schemeId: string) => void;
  onApproved?: (schemeId: string) => void;
}

const KIND_OPTIONS = WEEK_KINDS.map((kind) => ({ value: kind, label: weekKindLabel(kind) }));
const WIDE_TABLE = 1180;

function WeekRow({
  week,
  index,
  wide,
  disabled,
  flags,
  messages,
  onChange,
  onRemove,
}: {
  week: SchemeWeek;
  index: number;
  wide: boolean;
  disabled: boolean;
  flags: Flag[];
  messages: { severity: 'error' | 'warning'; message: string }[];
  onChange: (patch: Partial<SchemeWeek>) => void;
  onRemove: () => void;
}): ReactNode {
  const row = index + 1;
  const hasError = messages.some((message) => message.severity === 'error');
  return (
    <View
      role="row"
      style={{
        gap: space[2],
        padding: space[3],
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: hasError ? colors.dangerTint : colors.white,
      }}
    >
      <View
        style={{ flexDirection: wide ? 'row' : 'column', gap: space[3], alignItems: 'flex-start' }}
      >
        <View role="cell" style={{ width: wide ? 76 : 120 }}>
          <NumberField
            label={`Week number, row ${row}`}
            value={Number.isFinite(week.week_no) ? week.week_no : null}
            onNumber={(value) => onChange({ week_no: value ?? Number.NaN })}
            hideLabel={wide}
          />
        </View>
        <View role="cell" style={{ width: wide ? 160 : '100%' }}>
          <Select
            label={`Kind, row ${row}`}
            hideLabel={wide}
            value={week.kind}
            options={KIND_OPTIONS}
            onChange={(value) => {
              const kind = WEEK_KINDS.find((candidate) => candidate === value);
              if (kind) onChange({ kind });
            }}
            disabled={disabled}
          />
        </View>
        <View
          role="cell"
          style={{ flex: wide ? 1 : undefined, width: wide ? undefined : '100%', minWidth: 200 }}
        >
          <TextField
            label={`Topic, row ${row}`}
            hideLabel={wide}
            value={week.topic}
            onChangeText={(topic) => onChange({ topic })}
            multiline
            lines={2}
            editable={!disabled}
          />
        </View>
        <View
          role="cell"
          style={{ flex: wide ? 2 : undefined, width: wide ? undefined : '100%', minWidth: 240 }}
        >
          <TextField
            label={`Subtopics, row ${row}`}
            hideLabel={wide}
            hint={wide ? undefined : 'One per line.'}
            value={subtopicsToText(week.subtopics)}
            onChangeText={(text) => onChange({ subtopics: textToSubtopics(text) })}
            lines={Math.min(6, Math.max(2, week.subtopics.length + 1))}
            editable={!disabled}
          />
        </View>
        <View role="cell" style={{ width: wide ? 84 : undefined }}>
          <Button
            label="Remove"
            accessibilityLabel={`Remove week ${Number.isFinite(week.week_no) ? week.week_no : row}`}
            variant="secondary"
            small
            onPress={onRemove}
            disabled={disabled}
          />
        </View>
      </View>
      {messages.map((message, at) => (
        <Text
          key={`${message.message}-${at}`}
          accessibilityRole={message.severity === 'error' ? 'alert' : 'text'}
          style={{
            color: message.severity === 'error' ? colors.danger : colors.amberText,
            fontSize: 13,
          }}
        >
          {message.severity === 'error' ? '✕ ' : '⚠ '}
          {message.message}
        </Text>
      ))}
      {flags.length > 0 ? (
        <View
          style={{
            gap: space[1],
            backgroundColor: colors.amberTint,
            padding: space[2],
            borderRadius: radii.md,
          }}
        >
          <Small>Model notes about this week</Small>
          {sortFlags(flags).map((flag, at) => (
            <Text key={`${flag.code}-${at}`} style={{ fontSize: 13, color: colors.text }}>
              <Text style={{ fontWeight: '700' }}>
                {flag.severity === 'concern' ? 'Concern: ' : 'Note: '}
              </Text>
              {flag.message}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function SchemeDraftEditor(props: SchemeDraftEditorProps): ReactNode {
  const api = useApi();
  const { role } = useSession();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_TABLE;

  const [weeks, setWeeks] = useState<SchemeWeek[]>(props.initialWeeks);
  const [sourceNote, setSourceNote] = useState(props.initialSourceNote);
  const [schemeId, setSchemeId] = useState<string | null>(props.schemeId);
  const [saved, setSaved] = useState<{ weeks: SchemeWeek[]; note: string; at: Date } | null>(
    props.schemeId
      ? { weeks: props.initialWeeks, note: props.initialSourceNote, at: new Date(0) }
      : null,
  );
  const [approved, setApproved] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);

  const issues = useMemo(() => validateWeeks(weeks), [weeks]);
  const blocked = hasErrors(issues);
  const edited =
    saved === null || !weeksEqual(weeks, saved.weeks) || sourceNote.trim() !== saved.note.trim();
  useUnsavedChanges(edited && !approved);

  const counts = countByKind(weeks);
  const canSave = whyNot(role, 'scheme.save');
  const canApprove = whyNot(role, 'scheme.approve');

  const save = useAction(async () => {
    const clean = normalizeWeeks(weeks);
    const out = await api.schemes.saveDraft({
      subjectId: props.subjectId,
      levelCode: props.levelCode,
      term: props.term,
      weeks: clean,
      sourceNote: sourceNote.trim(),
    });
    // Only now, after the RPC resolved, is anything shown as saved.
    setSchemeId(out.schemeId);
    setWeeks(clean);
    setSaved({ weeks: clean, note: sourceNote.trim(), at: new Date() });
    props.onSaved?.(out.schemeId);
    return out.schemeId;
  });

  const approve = useAction(async () => {
    if (!schemeId) return;
    await api.schemes.approve(schemeId);
    setApproved(true);
    setConfirmApprove(false);
    props.onApproved?.(schemeId);
  });

  const approveReason = canApprove
    ? canApprove
    : schemeId === null
      ? 'Save the draft first.'
      : edited
        ? 'Save your changes first.'
        : blocked
          ? 'Fix the problems in the table first.'
          : null;

  if (approved) {
    return (
      <Banner tone="success" title="Scheme approved" testID="scheme-approved">
        <P>
          {props.subjectName} · {props.levelName} · Term {props.term} is approved. The weeks can no
          longer be edited here. You can now plan its chapters.
        </P>
      </Banner>
    );
  }

  const status = save.busy
    ? 'Saving…'
    : saved === null
      ? 'Not saved yet. This draft exists only on this page until you save it.'
      : edited
        ? 'Unsaved changes.'
        : saved.at.getTime() === 0
          ? 'Saved as a draft.'
          : `Saved as a draft at ${formatDateTime(saved.at.toISOString())}.`;

  return (
    <View style={{ gap: space[4] }}>
      {props.flags.length > 0 ? (
        <Section title="Notes from the model" tone="muted" testID="scheme-flags">
          <P>
            The model flagged these while reading the document. They are advisory: check each one
            against the source, then correct the table below.
          </P>
          <FlagList flags={props.flags} />
        </Section>
      ) : null}

      <Section title="Source note">
        <TextField
          label="Source note"
          hint="Where this scheme came from (document, page, who checked it). Saved with the scheme."
          value={sourceNote}
          onChangeText={setSourceNote}
          lines={2}
        />
      </Section>

      <Section
        title={`Weeks (${counts.teaching} teaching, ${counts.other} other)`}
        action={
          <Button
            label="Add week"
            variant="secondary"
            small
            onPress={() => setWeeks(addWeek(weeks))}
          />
        }
      >
        <View
          role="table"
          aria-label="Scheme weeks"
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.md,
            overflow: 'hidden',
          }}
        >
          {wide ? (
            <View
              role="row"
              style={{
                flexDirection: 'row',
                gap: space[3],
                padding: space[3],
                backgroundColor: colors.page,
                borderBottomWidth: 2,
                borderBottomColor: colors.border,
              }}
            >
              <View role="columnheader" style={{ width: 76 }}>
                <Label>Week</Label>
              </View>
              <View role="columnheader" style={{ width: 160 }}>
                <Label>Kind</Label>
              </View>
              <View role="columnheader" style={{ flex: 1 }}>
                <Label>Topic</Label>
              </View>
              <View role="columnheader" style={{ flex: 2 }}>
                <Label>Subtopics (one per line)</Label>
              </View>
              <View role="columnheader" style={{ width: 84 }}>
                <Label>Row</Label>
              </View>
            </View>
          ) : null}
          {weeks.length === 0 ? (
            <View style={{ padding: space[4] }}>
              <P>There are no weeks. Use “Add week”.</P>
            </View>
          ) : null}
          {weeks.map((week, index) => (
            <WeekRow
              key={index}
              week={week}
              index={index}
              wide={wide}
              disabled={false}
              flags={flagsForWeek(props.flags, week.week_no)}
              messages={issuesForRow(issues, index)}
              onChange={(patch) => setWeeks(updateWeek(weeks, index, patch))}
              onRemove={() => setWeeks(removeWeek(weeks, index))}
            />
          ))}
        </View>
        {issues
          .filter((issue) => issue.index === -1)
          .map((issue) => (
            <Text
              key={issue.message}
              accessibilityRole="alert"
              style={{ color: colors.danger, fontSize: 14 }}
            >
              ✕ {issue.message}
            </Text>
          ))}
      </Section>

      <View style={{ gap: space[3] }}>
        {save.error ? (
          <Banner tone="danger" title="The draft was not saved" testID="save-error">
            <P>{save.error.message}</P>
          </Banner>
        ) : null}
        {approve.error ? (
          <Banner tone="danger" title="The scheme was not approved" testID="approve-error">
            <P>{approve.error.message}</P>
          </Banner>
        ) : null}
        <P testID="scheme-save-status">{status}</P>
        <View
          style={{
            flexDirection: 'row',
            gap: space[4],
            flexWrap: 'wrap',
            alignItems: 'flex-start',
          }}
        >
          <Button
            label="Save as draft"
            onPress={() => void save.run()}
            busy={save.busy}
            disabled={Boolean(canSave) || blocked || !edited}
            reason={
              canSave ??
              (blocked
                ? 'Fix the problems marked in the table first.'
                : !edited
                  ? 'Nothing has changed since the last save.'
                  : null)
            }
          />
          <Button
            label="Approve scheme"
            variant="secondary"
            onPress={() => setConfirmApprove(true)}
            disabled={approveReason !== null}
            reason={approveReason}
          />
        </View>
      </View>

      <ConfirmDialog
        visible={confirmApprove}
        title="Approve this scheme?"
        confirmLabel="Approve scheme"
        busy={approve.busy}
        onConfirm={() => void approve.run()}
        onCancel={() => setConfirmApprove(false)}
      >
        <View style={{ gap: space[2] }}>
          <P>
            {props.subjectName} · {props.levelName} · Term {props.term}: {counts.teaching} teaching
            weeks.
          </P>
          <P>
            An approved scheme can no longer be replaced or edited here, and chapters can be planned
            from it. Approving does not publish anything to learners.
          </P>
        </View>
      </ConfirmDialog>
    </View>
  );
}
