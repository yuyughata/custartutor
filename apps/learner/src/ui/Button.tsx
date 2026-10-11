import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text } from 'react-native';
import { layerColors, minTouchTarget, palette, radii, space } from '@custar/design-tokens';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const teal = layerColors.CORE;

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}): ReactNode {
  const background =
    variant === 'primary' ? teal.bar : variant === 'danger' ? palette.danger : 'transparent';
  const color = variant === 'primary' || variant === 'danger' ? palette.white : teal.text;
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      {...(accessibilityHint ? { accessibilityHint } : {})}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={{
        minHeight: minTouchTarget + 4,
        paddingHorizontal: space[6],
        borderRadius: radii.pill,
        backgroundColor: background,
        borderWidth: variant === 'secondary' ? 2 : 0,
        borderColor: teal.bar,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: space[2],
        opacity: inactive ? 0.55 : 1,
      }}
    >
      {busy ? <ActivityIndicator color={color} /> : null}
      <Text style={{ color, fontSize: 18, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
