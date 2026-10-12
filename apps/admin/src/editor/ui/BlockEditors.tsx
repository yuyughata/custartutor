// The editors of the ten block types (and the stand-in for a block type this build does not know). Each block is a
// card with its own move, duplicate and remove, and the fields of its type; the text fields take `**bold**`.
import { memo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { BLOCK_TYPES, type BlockType } from '@custar/content-schema';
import { Button } from '../../ui/Button';
import { Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS, blockSummary, tableAddColumn, tableAddRow, tableRemoveColumn, tableRemoveRow } from '../blocks';
import { BLOCK_LABELS } from '../factories';
import { duplicateBlock, moveBlock, removeBlock } from '../ops';
import { getAt, setAt, type Path } from '../path';
import { keys } from '../jump';
import { useActions, useEnv, useIssuesAt } from './context';
import { AddButton, IssueLines, ItemBar, ItemCard, Note, Pick, Row, Rows, Txt } from './Fields';

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

const TONES = [
  { value: 'info', label: 'Info (a useful fact)' },
  { value: 'tip', label: 'Tip (a way to remember)' },
  { value: 'not_yet', label: 'Not yet (gentle remediation)' },
];

export const BLOCK_MENU = BLOCK_TYPES.filter((type) => type !== 'question').map((type) => ({
  value: type,
  label: BLOCK_LABELS[type],
}));

/** The optional language tag of a block: shown once it is set, or on request. */
export function LangField({ path, value }: { path: Path; value: unknown }): ReactNode {
  const actions = useActions();
  const env = useEnv();
  if (typeof value === 'string') {
    return (
      <Row>
        <View style={{ minWidth: 200, flexGrow: 1, maxWidth: 360 }}>
          <Txt
            path={[...path, 'lang']}
            label="Language of this block (tag)"
            value={value}
            mono
            hint="For example yo, ig, ha or en-NG. Leave empty to use the section's language; emptying it removes the tag."
            optional
          />
        </View>
      </Row>
    );
  }
  if (env.readOnly) return null;
  return (
    <AddButton label="Set a different language" onPress={() => actions.commit((u) => setAt(u, [...path, 'lang'], 'yo'))} />
  );
}

// --- the fields of each type -------------------------------------------------------------------------------------------

function BlockFields({
  block,
  path,
  questions,
  question,
}: {
  block: Rec;
  path: Path;
  questions: readonly { id: string; label: string }[];
  question: Rec | undefined;
}): ReactNode {
  const actions = useActions();
  const at = (...rest: (string | number)[]): Path => [...path, ...rest];
  switch (block.type) {
    case 'paragraph':
      return <Txt path={at('text')} label="Text" value={str(block.text)} multiline rich rows={4} />;
    case 'bullets':
      return (
        <Rows
          path={at('items')}
          label="Items"
          noun="item"
          count={recs(block.items).length}
          blank={() => ({ text: '' })}
          hint="A bold lead-in (optional) is shown before the text, like a glossary entry."
          renderItem={(itemPath, index) => (
            <>
              <Txt path={[...itemPath, 'lead']} label={`Lead-in of item ${index + 1} (optional)`} value={str(recs(block.items)[index]?.lead)} optional />
              <Txt path={[...itemPath, 'text']} label={`Text of item ${index + 1}`} value={str(recs(block.items)[index]?.text)} multiline rich rows={2} />
            </>
          )}
        />
      );
    case 'definition':
      return (
        <>
          <Txt path={at('term')} label="Term" value={str(block.term)} />
          <Txt path={at('meaning')} label="Meaning" value={str(block.meaning)} multiline rich rows={3} />
        </>
      );
    case 'example':
      return (
        <>
          <Txt path={at('label')} label="Label" value={str(block.label)} hint='For example "Example" or "Try this".' />
          <Txt path={at('text')} label="Text" value={str(block.text)} multiline rich rows={3} />
        </>
      );
    case 'dialogue':
      return (
        <Rows
          path={at('lines')}
          label="Lines"
          noun="line"
          count={recs(block.lines).length}
          blank={() => ({ character: '', text: '' })}
          renderItem={(itemPath, index) => (
            <>
              <Txt path={[...itemPath, 'character']} label={`Who says line ${index + 1}`} value={str(recs(block.lines)[index]?.character)} />
              <Txt path={[...itemPath, 'text']} label={`What line ${index + 1} says`} value={str(recs(block.lines)[index]?.text)} multiline rich rows={2} />
            </>
          )}
        />
      );
    case 'illustration':
      return (
        <>
          <Txt
            path={at('brief')}
            label="Brief for the illustrator"
            value={str(block.brief)}
            multiline
            rows={3}
            hint="Describe the picture: who or what is in it, where, what is happening. No text inside the picture."
          />
          <Txt
            path={at('alt')}
            label="Alt text (read by screen readers and spoken by the tutor)"
            value={str(block.alt)}
            multiline
            rows={2}
            counts
          />
          {typeof block.asset_id === 'string' ? (
            <Note>
              Picture attached: <Text style={{ fontFamily: 'monospace' }}>{block.asset_id}</Text>. Uploading or replacing pictures is not done in this editor; the
              attachment is kept as it is when you save.
            </Note>
          ) : (
            <Small>No picture is attached yet. The learner app shows the brief in a dashed box until one is added.</Small>
          )}
        </>
      );
    case 'callout':
      return (
        <>
          <Pick path={at('tone')} label="Kind of note" value={str(block.tone)} options={TONES} />
          <Txt path={at('text')} label="Text" value={str(block.text)} multiline rich rows={3} />
        </>
      );
    case 'activity_steps':
      return (
        <Rows
          path={at('steps')}
          label="Steps"
          noun="step"
          count={recs(block.steps).length}
          blank={() => ({ label: `Step ${recs(block.steps).length + 1}`, text: '' })}
          renderItem={(itemPath, index) => (
            <>
              <Txt path={[...itemPath, 'label']} label={`Label of step ${index + 1}`} value={str(recs(block.steps)[index]?.label)} />
              <Txt path={[...itemPath, 'text']} label={`What to do in step ${index + 1}`} value={str(recs(block.steps)[index]?.text)} multiline rich rows={2} />
            </>
          )}
        />
      );
    case 'table': {
      const headers = strs(block.headers);
      const rows = Array.isArray(block.rows) ? block.rows.map(strs) : [];
      const change = (fn: (table: Rec) => Rec): void => actions.commit((u) => setAt(u, path, fn(getAt(u, path) as Rec)));
      return (
        <View style={{ gap: space[3] }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textSoft }}>Column headings</Text>
          <Small>Add or remove a column with the buttons under the rows, so every row stays as wide as the headings.</Small>
          {headers.map((heading, c) => (
            <Txt key={c} path={at('headers', c)} label={`Heading of column ${c + 1}`} value={heading} />
          ))}
          <TableGrid path={path} headers={headers} rows={rows} change={change} />
        </View>
      );
    }
    case 'question': {
      const id = str(block.question_id);
      return (
        <>
          <Pick
            path={at('question_id')}
            label="Question shown here"
            value={questions.some((q) => q.id === id) ? id : ''}
            placeholder="Choose a question…"
            options={questions.map((q) => ({ value: q.id, label: q.label }))}
          />
          {id !== '' && !questions.some((q) => q.id === id) ? (
            <Small>"{id}" is not a question of this unit. Choose one above.</Small>
          ) : null}
          {question ? (
            <Note>
              {str(question.kind).replace(/_/g, ' ')} · tier {String(question.tier ?? '?')} · {str(question.prompt) || 'no prompt yet'}
            </Note>
          ) : null}
          {id !== '' && question ? (
            <View style={{ alignItems: 'flex-start' }}>
              <Button label="Edit this question" small variant="secondary" onPress={() => actions.jump(['questions', id])} />
            </View>
          ) : null}
        </>
      );
    }
    case 'unknown':
      return (
        <View style={{ gap: space[2] }}>
          <Note>
            This block has a type the editor does not know ("{str(block.original_type)}"), probably from a newer version of the content format. It is kept exactly as it is. A unit with
            an unrecognised block cannot be published, so the only thing you can do here is remove it.
          </Note>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, color: colors.textSoft }}>
            {JSON.stringify(block.raw ?? null, null, 2)}
          </Text>
        </View>
      );
    default:
      return <Small>This block cannot be edited here.</Small>;
  }
}

