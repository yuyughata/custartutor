// Every problem found in the unit, in one place, each one a button that jumps to the field. Errors stop "Save as new
// version"; warnings never do. The same issues are also shown beside their fields; this panel lists all of them, so
// none can hide inside a collapsed card.
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import { describeLocation } from '../jump';
import type { Path } from '../path';
import type { EditorIssue } from '../validate';

const SOURCE_LABEL: Record<EditorIssue['source'], string> = {
  schema: 'format',
  lint: 'publish check',
  ids: 'stable ids',
  editor: 'editor',
};

const LIMIT = 60;

function Item({ issue, unit, onJump }: { issue: EditorIssue; unit: unknown; onJump: (path: Path) => void }): ReactNode {
  const place = describeLocation(unit, issue.owner);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${issue.severity === 'error' ? 'Error' : 'Warning'} in ${place}: ${issue.message}. Go to the field.`}
      onPress={() => onJump(issue.owner)}
      style={{
        padding: space[2],
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: issue.severity === 'error' ? colors.danger : colors.border,
        backgroundColor: issue.severity === 'error' ? colors.dangerTint : colors.white,
        gap: 2,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '800', color: issue.severity === 'error' ? colors.danger : colors.amberText }}>
        {issue.severity === 'error' ? '✕ Error' : '⚠ Warning'} · {place}
        {issue.where ? ` · ${issue.where}` : ''}
      </Text>
      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text }}>{issue.message}</Text>
      <Text style={{ fontSize: 12, color: colors.subtle }}>
        {SOURCE_LABEL[issue.source]} · go to the field
      </Text>
    </Pressable>
  );
}

export function IssueSummary({
  issues,
  errors,
  warnings,
  unit,
  onJump,
  pending,
}: {
  issues: readonly EditorIssue[];
  errors: number;
  warnings: number;
  unit: unknown;
  onJump: (path: Path) => void;
  /** The checks are catching up with the last keystroke. */
  pending: boolean;
}): ReactNode {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const shown = all ? sorted : sorted.slice(0, LIMIT);
  return (
    <View testID="issue-summary" style={{ gap: space[2] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Checks: ${errors} errors, ${warnings} warnings. ${open ? 'Collapse' : 'Expand'} the list.`}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', minHeight: 32 }}
      >
        <Text aria-hidden style={{ fontSize: 14, color: colors.primaryDark, width: 14 }}>
          {open ? '▾' : '▸'}
        </Text>
        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>Checks</Text>
        <Text testID="issue-counts" style={{ fontSize: 14, color: errors > 0 ? colors.danger : colors.textSoft, fontWeight: '700' }}>
          {errors} error{errors === 1 ? '' : 's'} · {warnings} warning{warnings === 1 ? '' : 's'}
          {pending ? ' · checking…' : ''}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ gap: space[2] }}>
          {issues.length === 0 ? (
            <Banner tone="success" title="No problems found">
              <Small>The unit parses and passes every publish check.</Small>
            </Banner>
          ) : (
            <>
              <Small>
                {errors > 0 ? 'Errors stop you saving. ' : ''}Warnings are worth reading but never stop you saving. Press one to go to its field.
              </Small>
              {shown.map((issue) => (
                <Item key={issue.key} issue={issue} unit={unit} onJump={onJump} />
              ))}
              {!all && sorted.length > LIMIT ? (
                <Button label={`Show all ${sorted.length}`} small variant="secondary" onPress={() => setAll(true)} />
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}
