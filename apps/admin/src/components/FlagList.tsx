import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Flag } from '@custar/authoring-core';
import { countFlags, flagCodeLabel, severityLabel, sortFlags } from '../lib/flags';
import { Badge } from '../ui/Badge';
import { P, Small } from '../ui/Text';
import { colors, radii, space, tones } from '../ui/theme';

/** One advisory note: severity (glyph and word), where it is about, and the message. */
export function FlagItem({
  flag,
  onJump,
}: {
  flag: Flag;
  onJump?: (() => void) | undefined;
}): ReactNode {
  const concern = flag.severity === 'concern';
  const palette = tones[concern ? 'warning' : 'info'];
  return (
    <View
      style={{
        gap: space[1],
        padding: space[3],
        borderRadius: radii.md,
        borderWidth: 1,
        borderLeftWidth: 5,
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge
          label={severityLabel(flag.severity)}
          glyph={concern ? '⚠' : 'ℹ'}
          tone={concern ? 'warning' : 'info'}
        />
        <Text style={{ fontWeight: '700', fontSize: 13, color: palette.text }}>
          {flagCodeLabel(flag.code)}
        </Text>
        {flag.week_no !== undefined ? <Small>Week {flag.week_no}</Small> : null}
        {flag.path ? <Small>{flag.path}</Small> : null}
      </View>
      <P style={{ color: colors.text }}>{flag.message}</P>
      {onJump ? (
        <Text
          accessibilityRole="button"
          onPress={onJump}
          style={{
            color: colors.primary,
            fontWeight: '700',
            fontSize: 13,
            textDecorationLine: 'underline',
          }}
        >
          Show in preview
        </Text>
      ) : null}
    </View>
  );
}

/** Flags listed by severity, concerns first. */
export function FlagList({
  flags,
  emptyText,
  onJump,
  limit = 6,
}: {
  flags: readonly Flag[];
  emptyText?: string;
  onJump?: (flag: Flag) => void;
  /** How many flags to show before "Show all". Concerns are never hidden. */
  limit?: number;
}): ReactNode {
  const [all, setAll] = useState(false);
  if (flags.length === 0) return emptyText ? <Small>{emptyText}</Small> : null;
  const { concerns, notes } = countFlags(flags);
  const sorted = sortFlags(flags);
  const visible = all
    ? sorted
    : sorted.filter((flag, index) => flag.severity === 'concern' || index < limit);
  const hidden = sorted.length - visible.length;
  return (
    <View style={{ gap: space[2] }}>
      <Small>
        {concerns} concern{concerns === 1 ? '' : 's'} · {notes} note{notes === 1 ? '' : 's'}
      </Small>
      {visible.map((flag, index) => (
        <FlagItem
          key={`${flag.code}-${flag.week_no ?? 'x'}-${index}`}
          flag={flag}
          onJump={flag.path && onJump ? () => onJump(flag) : undefined}
        />
      ))}
      {hidden > 0 || (all && sorted.length > limit) ? (
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
          {all ? 'Show fewer' : `Show ${hidden} more`}
        </Text>
      ) : null}
    </View>
  );
}
