// The browser's own <select>: keyboard and screen-reader friendly, and it opens a native list.
import type { ReactNode } from 'react';
import { View } from 'react-native';
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
  placeholder,
  hint,
}: SelectProps): ReactNode {
  return (
    <View style={{ gap: space[1], flexShrink: 1 }}>
      {hideLabel ? null : <Label>{label}</Label>}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        style={{
          minHeight: MIN_TARGET,
          borderWidth: 1.5,
          borderStyle: 'solid',
          borderColor: colors.borderStrong,
          borderRadius: radii.md,
          paddingLeft: space[3],
          paddingRight: space[3],
          fontSize: 15,
          color: colors.text,
          backgroundColor: colors.white,
        }}
      >
        {placeholder !== undefined ? (
          <option value="" disabled={value !== ''}>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <Small>{hint}</Small> : null}
    </View>
  );
}
