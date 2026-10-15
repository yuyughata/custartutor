// The building blocks of every editor form, bound to the working copy by a path: a text box with the problems
// beside it, numbers, choices, flags, lists of strings, the small toolbar of an item (move, duplicate, remove) and
// the collapsible card. Each one reads its value from its parent (so only the field being typed in re-renders) and
// writes through the editor's actions (so every change is one undo step and one autosave).
import { createElement, memo, useContext, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Toggle } from '../../ui/Fields';
import { Select } from '../../ui/Select';
import type { SelectOption } from '../../ui/selectTypes';
import { Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import {
  appendAt,
  getAt,
  insertAt,
  moveItem,
  pathKey,
  removeAt,
  samePath,
  type Path,
} from '../path';
import type { EditorIssue } from '../validate';
import { IssuesContext, OpenContext, useActions, useEnv, useIssuesAt } from './context';
import { TextEditor } from './TextEditor';

// --- problems ------------------------------------------------------------------------------------------------------

export function IssueLines({ issues }: { issues: readonly EditorIssue[] }): ReactNode {
  if (issues.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      {issues.map((issue) => (
        <Text
          key={issue.key}
          selectable
          style={{
            fontSize: 13,
            lineHeight: 18,
            color: issue.severity === 'error' ? colors.danger : colors.amberText,
          }}
        >
          {issue.severity === 'error' ? '✕ Error: ' : '⚠ Warning: '}
          {issue.where ? `${issue.where}: ` : ''}
          {issue.message}
        </Text>
      ))}
    </View>
  );
}

/** Problems at a path or anywhere below it, as counts (for a card's heading). */
export function useRollup(prefix: Path): { errors: number; warnings: number } {
  const map = useContext(IssuesContext);
  const key = pathKey(prefix);
  let errors = 0;
  let warnings = 0;
  for (const [owner, list] of map) {
    if (owner === key || owner.startsWith(`${key}.`) || owner.startsWith(`${key}[`)) {
      for (const issue of list) {
        if (issue.severity === 'error') errors += 1;
        else warnings += 1;
      }
    }
  }
  return { errors, warnings };
}

export function RollupBadges({ prefix }: { prefix: Path }): ReactNode {
  const { errors, warnings } = useRollup(prefix);
  if (errors === 0 && warnings === 0) return null;
  return (
    <View style={{ flexDirection: 'row', gap: space[1], flexWrap: 'wrap' }}>
      {errors > 0 ? (
        <Badge label={`${errors} error${errors === 1 ? '' : 's'}`} glyph="✕" tone="danger" />
      ) : null}
      {warnings > 0 ? (
        <Badge label={`${warnings} warning${warnings === 1 ? '' : 's'}`} glyph="⚠" tone="warning" />
      ) : null}
    </View>
  );
}

// --- memo that understands paths -------------------------------------------------------------------------------------

type Props = Record<string, unknown> & { path?: Path };

function sameProps(a: Props, b: Props): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'path') {
      if (!a.path || !b.path || !samePath(a.path, b.path)) return false;
    } else if (!Object.is(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

function memoPath<P extends { path: Path }>(
  component: (props: P) => ReactNode,
): (props: P) => ReactNode {
  return memo(component, (a, b) =>
    sameProps(a as unknown as Props, b as unknown as Props),
  ) as unknown as (props: P) => ReactNode;
}

// --- text ------------------------------------------------------------------------------------------------------------

export interface TxtProps {
  path: Path;
  label: string;
  value: string;
  multiline?: boolean;
  rich?: boolean;
  rows?: number;
  hint?: string;
  mono?: boolean;
  counts?: boolean;
  hideLabel?: boolean;
  /** For a field that is not the author's to change here (ids, numbers set by the planner). */
  locked?: boolean;
  /** An optional field: emptying the box removes it from the unit (an empty text would not parse). */
  optional?: boolean;
  /** Called with the new text instead of writing it to the path (for answers whose parts move together). */
  onValue?: (next: string) => void;
}

export const Txt = memoPath(function Txt({
  path,
  label,
  value,
  multiline,
  rich,
  rows,
  hint,
  mono,
  counts,
  hideLabel,
  locked,
  optional,
  onValue,
}: TxtProps): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(path);
  return (
    <View style={{ gap: space[1], minWidth: 0 }}>
      <TextEditor
        label={label}
        value={value}
        onChange={(next) =>
          onValue
            ? onValue(next)
            : actions.setField(path, optional && next === '' ? undefined : next)
        }
        fieldKey={pathKey(path)}
        readOnly={env.readOnly || locked === true}
        invalid={issues.some((issue) => issue.severity === 'error')}
        {...(multiline ? { multiline } : {})}
        {...(rich ? { rich } : {})}
        {...(rows ? { rows } : {})}
        {...(hint ? { hint } : {})}
        {...(mono ? { mono } : {})}
        {...(counts ? { counts } : {})}
        {...(hideLabel ? { hideLabel } : {})}
      />
      <IssueLines issues={issues} />
    </View>
  );
});

export interface NumProps {
  path: Path;
  label: string;
  value: number | null | undefined;
  hint?: string;
  locked?: boolean;
  width?: number;
}

/**
 * A number box. The text is kept as typed ("1." stays "1." while the person is still typing) and the number is
 * written to the working copy as soon as the text is one; an empty box removes the value.
 */
export const Num = memoPath(function Num({
  path,
  label,
  value,
  hint,
  locked,
  width,
}: NumProps): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(path);
  const shown = typeof value === 'number' ? String(value) : '';
  const [text, setText] = useState(shown);
  const last = useRef(shown);
  // The value changed from outside this box (undo, restore, a button): show it.
  if (last.current !== shown) {
    last.current = shown;
    const typed = text.trim() === '' ? null : Number(text);
    const typedValue = typed !== null && Number.isFinite(typed) ? String(typed) : '';
    if (typedValue !== shown) setText(shown);
  }
  return (
    <View style={{ gap: space[1], ...(width ? { width } : { minWidth: 110 }) }}>
      <TextEditor
        label={label}
        value={text}
        fieldKey={pathKey(path)}
        readOnly={env.readOnly || locked === true}
        invalid={issues.some((issue) => issue.severity === 'error')}
        onChange={(next) => {
          setText(next);
          const trimmed = next.trim();
          if (trimmed === '') return actions.setField(path, undefined);
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed)) actions.setField(path, parsed);
        }}
        {...(hint ? { hint } : {})}
      />
      <IssueLines issues={issues} />
    </View>
  );
});

