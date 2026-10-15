// The workbook: tiers of questions (supported, now you try, stretch), the timed quick-answer drill, the take-it-home
// task, the everyday-life application question, the remediation note and the pre-reviewed practice sets. Questions are
// chosen from the unit's own questions; they are edited on the Questions tab.
import { useMemo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Small } from '../../ui/Text';
import { colors, space } from '../../ui/theme';
import { keys } from '../jump';
import { addTier, addVariant } from '../ops';
import { appendAt, moveItem, pathKey, removeAt, type Path } from '../path';
import { useActions, useEnv, useIssuesAt } from './context';
import {
  AddButton,
  AddMenu,
  IssueLines,
  ItemBar,
  ItemCard,
  Note,
  Num,
  Pick,
  Row,
  SubHeading,
  Txt,
} from './Fields';

type Rec = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function recs(value: unknown): Rec[] {
  return Array.isArray(value)
    ? value.map((v) => (typeof v === 'object' && v !== null ? (v as Rec) : {}))
    : [];
}
function strs(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str) : [];
}

/** A list of question ids chosen from the unit's questions, in the order they are shown. */
export function QuestionIdList({
  path,
  label,
  ids,
  questions,
  min = 0,
  hint,
}: {
  path: Path;
  label: string;
  ids: readonly string[];
  questions: readonly { id: string; label: string }[];
  min?: number;
  hint?: string;
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(path);
  const names = useMemo(() => new Map(questions.map((q) => [q.id, q.label])), [questions]);
  const available = questions.filter((q) => !ids.includes(q.id));
  return (
    <View style={{ gap: space[2] }} {...({ dataSet: { field: pathKey(path) } } as object)}>
      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textSoft }}>{label}</Text>
      {hint ? <Small>{hint}</Small> : null}
      <IssueLines issues={issues} />
      {ids.length === 0 ? <Small>No questions chosen yet.</Small> : null}
      {ids.map((id, index) => (
        <View key={`${id}-${index}`} style={{ gap: space[1] }}>
          <Text
            selectable
            style={{ fontSize: 14, color: names.has(id) ? colors.text : colors.danger }}
          >
            {index + 1}. {names.get(id) ?? `${id} (not a question of this unit)`}
          </Text>
          <ItemBar
            noun={`${id} in ${label.toLowerCase()}`}
            canUp={index > 0}
            canDown={index < ids.length - 1}
            onUp={() => actions.commit((u) => moveItem(u, path, index, index - 1))}
            onDown={() => actions.commit((u) => moveItem(u, path, index, index + 1))}
            {...(ids.length > min
              ? { onRemove: () => actions.commit((u) => removeAt(u, [...path, index])) }
              : {})}
          />
        </View>
      ))}
      {!env.readOnly && available.length > 0 ? (
        <AddMenu
          label={`Add a question: ${label.toLowerCase()}`}
          options={available.map((q) => ({ value: q.id, label: q.label }))}
          onPick={(id) => actions.commit((u) => appendAt(u, path, id))}
        />
      ) : null}
    </View>
  );
}

const TIER_NAMES: Record<number, string> = {
  1: 'Tier 1: supported',
  2: 'Tier 2: now you try',
  3: 'Tier 3: stretch',
};

