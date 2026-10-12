// The teacher's manual: the say / ask / watch-for script for each section, the script for the human helper who sits
// beside a pre-reader, timing, materials, what "got it" looks like and what to do when a child has not, and (optional)
// the theme map that ties this subject to the others. Everything the tutor and the helper will be given is on this tab.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Small } from '../../ui/Text';
import { space } from '../../ui/theme';
import { keys } from '../jump';
import { addMissingScriptRows } from '../ops';
import { appendAt, moveItem, removeAt, setAt } from '../path';
import { useActions, useEnv, useIssuesAt } from './context';
import { AddButton, AddMenu, IssueLines, ItemBar, ItemCard, Note, Pick, Row, Rows, Strings, SubHeading, Txt } from './Fields';

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

export function ManualEditor({
  manual,
  sectionList,
}: {
  manual: Rec;
  sectionList: readonly { id: string; heading: string }[];
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const rootIssues = useIssuesAt(['teacher_manual']);
  const script = recs(manual.script);
  const helper = recs(manual.helper_script);
  const guidance = (typeof manual.mastery_guidance === 'object' && manual.mastery_guidance !== null ? manual.mastery_guidance : {}) as Rec;
  const themeMap = typeof manual.theme_map === 'object' && manual.theme_map !== null ? (manual.theme_map as Rec) : undefined;
  const label = (id: string): string => {
    const section = sectionList.find((s) => s.id === id);
    return section ? (section.heading.trim() === '' ? section.id : `${section.heading} (${section.id})`) : `${id} (not a section of this unit)`;
  };
  const sectionOptions = (current: string) => [
    ...sectionList.map((s) => ({ value: s.id, label: label(s.id) })),
    ...(current !== '' && !sectionList.some((s) => s.id === current) ? [{ value: current, label: label(current) }] : []),
  ];
  const scriptIds = new Set(script.map((row) => str(row.section_id)));
  const helperIds = new Set(helper.map((row) => str(row.section_id)));
  const withoutScript = sectionList.filter((s) => !scriptIds.has(s.id));
  const withoutHelper = sectionList.filter((s) => !helperIds.has(s.id));

  return (
    <View style={{ gap: space[3] }}>
      <Note>The teacher's manual is what a guardian or tutor reads aloud from, and what the human helper follows beside a child who cannot read yet.</Note>
      <IssueLines issues={rootIssues} />

      <SubHeading>Script for each section: say, ask, watch for</SubHeading>
      {script.map((row, index) => (
        <ItemCard
          key={index}
          title={`${index + 1}. ${label(str(row.section_id))}`}
          openKey={keys.manualRow(index)}
          defaultOpen={false}
          fieldKey={`teacher_manual.script[${index}]`}
          rollup={['teacher_manual', 'script', index]}
          bar={
            <ItemBar
              noun={`script row ${index + 1}`}
              canUp={index > 0}
              canDown={index < script.length - 1}
              onUp={() => actions.commit((u) => moveItem(u, ['teacher_manual', 'script'], index, index - 1))}
              onDown={() => actions.commit((u) => moveItem(u, ['teacher_manual', 'script'], index, index + 1))}
              onRemove={() => actions.commit((u) => removeAt(u, ['teacher_manual', 'script', index]))}
            />
          }
        >
          <Pick
            path={['teacher_manual', 'script', index, 'section_id']}
            label="Section"
            value={str(row.section_id)}
            options={sectionOptions(str(row.section_id))}
            placeholder="Choose a section…"
          />
          <Txt path={['teacher_manual', 'script', index, 'say']} label="Say this" value={str(row.say)} multiline rich rows={3} />
          <Txt path={['teacher_manual', 'script', index, 'ask']} label="Ask this" value={str(row.ask)} multiline rich rows={2} />
          <Txt path={['teacher_manual', 'script', index, 'watch_for']} label="Watch for" value={str(row.watch_for)} multiline rich rows={2} />
        </ItemCard>
      ))}
      {!env.readOnly ? (
        <Row>
          <AddButton
            label={withoutScript.length > 0 ? `Add a row for each of the ${withoutScript.length} sections without one` : 'Every section has a script row'}
            disabled={withoutScript.length === 0}
            onPress={() => actions.commit((u) => addMissingScriptRows(u))}
          />
          <AddButton label="Add a row" onPress={() => actions.commit((u) => appendAt(u, ['teacher_manual', 'script'], { section_id: '', say: '', ask: '', watch_for: '' }))} />
        </Row>
      ) : null}

      <SubHeading>Helper script</SubHeading>
      <Small>For the human helper who co-pilots a pre-reader's lesson: short steps to follow, in order.</Small>
      {helper.map((row, index) => (
        <ItemCard
          key={index}
          title={`${index + 1}. ${label(str(row.section_id))}`}
          openKey={keys.helperRow(index)}
          defaultOpen={false}
          fieldKey={`teacher_manual.helper_script[${index}]`}
          rollup={['teacher_manual', 'helper_script', index]}
          bar={
            <ItemBar
              noun={`helper script row ${index + 1}`}
              canUp={index > 0}
              canDown={index < helper.length - 1}
              onUp={() => actions.commit((u) => moveItem(u, ['teacher_manual', 'helper_script'], index, index - 1))}
              onDown={() => actions.commit((u) => moveItem(u, ['teacher_manual', 'helper_script'], index, index + 1))}
              onRemove={() => actions.commit((u) => removeAt(u, ['teacher_manual', 'helper_script', index]))}
            />
          }
        >
          <Pick
            path={['teacher_manual', 'helper_script', index, 'section_id']}
            label="Section"
            value={str(row.section_id)}
            options={sectionOptions(str(row.section_id))}
            placeholder="Choose a section…"
          />
          <Strings
            path={['teacher_manual', 'helper_script', index, 'steps']}
            label="Steps for the helper"
            noun="step"
            values={strs(row.steps)}
            min={1}
            multiline
            rich
          />
        </ItemCard>
      ))}
      {!env.readOnly && withoutHelper.length > 0 ? (
        <AddMenu
          label="Add a helper script for a section"
          options={withoutHelper.map((s) => ({ value: s.id, label: `For: ${label(s.id)}` }))}
          onPick={(id) => actions.commit((u) => appendAt(u, ['teacher_manual', 'helper_script'], { section_id: id, steps: [''] }))}
        />
      ) : null}

      <SubHeading>Timing and materials</SubHeading>
      <Txt path={['teacher_manual', 'timing']} label="Timing" value={str(manual.timing)} multiline rich rows={2} />
      <Strings path={['teacher_manual', 'materials']} label="Materials (low-cost, local)" noun="material" values={strs(manual.materials)} min={0} addLabel="Add a material" />

      <SubHeading>Did the child get it?</SubHeading>
      <Strings path={['teacher_manual', 'mastery_guidance', 'got_it']} label="What 'got it' looks like" noun="sign" values={strs(guidance.got_it)} min={0} addLabel="Add a sign" multiline />
      <Txt path={['teacher_manual', 'mastery_guidance', 'not_yet']} label="If the child has not got it yet" value={str(guidance.not_yet)} multiline rich rows={3} />

      <SubHeading>Theme map (optional)</SubHeading>
      {themeMap ? (
        <>
          <Rows
            path={['teacher_manual', 'theme_map', 'lenses']}
            label="How each subject looks at the theme"
            noun="subject"
            count={recs(themeMap.lenses).length}
            blank={() => ({ subject: '', lens: '', what_child_does: '' })}
            renderItem={(itemPath, index) => (
              <>
                <Txt path={[...itemPath, 'subject']} label={`Subject ${index + 1}`} value={str(recs(themeMap.lenses)[index]?.subject)} />
                <Txt path={[...itemPath, 'lens']} label={`Lens of subject ${index + 1}`} value={str(recs(themeMap.lenses)[index]?.lens)} />
                <Txt path={[...itemPath, 'what_child_does']} label={`What the child does in subject ${index + 1}`} value={str(recs(themeMap.lenses)[index]?.what_child_does)} multiline rows={2} />
              </>
            )}
          />
          <Txt path={['teacher_manual', 'theme_map', 'connection_moment']} label="The two-minute connection moment" value={str(themeMap.connection_moment)} multiline rich rows={2} />
          <AddButton
            label="Remove the theme map"
            onPress={() =>
              actions.confirmDelete({
                title: 'Remove the theme map?',
                notes: ['The lenses and the connection moment go. You can undo this.'],
                confirmLabel: 'Remove theme map',
                onConfirm: () => actions.commit((u) => removeAt(u, ['teacher_manual', 'theme_map'])),
              })
            }
          />
        </>
      ) : (
        <AddButton
          label="Add a theme map"
          onPress={() =>
            actions.commit((u) =>
              setAt(u, ['teacher_manual', 'theme_map'], { lenses: [{ subject: '', lens: '', what_child_does: '' }], connection_moment: '' }),
            )
          }
        />
      )}
    </View>
  );
}