export interface PickProps {
  path: Path;
  label: string;
  value: string;
  options: readonly SelectOption[];
  placeholder?: string;
  hint?: string;
  hideLabel?: boolean;
  /** Called instead of writing the value to the path (for choices that are an operation). */
  onPick?: (value: string) => void;
}

export const Pick = memo(function Pick({
  path,
  label,
  value,
  options,
  placeholder,
  hint,
  hideLabel,
  onPick,
}: PickProps): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(path);
  return (
    <View
      style={{ gap: space[1], minWidth: 120 }}
      {...({ dataSet: { field: pathKey(path) } } as object)}
    >
      <Select
        label={label}
        value={value}
        options={options}
        disabled={env.readOnly}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(hint ? { hint } : {})}
        {...(hideLabel ? { hideLabel } : {})}
        onChange={(next) =>
          onPick ? onPick(next) : actions.setField(path, next === '' ? undefined : next)
        }
      />
      <IssueLines issues={issues} />
    </View>
  );
});

export function Flag({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}): ReactNode {
  const env = useEnv();
  return (
    <Toggle
      label={label}
      value={value}
      onChange={onChange}
      disabled={env.readOnly}
      {...(hint ? { hint } : {})}
    />
  );
}

// --- toolbars and lists ------------------------------------------------------------------------------------------------

export interface BarProps {
  /** What the item is called in the buttons' names ("block 2"). */
  noun: string;
  canUp?: boolean;
  canDown?: boolean;
  onUp?: (() => void) | undefined;
  onDown?: (() => void) | undefined;
  onDuplicate?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  /** Why the remove button is disabled (for example a published id). */
  removeBlockedReason?: string | null;
}

/** Move, duplicate and remove for one item. Hidden entirely when the editor is read-only. */
export function ItemBar({
  noun,
  canUp = true,
  canDown = true,
  onUp,
  onDown,
  onDuplicate,
  onRemove,
  removeBlockedReason,
}: BarProps): ReactNode {
  const env = useEnv();
  if (env.readOnly) return null;
  return (
    <View
      style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap', alignItems: 'flex-start' }}
    >
      {onUp ? (
        <Button
          label="↑"
          accessibilityLabel={`Move ${noun} up`}
          variant="secondary"
          small
          disabled={!canUp}
          onPress={onUp}
        />
      ) : null}
      {onDown ? (
        <Button
          label="↓"
          accessibilityLabel={`Move ${noun} down`}
          variant="secondary"
          small
          disabled={!canDown}
          onPress={onDown}
        />
      ) : null}
      {onDuplicate ? (
        <Button
          label="Duplicate"
          accessibilityLabel={`Duplicate ${noun}`}
          variant="secondary"
          small
          onPress={onDuplicate}
        />
      ) : null}
      {onRemove ? (
        <Button
          label="Remove"
          accessibilityLabel={`Remove ${noun}`}
          variant="secondary"
          small
          disabled={Boolean(removeBlockedReason)}
          reason={removeBlockedReason}
          onPress={onRemove}
        />
      ) : null}
    </View>
  );
}

