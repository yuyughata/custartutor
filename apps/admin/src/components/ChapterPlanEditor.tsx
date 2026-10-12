// The editable chapter plan: rename chapters and units, edit objectives and stage, move a boundary unit to the
// neighbouring chapter (keeping 3 to 5 units per chapter) and apply it. Validation messages are live.
import { useMemo, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { ChapterPlan, Flag, PlannedUnit } from '@custar/authoring-core';
import { STAGE_ORDER, type Scheme, type Stage } from '@custar/content-schema';
import { stageLabels } from '@custar/design-tokens';
import type { ApplyPlanResult } from '../api/types';
import { useAction } from '../hooks/useAction';
import { whyNot } from '../lib/roles';
import {
  PLAN_MAX_UNITS,
  PLAN_MIN_UNITS,
  canMoveUnit,
  hasPlanErrors,
  issuesForChapter,
  moveUnit,
  normalizePlan,
  plansEqual,
  renameChapter,
  setTheme,
  unitCount,
  updateUnit,
  validatePlan,
} from '../lib/planEdit';
import { useApi, useSession } from '../runtime/RuntimeProvider';
import { useUnsavedChanges } from '../runtime/UnsavedGuard';
import { Badge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { NumberField, TextField } from '../ui/Fields';
import { Select } from '../ui/Select';
import { H3, P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';
import { FlagList } from './FlagList';

const STAGE_OPTIONS = STAGE_ORDER.map((stage) => ({ value: stage, label: stageLabels[stage].label }));
const END_STAGE_OPTIONS = [{ value: '', label: 'Same stage' }, ...STAGE_OPTIONS];

function asStage(value: string): Stage | undefined {
  return STAGE_ORDER.find((stage) => stage === value);
}

export interface ChapterPlanEditorProps {
  schemeId: string;
  initialPlan: ChapterPlan;
  flags: readonly Flag[];
  scheme: Scheme | null;
  onApplied?: (result: ApplyPlanResult) => void;
}

function UnitEditor({
  unit,
  chapterIndex,
  unitIndex,
  plan,
  messages,
  onPlan,
}: {
  unit: PlannedUnit;
  chapterIndex: number;
  unitIndex: number;
  plan: ChapterPlan;
  messages: string[];
  onPlan: (next: ChapterPlan) => void;
}): ReactNode {
  const label = `unit ${unit.unit_no}`;
  const previous = canMoveUnit(plan, chapterIndex, unitIndex, 'previous');
  const next = canMoveUnit(plan, chapterIndex, unitIndex, 'next');
  const chapter = plan.chapters[chapterIndex];
  const isFirst = unitIndex === 0;
  const isLast = chapter ? unitIndex === chapter.units.length - 1 : false;
  return (
    <View
      style={{
        gap: space[2],
        padding: space[3],
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: messages.length > 0 ? colors.danger : colors.border,
        backgroundColor: colors.white,
      }}
    >
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Text style={{ fontWeight: '800', color: colors.primaryDark }}>Unit {unit.unit_no}</Text>
        <Small>Week {unit.week_no}</Small>
        <Badge label={unit.kind.replace(/_/g, ' ')} tone="neutral" />
      </View>
      <TextField
        label={`Title, ${label}`}
        value={unit.title}
        onChangeText={(title) => onPlan(updateUnit(plan, chapterIndex, unitIndex, { title }))}
      />
      <TextField
        label={`Objective, ${label}`}
        hint="The NERDC objective the unit must cover. Edit it to match the scheme."
        value={unit.objective}
        onChangeText={(objective) => onPlan(updateUnit(plan, chapterIndex, unitIndex, { objective }))}
        lines={3}
      />
      <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <View style={{ width: 170 }}>
          <Select
            label={`Stage, ${label}`}
            value={unit.stage}
            options={STAGE_OPTIONS}
            onChange={(value) => {
              const stage = asStage(value);
              if (stage) onPlan(updateUnit(plan, chapterIndex, unitIndex, { stage }));
            }}
          />
        </View>
        <View style={{ width: 170 }}>
          <Select
            label={`Ends at stage, ${label}`}
            value={unit.stage_to ?? ''}
            options={END_STAGE_OPTIONS}
            onChange={(value) => {
              const stage = asStage(value);
              onPlan(updateUnit(plan, chapterIndex, unitIndex, { stage_to: stage }));
            }}
          />
        </View>
        <View style={{ width: 110 }}>
          <NumberField
            label={`Periods, ${label}`}
            value={unit.periods}
            onNumber={(value) => onPlan(updateUnit(plan, chapterIndex, unitIndex, { periods: value ?? Number.NaN }))}
          />
        </View>
      </View>
      {isFirst || isLast ? (
        <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {isFirst && chapterIndex > 0 ? (
            <Button
              label="Move to previous chapter"
              accessibilityLabel={`Move ${label} to previous chapter`}
              variant="secondary"
              small
              disabled={!previous.ok}
              reason={previous.reason}
              onPress={() => onPlan(moveUnit(plan, chapterIndex, unitIndex, 'previous'))}
            />
          ) : null}
          {isLast && chapterIndex < plan.chapters.length - 1 ? (
            <Button
              label="Move to next chapter"
              accessibilityLabel={`Move ${label} to next chapter`}
              variant="secondary"
              small
              disabled={!next.ok}
              reason={next.reason}
              onPress={() => onPlan(moveUnit(plan, chapterIndex, unitIndex, 'next'))}
            />
          ) : null}
        </View>
      ) : null}
      {messages.map((message) => (
        <Text key={message} accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13 }}>
          ✕ {message}
        </Text>
      ))}
    </View>
  );
}

export function ChapterPlanEditor({
  schemeId,
  initialPlan,
  flags,
  scheme,
  onApplied,
}: ChapterPlanEditorProps): ReactNode {
  const api = useApi();
  const { role } = useSession();
  const [plan, setPlan] = useState<ChapterPlan>(initialPlan);
  const [baseline, setBaseline] = useState<ChapterPlan | null>(null);
  const [result, setResult] = useState<ApplyPlanResult | null>(null);

  const issues = useMemo(() => validatePlan(plan, scheme), [plan, scheme]);
  const blocked = hasPlanErrors(issues);
  const dirty = baseline === null || !plansEqual(plan, baseline);
  useUnsavedChanges(dirty);

  const canApply = whyNot(role, 'plan.apply');
  const apply = useAction(async () => {
    const clean = normalizePlan(plan);
    const out = await api.chapters.applyPlan(schemeId, clean);
    // Only after the RPC resolved does the page say the plan was applied.
    setPlan(clean);
    setBaseline(clean);
    setResult(out);
    onApplied?.(out);
    return out;
  });

  const planWide = issues.filter((issue) => issue.chapter === undefined);
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;

  return (
    <View style={{ gap: space[4] }}>
      <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'center', flexWrap: 'wrap' }}>
        <P testID="plan-summary">
          {plan.chapters.length} chapter{plan.chapters.length === 1 ? '' : 's'} · {unitCount(plan)} units · each chapter
          needs {PLAN_MIN_UNITS} to {PLAN_MAX_UNITS} units
        </P>
        {errorCount > 0 ? (
          <Badge label={`${errorCount} problem${errorCount === 1 ? '' : 's'} to fix`} glyph="✕" tone="danger" />
        ) : (
          <Badge label="Plan is valid" glyph="✓" tone="success" />
        )}
      </View>

      {flags.length > 0 ? (
        <Card tone="muted">
          <H3>Notes from the model</H3>
          <FlagList flags={flags} />
        </Card>
      ) : null}

      {planWide.length > 0 ? (
        <View style={{ gap: space[1] }}>
          {planWide.map((issue) => (
            <Text
              key={issue.message}
              accessibilityRole={issue.severity === 'error' ? 'alert' : 'text'}
              style={{ color: issue.severity === 'error' ? colors.danger : colors.amberText, fontSize: 14 }}
            >
              {issue.severity === 'error' ? '✕ ' : '⚠ '}
              {issue.message}
            </Text>
          ))}
        </View>
      ) : null}

      {plan.chapters.map((chapter, chapterIndex) => {
        const chapterMessages = issuesForChapter(issues, chapterIndex).map((issue) => issue.message);
        return (
          <Card key={`${chapter.chapter_no}-${chapterIndex}`} style={{ gap: space[3] }}>
            <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 260 }}>
                <TextField
                  label={`Title, chapter ${chapter.chapter_no}`}
                  value={chapter.title}
                  onChangeText={(title) => setPlan(renameChapter(plan, chapterIndex, title))}
                />
              </View>
              <Badge
                label={`${chapter.units.length} unit${chapter.units.length === 1 ? '' : 's'}`}
                glyph={chapter.units.length >= PLAN_MIN_UNITS && chapter.units.length <= PLAN_MAX_UNITS ? '✓' : '✕'}
                tone={chapter.units.length >= PLAN_MIN_UNITS && chapter.units.length <= PLAN_MAX_UNITS ? 'success' : 'danger'}
              />
            </View>
            {chapter.theme ? (
              <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <TextField
                    label={`Theme title, chapter ${chapter.chapter_no}`}
                    value={chapter.theme.title}
                    onChangeText={(title) => setPlan(setTheme(plan, chapterIndex, { title, lens: chapter.theme?.lens ?? '' }))}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <TextField
                    label={`Theme lens, chapter ${chapter.chapter_no}`}
                    hint="How this subject looks at the theme, for example Observation."
                    value={chapter.theme.lens}
                    onChangeText={(lens) => setPlan(setTheme(plan, chapterIndex, { title: chapter.theme?.title ?? '', lens }))}
                  />
                </View>
                <Button
                  label="Remove theme"
                  accessibilityLabel={`Remove theme from chapter ${chapter.chapter_no}`}
                  variant="secondary"
                  small
                  onPress={() => setPlan(setTheme(plan, chapterIndex, null))}
                />
              </View>
            ) : (
              <View style={{ alignItems: 'flex-start' }}>
                <Button
                  label="Add a theme"
                  accessibilityLabel={`Add a theme to chapter ${chapter.chapter_no}`}
                  variant="ghost"
                  small
                  onPress={() => setPlan(setTheme(plan, chapterIndex, { title: 'New theme', lens: 'Observation' }))}
                />
              </View>
            )}
            {chapterMessages.map((message) => (
              <Text key={message} accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14 }}>
                ✕ {message}
              </Text>
            ))}
            <View style={{ gap: space[3] }}>
              {chapter.units.map((unit, unitIndex) => (
                <UnitEditor
                  key={unit.unit_no}
                  unit={unit}
                  chapterIndex={chapterIndex}
                  unitIndex={unitIndex}
                  plan={plan}
                  messages={issuesForChapter(issues, chapterIndex, unitIndex).map((issue) => issue.message)}
                  onPlan={setPlan}
                />
              ))}
            </View>
          </Card>
        );
      })}

      {apply.error ? (
        <Banner tone="danger" title="The plan was not applied" testID="apply-error">
          <P>{apply.error.message}</P>
        </Banner>
      ) : null}
      {result ? (
        <Banner tone="success" title="Plan applied" testID="plan-applied">
          <P>
            {result.chapters} chapter{result.chapters === 1 ? '' : 's'} and {result.units} unit
            {result.units === 1 ? '' : 's'} saved as drafts. Open a unit below to draft it.
          </P>
        </Banner>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Button
          label="Apply plan"
          onPress={() => void apply.run()}
          busy={apply.busy}
          disabled={Boolean(canApply) || blocked || (!dirty && result !== null)}
          reason={canApply ?? (blocked ? 'Fix the problems marked above first.' : null)}
        />
        <Small>
          {apply.busy
            ? 'Applying…'
            : dirty
              ? baseline === null
                ? 'Not applied yet. Chapters and units are created only when you apply.'
                : 'You have edited the plan since it was applied.'
              : 'Applied.'}
        </Small>
      </View>
    </View>
  );
}
