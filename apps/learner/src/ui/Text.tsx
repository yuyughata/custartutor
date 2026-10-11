import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { palette, typeScale, textColors, type TextRole } from '@custar/design-tokens';

export function Title({ children }: { children: ReactNode }): ReactNode {
  return (
    <Text accessibilityRole="header" style={{ ...typeScale.title, color: textColors.heading }}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  role = 'body',
  muted = false,
}: {
  children: ReactNode;
  role?: TextRole;
  muted?: boolean;
}): ReactNode {
  return (
    <Text style={{ ...typeScale[role], color: muted ? palette.muted : textColors.body }}>
      {children}
    </Text>
  );
}

export function ErrorText({ children }: { children: ReactNode }): ReactNode {
  return <Text style={{ ...typeScale.label, color: palette.danger }}>{children}</Text>;
}
