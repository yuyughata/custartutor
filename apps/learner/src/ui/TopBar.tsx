import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { layerColors, minTouchTarget, palette, space } from '@custar/design-tokens';

const teal = layerColors.CORE;

/** Back button, title and an optional action, pinned above the screen content. */
export function TopBar({
  title,
  back = true,
  action,
}: {
  title: string;
  back?: boolean;
  action?: { label: string; onPress: () => void };
}): ReactNode {
  const router = useRouter();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        paddingHorizontal: space[4],
        backgroundColor: teal.tint,
        borderBottomWidth: 1,
        borderBottomColor: palette.placeholderBorder,
        minHeight: minTouchTarget + 8,
      }}
    >
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={{ minHeight: minTouchTarget, justifyContent: 'center', paddingRight: space[2] }}
        >
          <Text style={{ color: teal.text, fontSize: 24, fontWeight: '700' }}>←</Text>
        </Pressable>
      ) : null}
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{ flex: 1, color: teal.text, fontSize: 20, fontWeight: '700' }}
      >
        {title}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          style={{ minHeight: minTouchTarget, justifyContent: 'center' }}
        >
          <Text style={{ color: teal.text, fontSize: 16, fontWeight: '700' }}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
