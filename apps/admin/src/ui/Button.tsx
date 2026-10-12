import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View, type PressableStateCallbackType } from 'react-native';
import { MIN_TARGET, colors, radii, space } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  /** Why the button is disabled, in words. Shown under the button, never hidden in a tooltip. */
  reason?: string | null | undefined;
  small?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/** A button that keeps its label when busy and says why it is disabled. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  reason,
  small = false,
  accessibilityLabel,
  testID,
}: ButtonProps): ReactNode {
  const inactive = disabled || busy;
  const filled = variant === 'primary' || variant === 'danger';
  const background = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : colors.white;
  const color = filled ? colors.white : variant === 'ghost' ? colors.primaryDark : colors.primaryDark;
  const border = variant === 'secondary' ? colors.primary : variant === 'ghost' ? 'transparent' : background;
  return (
    <View style={{ alignItems: 'flex-start', gap: space[1] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: inactive, busy }}
        disabled={inactive}
        onPress={onPress}
        {...(testID ? { testID } : {})}
        style={(state) => {
          // react-native-web adds `hovered` and `focused` to the state.
          const { focused, hovered } = state as PressableStateCallbackType & {
            focused?: boolean;
            hovered?: boolean;
          };
          return {
          minHeight: small ? 32 : MIN_TARGET,
          paddingHorizontal: small ? space[3] : space[4],
          borderRadius: radii.md,
          backgroundColor: background,
          borderWidth: 2,
          borderColor: focused ? colors.amber : border,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: space[2],
          opacity: inactive ? 0.55 : hovered ? 0.92 : 1,
          };
        }}
      >
        {busy ? <ActivityIndicator size="small" color={color} /> : null}
        <Text style={{ color, fontSize: small ? 13 : 15, fontWeight: '700' }}>{label}</Text>
      </Pressable>
      {disabled && reason ? (
        <Text style={{ color: colors.subtle, fontSize: 12, lineHeight: 16, maxWidth: 260 }}>{reason}</Text>
      ) : null}
    </View>
  );
}
