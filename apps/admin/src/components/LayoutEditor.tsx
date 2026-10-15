// The layout editor of the chapter planner: add units by hand (up to five in a chapter), remove a unit that has no
// versions, reorder inside a chapter, move a boundary unit to the neighbouring chapter, edit the details of a unit
// that has no draft, and add a chapter. Everything is edited in the browser; nothing happens until "Apply layout",
// which sends ONE atomic call (`apply_unit_layout`). The 3 to 5 units per chapter rule is shown here, enforced by the
// server and enforced again when a version is published.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Stage, UnitKind } from '@custar/content-schema';
import { renumberDetail } from '../api/errors';
import type { ApplyLayoutResult, ChapterRow } from '../api/types';
import { useAction } from '../hooks/useAction';
import {
  addChapter,
  addUnit,
  blankFields,
  canAddUnit,
  canEditDetails,
  canMoveToChapter,
  canMoveWithin,
  canRemoveUnit,
  draftChanged,
  draftFrom,
  draftToDoc,
  dropNewChapter,
  liveUnitCount,
  moveToChapter,
  moveWithin,
  numbering,
  removeUnit,
  setChapterTitle,
  setUnitFields,
  validateDraft,
  versionedChanges,
  type DraftChapter,
  type DraftUnit,
  type LayoutDraft,
} from '../lib/layoutDraft';
import { CHAPTER_MAX_UNITS, CHAPTER_MIN_UNITS, type UnitFields } from '../lib/unitLayout';
import { useApi } from '../runtime/RuntimeProvider';
import { useUnsavedChanges } from '../runtime/UnsavedGuard';
import { Badge, ContentStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card, Row } from '../ui/Card';
import { ConfirmDialog } from '../ui/Dialog';
import { NumberField, TextField } from '../ui/Fields';
import { Select } from '../ui/Select';
import { H3, Label, P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';

const KINDS: { value: UnitKind; label: string }[] = [
  { value: 'lesson', label: 'Lesson' },
  { value: 'revision', label: 'Revision' },
  { value: 'assessment', label: 'Assessment' },
  { value: 'mini_project', label: 'Mini project' },
  { value: 'term_project', label: 'Term project' },
];

const STAGES: { value: Stage; label: string }[] = [
  { value: 'absorb', label: 'Absorb' },
  { value: 'connect', label: 'Connect' },
  { value: 'express', label: 'Express' },
];

export interface LayoutWeek {
  week_no: number;
  topic: string;
}

function Labelled({
  label,
  children,
  minWidth,
  width,
}: {
  label: string;
  children: ReactNode;
  minWidth?: number;
  width?: number;
}): ReactNode {
  return (
    <View style={{ gap: space[1], ...(width ? { width } : {}), ...(minWidth ? { minWidth } : {}) }}>
      <Label>{label}</Label>
      {children}
    </View>
  );
}

/** What a unit that has drafts shows instead of a form: its fields as they are. */
function UnitFieldsSummary({
  fields,
  weeks,
}: {
  fields: UnitFields;
  weeks: readonly LayoutWeek[];
}): ReactNode {
  const week = weeks.find((w) => w.week_no === fields.week_no);
  return (
    <View style={{ gap: space[1] }} testID="unit-fields-summary">
      <Small>Title: {fields.title}</Small>
      <Small>Objective: {fields.objective}</Small>
      <Small>
        {KINDS.find((k) => k.value === fields.kind)?.label ?? fields.kind} · stage {fields.stage} ·{' '}
        {fields.periods} period
        {fields.periods === 1 ? '' : 's'}
        {week
          ? ` · week ${week.week_no}: ${week.topic}`
          : fields.week_no !== null
            ? ` · week ${fields.week_no}`
            : ''}
      </Small>
    </View>
  );
}

/** The fields of a unit: title, objective, kind, stage, periods, scheme week. */
function UnitFieldsForm({
  idPrefix,
  fields,
  weeks,
  onChange,
  disabled,
}: {
  idPrefix: string;
  fields: UnitFields;
  weeks: readonly LayoutWeek[];
  onChange: (patch: Partial<UnitFields>) => void;
  disabled?: boolean;
}): ReactNode {
  const fieldProps = disabled ? { editable: false } : {};
  return (
    <View style={{ gap: space[3] }}>
      <TextField
        label={`${idPrefix} title`}
        visibleLabel="Title"
        value={fields.title}
        onChangeText={(title) => onChange({ title })}
        {...fieldProps}
      />
      <TextField
        label={`${idPrefix} objective`}
        visibleLabel="Objective (what the child will learn, from the scheme of work)"
        value={fields.objective}
        onChangeText={(objective) => onChange({ objective })}
        lines={3}
        {...fieldProps}
      />
      <Row gap={space[3]}>
        <Labelled label="Kind" minWidth={170}>
          <Select
            label={`${idPrefix} kind`}
            hideLabel
            value={fields.kind}
            options={KINDS}
            disabled={disabled === true}
            onChange={(kind) => onChange({ kind: kind as UnitKind })}
          />
        </Labelled>
        <Labelled label="Stage" minWidth={150}>
          <Select
            label={`${idPrefix} stage`}
            hideLabel
            value={fields.stage}
            options={STAGES}
            disabled={disabled === true}
            onChange={(stage) => onChange({ stage: stage as Stage })}
          />
        </Labelled>
        <Labelled label="Periods" width={110}>
          <NumberField
            label={`${idPrefix} periods`}
            hideLabel
            value={fields.periods}
            onNumber={(periods) => onChange({ periods: periods ?? 0 })}
            hint="1 to 10"
          />
        </Labelled>
        <Labelled label="Scheme week" minWidth={220}>
          <Select
            label={`${idPrefix} scheme week`}
            hideLabel
            value={fields.week_no === null ? '' : String(fields.week_no)}
            disabled={disabled === true}
            options={[
              { value: '', label: 'No scheme week' },
              ...weeks.map((w) => ({
                value: String(w.week_no),
                label: `Week ${w.week_no}: ${w.topic.slice(0, 40)}`,
              })),
            ]}
            onChange={(value) => onChange({ week_no: value === '' ? null : Number(value) })}
          />
        </Labelled>
      </Row>
    </View>
  );
}

function AddUnitForm({
  chapterNumber,
  weeks,
  defaultStage,
  onAdd,
  onCancel,
}: {
  chapterNumber: number;
  weeks: readonly LayoutWeek[];
  defaultStage: Stage;
  onAdd: (fields: UnitFields) => void;
  onCancel: () => void;
}): ReactNode {
  const [fields, setFields] = useState<UnitFields>(blankFields(defaultStage));
  const problem =
    fields.title.trim() === ''
      ? 'Give the unit a title.'
      : fields.objective.trim() === ''
        ? 'Say what the child will learn.'
        : !Number.isInteger(fields.periods) || fields.periods < 1 || fields.periods > 10
          ? 'Periods must be a whole number from 1 to 10.'
          : null;
  return (
    <View
      testID={`add-unit-form-${chapterNumber}`}
      style={{
        gap: space[3],
        padding: space[3],
        borderWidth: 1.5,
        borderColor: colors.primary,
        borderRadius: radii.md,
        backgroundColor: colors.primaryTint,
      }}
    >
      <Text style={{ fontSize: 15, fontWeight: '800', color: colors.primaryDark }}>
        New unit in chapter {chapterNumber}
      </Text>
      <UnitFieldsForm
        idPrefix={`New unit in chapter ${chapterNumber}:`}
        fields={fields}
        weeks={weeks}
        onChange={(patch) => setFields({ ...fields, ...patch })}
      />
      <Small>
        It starts with no draft. It gets its number from its place in the term. You can then draft
        it with Claude or write it by hand (Edit by hand).
      </Small>
      <Row>
        <Button
          label="Add this unit"
          disabled={problem !== null}
          reason={problem}
          onPress={() =>
            onAdd({ ...fields, title: fields.title.trim(), objective: fields.objective.trim() })
          }
          testID={`add-unit-confirm-${chapterNumber}`}
        />
        <Button label="Cancel" variant="secondary" onPress={onCancel} />
      </Row>
    </View>
  );
}

function UnitLine({
  chapter,
  chapterIndex,
  unit,
  unitIndex,
  draft,
  number,
  weeks,
  expanded,
  onToggle,
  onChange,
  update,
}: {
  chapter: DraftChapter;
  chapterIndex: number;
  unit: DraftUnit;
  unitIndex: number;
  draft: LayoutDraft;
  number: number;
  weeks: readonly LayoutWeek[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<UnitFields>) => void;
  update: (next: LayoutDraft) => void;
}): ReactNode {
  const name = `unit ${number}`;
  const remove = canRemoveUnit(draft, chapterIndex, unitIndex);
  const up = canMoveWithin(draft, chapterIndex, unitIndex, -1);
  const down = canMoveWithin(draft, chapterIndex, unitIndex, 1);
  const prev = canMoveToChapter(draft, chapterIndex, unitIndex, 'previous');
  const next = canMoveToChapter(draft, chapterIndex, unitIndex, 'next');
  const edit = canEditDetails(unit);
  const renumbered = unit.currentNo !== null && unit.currentNo !== number;
  const moved = unit.id !== null && unit.chapterId !== chapter.id;
  const reasons = [
    !up.ok && unitIndex > 0 ? up.reason : null,
    !remove.ok ? remove.reason : null,
    !prev.ok && unitIndex === 0 && chapterIndex > 0 ? prev.reason : null,
    !next.ok && unitIndex === chapter.units.length - 1 && chapterIndex < draft.chapters.length - 1
      ? next.reason
      : null,
  ].filter((r): r is string => Boolean(r));
  return (
    <View
      testID={`layout-unit-${chapter.number}-${unitIndex + 1}`}
      style={{
        gap: space[2],
        padding: space[3],
        borderWidth: 1,
        borderColor: unit.id === null ? colors.primary : colors.border,
        borderRadius: radii.md,
        backgroundColor: colors.white,
      }}
    >
      <Row gap={space[2]}>
        <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>
          Unit {number}
          {renumbered ? ` (was ${unit.currentNo})` : ''}:{' '}
          {unit.fields.title.trim() === '' ? '(no title yet)' : unit.fields.title}
        </Text>
        {unit.id === null ? (
          <Badge label="New" tone="info" glyph="＋" />
        ) : (
          <ContentStatusBadge status={unit.published ? 'published' : 'draft'} />
        )}
        {unit.id !== null ? (
          unit.hasVersions ? (
            <Badge
              label={`${unit.versionCount} version${unit.versionCount === 1 ? '' : 's'}`}
              tone="neutral"
            />
          ) : (
            <Badge label="No draft yet" tone="neutral" />
          )
        ) : null}
        {moved ? (
          <Badge label={`Moved to chapter ${chapter.number}`} tone="warning" glyph="↔" />
        ) : null}
        {unit.fields.week_no !== null ? <Small>Week {unit.fields.week_no}</Small> : null}
      </Row>
      <Row gap={space[2]}>
        <Button
          label="↑"
          accessibilityLabel={`Move ${name} up`}
          small
          variant="secondary"
          disabled={!up.ok}
          onPress={() => update(moveWithin(draft, chapterIndex, unitIndex, -1))}
        />
        <Button
          label="↓"
          accessibilityLabel={`Move ${name} down`}
          small
          variant="secondary"
          disabled={!down.ok}
          onPress={() => update(moveWithin(draft, chapterIndex, unitIndex, 1))}
        />
        {chapterIndex > 0 && unitIndex === 0 ? (
          <Button
            label="To previous chapter"
            accessibilityLabel={`Move ${name} to the previous chapter`}
            small
            variant="secondary"
            disabled={!prev.ok}
            onPress={() => update(moveToChapter(draft, chapterIndex, unitIndex, 'previous'))}
          />
        ) : null}
        {chapterIndex < draft.chapters.length - 1 && unitIndex === chapter.units.length - 1 ? (
          <Button
            label="To next chapter"
            accessibilityLabel={`Move ${name} to the next chapter`}
            small
            variant="secondary"
            disabled={!next.ok}
            onPress={() => update(moveToChapter(draft, chapterIndex, unitIndex, 'next'))}
          />
        ) : null}
        <Button
          label="Edit details"
          accessibilityLabel={`${expanded ? 'Hide' : 'Show'} the details of ${name}`}
          small
          variant="ghost"
          onPress={onToggle}
        />
        <Button
          label="Remove"
          accessibilityLabel={`Remove ${name}`}
          small
          variant="secondary"
          disabled={!remove.ok}
          onPress={() => update(removeUnit(draft, chapterIndex, unitIndex))}
          testID={`remove-unit-${chapter.number}-${unitIndex + 1}`}
        />
      </Row>
      {reasons.map((reason) => (
        <Small key={reason}>{reason}</Small>
      ))}
      {expanded ? (
        <View style={{ gap: space[2] }}>
          {!edit.ok ? (
            <>
              <Small>{edit.reason}</Small>
              <UnitFieldsSummary fields={unit.fields} weeks={weeks} />
            </>
          ) : (
            <UnitFieldsForm
              idPrefix={`Unit ${number}:`}
              fields={unit.fields}
              weeks={weeks}
              onChange={onChange}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

export function LayoutEditor({
  schemeId,
  chapters,
  weeks,
  defaultStage,
  onApplied,
  onReload,
  onClose,
}: {
  schemeId: string;
  chapters: ChapterRow[];
  weeks: readonly LayoutWeek[];
  defaultStage: Stage;
  /** Called after the server accepted the layout, so the list behind it reloads. */
  onApplied: (result: ApplyLayoutResult) => void;
  onReload: () => void;
  onClose: () => void;
}): ReactNode {
  const api = useApi();
  const loaded = useMemo(() => draftFrom(chapters), [chapters]);
  const [draft, setDraft] = useState<LayoutDraft>(loaded);
  const [adding, setAdding] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<ReturnType<typeof versionedChanges> | null>(null);
  const [outcome, setOutcome] = useState<ApplyLayoutResult | null>(null);
  const [reloading, setReloading] = useState(false);
  const changed = draftChanged(draft, loaded);
  useUnsavedChanges(changed);

  // The chapters were loaded again (after an apply, or "Reload"): start from what the server has now.
  useEffect(() => {
    setDraft(loaded);
    setAdding(null);
    setExpanded(new Set());
    setReloading(false);
  }, [loaded]);

  const numbers = useMemo(() => numbering(draft), [draft]);
  const issues = useMemo(() => validateDraft(draft), [draft]);
  const total = liveUnitCount(draft);

  const apply = useAction(async (confirmRenumber: boolean) => {
    const result = await api.chapters.applyLayout(schemeId, draftToDoc(draft), { confirmRenumber });
    return result;
  });

  const runApply = async (confirmRenumber: boolean): Promise<void> => {
    setOutcome(null);
    const result = await apply.run(confirmRenumber);
    setConfirm(null);
    if (result) {
      setOutcome(result);
      setReloading(true);
      onApplied(result);
    }
  };

  const onApplyPressed = (): void => {
    const affected = versionedChanges(draft);
    if (affected.length > 0) setConfirm(affected);
    else void runApply(false);
  };

  const stale =
    apply.error?.code === 'layout_out_of_date' || apply.error?.code === 'chapter_order_changed';
  const renumber = renumberDetail(apply.error);
  // The server refused because a unit with drafts would change number (the page's own idea of the layout was out of
  // step): show what it says, and let the person confirm.
  const refusedKey = renumber ? JSON.stringify(renumber) : '';
  useEffect(() => {
    if (renumber)
      setConfirm(
        renumber.map((r) => ({ title: r.title, from: r.from, to: r.to, chapter: 0, moved: false })),
      );
  }, [refusedKey]);
  const disabledReason = reloading
    ? 'Loading the chapters again…'
    : !changed
      ? 'Nothing has changed yet.'
      : issues.length > 0
        ? `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix first (listed in red below).`
        : null;

  return (
    <View style={{ gap: space[3] }} testID="layout-editor">
      <Banner tone="info" title="Editing the layout. Nothing changes until you press Apply layout">
        <P>
          Add units by hand (a chapter holds {CHAPTER_MIN_UNITS} to {CHAPTER_MAX_UNITS}), reorder
          them, move the first or last unit of a chapter into the neighbouring chapter, or remove a
          unit that has no draft yet. A unit's number is its place in the term, so the numbers after
          a change move up or down by themselves. A unit that already has drafts is never deleted or
          rewritten here.
        </P>
      </Banner>

      {outcome ? (
        <Banner tone="success" title="Layout applied" testID="layout-applied">
          <P>
            {outcome.units} units in {outcome.chapters} chapters: {outcome.units_created} added,{' '}
            {outcome.units_updated} edited, {outcome.units_moved} moved to another chapter,{' '}
            {outcome.units_renumbered} renumbered, {outcome.units_archived} archived.
          </P>
        </Banner>
      ) : null}

      {stale ? (
        <Banner
          tone="warning"
          title="The chapters changed while you were editing"
          testID="layout-stale"
          action={<Button label="Reload the chapters" small onPress={onReload} />}
        >
          <P>
            Someone else changed the units of this scheme after you opened this page, so your layout
            would overwrite their change. Nothing was saved. Reload, then make your changes again.
          </P>
        </Banner>
      ) : apply.error && !renumber ? (
        <Banner tone="danger" title="The layout was not applied" testID="layout-error">
          <P>{apply.error.message}</P>
        </Banner>
      ) : null}

      {draft.chapters.map((chapter, ci) => {
        const count = chapter.units.length;
        const add = canAddUnit(chapter);
        const chapterIssues = issues.filter(
          (issue) => issue.chapter === ci && issue.unit === undefined,
        );
        return (
          <Card key={chapter.key} testID={`layout-chapter-${chapter.number}`}>
            <Row>
              <H3>{`Chapter ${chapter.number}${chapter.id !== null ? `: ${chapter.title}` : ''}`}</H3>
              <Badge
                label={`${count} of ${CHAPTER_MIN_UNITS} to ${CHAPTER_MAX_UNITS} units`}
                tone={
                  count < CHAPTER_MIN_UNITS || count > CHAPTER_MAX_UNITS
                    ? 'danger'
                    : count === CHAPTER_MAX_UNITS
                      ? 'warning'
                      : 'success'
                }
              />
              {chapter.id === null ? <Badge label="New chapter" tone="info" glyph="＋" /> : null}
            </Row>
            {chapter.id === null ? (
              <View style={{ gap: space[2] }}>
                <TextField
                  label={`Title of new chapter ${chapter.number}`}
                  visibleLabel="Chapter title"
                  value={chapter.title}
                  onChangeText={(title) => setDraft(setChapterTitle(draft, ci, title))}
                />
                <Row>
                  <Button
                    label="Remove this new chapter"
                    accessibilityLabel={`Remove new chapter ${chapter.number}`}
                    small
                    variant="secondary"
                    onPress={() => setDraft(dropNewChapter(draft, ci))}
                  />
                </Row>
              </View>
            ) : null}
            {chapterIssues.map((issue) => (
              <Text
                key={issue.message}
                style={{ color: colors.danger, fontSize: 13 }}
                accessibilityRole="alert"
              >
                ✕ {issue.message}
              </Text>
            ))}
            {chapter.units.map((unit, ui) => {
              const unitIssues = issues.filter(
                (issue) => issue.chapter === ci && issue.unit === ui,
              );
              return (
                <View key={unit.key} style={{ gap: space[1] }}>
                  <UnitLine
                    chapter={chapter}
                    chapterIndex={ci}
                    unit={unit}
                    unitIndex={ui}
                    draft={draft}
                    number={numbers.get(unit.key) ?? 0}
                    weeks={weeks}
                    expanded={
                      expanded.has(unit.key) ||
                      (unit.id === null && unitIssues.length > 0 && chapter.id === null)
                    }
                    onToggle={() => {
                      const next = new Set(expanded);
                      if (next.has(unit.key)) next.delete(unit.key);
                      else next.add(unit.key);
                      setExpanded(next);
                    }}
                    onChange={(patch) => setDraft(setUnitFields(draft, ci, ui, patch))}
                    update={setDraft}
                  />
                  {unitIssues.map((issue) => (
                    <Text
                      key={issue.message}
                      style={{ color: colors.danger, fontSize: 13 }}
                      accessibilityRole="alert"
                    >
                      ✕ {issue.message}
                    </Text>
                  ))}
                </View>
              );
            })}
            {adding === ci ? (
              <AddUnitForm
                chapterNumber={chapter.number}
                weeks={weeks}
                defaultStage={defaultStage}
                onCancel={() => setAdding(null)}
                onAdd={(fields) => {
                  setDraft(addUnit(draft, ci, fields));
                  setAdding(null);
                }}
              />
            ) : (
              <Row>
                <Button
                  label={`Add a unit to chapter ${chapter.number}`}
                  variant="secondary"
                  disabled={!add.ok}
                  reason={add.reason}
                  onPress={() => setAdding(ci)}
                  testID={`add-unit-${chapter.number}`}
                />
              </Row>
            )}
          </Card>
        );
      })}

      <Row>
        <Button
          label="Add a chapter"
          variant="secondary"
          onPress={() => setDraft(addChapter(draft))}
          testID="add-chapter"
        />
        <Small>A new chapter starts with three blank units to fill in.</Small>
      </Row>

      {draft.removed.length > 0 ? (
        <Card tone="muted" testID="layout-removed">
          <H3>Will be archived</H3>
          {draft.removed.map((unit) => (
            <Small key={unit.key}>
              {unit.fields.title} (was unit {unit.currentNo}). It had no draft; it is archived, not
              deleted, and its number is freed.
            </Small>
          ))}
        </Card>
      ) : null}

      <Card tone="muted">
        <Small testID="layout-summary">
          {draft.chapters.length} chapter{draft.chapters.length === 1 ? '' : 's'}, {total} unit
          {total === 1 ? '' : 's'}.
        </Small>
        <Row>
          <Button
            label="Apply layout"
            onPress={onApplyPressed}
            busy={apply.busy}
            disabled={disabledReason !== null}
            reason={disabledReason}
            testID="apply-layout"
          />
          <Button
            label="Discard my changes"
            variant="secondary"
            disabled={!changed}
            onPress={() => {
              setDraft(loaded);
              setAdding(null);
              setOutcome(null);
              apply.clearError();
            }}
          />
          <Button label="Close the layout editor" variant="ghost" onPress={onClose} />
        </Row>
      </Card>

      <ConfirmDialog
        visible={confirm !== null}
        title="Some units that already have drafts will change number"
        confirmLabel="Apply and renumber"
        cancelLabel="Not yet"
        busy={apply.busy}
        onConfirm={() => void runApply(true)}
        onCancel={() => {
          setConfirm(null);
          apply.clearError();
        }}
      >
        <View style={{ gap: space[2] }}>
          <P>
            The drafts and their history are kept. Only the unit's number (and chapter) changes, and
            the next version you save will carry the new number in its header.
          </P>
          {(confirm ?? []).map((item) => (
            <Text key={`${item.title}-${item.from}`} style={{ fontSize: 14, color: colors.text }}>
              {item.title}: unit {item.from} becomes unit {item.to}
              {item.moved ? `, moving to chapter ${item.chapter}` : ''}
            </Text>
          ))}
        </View>
      </ConfirmDialog>
    </View>
  );
}
