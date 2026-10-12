// One section of the textbook: its type, heading and blocks, a reading-level meter, its offline tutor script, and where
// the rest of the unit refers to it. A section that was ever published cannot be deleted (children's progress refers
// to its id); its text can be rewritten freely.
import { memo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { QUESTION_KINDS, type AnyBlock, type QuestionKind, type SectionType, type Stage, type UnitKind } from '@custar/content-schema';
import { Badge } from '../../ui/Badge';
import { Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import { ALL_SECTION_TYPES, QUESTION_KIND_LABELS, SECTION_TYPE_LABELS, sectionTypesFor } from '../factories';
import { keys } from '../jump';
import { addBlock, addQuestion, duplicateSection, moveSection, removeSection, setSectionType } from '../ops';
import { insertAt, type Path } from '../path';
import { readingLabel, readingMeter } from '../reading';
import { protection } from '../stableIds';
import { BLOCK_MENU, BlockCard, LangField } from './BlockEditors';
import { useActions, useEnv, useIssuesAt } from './context';
import { AddMenu, IssueLines, ItemBar, ItemCard, Note, Pick, Row, Txt } from './Fields';
import { TutorScriptEditor } from './TutorScriptEditor';

type Rec = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function recs(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'object' && v !== null ? (v as Rec) : {})) : [];
}

/** The reading-level meter of a section, in words and a bar (never colour alone). */
export function ReadingMeterView({ blocks, stage }: { blocks: readonly AnyBlock[]; stage: Stage }): ReactNode {
  const meter = readingMeter(blocks, stage);
  const share = meter.average === null || meter.limit === null ? 0 : Math.min(1, meter.average / (meter.limit * 1.5));
  const over = meter.status === 'over';
  return (
    <View testID="reading-meter" style={{ gap: space[1] }}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: over ? colors.amberText : colors.textSoft }}>
        {over ? '⚠ ' : ''}Reading level: {readingLabel(meter)}
      </Text>
      {meter.limit !== null && meter.average !== null ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`Average sentence length ${meter.average.toFixed(1)} of ${meter.limit}`}
          style={{ height: 8, borderRadius: radii.pill, backgroundColor: colors.border, maxWidth: 360, overflow: 'hidden' }}
        >
          <View style={{ width: `${Math.round(share * 100)}%`, height: 8, backgroundColor: over ? colors.amber : colors.primary }} />
        </View>
      ) : null}
      {over && meter.longest ? <Small>Longest sentence ({meter.longest.words} words): "{meter.longest.text.slice(0, 120)}{meter.longest.text.length > 120 ? '…' : ''}"</Small> : null}
    </View>
  );
}

export interface SectionCardProps {
  index: number;
  count: number;
  section: Rec;
  kind: UnitKind;
  stage: Stage;
  questions: readonly { id: string; label: string }[];
  questionRecords: Record<string, Rec>;
  /** Where the section is referred to outside its own place (session plan, manual), as phrases. */
  usage: readonly string[];
  /** Enrichment sections the lesson has / the template's limits, to show beside the type picker. */
  enrichment: { used: number; min: number; max: number } | null;
}

