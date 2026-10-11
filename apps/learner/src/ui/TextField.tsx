import type { ReactNode } from 'react';
import { Text, TextInput, type TextInputProps, View } from 'react-native';
import { minTouchTarget, palette, radii, space, textColors } from '@custar/design-tokens';

export function TextField({
  label,
  error,
  ...input
}: { label: string; error?: string | null } & TextInputProps): ReactNode {
  return (
    <View style={{ gap: space[1] }}>
      <Text style={{ color: textColors.secondary, fontSize: 16, fontWeight: '600' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={palette.muted}
        {...input}
        style={{
          minHeight: minTouchTarget + 4,
          borderWidth: 2,
          borderColor: error ? palette.danger : palette.placeholderBorder,
          borderRadius: radii.md,
          paddingHorizontal: space[4],
          fontSize: 20,
          color: textColors.body,
          backgroundColor: palette.white,
        }}
      />
      {error ? <Text style={{ color: palette.danger, fontSize: 15 }}>{error}</Text> : null}
    </View>
  );
}