export function AddButton({
  label,
  onPress,
  disabled,
  reason,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  reason?: string | null;
}): ReactNode {
  const env = useEnv();
  if (env.readOnly) return null;
  return (
    <View style={{ alignItems: 'flex-start' }}>
      <Button
        label={label}
        variant="secondary"
        small
        onPress={onPress}
        disabled={disabled === true}
        reason={reason}
      />
    </View>
  );
}

/** A choice that does something when picked (add a block, add a question) and springs back to the prompt. */
export function AddMenu({
  label,
  options,
  onPick,
}: {
  label: string;
  options: readonly SelectOption[];
  onPick: (value: string) => void;
}): ReactNode {
  const env = useEnv();
  if (env.readOnly) return null;
  return (
    <View style={{ minWidth: 200, maxWidth: 320 }}>
      <Select
        label={label}
        value=""
        options={options}
        placeholder={`${label}…`}
        hideLabel
        onChange={(value) => value !== '' && onPick(value)}
      />
    </View>
  );
}

export interface StringsProps {
  path: Path;
  label: string;
  /** "accepted answer", "hint", "step": how one item is called in button names and field labels. */
  noun: string;
  values: readonly string[];
  /** The fewest items it may have (a remove below this is disabled). */
  min?: number;
  max?: number;
  rich?: boolean;
  multiline?: boolean;
  hint?: string;
  addLabel?: string;
}

/** A list of one-line (or multi-line) texts that can grow, shrink and be reordered. */
export const Strings = memoPath(function Strings({
  path,
  label,
  noun,
  values,
  min = 0,
  max = 99,
  rich,
  multiline,
  hint,
  addLabel,
}: StringsProps): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(path);
  return (
    <View style={{ gap: space[2] }} {...({ dataSet: { field: pathKey(path) } } as object)}>
      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textSoft }}>{label}</Text>
      {hint ? <Small>{hint}</Small> : null}
      <IssueLines issues={issues} />
      {values.map((value, index) => (
        <View key={index} style={{ gap: space[1] }}>
          <Txt
            path={[...path, index]}
            label={`${noun} ${index + 1}`}
            value={value}
            {...(rich ? { rich } : {})}
            {...(multiline ? { multiline } : {})}
          />
          <ItemBar
            noun={`${noun} ${index + 1}`}
            canUp={index > 0}
            canDown={index < values.length - 1}
            onUp={() => actions.commit((u) => moveItem(u, path, index, index - 1))}
            onDown={() => actions.commit((u) => moveItem(u, path, index, index + 1))}
            {...(values.length > min
              ? { onRemove: () => actions.commit((u) => removeAt(u, [...path, index])) }
              : {})}
          />
        </View>
      ))}
      {!env.readOnly ? (
        <AddButton
          label={addLabel ?? `Add ${noun}`}
          disabled={values.length >= max}
          reason={values.length >= max ? `At most ${max}.` : null}
          onPress={() => actions.commit((u) => appendAt(u, path, ''))}
        />
      ) : null}
    </View>
  );
});

// --- cards -------------------------------------------------------------------------------------------------------------

