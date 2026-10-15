// The week's timetable for the subject: one card per period with the sections taught in it and the minutes of each
// part (Start, Teach, Move and Do, Practice, Close). A period should run 50 to 70 minutes (a warning, not a block).
import { memo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { SESSION_MINUTES_MAX, SESSION_MINUTES_MIN } from '@custar/content-schema';
import { Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import { keys } from '../jump';
import { addPeriod, addSegment, removePeriod, setPeriodSection, SEGMENTS } from '../ops';
import { removeAt, type Path } from '../path';
import { useActions, useEnv, useIssuesAt } from './context';
import {
  AddButton,
  AddMenu,
  IssueLines,
  ItemBar,
  ItemCard,
  Mark,
  Note,
  Num,
  Row,
  SubHeading,
} from './Fields';

type Rec = Record<string, unknown>;

const SEGMENT_LABELS: Record<string, string> = {
  start: 'Start',
  teach: 'Teach',
  move_and_do: 'Move and Do',
  practice: 'Practice',
  close: 'Close',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function recs(value: unknown): Rec[] {
  return Array.isArray(value)
    ? value.map((v) => (typeof v === 'object' && v !== null ? (v as Rec) : {}))
    : [];
}

export function minutesTotal(period: Rec): number {
  return recs(period.minutes).reduce(
    (sum, m) => sum + (typeof m.minutes === 'number' && Number.isFinite(m.minutes) ? m.minutes : 0),
    0,
  );
}

/** "62 minutes: within 50 to 70", with a bar that marks the band. Words first, colour second. */
export function MinutesMeter({ total }: { total: number }): ReactNode {
  const inside = total >= SESSION_MINUTES_MIN && total <= SESSION_MINUTES_MAX;
  const scaleMax = 90;
  const left = (SESSION_MINUTES_MIN / scaleMax) * 100;
  const width = ((SESSION_MINUTES_MAX - SESSION_MINUTES_MIN) / scaleMax) * 100;
  const text = inside
    ? `${total} minutes: within ${SESSION_MINUTES_MIN} to ${SESSION_MINUTES_MAX}`
    : total < SESSION_MINUTES_MIN
      ? `${total} minutes: ${SESSION_MINUTES_MIN - total} short of ${SESSION_MINUTES_MIN}`
      : `${total} minutes: ${total - SESSION_MINUTES_MAX} over ${SESSION_MINUTES_MAX}`;
  return (
    <View testID="minutes-meter" style={{ gap: space[1] }}>
      <Text
        style={{
          fontSize: 14,
          fontWeight: '700',
          color: inside ? colors.success : colors.amberText,
        }}
      >
        {inside ? '✓ ' : '⚠ '}
        {text}
      </Text>
      <View
        accessibilityLabel={`Timeline, band ${SESSION_MINUTES_MIN} to ${SESSION_MINUTES_MAX} minutes`}
        style={{
          height: 10,
          maxWidth: 360,
          backgroundColor: colors.border,
          borderRadius: radii.pill,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            position: 'absolute',
            left: `${left}%`,
            width: `${width}%`,
            top: 0,
            bottom: 0,
            backgroundColor: colors.primaryTint,
            borderColor: colors.primary,
            borderLeftWidth: 1,
            borderRightWidth: 1,
          }}
        />
        <View
          style={{
            position: 'absolute',
            left: 0,
            width: `${Math.min(100, (total / scaleMax) * 100)}%`,
            top: 3,
            height: 4,
            backgroundColor: inside ? colors.success : colors.amber,
          }}
        />
      </View>
    </View>
  );
}

const PeriodCard = memo(function PeriodCard({
  index,
  count,
  period,
  sectionList,
  missing,
}: {
  index: number;
  count: number;
  period: Rec;
  sectionList: readonly { id: string; heading: string }[];
  missing: readonly string[];
}): ReactNode {
  const actions = useActions();
  const path: Path = ['session_plan', index];
  const issues = useIssuesAt(path);
  const minutesIssues = useIssuesAt([...path, 'minutes']);
  const sectionsIssues = useIssuesAt([...path, 'sections']);
  const chosen = new Set(
    Array.isArray(period.sections) ? (period.sections as unknown[]).map(str) : [],
  );
  const known = new Set(sectionList.map((s) => s.id));
  const leftovers = [...chosen].filter((id) => !known.has(id));
  const minutes = recs(period.minutes);
  const total = minutesTotal(period);
  return (
    <ItemCard
      title={`Period ${String(period.period ?? index + 1)}`}
      subtitle={`${chosen.size} section${chosen.size === 1 ? '' : 's'} · ${total} minutes`}
      openKey={keys.period(index)}
      fieldKey={`session_plan[${index}]`}
      rollup={path}
      testID={`period-${index}`}
      bar={
        <ItemBar
          noun={`period ${index + 1}`}
          {...(count > 1
            ? {
                onRemove: () =>
                  actions.confirmDelete({
                    title: `Remove period ${index + 1}?`,
                    notes: ['The periods after it are renumbered.'],
                    confirmLabel: 'Remove period',
                    onConfirm: () => actions.commit((u) => removePeriod(u, index)),
                  }),
              }
            : {})}
        />
      }
    >
      <IssueLines issues={issues} />
      <MinutesMeter total={total} />
      <View
        style={{ gap: space[2] }}
        {...({ dataSet: { field: `session_plan[${index}].sections` } } as object)}
      >
        <SubHeading>Sections taught in this period</SubHeading>
        <IssueLines issues={sectionsIssues} />
        {sectionList.map((section) => (
          <Mark
            key={section.id}
            on={chosen.has(section.id)}
            label={
              section.heading.trim() === '' ? section.id : `${section.heading} (${section.id})`
            }
            name={`Period ${index + 1} teaches ${section.heading || section.id}`}
            onPress={() =>
              actions.commit((u) => setPeriodSection(u, index, section.id, !chosen.has(section.id)))
            }
          />
        ))}
        {leftovers.map((id) => (
          <Mark
            key={id}
            on
            label={`${id} (not a section of this unit)`}
            name={`Period ${index + 1} refers to ${id}, which is not a section`}
            onPress={() => actions.commit((u) => setPeriodSection(u, index, id, false))}
          />
        ))}
      </View>
      <View
        style={{ gap: space[2] }}
        {...({ dataSet: { field: `session_plan[${index}].minutes` } } as object)}
      >
        <SubHeading>Minutes for each part</SubHeading>
        <IssueLines issues={minutesIssues} />
        <Row>
          {minutes.map((entry, m) => (
            <View key={m} style={{ gap: space[1] }}>
              <Num
                path={[...path, 'minutes', m, 'minutes']}
                label={`${SEGMENT_LABELS[str(entry.segment)] ?? str(entry.segment)}, minutes`}
                value={typeof entry.minutes === 'number' ? entry.minutes : null}
                width={150}
              />
              {minutes.length > 1 ? (
                <ItemBar
                  noun={`${SEGMENT_LABELS[str(entry.segment)] ?? str(entry.segment)} part of period ${index + 1}`}
                  onRemove={() => actions.commit((u) => removeAt(u, [...path, 'minutes', m]))}
                />
              ) : null}
            </View>
          ))}
        </Row>
        {missing.length > 0 ? (
          <AddMenu
            label="Add a part"
            options={missing.map((segment) => ({
              value: segment,
              label: `Add: ${SEGMENT_LABELS[segment] ?? segment}`,
            }))}
            onPick={(segment) => actions.commit((u) => addSegment(u, index, segment))}
          />
        ) : null}
      </View>
    </ItemCard>
  );
});

export function SessionPlanEditor({
  plan,
  sectionList,
  outside,
}: {
  plan: Rec[];
  sectionList: readonly { id: string; heading: string }[];
  outside: readonly string[];
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const rootIssues = useIssuesAt(['session_plan']);
  return (
    <View style={{ gap: space[3] }}>
      <Note>
        The session plan is the week's timetable for this subject. Each period is about an hour; the
        minutes below add up to 50 to 70 (otherwise a warning is shown, which does not stop you
        saving).
      </Note>
      <IssueLines issues={rootIssues} />
      {outside.length > 0 ? (
        <Small>
          Sections in no period: {outside.join(', ')}. A child would not reach them through the
          timetable.
        </Small>
      ) : null}
      {plan.map((period, index) => (
        <PeriodCard
          key={index}
          index={index}
          count={plan.length}
          period={period}
          sectionList={sectionList}
          missing={missingSegmentsOf(period)}
        />
      ))}
      {!env.readOnly ? (
        <AddButton label="Add a period" onPress={() => actions.commit((u) => addPeriod(u))} />
      ) : null}
    </View>
  );
}

function missingSegmentsOf(period: Rec): string[] {
  const have = new Set(recs(period.minutes).map((m) => m.segment));
  return SEGMENTS.filter((segment) => !have.has(segment));
}
