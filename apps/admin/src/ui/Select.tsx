// Fallback for platforms without a native <select>: a row of choice buttons. The admin is web-first, so this
// is only used by tests and by native builds, which are not shipped.
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Label, Small } from './Text';
import type { SelectProps } from './selectTypes';
import { MIN_TARGET, colors, radii, space } from './theme';

export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  hideLabel = false,
  hint,
}: SelectProps): ReactNode {
  return (
    <View style={{ gap: space[1] }}>
      {hideLabel ? null : <Label>{label}</Label>}
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              style={{
                minHeight: MIN_TARGET,
                justifyContent: 'center',
                paddingHorizontal: space[3],
                borderRadius: radii.md,
                borderWidth: 1.5,
                borderColor: selected ? colors.primary : colors.borderStrong,
                backgroundColor: selected ? colors.primaryTint : colors.white,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: selected ? '700' : '400' }}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {hint ? <Small>{hint}</Small> : null}
    </View>
  );
}
