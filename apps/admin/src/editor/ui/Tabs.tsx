// The two long tabs of the editor: the sections of the textbook and the questions of the unit.
import { useMemo, useRef, type ReactNode } from 'react';
import { View } from 'react-native';
import {
  ALWAYS_PRESENT_TYPES,
  QUESTION_KINDS,
  isEnrichmentType,
  type QuestionKind,
  type SectionType,
  type Stage,
  type UnitKind,
} from '@custar/content-schema';
import { Small } from '../../ui/Text';
import { space } from '../../ui/theme';
import { QUESTION_KIND_LABELS, SECTION_TYPE_LABELS, sectionTypesFor } from '../factories';
import { keys } from '../jump';
import {
  addQuestion,
  addSection,
  questionMap,
  questionOptions,
  questionUsage,
  questionsNotInSections,
  sectionUsage,
  sections,
} from '../ops';
import type { Unit } from '../ops';
import { QuestionCard } from './QuestionCard';
import { SectionCard } from './SectionCard';
import { useActions, useEnv, useIssuesAt } from './context';
import { AddMenu, IssueLines, Note, SubHeading } from './Fields';

/** The same array again when its content is the same, so memoised cards are not re-rendered for nothing. */
function useStableLists(): (key: string, list: string[]) => string[] {
  const cache = useRef(new Map<string, string[]>());
  return (key, list) => {
    const before = cache.current.get(key);
    if (before && before.length === list.length && before.every((v, i) => v === list[i]))
      return before;
    cache.current.set(key, list);
    return list;
  };
}

export function SectionsTab({
  unit,
  kind,
  stage,
}: {
  unit: Unit;
  kind: UnitKind;
  stage: Stage;
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(['sections']);
  const stable = useStableLists();
  const list = sections(unit);
  const questions = (unit as { questions?: unknown }).questions;
  const options = useMemo(() => questionOptions(unit), [questions]);
  const records = useMemo(() => questionMap(unit), [questions]);

  const lesson = kind === 'lesson';
  const types = list.map((s) => String(s.type ?? '') as SectionType);
  const enrichmentUsed = types.filter((t) => isEnrichmentType(t)).length;
  const missing = lesson ? ALWAYS_PRESENT_TYPES.filter((t) => !types.includes(t)) : [];
  const addOptions = sectionTypesFor(kind).map((t) => ({
    value: t,
    label: `Add: ${SECTION_TYPE_LABELS[t]}`,
  }));

  return (
    <View style={{ gap: space[3] }}>
      <IssueLines issues={issues} />
      {lesson ? (
        <Note>
          {list.length} section{list.length === 1 ? '' : 's'}. A lesson has the six always-present
          sections (
          {ALWAYS_PRESENT_TYPES.map((t) => SECTION_TYPE_LABELS[t].split(' (')[0]).join(', ')}) and
          two to five enrichment sections; it has {enrichmentUsed} now.
          {missing.length > 0
            ? ` Missing: ${missing.map((t) => SECTION_TYPE_LABELS[t].split(' (')[0]).join(', ')}.`
            : ''}{' '}
          The NERDC objective stays the backbone; enrichment adds depth to it.
        </Note>
      ) : null}
      {list.map((section, index) => {
        const id = String(section.id ?? '');
        return (
          <SectionCard
            key={id || index}
            index={index}
            count={list.length}
            section={section}
            kind={kind}
            stage={stage}
            questions={options}
            questionRecords={records}
            usage={stable(`s:${id}`, sectionUsage(unit, id))}
            enrichment={lesson ? { used: enrichmentUsed, min: 2, max: 5 } : null}
          />
        );
      })}
      {!env.readOnly ? (
        <AddMenu
          label="Add a section"
          options={addOptions}
          onPick={(type) => {
            const { unit: next, id } = addSection(
              actions.current(),
              type as SectionType,
              env.publishedTaken,
            );
            actions.commit(() => next);
            actions.open(keys.section(id));
            actions.jump(['sections', sections(next).length - 1, 'heading']);
          }}
        />
      ) : null}
    </View>
  );
}

export function QuestionsTab({ unit }: { unit: Unit }): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(['questions']);
  const stable = useStableLists();
  const map = questionMap(unit);
  const ids = Object.keys(map);
  const unplaced = questionsNotInSections(unit);
  return (
    <View style={{ gap: space[3] }}>
      <IssueLines issues={issues} />
      <Note>
        Every question of the unit is edited here. Place one in a section with a question block (on
        the Sections tab) and in the workbook (on the Workbook tab). Only questions marked as
        offline-marked can grant mastery; the rest are advisory.
      </Note>
      {unplaced.length > 0 ? (
        <Small>Not placed in any section: {unplaced.join(', ')}.</Small>
      ) : null}
      <SubHeading>
        {ids.length} question{ids.length === 1 ? '' : 's'}
      </SubHeading>
      {ids.map((id) => (
        <QuestionCard
          key={id}
          qid={id}
          question={map[id] as never}
          usage={stable(`q:${id}`, questionUsage(unit, id))}
        />
      ))}
      {!env.readOnly ? (
        <AddMenu
          label="Add a question"
          options={QUESTION_KINDS.map((k: QuestionKind) => ({
            value: k,
            label: `New question: ${QUESTION_KIND_LABELS[k]}`,
          }))}
          onPick={(value) => {
            const { unit: next, id } = addQuestion(
              actions.current(),
              value as QuestionKind,
              env.publishedTaken,
            );
            actions.commit(() => next);
            actions.open(keys.question(id));
            actions.jump(['questions', id, 'prompt']);
          }}
        />
      ) : null}
    </View>
  );
}
