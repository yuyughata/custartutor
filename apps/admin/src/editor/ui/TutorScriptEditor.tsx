// The offline tutor dialogue ("Tutor Lite") of a section, or of a project: lines the tutor says, what each one waits for
// (a question of the unit, or a few accepted answers), what it says when right or wrong, the hints, and where to jump.
// The review rule applies: everything the tutor will say is shown here, in full, for a person to read.
import { memo, type ReactNode } from 'react';
import { View } from 'react-native';
import { Small } from '../../ui/Text';
import { space } from '../../ui/theme';
import { keys } from '../jump';
import { addNode, removeNode } from '../ops';
import { getAt, moveItem, removeAt, setAt, type Path } from '../path';
import { useActions, useEnv, useIssuesAt } from './context';
import { AddButton, IssueLines, ItemBar, ItemCard, Note, Pick, Row, Strings, SubHeading, Txt } from './Fields';

type Rec = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function strs(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str) : [];
}
function recs(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'object' && v !== null ? (v as Rec) : {})) : [];
}

type WaitMode = 'none' | 'question' | 'accepted';

function waitMode(node: Rec): WaitMode {
  const expect = node.expect;
  if (typeof expect !== 'object' || expect === null) return 'none';
  const e = expect as Rec;
  if (e.question_id !== undefined) return 'question';
  if (e.accepted !== undefined) return 'accepted';
  return 'none';
}

interface NodeCardProps {
  scope: string;
  /** `null` for a project's own script. */
  sectionIndex: number | null;
  nodeIndex: number;
  count: number;
  node: Rec;
  siblingIds: readonly string[];
  questions: readonly { id: string; label: string }[];
}

const NodeCard = memo(function NodeCard({ scope, sectionIndex, nodeIndex, count, node, siblingIds, questions }: NodeCardProps): ReactNode {
  const actions = useActions();
  const base: Path = sectionIndex === null ? ['tutor_script', 'nodes', nodeIndex] : ['sections', sectionIndex, 'tutor_script', 'nodes', nodeIndex];
  const issues = useIssuesAt(base);
  const id = str(node.id);
  const mode = waitMode(node);
  const jumpsTo = str(node.next);
  return (
    <ItemCard
      title={`${nodeIndex + 1}. ${id}`}
      subtitle={str(node.say).replace(/\*\*/g, '').slice(0, 80)}
      openKey={keys.node(scope, id)}
      defaultOpen={false}
      fieldKey={sectionIndex === null ? `tutor_script.nodes[${nodeIndex}]` : `sections[${sectionIndex}].tutor_script.nodes[${nodeIndex}]`}
      rollup={base}
      bar={
        <ItemBar
          noun={`tutor line ${nodeIndex + 1}`}
          canUp={nodeIndex > 0}
          canDown={nodeIndex < count - 1}
          onUp={() => actions.commit((u) => moveItem(u, base.slice(0, -1), nodeIndex, nodeIndex - 1))}
          onDown={() => actions.commit((u) => moveItem(u, base.slice(0, -1), nodeIndex, nodeIndex + 1))}
          onRemove={() =>
            actions.confirmDelete({
              title: `Remove tutor line ${nodeIndex + 1} (${id})?`,
              notes: ['Lines that jumped to it will continue in order.', ...(count === 1 ? ['It is the last line, so the whole tutor script goes.'] : [])],
              confirmLabel: 'Remove line',
              onConfirm: () => actions.commit((u) => removeNode(u, sectionIndex, nodeIndex).unit),
            })
          }
        />
      }
    >
      <IssueLines issues={issues} />
      <Txt path={[...base, 'id']} label="Line id (fixed)" value={id} mono locked />
      <Txt path={[...base, 'say']} label="What the tutor says" value={str(node.say)} multiline rows={3} counts hint="Plain, short, friendly. It is spoken aloud; **bold** markers are dropped when it is read out." />
      <Pick
        path={[...base, 'expect']}
        label="Then the tutor waits for"
        value={mode}
        options={[
          { value: 'none', label: 'Nothing: carry straight on' },
          { value: 'question', label: "The child's answer to a question of this unit" },
          { value: 'accepted', label: "The child's reply, matched against accepted answers" },
        ]}
        onPick={(next) =>
          actions.commit((u) => {
            if (next === 'none') return removeAt(u, [...base, 'expect']);
            if (next === 'question') return setAt(u, [...base, 'expect'], { question_id: questions[0]?.id ?? '' });
            return setAt(u, [...base, 'expect'], { accepted: [''] });
          })
        }
      />
      {mode === 'question' ? (
        <Pick
          path={[...base, 'expect', 'question_id']}
          label="Question that grades the reply"
          value={questions.some((q) => q.id === str(getAt(node, ['expect', 'question_id']))) ? str(getAt(node, ['expect', 'question_id'])) : ''}
          placeholder="Choose a question…"
          options={questions.map((q) => ({ value: q.id, label: q.label }))}
        />
      ) : null}
      {mode === 'accepted' ? (
        <Strings
          path={[...base, 'expect', 'accepted']}
          label="Accepted replies"
          noun="accepted reply"
          values={strs(getAt(node, ['expect', 'accepted']))}
          min={1}
          hint="Matched like fill-in-the-blank answers (not case sensitive, one typo forgiven)."
        />
      ) : null}
      <Strings path={[...base, 'on_correct']} label="Says when the reply is right (the app picks one)" noun="line" values={strs(node.on_correct)} min={0} addLabel="Add a line for a right reply" />
      <Strings path={[...base, 'on_incorrect']} label="Says when the reply is wrong (the app picks one)" noun="line" values={strs(node.on_incorrect)} min={0} addLabel="Add a line for a wrong reply" />
      <Strings path={[...base, 'hint']} label="Hints offered after a miss, in order" noun="hint" values={strs(node.hint)} min={0} addLabel="Add a hint" />
      <Pick
        path={[...base, 'next']}
        label="Afterwards go to"
        value={jumpsTo !== '' && siblingIds.includes(jumpsTo) ? jumpsTo : ''}
        placeholder="The next line in order"
        options={[{ value: '', label: 'The next line in order' }, ...siblingIds.filter((s) => s !== id).map((s) => ({ value: s, label: `Jump to ${s}` }))]}
      />
    </ItemCard>
  );
});

