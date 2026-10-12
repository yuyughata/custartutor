import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { H2 } from './Text';
import { colors, radii, space } from './theme';

export function Card({
  children,
  style,
  tone = 'plain',
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: 'plain' | 'muted' | 'core';
  testID?: string;
}): ReactNode {
  return (
    <View
      {...(testID ? { testID } : {})}
      style={[
        {
          backgroundColor: tone === 'muted' ? colors.page : tone === 'core' ? colors.primaryTint : colors.surface,
          borderWidth: 1,
          borderColor: tone === 'core' ? colors.primary : colors.border,
          borderRadius: radii.lg,
          padding: space[4],
          gap: space[3],
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A card with a heading and an optional action on the right. */
export function Section({
  title,
  action,
  children,
  tone,
  testID,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  tone?: 'plain' | 'muted' | 'core';
  testID?: string;
}): ReactNode {
  return (
    <Card {...(tone ? { tone } : {})} {...(testID ? { testID } : {})}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3], flexWrap: 'wrap' }}
      >
        <H2>{title}</H2>
        {action}
      </View>
      {children}
    </Card>
  );
}

export function Row({
  children,
  gap = space[3],
  wrap = true,
  align = 'center',
  style,
}: {
  children: ReactNode;
  gap?: number;
  wrap?: boolean;
  align?: 'center' | 'flex-start' | 'flex-end' | 'stretch';
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  return (
    <View style={[{ flexDirection: 'row', alignItems: align, gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>
      {children}
    </View>
  );
}

export function Stack({
  children,
  gap = space[3],
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  return <View style={[{ gap }, style]}>{children}</View>;
}
