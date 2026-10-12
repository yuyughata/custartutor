// One question of the unit: the common fields (tier, prompt, hint, explanation, skill tag), the answer builder for its
// kind, the Try-it box, and where the question is used. Questions are edited here and nowhere else; a section's
// question block only places one.
import { memo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Question, QuestionKind } from '@custar/content-schema';
import { Badge } from '../../ui/Badge';
import { Small } from '../../ui/Text';
import { colors, space } from '../../ui/theme';
import { fillSetPrompt } from '../answers';
import { GRADED_OFFLINE, QUESTION_KIND_LABELS } from '../factories';
import { keys } from '../jump';
import { duplicateQuestion, removeQuestion } from '../ops';
import { getAt, setAt, type Path } from '../path';
import { protection } from '../stableIds';
import {
  CircleAnswer,
  DrawAnswer,
  FillBlankAnswer,
  MatchAnswer,
  McqAnswer,
  RubricAnswer,
  SortAnswer,
  SpeakAnswer,
  TapImageAnswer,
} from './AnswerEditors';
import { LangField } from './BlockEditors';
import { useActions, useEnv, useIssuesAt } from './context';
import { IssueLines, ItemBar, ItemCard, Pick, Row, Txt } from './Fields';
import { TryItBox } from './TryItBox';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

type Edit = (fn: (question: Question) => Question, key?: string) => void;
type Narrow<K extends Question['kind']> = (
  fn: (question: Extract<Question, { kind: K }>) => Extract<Question, { kind: K }>,
  key?: string,
) => void;

function narrow<K extends Question['kind']>(edit: Edit): Narrow<K> {
  return (fn, key) => edit((q) => fn(q as Extract<Question, { kind: K }>), key);
}

function AnswerEditor({ question, path, edit }: { question: Question; path: Path; edit: Edit }): ReactNode {
  switch (question.kind) {
    case 'mcq':
      return <McqAnswer question={question} path={path} edit={narrow<'mcq'>(edit)} />;
    case 'fill_blank':
      return <FillBlankAnswer question={question} path={path} edit={narrow<'fill_blank'>(edit)} />;
    case 'match':
      return <MatchAnswer question={question} path={path} edit={narrow<'match'>(edit)} />;
    case 'circle':
      return <CircleAnswer question={question} path={path} edit={narrow<'circle'>(edit)} />;
    case 'sort':
      return <SortAnswer question={question} path={path} edit={narrow<'sort'>(edit)} />;
    case 'tap_image':
      return <TapImageAnswer question={question} path={path} edit={narrow<'tap_image'>(edit)} />;
    case 'speak':
      return <SpeakAnswer question={question} path={path} edit={narrow<'speak'>(edit)} />;
    case 'draw':
      return <DrawAnswer question={question} path={path} edit={narrow<'draw'>(edit)} />;
    case 'free_text':
    case 'spoken':
      return <RubricAnswer question={question} path={path} />;
    default:
      return <Small>This kind of question cannot be edited here.</Small>;
  }
}

export interface QuestionCardProps {
  qid: string;
  question: Question;
  /** Where the question is used (section blocks, workbook, tutor script), as phrases. */
  usage: readonly string[];
}

export const QuestionCard = memo(function QuestionCard({ qid, question, usage }: QuestionCardProps): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const path: Path = ['questions', qid];
  const issues = useIssuesAt(path);
  const kind = question.kind as QuestionKind;
  const lock = protection('question', qid, env.published);
  const edit: Edit = (fn, key) => actions.commit((u) => setAt(u, path, fn(getAt(u, path) as Question)), key ?? null);
  const graded = GRADED_OFFLINE.includes(kind);

  return (
    <ItemCard
      title={`${qid}`}
      subtitle={`${QUESTION_KIND_LABELS[kind] ?? kind} · tier ${String(question.tier)}${str(question.prompt) ? ` · ${str(question.prompt).replace(/\*\*/g, '').slice(0, 70)}` : ''}`}
      openKey={keys.question(qid)}
      defaultOpen={false}
      fieldKey={`questions.${qid}`}
      rollup={path}
      testID={`question-${qid}`}
      bar={
        <ItemBar
          noun={`question ${qid}`}
          onDuplicate={() => {
            const { unit, id } = duplicateQuestion(actions.current(), qid, env.publishedTaken);
            if (id === '') return;
            actions.commit(() => unit);
            actions.open(keys.question(id));
          }}
          onRemove={() =>
            actions.confirmDelete({
              title: `Remove question ${qid}?`,
              notes: [
                ...(usage.length > 0 ? [`It is used in: ${usage.join('; ')}. Those places will lose it.`] : ['It is not used anywhere yet.']),
              ],
              confirmLabel: 'Remove question',
              onConfirm: () => actions.commit((u) => removeQuestion(u, qid).unit),
            })
          }
          removeBlockedReason={lock.reason}
        />
      }
    >
      <IssueLines issues={issues} />
      <Row>
        <Badge label={QUESTION_KIND_LABELS[kind] ?? kind} tone="neutral" />
        <Badge
          label={graded ? 'Marked offline: can grant mastery' : 'Not marked offline: never grants mastery'}
          tone={graded ? 'success' : 'warning'}
          glyph={graded ? '✓' : '⚑'}
        />
      </Row>
      <Row>
        <View style={{ minWidth: 220, flexGrow: 1, maxWidth: 360 }}>
          <Txt path={[...path, 'id']} label="Question id (fixed)" value={qid} mono locked hint="Ids never change: children's progress and the item analysis refer to them." />
        </View>
        <View style={{ minWidth: 220 }}>
          <Pick
            path={[...path, 'tier']}
            label="Tier"
            value={String(question.tier)}
            options={[
              { value: '1', label: 'Tier 1: supported' },
              { value: '2', label: 'Tier 2: now you try' },
              { value: '3', label: 'Tier 3: stretch' },
            ]}
            onPick={(value) => edit((q) => ({ ...q, tier: Number(value) as 1 | 2 | 3 }))}
          />
        </View>
      </Row>
      {question.kind === 'fill_blank' ? (
        <Txt
          path={[...path, 'prompt']}
          label="Prompt"
          value={question.prompt}
          multiline
          rich
          rows={3}
          onValue={(next) => edit((q) => (q.kind === 'fill_blank' ? fillSetPrompt(q, next) : q), `questions.${qid}.prompt`)}
        />
      ) : (
        <Txt path={[...path, 'prompt']} label="Prompt" value={str(question.prompt)} multiline rich rows={3} />
      )}
      <AnswerEditor question={question} path={path} edit={edit} />
      <Txt path={[...path, 'hint']} label="Hint (optional)" value={str(question.hint)} multiline rows={2} optional />
      <Txt path={[...path, 'explanation']} label="Explanation after answering (optional)" value={str(question.explanation)} multiline rich rows={2} optional />
      <Txt
        path={[...path, 'skill_tag']}
        label="Skill tag (optional)"
        value={str(question.skill_tag)}
        mono
        optional
        hint="Lowercase, for example fractions.halves. Used by the item analysis."
      />
      <LangField path={path} value={question.lang} />
      <TryItBox question={question} idPrefix={qid} />
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSoft }}>Used in</Text>
        <Small>{usage.length > 0 ? usage.join('; ') : 'Nowhere yet. Place it in a section (a question block) or in the workbook.'}</Small>
      </View>
      {lock.reason ? <Small>{lock.reason}</Small> : null}
      <View style={{ height: space[1] }} />
    </ItemCard>
  );
});
