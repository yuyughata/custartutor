// The answer-spec builders of the ten question kinds. Nobody types the answer as data: a correct option is picked, a
// blank is filled, a pair has two sides, an item is sorted into a group. Every change goes through the functions in
// `answers.ts`, which keep the parts that depend on each other consistent (remove an option and "correct" follows).
import { useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { countBlanks, type Question } from '@custar/content-schema';
import { Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import {
  CIRCLE_MAX_OPTIONS,
  CIRCLE_MIN_OPTIONS,
  MATCH_MIN_PAIRS,
  MCQ_MAX_OPTIONS,
  MCQ_MIN_OPTIONS,
  SORT_MIN,
  circleAddOption,
  circleIsCorrect,
  circleRemoveOption,
  circleSetOption,
  circleToggleCorrect,
  fillAddAccepted,
  fillRemoveAccepted,
  fillSetAccepted,
  fillSetFlag,
  fillSetUnits,
  fillUpdateBlank,
  hotspotSetBox,
  matchAddPair,
  matchRemovePair,
  matchSetPair,
  mcqAddOption,
  mcqMoveOption,
  mcqRemoveOption,
  mcqSetCorrect,
  mcqSetOption,
  sortAddCategory,
  sortAddItem,
  sortCategoryIndex,
  sortRemoveCategory,
  sortRemoveItem,
  sortSetCategory,
  sortSetCategoryName,
  sortSetItem,
  speakSetMatch,
  tapAddHotspot,
  tapRemoveHotspot,
  tapUpdateHotspot,
} from '../answers';
import { pathKey, type Path } from '../path';
import { useEnv, useIssuesAt } from './context';
import {
  AddButton,
  Flag,
  IssueLines,
  ItemBar,
  Mark,
  Note,
  Pick,
  Row,
  Strings,
  SubHeading,
  Txt,
} from './Fields';
import { TextEditor } from './TextEditor';

type Q<K extends Question['kind']> = Extract<Question, { kind: K }>;

/** What every answer editor gets: the question, where it lives, and a way to change it as a whole. */
export interface AnswerProps<K extends Question['kind']> {
  question: Q<K>;
  /** `['questions', id]` */
  path: Path;
  edit: (fn: (question: Q<K>) => Q<K>, key?: string) => void;
}

/** A text box whose change is made by a builder function (so index-coupled data moves with it). */
function Built({
  path,
  label,
  value,
  onText,
  multiline,
  rich,
  hint,
  hideLabel,
}: {
  path: Path;
  label: string;
  value: string;
  onText: (next: string, key: string) => void;
  multiline?: boolean;
  rich?: boolean;
  hint?: string;
  hideLabel?: boolean;
}): ReactNode {
  return (
    <Txt
      path={path}
      label={label}
      value={value}
      onValue={(next) => onText(next, pathKey(path))}
      {...(multiline ? { multiline } : {})}
      {...(rich ? { rich } : {})}
      {...(hint ? { hint } : {})}
      {...(hideLabel ? { hideLabel } : {})}
    />
  );
}

// --- multiple choice ---------------------------------------------------------------------------------------------------

export function McqAnswer({ question, path, edit }: AnswerProps<'mcq'>): ReactNode {
  const issues = useIssuesAt([...path, 'options']);
  const answerIssues = useIssuesAt([...path, 'answer']);
  const env = useEnv();
  const count = question.options.length;
  return (
    <View
      style={{ gap: space[2] }}
      {...({ dataSet: { field: pathKey([...path, 'options']) } } as object)}
    >
      <SubHeading>Options and the correct answer</SubHeading>
      <IssueLines issues={issues} />
      <IssueLines issues={answerIssues} />
      {question.options.map((option, index) => (
        <View
          key={index}
          style={{
            gap: space[1],
            padding: space[3],
            borderRadius: radii.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.page,
          }}
        >
          <Built
            path={[...path, 'options', index]}
            label={`Option ${index + 1}`}
            value={option}
            onText={(next, key) => edit((q) => mcqSetOption(q, index, next), key)}
          />
          <Row>
            <Mark
              label={question.answer.correct_index === index ? 'Correct answer' : 'Mark as correct'}
              name={`Option ${index + 1} is the correct answer`}
              on={question.answer.correct_index === index}
              onPress={() => edit((q) => mcqSetCorrect(q, index))}
            />
            <ItemBar
              noun={`option ${index + 1}`}
              canUp={index > 0}
              canDown={index < count - 1}
              onUp={() => edit((q) => mcqMoveOption(q, index, index - 1))}
              onDown={() => edit((q) => mcqMoveOption(q, index, index + 1))}
              {...(count > MCQ_MIN_OPTIONS
                ? { onRemove: () => edit((q) => mcqRemoveOption(q, index)) }
                : {})}
            />
          </Row>
        </View>
      ))}
      {!env.readOnly ? (
        <AddButton
          label="Add option"
          disabled={count >= MCQ_MAX_OPTIONS}
          reason={count >= MCQ_MAX_OPTIONS ? `At most ${MCQ_MAX_OPTIONS} options.` : null}
          onPress={() => edit((q) => mcqAddOption(q))}
        />
      ) : null}
    </View>
  );
}

// --- fill in the blank -------------------------------------------------------------------------------------------------

/** Units are typed as a comma-separated list; the text stays as typed while the list is rebuilt from it. */
function UnitsField({
  path,
  units,
  onUnits,
}: {
  path: Path;
  units: readonly string[];
  onUnits: (units: string[]) => void;
}): ReactNode {
  const env = useEnv();
  const [text, setText] = useState(units.join(', '));
  const last = useRef(units.join('|'));
  const joined = units.join('|');
  if (last.current !== joined) {
    last.current = joined;
    const mine = text
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u !== '')
      .join('|');
    if (mine !== joined) setText(units.join(', '));
  }
  return (
    <TextEditor
      label="Unit words the child may add (optional)"
      value={text}
      fieldKey={pathKey([...path, 'units'])}
      readOnly={env.readOnly}
      hint='Separate with commas, for example: naira, ₦. A numeric answer such as "50 naira" or "₦50" is then accepted as 50.'
      onChange={(next) => {
        setText(next);
        onUnits(next.split(','));
      }}
    />
  );
}

export function FillBlankAnswer({ question, path, edit }: AnswerProps<'fill_blank'>): ReactNode {
  const issues = useIssuesAt([...path, 'answer']);
  const wanted = Math.max(1, countBlanks(question.prompt));
  const blanks = question.answer.blanks;
  return (
    <View
      style={{ gap: space[2] }}
      {...({ dataSet: { field: pathKey([...path, 'answer']) } } as object)}
    >
      <SubHeading>Accepted answers for each blank</SubHeading>
      <Small>
        Put a run of three or more underscores (____) in the prompt for each blank. The blanks below
        follow the prompt: type another ____ and another blank appears.
      </Small>
      <IssueLines issues={issues} />
      {blanks.map((blank, index) => {
        const setBlank = (patch: (b: typeof blank) => typeof blank, key?: string): void =>
          edit((q) => fillUpdateBlank(q, index, patch), key);
        return (
          <View
            key={index}
            style={{
              gap: space[2],
              padding: space[3],
              borderRadius: radii.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.page,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '800', color: colors.primaryDark }}>
              Blank {index + 1} of {wanted}
            </Text>
            {blank.accepted.map((accepted, a) => (
              <View key={a} style={{ gap: space[1] }}>
                <Built
                  path={[...path, 'answer', 'blanks', index, 'accepted', a]}
                  label={`Blank ${index + 1}, accepted answer ${a + 1}`}
                  value={accepted}
                  onText={(next, key) => setBlank((b) => fillSetAccepted(b, a, next), key)}
                />
                {blank.accepted.length > 1 ? (
                  <ItemBar
                    noun={`accepted answer ${a + 1} of blank ${index + 1}`}
                    onRemove={() => setBlank((b) => fillRemoveAccepted(b, a))}
                  />
                ) : null}
              </View>
            ))}
            <AddButton
              label="Add another accepted answer"
              onPress={() => setBlank((b) => fillAddAccepted(b))}
            />
            <Flag
              label="Compare as numbers"
              value={blank.numeric === true}
              hint='"1/2" then equals "0.5". Never fuzzy. At least one accepted answer must be a number.'
              onChange={(on) => setBlank((b) => fillSetFlag(b, 'numeric', on))}
            />
            {blank.numeric === true ? (
              <UnitsField
                path={[...path, 'answer', 'blanks', index]}
                units={blank.units ?? []}
                onUnits={(units) => setBlank((b) => fillSetUnits(b, units))}
              />
            ) : null}
            <Flag
              label="Spelling must be exact (no typo tolerance)"
              value={blank.exact === true}
              hint="Turn this on when spelling is the point of the question. Otherwise one typo is forgiven."
              onChange={(on) => setBlank((b) => fillSetFlag(b, 'exact', on))}
            />
          </View>
        );
      })}
    </View>
  );
}

// --- match -------------------------------------------------------------------------------------------------------------

export function MatchAnswer({ question, path, edit }: AnswerProps<'match'>): ReactNode {
  const issues = useIssuesAt([...path, 'answer']);
  const env = useEnv();
  const pairs = question.answer.pairs;
  return (
    <View
      style={{ gap: space[2] }}
      {...({ dataSet: { field: pathKey([...path, 'answer']) } } as object)}
    >
      <SubHeading>Pairs</SubHeading>
      <IssueLines issues={issues} />
      {pairs.map((pair, index) => (
        <View
          key={index}
          style={{
            gap: space[1],
            padding: space[3],
            borderRadius: radii.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.page,
          }}
        >
          <Built
            path={[...path, 'answer', 'pairs', index, 'left']}
            label={`Pair ${index + 1}, left side`}
            value={pair.left}
            onText={(next, key) => edit((q) => matchSetPair(q, index, 'left', next), key)}
          />
          <Built
            path={[...path, 'answer', 'pairs', index, 'right']}
            label={`Pair ${index + 1}, matching right side`}
            value={pair.right}
            onText={(next, key) => edit((q) => matchSetPair(q, index, 'right', next), key)}
          />
          {pairs.length > MATCH_MIN_PAIRS ? (
            <ItemBar
              noun={`pair ${index + 1}`}
              onRemove={() => edit((q) => matchRemovePair(q, index))}
            />
          ) : null}
        </View>
      ))}
      {!env.readOnly ? (
        <AddButton label="Add pair" onPress={() => edit((q) => matchAddPair(q))} />
      ) : null}
      <Strings
        path={[...path, 'distractors']}
        label="Extra right-hand items that match nothing (optional)"
        noun="distractor"
        values={question.distractors ?? []}
        addLabel="Add a distractor"
      />
    </View>
  );
}

// --- circle ------------------------------------------------------------------------------------------------------------

export function CircleAnswer({ question, path, edit }: AnswerProps<'circle'>): ReactNode {
  const issues = useIssuesAt([...path, 'options']);
  const answerIssues = useIssuesAt([...path, 'answer']);
  const env = useEnv();
  const count = question.options.length;
  return (
    <View
      style={{ gap: space[2] }}
      {...({ dataSet: { field: pathKey([...path, 'options']) } } as object)}
    >
      <SubHeading>Options: tick every correct one</SubHeading>
      <IssueLines issues={issues} />
      <IssueLines issues={answerIssues} />
      {question.options.map((option, index) => (
        <View
          key={index}
          style={{
            gap: space[1],
            padding: space[3],
            borderRadius: radii.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.page,
          }}
        >
          <Built
            path={[...path, 'options', index]}
            label={`Option ${index + 1}`}
            value={option}
            onText={(next, key) => edit((q) => circleSetOption(q, index, next), key)}
          />
          <Row>
            <Mark
              label={circleIsCorrect(question, index) ? 'Correct' : 'Not correct'}
              name={`Option ${index + 1} is a correct answer`}
              on={circleIsCorrect(question, index)}
              onPress={() => edit((q) => circleToggleCorrect(q, index))}
            />
            {count > CIRCLE_MIN_OPTIONS ? (
              <ItemBar
                noun={`option ${index + 1}`}
                onRemove={() => edit((q) => circleRemoveOption(q, index))}
              />
            ) : null}
          </Row>
        </View>
      ))}
      {!env.readOnly ? (
        <AddButton
          label="Add option"
          disabled={count >= CIRCLE_MAX_OPTIONS}
          reason={count >= CIRCLE_MAX_OPTIONS ? `At most ${CIRCLE_MAX_OPTIONS} options.` : null}
          onPress={() => edit((q) => circleAddOption(q))}
        />
      ) : null}
    </View>
  );
}

// --- sort --------------------------------------------------------------------------------------------------------------

export function SortAnswer({ question, path, edit }: AnswerProps<'sort'>): ReactNode {
  const itemIssues = useIssuesAt([...path, 'items']);
  const categoryIssues = useIssuesAt([...path, 'categories']);
  const answerIssues = useIssuesAt([...path, 'answer']);
  const env = useEnv();
  const categoryOptions = question.categories.map((name, index) => ({
    value: String(index),
    label: name.trim() === '' ? `Group ${index + 1} (no name yet)` : name,
  }));
  return (
    <View style={{ gap: space[3] }}>
      <View
        style={{ gap: space[2] }}
        {...({ dataSet: { field: pathKey([...path, 'categories']) } } as object)}
      >
        <SubHeading>Groups</SubHeading>
        <IssueLines issues={categoryIssues} />
        {question.categories.map((name, index) => (
          <View key={index} style={{ gap: space[1] }}>
            <Built
              path={[...path, 'categories', index]}
              label={`Group ${index + 1}`}
              value={name}
              onText={(next, key) => edit((q) => sortSetCategoryName(q, index, next), key)}
            />
            {question.categories.length > SORT_MIN ? (
              <ItemBar
                noun={`group ${index + 1}`}
                onRemove={() => edit((q) => sortRemoveCategory(q, index))}
              />
            ) : null}
          </View>
        ))}
        {!env.readOnly ? (
          <AddButton label="Add group" onPress={() => edit((q) => sortAddCategory(q))} />
        ) : null}
      </View>
      <View
        style={{ gap: space[2] }}
        {...({ dataSet: { field: pathKey([...path, 'items']) } } as object)}
      >
        <SubHeading>Items and the group each belongs to</SubHeading>
        <IssueLines issues={itemIssues} />
        <IssueLines issues={answerIssues} />
        {question.items.map((item, index) => {
          const chosen = sortCategoryIndex(question, index);
          return (
            <View
              key={index}
              style={{
                gap: space[1],
                padding: space[3],
                borderRadius: radii.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.page,
              }}
            >
              <Built
                path={[...path, 'items', index]}
                label={`Item ${index + 1}`}
                value={item}
                onText={(next, key) => edit((q) => sortSetItem(q, index, next), key)}
              />
              <Pick
                path={[...path, 'answer', 'mapping', index]}
                label={`Item ${index + 1} belongs in`}
                value={chosen >= 0 ? String(chosen) : ''}
                placeholder="Choose a group…"
                options={categoryOptions}
                onPick={(value) => edit((q) => sortSetCategory(q, index, Number(value)))}
              />
              {question.items.length > SORT_MIN ? (
                <ItemBar
                  noun={`item ${index + 1}`}
                  onRemove={() => edit((q) => sortRemoveItem(q, index))}
                />
              ) : null}
            </View>
          );
        })}
        {!env.readOnly ? (
          <AddButton label="Add item" onPress={() => edit((q) => sortAddItem(q))} />
        ) : null}
      </View>
    </View>
  );
}

// --- tap the picture ---------------------------------------------------------------------------------------------------

type BoxKey = 'x' | 'y' | 'w' | 'h';
const BOX_LABELS: Record<BoxKey, string> = {
  x: 'Left edge',
  y: 'Top edge',
  w: 'Width',
  h: 'Height',
};

function BoxField({
  path,
  label,
  value,
  onNumber,
}: {
  path: Path;
  label: string;
  value: number;
  onNumber: (value: number) => void;
}): ReactNode {
  const env = useEnv();
  const [text, setText] = useState(String(value));
  const last = useRef(value);
  if (last.current !== value) {
    last.current = value;
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <View style={{ width: 120 }}>
      <TextEditor
        label={label}
        value={text}
        fieldKey={pathKey(path)}
        readOnly={env.readOnly}
        onChange={(next) => {
          setText(next);
          const parsed = Number(next);
          if (next.trim() !== '' && Number.isFinite(parsed)) onNumber(parsed);
        }}
      />
    </View>
  );
}

/** The picture area with each hotspot drawn on it, so a rectangle can be seen as well as typed. */
export function HotspotMap({
  hotspots,
}: {
  hotspots: Q<'tap_image'>['answer']['hotspots'];
}): ReactNode {
  return (
    <View
      accessibilityLabel="Map of the tap areas on the picture"
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 360,
        aspectRatio: 4 / 3,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        borderStyle: 'dashed',
        backgroundColor: colors.page,
      }}
    >
      {hotspots.map((h) => (
        <View
          key={h.id}
          style={{
            position: 'absolute',
            left: `${Math.max(0, Math.min(100, h.x * 100))}%`,
            top: `${Math.max(0, Math.min(100, h.y * 100))}%`,
            width: `${Math.max(1, Math.min(100, h.w * 100))}%`,
            height: `${Math.max(1, Math.min(100, h.h * 100))}%`,
            borderWidth: 2,
            borderColor: h.correct ? colors.success : colors.danger,
            borderStyle: h.correct ? 'solid' : 'dashed',
            backgroundColor: h.correct ? colors.successTint : colors.dangerTint,
            overflow: 'hidden',
          }}
        >
          <Text style={{ fontSize: 10, color: colors.text }} numberOfLines={1}>
            {h.label || h.id}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function TapImageAnswer({ question, path, edit }: AnswerProps<'tap_image'>): ReactNode {
  const env = useEnv();
  const { publishedTaken } = env;
  const issues = useIssuesAt([...path, 'answer']);
  const hotspots = question.answer.hotspots;
  return (
    <View style={{ gap: space[3] }}>
      <Txt
        path={[...path, 'brief']}
        label="Brief for the illustrator"
        value={question.brief ?? ''}
        multiline
        rows={3}
        optional
        hint="Describe the picture. Needed until a picture is attached."
      />
      <Txt
        path={[...path, 'alt']}
        label="Alt text (read by screen readers and spoken by the tutor)"
        value={question.alt}
        multiline
        rows={2}
        counts
      />
      {question.asset_id ? (
        <Note>
          Picture attached: <Text style={{ fontFamily: 'monospace' }}>{question.asset_id}</Text>.
          Uploading or replacing pictures is not done in this editor; the attachment is kept when
          you save.
        </Note>
      ) : (
        <Small>
          No picture is attached yet. The tap areas below are positions on the picture, as fractions
          of its width and height (0 to 1).
        </Small>
      )}
      <View
        style={{ gap: space[2] }}
        {...({ dataSet: { field: pathKey([...path, 'answer']) } } as object)}
      >
        <SubHeading>Tap areas</SubHeading>
        <IssueLines issues={issues} />
        <HotspotMap hotspots={hotspots} />
        {hotspots.map((hotspot, index) => (
          <View
            key={hotspot.id + index}
            style={{
              gap: space[2],
              padding: space[3],
              borderRadius: radii.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.page,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '800', color: colors.primaryDark }}>
              Area {index + 1}{' '}
              <Text style={{ fontFamily: 'monospace', fontWeight: '400' }}>({hotspot.id})</Text>
            </Text>
            <Built
              path={[...path, 'answer', 'hotspots', index, 'label']}
              label={`Area ${index + 1}, what it shows`}
              value={hotspot.label}
              onText={(next, key) =>
                edit((q) => tapUpdateHotspot(q, index, (h) => ({ ...h, label: next })), key)
              }
            />
            <Row>
              {(['x', 'y', 'w', 'h'] as const).map((key) => (
                <BoxField
                  key={key}
                  path={[...path, 'answer', 'hotspots', index, key]}
                  label={`Area ${index + 1}, ${BOX_LABELS[key].toLowerCase()}`}
                  value={hotspot[key]}
                  onNumber={(value) =>
                    edit(
                      (q) => tapUpdateHotspot(q, index, (h) => hotspotSetBox(h, key, value)),
                      pathKey([...path, 'answer', 'hotspots', index, key]),
                    )
                  }
                />
              ))}
            </Row>
            <Mark
              label={hotspot.correct ? 'Correct area' : 'Not a correct area'}
              name={`Area ${index + 1} is a correct area`}
              on={hotspot.correct}
              onPress={() =>
                edit((q) => tapUpdateHotspot(q, index, (h) => ({ ...h, correct: !h.correct })))
              }
            />
            {hotspots.length > 1 ? (
              <ItemBar
                noun={`area ${index + 1}`}
                onRemove={() => edit((q) => tapRemoveHotspot(q, index))}
                removeBlockedReason={
                  publishedTaken.has(hotspot.id)
                    ? 'This area id was published; ids should stay stable. Edit it instead.'
                    : null
                }
              />
            ) : null}
          </View>
        ))}
        {!env.readOnly ? (
          <AddButton
            label="Add tap area"
            onPress={() => edit((q) => tapAddHotspot(q, publishedTaken))}
          />
        ) : null}
      </View>
    </View>
  );
}

// --- say it (checked on the transcript) -----------------------------------------------------------------------------------

export function SpeakAnswer({ question, path, edit }: AnswerProps<'speak'>): ReactNode {
  return (
    <View style={{ gap: space[3] }}>
      <Strings
        path={[...path, 'answer', 'expected']}
        label="Transcripts that count as right"
        noun="accepted transcript"
        values={question.answer.expected}
        min={1}
        hint="What the speech-to-text would write for a right answer. Add the spellings a child's accent may produce."
      />
      <Pick
        path={[...path, 'answer', 'match']}
        label="How the transcript is compared"
        value={question.answer.match ?? 'exact'}
        options={[
          { value: 'exact', label: 'The whole transcript must match' },
          { value: 'contains', label: 'The phrase may sit inside a longer reply' },
        ]}
        onPick={(value) =>
          edit((q) => speakSetMatch(q, value === 'contains' ? 'contains' : 'exact'))
        }
      />
    </View>
  );
}

// --- the ones that are not graded offline ---------------------------------------------------------------------------------

export function DrawAnswer({ question, path }: AnswerProps<'draw'>): ReactNode {
  return (
    <Strings
      path={[...path, 'self_check']}
      label="Self-check list (the child ticks these off against their drawing)"
      noun="check"
      values={question.self_check ?? []}
      addLabel="Add a check"
    />
  );
}

export function RubricAnswer({
  question,
  path,
}: {
  question: Q<'free_text'> | Q<'spoken'>;
  path: Path;
}): ReactNode {
  return (
    <View style={{ gap: space[3] }}>
      <Strings
        path={[...path, 'rubric', 'criteria']}
        label="Marking criteria (read by Claude or a person; advisory only)"
        noun="criterion"
        values={question.rubric.criteria}
        min={1}
      />
      <Txt
        path={[...path, 'rubric', 'exemplar']}
        label="A model answer (optional)"
        value={question.rubric.exemplar ?? ''}
        multiline
        rows={3}
        optional
      />
    </View>
  );
}