export const SectionCard = memo(function SectionCard({ index, count, section, kind, stage, questions, questionRecords, usage, enrichment }: SectionCardProps): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const path: Path = ['sections', index];
  const issues = useIssuesAt(path);
  const blocksIssues = useIssuesAt([...path, 'blocks']);
  const id = str(section.id);
  const type = str(section.type) as SectionType;
  const layer = str(section.layer);
  const heading = str(section.heading);
  const blocks = recs(section.blocks);
  const lock = protection('section', id, env.published);
  const typeLabel = SECTION_TYPE_LABELS[type] ?? type;
  const types = Array.from(new Set<SectionType>([...sectionTypesFor(kind), ...(ALL_SECTION_TYPES.includes(type) ? [type] : [])]));
  const tone = layer === 'ENRICH' ? 'enrich' : layer === 'CORE' || layer === 'CORE+' ? 'core' : 'plain';

  const addFromMenu = (value: string): void => {
    if (value.startsWith('block:')) {
      actions.commit((u) => addBlock(u, index, value.slice(6) as never));
      actions.open(keys.block(id, blocks.length));
    } else if (value === 'question:existing') {
      actions.commit((u) => insertAt(u, [...path, 'blocks'], Number.MAX_SAFE_INTEGER, { type: 'question', question_id: '' }));
      actions.open(keys.block(id, blocks.length));
    } else if (value.startsWith('question:new:')) {
      const kindOfQuestion = value.slice('question:new:'.length) as QuestionKind;
      const { unit, id: newId } = addQuestion(actions.current(), kindOfQuestion, env.publishedTaken, { sectionIndex: index });
      actions.commit(() => unit);
      actions.open(keys.block(id, blocks.length));
      actions.open(keys.question(newId));
    }
  };

  return (
    <ItemCard
      title={`${index + 1}. ${heading.trim() === '' ? typeLabel : heading}`}
      subtitle={`${typeLabel} · ${layer || 'no layer'} · ${blocks.length} block${blocks.length === 1 ? '' : 's'} · id ${id}`}
      openKey={keys.section(id)}
      defaultOpen={index === 0}
      tone={tone}
      fieldKey={`sections[${index}]`}
      rollup={path}
      testID={`section-${index}`}
      bar={
        <ItemBar
          noun={`section ${index + 1} (${heading || typeLabel})`}
          canUp={index > 0}
          canDown={index < count - 1}
          onUp={() => actions.commit((u) => moveSection(u, index, index - 1))}
          onDown={() => actions.commit((u) => moveSection(u, index, index + 1))}
          onDuplicate={() => {
            const { unit, id: newId } = duplicateSection(actions.current(), index, env.publishedTaken);
            if (newId === '') return;
            actions.commit(() => unit);
            actions.open(keys.section(newId));
          }}
          onRemove={() =>
            actions.confirmDelete({
              title: `Remove section ${index + 1} (${heading || typeLabel})?`,
              notes: [
                ...(usage.length > 0 ? [`It is also in: ${usage.join('; ')}. It will be taken out of those.`] : []),
                'The questions placed in it stay in the unit; they will be listed as not placed in a section.',
              ],
              confirmLabel: 'Remove section',
              onConfirm: () => actions.commit((u) => removeSection(u, index).unit),
            })
          }
          removeBlockedReason={lock.reason}
        />
      }
    >
      <IssueLines issues={issues} />
      <Row>
        <View style={{ minWidth: 200, flexGrow: 1, maxWidth: 320 }}>
          <Txt path={[...path, 'id']} label="Section id (fixed)" value={id} mono locked hint="Ids never change: children's progress refers to them." />
        </View>
        <View style={{ minWidth: 240, flexGrow: 1, maxWidth: 360 }}>
          <Pick
            path={[...path, 'type']}
            label="Type of section"
            value={type}
            options={types.map((t) => ({ value: t, label: SECTION_TYPE_LABELS[t] ?? t }))}
            onPick={(next) => actions.commit((u) => setSectionType(u, index, next as SectionType))}
          />
        </View>
      </Row>
      <Row>
        <Badge label={`Layer ${layer || '?'}`} tone={layer === 'ENRICH' ? 'warning' : 'info'} />
        {enrichment && layer === 'ENRICH' ? (
          <Small>
            This lesson has {enrichment.used} enrichment section{enrichment.used === 1 ? '' : 's'} (it needs {enrichment.min} to {enrichment.max}). The layer follows the type.
          </Small>
        ) : (
          <Small>The layer follows the type of section.</Small>
        )}
      </Row>
      <Txt path={[...path, 'heading']} label="Heading" value={heading} />
      <LangField path={path} value={section.lang} />
      <ReadingMeterView blocks={blocks as unknown as AnyBlock[]} stage={stage} />
      <View style={{ gap: space[2] }} {...({ dataSet: { field: `sections[${index}].blocks` } } as object)}>
        <Text style={{ fontSize: 15, fontWeight: '800', color: colors.primaryDark }} accessibilityRole="header">
          Blocks
        </Text>
        <IssueLines issues={blocksIssues} />
        {blocks.map((block, blockIndex) => (
          <BlockCard
            key={blockIndex}
            sectionIndex={index}
            sectionId={id}
            blockIndex={blockIndex}
            count={blocks.length}
            block={block}
            questions={questions}
            question={block.type === 'question' ? questionRecords[str(block.question_id)] : undefined}
          />
        ))}
        <AddMenu
          label="Add to this section"
          onPick={addFromMenu}
          options={[
            ...BLOCK_MENU.map((o) => ({ value: `block:${o.value}`, label: `Block: ${o.label}` })),
            { value: 'question:existing', label: 'Block: Question (an existing one)' },
            ...QUESTION_KINDS.map((k) => ({ value: `question:new:${k}`, label: `New question: ${QUESTION_KIND_LABELS[k]}` })),
          ]}
        />
      </View>
      <TutorScriptEditor
        scope={`sec:${id}`}
        sectionIndex={index}
        script={typeof section.tutor_script === 'object' && section.tutor_script !== null ? (section.tutor_script as Rec) : undefined}
        questions={questions}
        subject={`section ${index + 1}`}
      />
      {usage.length > 0 ? <Note>This section is also referred to in: {usage.join('; ')}.</Note> : null}
      {lock.reason ? <Small>{lock.reason}</Small> : null}
    </ItemCard>
  );
});
