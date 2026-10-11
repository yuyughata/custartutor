import type { ReactNode } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { textColors, typeScale, type TextRole } from '@custar/design-tokens';

/** Splits a string on `**bold**` spans. Odd-indexed parts are bold. Unbalanced markers stay literal. */
export function splitBold(input: string): { text: string; bold: boolean }[] {
  const parts = input.split('**');
  // An even number of parts means an unbalanced marker: keep everything literal.
  if (parts.length % 2 === 0) return [{ text: input, bold: false }];
  return parts
    .map((text, index) => ({ text, bold: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}

export interface RichTextProps {
  children: string;
  role?: TextRole;
  style?: StyleProp<TextStyle>;
  color?: string;
  accessibilityRole?: 'header' | 'text';
}

/** Body text with `**bold**` support, sized from the design tokens. */
export function RichText({
  children,
  role = 'body',
  style,
  color = textColors.body,
  accessibilityRole,
}: RichTextProps): ReactNode {
  const base = typeScale[role];
  return (
    <Text
      accessibilityRole={accessibilityRole}
      style={[
        {
          fontSize: base.fontSize,
          lineHeight: base.lineHeight,
          fontWeight: base.fontWeight,
          color,
        },
        style,
      ]}
    >
      {splitBold(children).map((part, index) =>
        part.bold ? (
          <Text key={index} style={{ fontWeight: '700' }}>
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}
