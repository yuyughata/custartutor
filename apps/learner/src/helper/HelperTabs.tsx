import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { layerColors, minTouchTarget, palette, space } from '@custar/design-tokens';

const teal = layerColors.CORE;

export type HelperTab = 'helper' | 'child';

/**
 * Two big tabs for a phone, where the helper's script and the child's page cannot sit side by side: the script is for
 * the grown-up to read, the page is for the child to see and tap. (On a wide screen both show at once.)
 */
export function HelperTabs({
  tab,
  childName,
  onChange,
}: {
  tab: HelperTab;
  childName: string;
  onChange: (tab: HelperTab) => void;
}): ReactNode {
  const items: { id: HelperTab; label: string }[] = [
    { id: 'helper', label: 'Helper script' },
    { id: 'child', label: `${childName}'s page` },
  ];
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: palette.white,
        borderBottomWidth: 1,
        borderBottomColor: palette.placeholderBorder,
      }}
    >
      {items.map((item) => {
        const selected = item.id === tab;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            aria-selected={selected}
            onPress={() => onChange(item.id)}
            style={{
              flex: 1,
              minHeight: minTouchTarget + 4,
              paddingHorizontal: space[2],
              alignItems: 'center',
              justifyContent: 'center',
              borderBottomWidth: 4,
              borderBottomColor: selected ? teal.bar : 'transparent',
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                fontSize: 18,
                fontWeight: selected ? '700' : '500',
                color: selected ? teal.text : palette.muted,
              }}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