function TableGrid({
  path,
  headers,
  rows,
  change,
}: {
  path: Path;
  headers: string[];
  rows: string[][];
  change: (fn: (table: Rec) => Rec) => void;
}): ReactNode {
  const env = useEnv();
  const issues = useIssuesAt([...path, 'rows']);
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textSoft }}>Rows</Text>
      <IssueLines issues={issues} />
      {rows.map((row, r) => (
        <View key={r} style={{ gap: space[1], padding: space[3], borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.page }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.subtle }}>Row {r + 1}</Text>
          {headers.map((heading, c) => (
            <Txt key={c} path={[...path, 'rows', r, c]} label={`Row ${r + 1}, ${heading.trim() === '' ? `column ${c + 1}` : heading}`} value={row[c] ?? ''} />
          ))}
          {!env.readOnly ? (
            <View style={{ alignItems: 'flex-start' }}>
              <Button
                label="Remove row"
                accessibilityLabel={`Remove row ${r + 1}`}
                variant="secondary"
                small
                disabled={rows.length <= 1}
                reason={rows.length <= 1 ? 'A table needs at least one row.' : null}
                onPress={() => change((t) => tableRemoveRow(t, r))}
              />
            </View>
          ) : null}
        </View>
      ))}
      {!env.readOnly ? (
        <Row>
          <Button label="Add row" small variant="secondary" disabled={rows.length >= TABLE_MAX_ROWS} onPress={() => change(tableAddRow)} />
          <Button label="Add column" small variant="secondary" disabled={headers.length >= TABLE_MAX_COLUMNS} onPress={() => change(tableAddColumn)} />
          {headers.map((heading, c) => (
            <Button
              key={c}
              label={`Remove column ${c + 1}`}
              accessibilityLabel={`Remove column ${c + 1}${heading.trim() ? `, ${heading}` : ''}`}
              small
              variant="secondary"
              disabled={headers.length <= 1}
              onPress={() => change((t) => tableRemoveColumn(t, c))}
            />
          ))}
        </Row>
      ) : null}
    </View>
  );
}

