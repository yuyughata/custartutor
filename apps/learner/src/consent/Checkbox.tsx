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

/** A big, labelled checkbox. Never pre-ticked by the caller. */
export function Checkbox({
  checked,
  onToggle,
  label,
  disabled = false,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onToggle}
      style={{
        minHeight: minTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: radii.md,
          borderWidth: 3,
          borderColor: teal.bar,
          backgroundColor: checked ? teal.bar : palette.white,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? (
          <Text style={{ color: palette.white, fontSize: 22, fontWeight: '700' }}>✓</Text>
        ) : null}
      </View>
      <Text style={{ flex: 1, fontSize: 18, lineHeight: 26, color: textColors.body }}>{label}</Text>
    </Pressable>
  );
}
