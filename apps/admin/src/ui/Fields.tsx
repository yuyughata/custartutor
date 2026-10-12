import type { ReactNode } from 'react';
import { Switch, Text, TextInput, View, type TextInputProps } from 'react-native';
import { Label, Small } from './Text';
import { MIN_TARGET, colors, radii, space } from './theme';

export interface TextFieldProps
  extends Omit<TextInputProps, 'style' | 'accessibilityLabel' | 'onChangeText'> {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  hint?: string | undefined;
  error?: string | null | undefined;
  /** Visible lines for a multiline field. */
  lines?: number;
  /** Hide the visible label (the accessible label stays), for fields inside table cells. */
  hideLabel?: boolean;
  mono?: boolean;
}

/** A labelled text input. The label is also the accessible name, so tests and screen readers find it. */
export function TextField({
  label,
  value,
  onChangeText,
  hint,
  error,
  lines,
  hideLabel = false,
  mono = false,
  multiline,
  ...input
}: TextFieldProps): ReactNode {
  const isMultiline = multiline ?? (lines !== undefined && lines > 1);
  return (
    <View style={{ gap: space[1], flexShrink: 1 }}>
      {hideLabel ? null : <Label>{label}</Label>}
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.subtle}
        value={value}
        onChangeText={onChangeText}
        multiline={isMultiline}
        {...(isMultiline && lines ? { numberOfLines: lines } : {})}
        {...input}
        style={{
          minHeight: isMultiline ? Math.max(MIN_TARGET, (lines ?? 3) * 22 + 16) : MIN_TARGET,
          borderWidth: 1.5,
          borderColor: error ? colors.danger : colors.borderStrong,
          borderRadius: radii.md,
          paddingHorizontal: space[3],
          paddingVertical: isMultiline ? space[2] : 0,
          fontSize: 15,
          lineHeight: 22,
          color: colors.text,
          backgroundColor: colors.white,
          textAlignVertical: isMultiline ? 'top' : 'center',
          ...(mono ? { fontFamily: 'monospace' } : {}),
        }}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13, lineHeight: 18 }}>
          {error}
        </Text>
      ) : hint ? (
        <Small>{hint}</Small>
      ) : null}
    </View>
  );
}

/** A number field: the text is kept as typed, and `onNumber` fires with a number (or null when it is not one). */
export function NumberField({
  label,
  value,
  onNumber,
  hint,
  error,
  hideLabel,
  placeholder,
  allowDecimal = false,
}: {
  label: string;
  value: number | null;
  onNumber: (value: number | null) => void;
  hint?: string;
  error?: string | null;
  hideLabel?: boolean;
  placeholder?: string;
  allowDecimal?: boolean;
}): ReactNode {
  return (
    <TextField
      label={label}
      value={value === null ? '' : String(value)}
      onChangeText={(text) => {
        const trimmed = text.trim();
        if (trimmed === '') return onNumber(null);
        const parsed = Number(trimmed);
        onNumber(Number.isFinite(parsed) ? parsed : null);
      }}
      keyboardType={allowDecimal ? 'decimal-pad' : 'number-pad'}
      {...(hint ? { hint } : {})}
      {...(error !== undefined ? { error } : {})}
      {...(hideLabel ? { hideLabel } : {})}
      {...(placeholder ? { placeholder } : {})}
    />
  );
}

/** A switch with its label beside it. */
export function Toggle({
  label,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  hint?: string;
}): ReactNode {
  return (
    <View style={{ gap: space[1] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        <Switch
          accessibilityLabel={label}
          value={value}
          disabled={disabled}
          onValueChange={onChange}
          trackColor={{ false: colors.borderStrong, true: colors.primary }}
          thumbColor={colors.white}
        />
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{label}</Text>
      </View>
      {hint ? <Small>{hint}</Small> : null}
    </View>
  );
}
