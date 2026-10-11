import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { layerColors, palette, radii, space } from '@custar/design-tokens';

export function Card({
  children,
  onPress,
  tone = 'plain',
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  tone?: 'plain' | 'core' | 'enrich' | 'muted';
  accessibilityLabel?: string;
}): ReactNode {
  const background =
    tone === 'core'
      ? layerColors.CORE.tint
      : tone === 'enrich'
        ? layerColors.ENRICH.tint
        : tone === 'muted'
          ? palette.placeholderBg
          : palette.white;
  const border =
    tone === 'enrich'
      ? layerColors.ENRICH.bar
      : tone === 'core'
        ? layerColors.CORE.bar
        : palette.placeholderBorder;
  const style = {
    backgroundColor: background,
    borderWidth: 2,
    borderColor: border,
    borderRadius: radii.lg,
    padding: space[4],
    gap: space[2],
  } as const;
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      onPress={onPress}
      style={style}
    >
      {children}
    </Pressable>
  ) : (
    <View style={style}>{children}</View>
  );
}