export function WorkbookEditor({
  workbook,
  questions,
}: {
  workbook: Rec;
  questions: readonly { id: string; label: string }[];
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const rootIssues = useIssuesAt(['workbook']);
  const tiers = recs(workbook.tiers);
  const have = new Set(tiers.map((t) => t.tier));
  const missing = ([1, 2, 3] as const).filter((t) => !have.has(t));
  const drill = (
    typeof workbook.quick_answer_drill === 'object' && workbook.quick_answer_drill !== null
      ? workbook.quick_answer_drill
      : {}
  ) as Rec;
  const variants = recs(workbook.practice_variants);
  return (
    <View style={{ gap: space[3] }}>
      <Note>
        The workbook is built from the unit's questions. Add or change the questions themselves on
        the Questions tab; here you choose which ones go where.
      </Note>
      <IssueLines issues={rootIssues} />
      <Txt
        path={['workbook', 'intro']}
        label={'"How this works" note at the top (optional)'}
        value={str(workbook.intro)}
        multiline
        rich
        rows={3}
        optional
      />

      <SubHeading>Tiers</SubHeading>
      {tiers.map((tier, index) => (
        <ItemCard
          key={index}
          title={TIER_NAMES[Number(tier.tier)] ?? `Tier ${String(tier.tier)}`}
          subtitle={`${strs(tier.question_ids).length} question${strs(tier.question_ids).length === 1 ? '' : 's'}`}
          openKey={keys.group(`tier${String(tier.tier)}`)}
          fieldKey={`workbook.tiers[${index}]`}
          rollup={['workbook', 'tiers', index]}
          testID={`tier-${index}`}
        >
          <Txt
            path={['workbook', 'tiers', index, 'title']}
            label="Title shown on the page"
            value={str(tier.title)}
          />
          <QuestionIdList
            path={['workbook', 'tiers', index, 'question_ids']}
            label="Questions in this tier"
            ids={strs(tier.question_ids)}
            questions={questions}
            min={1}
          />
        </ItemCard>
      ))}
      {!env.readOnly && missing.length > 0 ? (
        <Row>
          {missing.map((tier) => (
            <AddButton
              key={tier}
              label={`Add ${TIER_NAMES[tier]}`}
              onPress={() => actions.commit((u) => addTier(u, tier))}
            />
          ))}
        </Row>
      ) : null}

      <SubHeading>Quick-answer drill</SubHeading>
      <Num
        path={['workbook', 'quick_answer_drill', 'seconds']}
        label="Seconds on the clock"
        value={typeof drill.seconds === 'number' ? drill.seconds : null}
        hint="10 to 600."
      />
      <QuestionIdList
        path={['workbook', 'quick_answer_drill', 'question_ids']}
        label="Questions in the drill"
        ids={strs(drill.question_ids)}
        questions={questions}
      />

      <SubHeading>Take it home</SubHeading>
      <Txt
        path={['workbook', 'take_it_home']}
        label="Take-it-home task"
        value={str(workbook.take_it_home)}
        multiline
        rich
        rows={3}
      />
      <Pick
        path={['workbook', 'application_task_id']}
        label="Application task (an everyday-life question)"
        value={
          questions.some((q) => q.id === str(workbook.application_task_id))
            ? str(workbook.application_task_id)
            : ''
        }
        placeholder="Choose a question…"
        options={questions.map((q) => ({ value: q.id, label: q.label }))}
      />

      <SubHeading>Notes</SubHeading>
      <Txt
        path={['workbook', 'answers_note']}
        label="Note beside the answers (optional)"
        value={str(workbook.answers_note)}
        multiline
        rich
        rows={2}
        optional
      />
      <Txt
        path={['workbook', 'not_yet']}
        label="If the child has not got it yet (optional)"
        value={str(workbook.not_yet)}
        multiline
        rich
        rows={2}
        optional
      />

      <SubHeading>Practice sets</SubHeading>
      <Small>Pre-reviewed pools for "more practice", so no worksheet is made on demand.</Small>
      {variants.map((variant, index) => (
        <ItemCard
          key={str(variant.id) || index}
          title={str(variant.id) || `Set ${index + 1}`}
          subtitle={`${strs(variant.question_ids).length} question${strs(variant.question_ids).length === 1 ? '' : 's'}`}
          openKey={keys.variant(str(variant.id))}
          defaultOpen={false}
          fieldKey={`workbook.practice_variants[${index}]`}
          rollup={['workbook', 'practice_variants', index]}
          bar={
            <ItemBar
              noun={`practice set ${str(variant.id)}`}
              onRemove={() =>
                actions.confirmDelete({
                  title: `Remove practice set ${str(variant.id)}?`,
                  notes: env.publishedTaken.has(str(variant.id))
                    ? [
                        'This set was published. Practice-set ids should stay stable, so check nothing refers to it.',
                      ]
                    : [],
                  confirmLabel: 'Remove practice set',
                  onConfirm: () =>
                    actions.commit((u) => removeAt(u, ['workbook', 'practice_variants', index])),
                })
              }
            />
          }
        >
          <Txt
            path={['workbook', 'practice_variants', index, 'id']}
            label="Set id (fixed)"
            value={str(variant.id)}
            mono
            locked
          />
          <QuestionIdList
            path={['workbook', 'practice_variants', index, 'question_ids']}
            label="Questions in this set"
            ids={strs(variant.question_ids)}
            questions={questions}
            min={1}
          />
        </ItemCard>
      ))}
      {!env.readOnly ? (
        <AddButton
          label="Add a practice set"
          onPress={() => {
            const { unit, id } = addVariant(actions.current(), env.publishedTaken);
            actions.commit(() => unit);
            actions.open(keys.variant(id));
          }}
        />
      ) : null}
    </View>
  );
}
