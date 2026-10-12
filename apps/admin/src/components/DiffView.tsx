// Shows a section-level diff of two unit versions. Changes are marked with a glyph and a word, and changed
// words are highlighted inside each field (underline for additions, strike-through for removals), so the diff
// reads without colour.
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import {
  wordDiff,
  type ChangeKind,
  type DiffItem,
  type FieldChange,
  type UnitDiff,
} from '../lib/diff';
import type { StatusTone } from '../lib/workflow';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/States';
import { P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';

const CHANGE_STYLE: Record<ChangeKind, { label: string; glyph: string; tone: StatusTone }> = {
  added: { label: 'Added', glyph: '＋', tone: 'success' },
  removed: { label: 'Removed', glyph: '－', tone: 'danger' },
  changed: { label: 'Changed', glyph: '≠', tone: 'warning' },
  moved: { label: 'Moved', glyph: '↕', tone: 'info' },
};

const AREA_LABEL: Record<DiffItem['area'], string> = {
  meta: 'Unit',
  header: 'Header',
  section: 'Section',
  question: 'Question',
  workbook: 'Workbook',
  manual: "Teacher's manual",
  session_plan: 'Session plan',
  other: 'Other',
};

const FIELDS_SHOWN = 8;

function Marked({
  before,
  after,
  side,
}: {
  before: string | null;
  after: string | null;
  side: 'before' | 'after';
}): ReactNode {
  const text = side === 'before' ? before : after;
  if (text === null) return <Small>(nothing)</Small>;
  if (before === null || after === null) {
    return (
      <Text selectable style={{ fontSize: 14, lineHeight: 20, color: colors.text }}>
        {text}
      </Text>
    );
  }
  const segments = wordDiff(before, after).filter((segment) =>
    side === 'before' ? segment.kind !== 'added' : segment.kind !== 'removed',
  );
  return (
    <Text selectable style={{ fontSize: 14, lineHeight: 20, color: colors.text }}>
      {segments.map((segment, index) =>
        segment.kind === 'same' ? (
          segment.text
        ) : (
          <Text
            key={index}
            style={
              segment.kind === 'removed'
                ? {
                    backgroundColor: colors.dangerTint,
                    color: '#8f1d17',
                    textDecorationLine: 'line-through',
                  }
                : {
                    backgroundColor: colors.successTint,
                    color: '#14633a',
                    textDecorationLine: 'underline',
                  }
            }
          >
            {segment.text}
          </Text>
        ),
      )}
    </Text>
  );
}

function FieldRow({ field }: { field: FieldChange }): ReactNode {
  return (
    <View
      style={{
        gap: space[1],
        paddingVertical: space[2],
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.subtle }}>{field.label}</Text>
      <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
          <Small>Before</Small>
          <Marked before={field.before} after={field.after} side="before" />
        </View>
        <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
          <Small>After</Small>
          <Marked before={field.before} after={field.after} side="after" />
        </View>
      </View>
    </View>
  );
}

function Item({ item }: { item: DiffItem }): ReactNode {
  const [all, setAll] = useState(false);
  const style = CHANGE_STYLE[item.change];
  const shown = all ? item.fields : item.fields.slice(0, FIELDS_SHOWN);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.md,
        padding: space[3],
        gap: space[1],
        backgroundColor: colors.white,
      }}
    >
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge label={style.label} glyph={style.glyph} tone={style.tone} />
        <Text style={{ fontWeight: '700', fontSize: 15, color: colors.text, flexShrink: 1 }}>
          {item.title}
        </Text>
        <Small>{AREA_LABEL[item.area]}</Small>
        {item.movedFrom !== undefined && item.movedTo !== undefined ? (
          <Small>
            position {item.movedFrom} → {item.movedTo}
          </Small>
        ) : null}
      </View>
      {shown.map((field, index) => (
        <FieldRow key={`${field.path}-${index}`} field={field} />
      ))}
      {item.fields.length > FIELDS_SHOWN ? (
        <Text
          accessibilityRole="button"
          onPress={() => setAll(!all)}
          style={{
            color: colors.primary,
            fontWeight: '700',
            textDecorationLine: 'underline',
            fontSize: 13,
          }}
        >
          {all ? 'Show fewer' : `Show all ${item.fields.length} changes`}
        </Text>
      ) : null}
    </View>
  );
}

export function DiffView({
  diff,
  fromLabel,
  toLabel,
}: {
  diff: UnitDiff;
  fromLabel: string;
  toLabel: string;
}): ReactNode {
  if (diff.same) {
    return (
      <EmptyState title="No differences">
        <P>
          {fromLabel} and {toLabel} have identical content.
        </P>
      </EmptyState>
    );
  }
  return (
    <View style={{ gap: space[3] }} testID="diff-view">
      <Card tone="muted">
        <P>
          {fromLabel} → {toLabel}: {diff.counts.changed} changed, {diff.counts.added} added,{' '}
          {diff.counts.removed} removed, {diff.counts.moved} moved
        </P>
      </Card>
      {diff.items.map((item) => (
        <Item key={`${item.area}-${item.id}-${item.change}`} item={item} />
      ))}
    </View>
  );
}
