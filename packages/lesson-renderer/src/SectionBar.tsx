import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { layerColors, radii, space, type LayerKey } from '@custar/design-tokens';

export interface SectionBarProps {
  heading: string;
  layer: LayerKey;
  /** Grown-ups and admins see the CORE / ENRICH badge; children do not. */
  showBadge: boolean;
}

/** Coloured heading bar for a lesson section (teal for CORE, amber for ENRICH), as in the unit template. */
export function SectionBar({ heading, layer, showBadge }: SectionBarProps): ReactNode {
  const colors = layerColors[layer];
  return (
    <View
      style={{
        backgroundColor: colors.bar,
        borderRadius: radii.sm,
        paddingVertical: space[2],
        paddingHorizontal: space[3],
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          color: colors.onBar,
          fontSize: 22,
          lineHeight: 30,
          fontWeight: '700',
          flexShrink: 1,
        }}
      >
        {heading}
      </Text>
      {showBadge ? (
        <Text
          style={{
            color: colors.onBar,
            opacity: 0.9,
            fontSize: 12,
            lineHeight: 16,
            fontWeight: '700',
            letterSpacing: 0.6,
          }}
        >
          {colors.badge}
        </Text>
      ) : null}
    </View>
  );
}
