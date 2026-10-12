// The editor's text box outside the browser. The admin app is web-first and never shipped to phones, so this is only
// the plain fallback: a labelled TextInput with a Bold button that wraps the selection (no live preview).
import { useState, type ReactNode } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from '../../ui/Button';
import { Small } from '../../ui/Text';
import { MIN_TARGET, colors, radii, space } from '../../ui/theme';
import { charCount, toggleBold, wordCount } from '../markup';
import type { TextEditorProps } from './textEditorTypes';

export function TextEditor({
  label,
  value,
  onChange,
  multiline = false,
  rich = false,
  rows = 3,
  hint,
  readOnly = false,
  invalid = false,
  mono = false,
  counts = false,
  hideLabel = false,
}: TextEditorProps): ReactNode {
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  return (
    <View style={{ gap: space[1] }}>
      {hideLabel ? null : (
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textSoft }}>{label}</Text>
      )}
      <TextInput
        accessibilityLabel={label}
        value={value}
        editable={!readOnly}
        multiline={multiline}
        numberOfLines={multiline ? rows : 1}
        onChangeText={onChange}
        onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
        style={{
          minHeight: multiline ? rows * 22 + 16 : MIN_TARGET,
          borderWidth: 1.5,
          borderColor: invalid ? colors.danger : colors.borderStrong,
          borderRadius: radii.md,
          paddingHorizontal: space[3],
          fontSize: 15,
          color: colors.text,
          backgroundColor: readOnly ? colors.page : colors.white,
          ...(mono ? { fontFamily: 'monospace' } : {}),
        }}
      />
      {rich && !readOnly ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Button
            label="Bold"
            variant="secondary"
            small
            onPress={() => onChange(toggleBold(value, selection).text)}
          />
        </View>
      ) : null}
      {hint ? <Small>{hint}</Small> : null}
      {counts || rich ? (
        <Small>
          {charCount(value)} characters · {wordCount(value)} words
        </Small>
      ) : null}
    </View>
  );
}