// --- the card ----------------------------------------------------------------------------------------------------------

export interface BlockCardProps {
  sectionIndex: number;
  sectionId: string;
  blockIndex: number;
  count: number;
  block: Rec;
  questions: readonly { id: string; label: string }[];
  /** The question this block places, if it is a question block. */
  question: Rec | undefined;
}

export const BlockCard = memo(function BlockCard({ sectionIndex, sectionId, blockIndex, count, block, questions, question }: BlockCardProps): ReactNode {
  const actions = useActions();
  const path: Path = ['sections', sectionIndex, 'blocks', blockIndex];
  const issues = useIssuesAt(path);
  const type = str(block.type);
  const label = type === 'unknown' ? 'Unrecognised block' : (BLOCK_LABELS[type as BlockType] ?? type);
  const noun = `block ${blockIndex + 1} (${label.toLowerCase()})`;
  return (
    <ItemCard
      title={`${blockIndex + 1}. ${label}`}
      subtitle={blockSummary(block)}
      openKey={keys.block(sectionId, blockIndex)}
      fieldKey={`sections[${sectionIndex}].blocks[${blockIndex}]`}
      rollup={path}
      testID={`block-${sectionIndex}-${blockIndex}`}
      bar={
        <ItemBar
          noun={noun}
          canUp={blockIndex > 0}
          canDown={blockIndex < count - 1}
          onUp={() => actions.commit((u) => moveBlock(u, sectionIndex, blockIndex, blockIndex - 1))}
          onDown={() => actions.commit((u) => moveBlock(u, sectionIndex, blockIndex, blockIndex + 1))}
          {...(type !== 'question' && type !== 'unknown'
            ? { onDuplicate: () => actions.commit((u) => duplicateBlock(u, sectionIndex, blockIndex)) }
            : {})}
          onRemove={() => {
            actions.confirmDelete({
              title: `Remove block ${blockIndex + 1} (${label})?`,
              notes: type === 'question' ? ['The question itself stays in the unit; it is only taken out of this section.'] : [],
              confirmLabel: 'Remove block',
              onConfirm: () => actions.commit((u) => removeBlock(u, sectionIndex, blockIndex)),
            });
          }}
        />
      }
    >
      <IssueLines issues={issues} />
      <BlockFields block={block} path={path} questions={questions} question={question} />
      {type !== 'unknown' ? <LangField path={path} value={block.lang} /> : null}
    </ItemCard>
  );
});

