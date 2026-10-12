import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  textColors,
} from '@custar/design-tokens';

const teal = layerColors.CORE;

/** A big on/off choice with a label and a line of explanation. */
export function Toggle({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      aria-checked={on}
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onToggle}
      style={{
        minHeight: minTouchTarget + 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        borderWidth: 2,
        borderColor: on ? teal.bar : palette.placeholderBorder,
        backgroundColor: on ? teal.tint : palette.white,
        borderRadius: radii.lg,
        padding: space[3],
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: radii.sm,
          borderWidth: 2,
          borderColor: teal.bar,
          backgroundColor: on ? teal.bar : palette.white,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {on ? (
          <Text style={{ color: palette.white, fontSize: 20, fontWeight: '700' }}>✓</Text>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: textColors.body }}>{label}</Text>
        <Text style={{ fontSize: 15, color: textColors.secondary }}>{hint}</Text>
      </View>
    </Pressable>
  );
}
