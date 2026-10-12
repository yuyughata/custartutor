import type { ReactNode } from 'react';
import { Text as RNText, type StyleProp, type TextStyle } from 'react-native';
import { colors, type } from './theme';

interface TextProps {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
  numberOfLines?: number;
  testID?: string;
}

export function H1({ children, style, testID }: TextProps): ReactNode {
  return (
    <RNText accessibilityRole="header" aria-level={1} style={[type.h1, style]} {...(testID ? { testID } : {})}>
      {children}
    </RNText>
  );
}

export function H2({ children, style, testID }: TextProps): ReactNode {
  return (
    <RNText accessibilityRole="header" aria-level={2} style={[type.h2, style]} {...(testID ? { testID } : {})}>
      {children}
    </RNText>
  );
}

export function H3({ children, style, testID }: TextProps): ReactNode {
  return (
    <RNText accessibilityRole="header" aria-level={3} style={[type.h3, style]} {...(testID ? { testID } : {})}>
      {children}
    </RNText>
  );
}

export function P({ children, style, selectable = true, numberOfLines, testID }: TextProps): ReactNode {
  return (
    <RNText
      selectable={selectable}
      style={[type.body, style]}
      {...(numberOfLines ? { numberOfLines } : {})}
      {...(testID ? { testID } : {})}
    >
      {children}
    </RNText>
  );
}

export function Small({ children, style, selectable = true, numberOfLines, testID }: TextProps): ReactNode {
  return (
    <RNText
      selectable={selectable}
      style={[type.small, style]}
      {...(numberOfLines ? { numberOfLines } : {})}
      {...(testID ? { testID } : {})}
    >
      {children}
    </RNText>
  );
}

export function Label({ children, style }: TextProps): ReactNode {
  return <RNText style={[type.label, style]}>{children}</RNText>;
}

export function Mono({ children, style, selectable = true }: TextProps): ReactNode {
  return (
    <RNText
      selectable={selectable}
      style={[type.small, { fontFamily: 'monospace', color: colors.textSoft }, style]}
    >
      {children}
    </RNText>
  );
}