export function ItemCard({
  title,
  subtitle,
  openKey,
  defaultOpen = true,
  rollup,
  bar,
  tone = 'plain',
  children,
  testID,
  fieldKey,
}: {
  title: string;
  subtitle?: string | undefined;
  openKey: string;
  defaultOpen?: boolean;
  rollup: Path;
  bar?: ReactNode;
  tone?: 'plain' | 'core' | 'enrich';
  children: ReactNode;
  testID?: string;
  fieldKey?: string;
}): ReactNode {
  const actions = useActions();
  const open = useContext(OpenContext).get(openKey) ?? defaultOpen;
  const accent =
    tone === 'enrich' ? colors.amber : tone === 'core' ? colors.primary : colors.border;
  return (
    <View
      {...(testID ? { testID } : {})}
      {...({ dataSet: { field: fieldKey ?? openKey } } as object)}
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderLeftWidth: 5,
        borderLeftColor: accent,
        borderRadius: radii.lg,
        backgroundColor: colors.white,
        padding: space[3],
        gap: space[3],
      }}
    >
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${title}`}
          accessibilityState={{ expanded: open }}
          onPress={() => actions.toggle(openKey, defaultOpen)}
          style={{
            flexDirection: 'row',
            gap: space[2],
            alignItems: 'center',
            flexShrink: 1,
            minHeight: 32,
          }}
        >
          <Text aria-hidden style={{ fontSize: 14, color: colors.primaryDark, width: 14 }}>
            {open ? '▾' : '▸'}
          </Text>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, flexShrink: 1 }}>
            {title}
          </Text>
        </Pressable>
        <RollupBadges prefix={rollup} />
      </View>
      {subtitle ? <Small>{subtitle}</Small> : null}
      {open ? (
        <View style={{ gap: space[3] }}>
          {children}
          {bar}
        </View>
      ) : (
        bar
      )}
    </View>
  );
}

export function SubHeading({ children }: { children: ReactNode }): ReactNode {
  return createElement(
    Text,
    {
      style: { fontSize: 15, fontWeight: '800', color: colors.primaryDark },
      accessibilityRole: 'header',
    },
    children,
  );
}

export function Row({
  children,
  gap = space[3],
}: {
  children: ReactNode;
  gap?: number;
}): ReactNode {
  return (
    <View style={{ flexDirection: 'row', gap, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {children}
    </View>
  );
}

export function Note({ children }: { children: ReactNode }): ReactNode {
  return (
    <View
      style={{
        padding: space[3],
        borderRadius: radii.md,
        backgroundColor: colors.page,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Small>{children}</Small>
    </View>
  );
}

// --- a list of structured items ----------------------------------------------------------------------------------------

export interface RowsProps {
  path: Path;
  label?: string;
  /** How one item is called in button names ("line", "step", "pair"). */
  noun: string;
  count: number;
  min?: number;
  max?: number;
  /** What a new item looks like. */
  blank: () => unknown;
  /** The fields of one item. */
  renderItem: (itemPath: Path, index: number) => ReactNode;
  hint?: string;
  addLabel?: string;
  /** Why an item cannot be removed (for example a published id); null when it may. */
  removeBlocked?: (index: number) => string | null;
}

/** Items made of several fields (a dialogue line, an activity step): each with its own move, duplicate and remove. */
export function Rows({
  path,
  label,
  noun,
  count,
  min = 1,
  max = 99,
  blank,
  renderItem,
  hint,
  addLabel,
  removeBlocked,
}: RowsProps): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const issues = useIssuesAt(path);
  const items = Array.from({ length: count }, (_, index) => index);
  return (
    <View style={{ gap: space[2] }} {...({ dataSet: { field: pathKey(path) } } as object)}>
      {label ? (
        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textSoft }}>{label}</Text>
      ) : null}
      {hint ? <Small>{hint}</Small> : null}
      <IssueLines issues={issues} />
      {items.map((index) => (
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
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.subtle }}>
            {noun.charAt(0).toUpperCase() + noun.slice(1)} {index + 1}
          </Text>
          {renderItem([...path, index], index)}
          <ItemBar
            noun={`${noun} ${index + 1}`}
            canUp={index > 0}
            canDown={index < count - 1}
            onUp={() => actions.commit((u) => moveItem(u, path, index, index - 1))}
            onDown={() => actions.commit((u) => moveItem(u, path, index, index + 1))}
            onDuplicate={
              count < max
                ? () =>
                    actions.commit((u) => {
                      const list = (getAt(u, path) as unknown[] | undefined) ?? [];
                      return insertAt(u, path, index + 1, structuredClone(list[index]));
                    })
                : undefined
            }
            onRemove={
              count > min ? () => actions.commit((u) => removeAt(u, [...path, index])) : undefined
            }
            removeBlockedReason={removeBlocked?.(index) ?? null}
          />
        </View>
      ))}
      {!env.readOnly ? (
        <AddButton
          label={addLabel ?? `Add ${noun}`}
          disabled={count >= max}
          reason={count >= max ? `At most ${max}.` : null}
          onPress={() => actions.commit((u) => appendAt(u, path, blank()))}
        />
      ) : null}
    </View>
  );
}

/** A button that is on or off ("Correct answer"), with the state in its name, not only its colour. */
export function Mark({
  label,
  on,
  onPress,
  name,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  name: string;
}): ReactNode {
  const env = useEnv();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={name}
      accessibilityState={{ checked: on, disabled: env.readOnly }}
      disabled={env.readOnly}
      onPress={onPress}
      style={{
        minHeight: 36,
        paddingHorizontal: space[3],
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        borderRadius: radii.md,
        borderWidth: 1.5,
        borderColor: on ? colors.success : colors.borderStrong,
        backgroundColor: on ? colors.successTint : colors.white,
        alignSelf: 'flex-start',
      }}
    >
      <Text aria-hidden style={{ fontSize: 15, color: on ? colors.success : colors.subtle }}>
        {on ? '✓' : '○'}
      </Text>
      <Text
        style={{ fontSize: 14, fontWeight: '700', color: on ? colors.success : colors.textSoft }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
