import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { palette, space } from '@custar/design-tokens';

/** A scrolling, centred page for phone and tablet. */
export function Screen({
  children,
  maxWidth = 640,
  background = palette.white,
}: {
  children: ReactNode;
  maxWidth?: number;
  background?: string;
}): ReactNode {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: background }}
      contentContainerStyle={{ alignItems: 'center', padding: space[5], paddingBottom: space[10] }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ width: '100%', maxWidth, gap: space[5] }}>{children}</View>
    </ScrollView>
  );
}
