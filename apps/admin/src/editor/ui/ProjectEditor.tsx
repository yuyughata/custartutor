// A project (mini or term): what the child makes, the steps, the low-cost materials, the rubric, how the work can be
// shown, the reflection prompts and the tutor's script for it.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Small } from '../../ui/Text';
import { space } from '../../ui/theme';
import { EVIDENCE_CHOICES, addStep, moveStep, removeStep, setEvidence } from '../ops';
import { keys } from '../jump';
import { appendAt, removeAt as removeAtPath } from '../path';
import { useActions, useEnv, useIssuesAt } from './context';
import { AddButton, IssueLines, ItemBar, ItemCard, Mark, Num, Rows, Strings, SubHeading, Txt } from './Fields';
import { TutorScriptEditor } from './TutorScriptEditor';

type Rec = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function recs(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'object' && v !== null ? (v as Rec) : {})) : [];
}
function strs(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str) : [];
}

const EVIDENCE_LABELS: Record<string, string> = { photo: 'A photo', drawing: 'A drawing', audio: 'A recording', text: 'Some writing' };

export function ProjectEditor({
  unit,
  questions,
}: {
  unit: Rec;
  questions: readonly { id: string; label: string }[];
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const steps = recs(unit.steps);
  const rubric = recs(unit.rubric);
  const evidence = strs(unit.evidence_options);
  const evidenceIssues = useIssuesAt(['evidence_options']);
  const stepsIssues = useIssuesAt(['steps']);
  const rubricIssues = useIssuesAt(['rubric']);
  return (
    <View style={{ gap: space[3] }}>
      <Txt path={['brief']} label="What the child will make or find out (child language)" value={str(unit.brief)} multiline rich rows={4} />

      <View style={{ gap: space[2] }} {...({ dataSet: { field: 'steps' } } as object)}>
        <SubHeading>Steps</SubHeading>
        <IssueLines issues={stepsIssues} />
        {steps.map((step, index) => (
          <View key={index} style={{ gap: space[1] }}>
            <Txt path={['steps', index, 'text']} label={`Step ${index + 1}`} value={str(step.text)} multiline rich rows={2} />
            <ItemBar
              noun={`step ${index + 1}`}
              canUp={index > 0}
              canDown={index < steps.length - 1}
              onUp={() => actions.commit((u) => moveStep(u, index, index - 1))}
              onDown={() => actions.commit((u) => moveStep(u, index, index + 1))}
              {...(steps.length > 1 ? { onRemove: () => actions.commit((u) => removeStep(u, index)) } : {})}
            />
          </View>
        ))}
        <AddButton label="Add a step" onPress={() => actions.commit((u) => addStep(u))} />
        <Small>Steps are numbered 1, 2, 3 in order automatically.</Small>
      </View>

      <Strings path={['materials']} label="Materials (low-cost, local)" noun="material" values={strs(unit.materials)} min={1} addLabel="Add a material" />

      <View style={{ gap: space[2] }} {...({ dataSet: { field: 'rubric' } } as object)}>
        <SubHeading>Rubric</SubHeading>
        <Small>Each criterion has levels from 1 (lowest) to 4, with a plain description of what the work looks like at that level.</Small>
        <IssueLines issues={rubricIssues} />
        {rubric.map((row, index) => (
          <ItemCard
            key={index}
            title={`${index + 1}. ${str(row.criterion) || 'New criterion'}`}
            openKey={keys.rubric(index)}
            fieldKey={`rubric[${index}]`}
            rollup={['rubric', index]}
            bar={
              <ItemBar
                noun={`criterion ${index + 1}`}
                {...(rubric.length > 1
                  ? { onRemove: () => actions.confirmDelete({ title: `Remove criterion ${index + 1}?`, confirmLabel: 'Remove criterion', onConfirm: () => actions.commit((u) => removeAtPath(u, ['rubric', index])) }) }
                  : {})}
              />
            }
          >
            <Txt path={['rubric', index, 'criterion']} label="Criterion" value={str(row.criterion)} />
            <Rows
              path={['rubric', index, 'levels']}
              label="Levels"
              noun="level"
              min={2}
              max={4}
              count={recs(row.levels).length}
              blank={() => ({ level: Math.min(4, recs(row.levels).length + 1), descriptor: '' })}
              renderItem={(itemPath, levelIndex) => (
                <>
                  <Num path={[...itemPath, 'level']} label={`Level number ${levelIndex + 1} (1 to 4)`} value={typeof recs(row.levels)[levelIndex]?.level === 'number' ? (recs(row.levels)[levelIndex]?.level as number) : null} />
                  <Txt path={[...itemPath, 'descriptor']} label={`What level ${levelIndex + 1} looks like`} value={str(recs(row.levels)[levelIndex]?.descriptor)} multiline rows={2} />
                </>
              )}
            />
          </ItemCard>
        ))}
        {!env.readOnly ? (
          <AddButton
            label="Add a criterion"
            onPress={() =>
              actions.commit((u) =>
                appendAt(u, ['rubric'], {
                  criterion: '',
                  levels: [
                    { level: 1, descriptor: '' },
                    { level: 2, descriptor: '' },
                  ],
                }),
              )
            }
          />
        ) : null}
      </View>

      <View style={{ gap: space[2] }} {...({ dataSet: { field: 'evidence_options' } } as object)}>
        <SubHeading>How the child can show the work</SubHeading>
        <IssueLines issues={evidenceIssues} />
        {EVIDENCE_CHOICES.map((choice) => (
          <Mark
            key={choice}
            on={evidence.includes(choice)}
            label={EVIDENCE_LABELS[choice] ?? choice}
            name={`Evidence: ${EVIDENCE_LABELS[choice] ?? choice}`}
            onPress={() => actions.commit((u) => setEvidence(u, choice, !evidence.includes(choice)))}
          />
        ))}
      </View>

      <Strings path={['reflection_prompts']} label="Reflection prompts" noun="prompt" values={strs(unit.reflection_prompts)} min={1} addLabel="Add a prompt" />

      <TutorScriptEditor
        scope="project"
        sectionIndex={null}
        script={typeof unit.tutor_script === 'object' && unit.tutor_script !== null ? (unit.tutor_script as Rec) : undefined}
        questions={questions}
        subject="the project"
      />
    </View>
  );
}

