import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { StatusTone } from '../lib/workflow';
import { P } from './Text';
import { space, tones } from './theme';

const GLYPH: Record<StatusTone, string> = {
  neutral: 'ℹ',
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  danger: '✕',
};

const ROLE: Record<StatusTone, 'alert' | 'status'> = {
  neutral: 'status',
  info: 'status',
  success: 'status',
  warning: 'alert',
  danger: 'alert',
};

/** A message box with a glyph, a title and optional body and action. Not colour-only. */
export function Banner({
  tone = 'info',
  title,
  children,
  action,
  testID,
}: {
  tone?: StatusTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  testID?: string;
}): ReactNode {
  const palette = tones[tone];
  return (
    <View
      role={ROLE[tone]}
      {...(testID ? { testID } : {})}
      style={{
        flexDirection: 'row',
        gap: space[3],
        padding: space[3],
        borderRadius: 10,
        borderWidth: 1,
        borderLeftWidth: 5,
        borderColor: palette.border,
        backgroundColor: palette.background,
        alignItems: 'flex-start',
      }}
    >
      <Text aria-hidden style={{ color: palette.text, fontSize: 16, fontWeight: '700', width: 18 }}>
        {GLYPH[tone]}
      </Text>
      <View style={{ flex: 1, gap: space[1] }}>
        <Text style={{ color: palette.text, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>
          {title}
        </Text>
        {typeof children === 'string' ? (
          <P style={{ color: palette.text }}>{children}</P>
        ) : (
          children
        )}
        {action}
      </View>
    </View>
  );
}