export function TutorScriptEditor({
  scope,
  sectionIndex,
  script,
  questions,
  subject,
}: {
  scope: string;
  sectionIndex: number | null;
  script: Rec | undefined;
  questions: readonly { id: string; label: string }[];
  /** What the script belongs to, for its heading ("section Come and Explore", "the project"). */
  subject: string;
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const path: Path = sectionIndex === null ? ['tutor_script'] : ['sections', sectionIndex, 'tutor_script'];
  const issues = useIssuesAt(path);
  const nodes = recs(script?.nodes);
  const ids = nodes.map((n) => str(n.id));
  return (
    <View style={{ gap: space[2] }} {...({ dataSet: { field: sectionIndex === null ? 'tutor_script' : `sections[${sectionIndex}].tutor_script` } } as object)}>
      <SubHeading>Tutor script for {subject}</SubHeading>
      <IssueLines issues={issues} />
      {script === undefined ? (
        <>
          <Small>No offline tutor lines for {subject}. Without them the tutor has nothing scripted to say here when the child is offline.</Small>
          <AddButton
            label="Add a tutor script"
            onPress={() => {
              const { unit, id } = addNode(actions.current(), sectionIndex, env.publishedTaken);
              actions.commit(() => unit);
              actions.open(keys.node(scope, id));
            }}
          />
        </>
      ) : (
        <>
          <Note>
            {nodes.length} line{nodes.length === 1 ? '' : 's'}. Lines run in order unless one jumps to another. Everything the tutor will say is listed here; open a line to read and change it.
          </Note>
          {nodes.map((node, index) => (
            <NodeCard
              key={ids[index] || index}
              scope={scope}
              sectionIndex={sectionIndex}
              nodeIndex={index}
              count={nodes.length}
              node={node}
              siblingIds={ids}
              questions={questions}
            />
          ))}
          <Row>
            <AddButton
              label="Add a tutor line"
              onPress={() => {
                const { unit, id } = addNode(actions.current(), sectionIndex, env.publishedTaken);
                actions.commit(() => unit);
                actions.open(keys.node(scope, id));
              }}
            />
            <AddButton
              label="Remove the whole tutor script"
              onPress={() =>
                actions.confirmDelete({
                  title: `Remove the tutor script for ${subject}?`,
                  notes: ['Every tutor line for it goes. You can undo this.'],
                  confirmLabel: 'Remove tutor script',
                  onConfirm: () => actions.commit((u) => removeAt(u, path)),
                })
              }
            />
          </Row>
        </>
      )}
    </View>
  );
}
