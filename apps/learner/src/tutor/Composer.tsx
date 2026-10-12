import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { MAX_CHILD_MESSAGE_CHARS } from '@custar/tutor-core/client';
import { minTouchTarget, palette, radii, space, textColors } from '@custar/design-tokens';
import { Button } from '../ui';
import { TUTOR_COPY } from './copy';

/** Only show how many characters are left when the end is near; a counter all the time is noise. */
const SHOW_COUNT_FROM = MAX_CHILD_MESSAGE_CHARS - 60;

/**
 * The text box and the big Send button. Text only: no attachments, no links. What is typed lives in this
 * component's state until it is sent; it is never stored or logged.
 */
export function Composer({
  onSend,
  disabled,
  label = TUTOR_COPY.inputLabel,
  sendLabel = TUTOR_COPY.send,
}: {
  onSend: (text: string) => boolean | void;
  disabled: boolean;
  label?: string;
  sendLabel?: string;
}) {
  const [text, setText] = useState('');
  const empty = text.trim().length === 0;

  function submit() {
    if (disabled || empty) return;
    const accepted = onSend(text);
    if (accepted !== false) setText('');
  }

  return (
    <View style={{ gap: space[1] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <TextInput
          accessibilityLabel={label}
          placeholder={TUTOR_COPY.inputPlaceholder}
          placeholderTextColor={palette.muted}
          value={text}
          onChangeText={setText}
          maxLength={MAX_CHILD_MESSAGE_CHARS}
          multiline
          editable={!disabled}
          autoComplete="off"
          autoCapitalize="sentences"
          importantForAutofill="no"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: minTouchTarget + 8,
            maxHeight: 128,
            borderWidth: 2,
            borderColor: palette.placeholderBorder,
            borderRadius: radii.md,
            paddingHorizontal: space[3],
            paddingVertical: space[3],
            fontSize: 20,
            color: textColors.body,
            backgroundColor: disabled ? palette.placeholderBg : palette.white,
          }}
        />
        <Button label={sendLabel} onPress={submit} disabled={disabled || empty} />
      </View>
      {text.length >= SHOW_COUNT_FROM ? (
        <Text style={{ fontSize: 14, color: palette.muted, textAlign: 'right' }}>
          {MAX_CHILD_MESSAGE_CHARS - text.length} left
        </Text>
      ) : null}
    </View>
  );
}
