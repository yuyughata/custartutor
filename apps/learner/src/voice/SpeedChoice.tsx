import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  textColors,
} from '@custar/design-tokens';
import {
  SPEED_LABELS,
  defaultSpeed,
  useSpeedChoice,
  type SpeedChoice as Choice,
} from './readAloud/prefs';

const teal = layerColors.CORE;
const CHOICES: Choice[] = ['slow', 'normal'];

/**
 * Lets a grown-up choose how fast read-aloud speaks. With no choice the child's default applies (slow for a child
 * who cannot read yet). The choice lasts until the app is closed (see `readAloud/prefs.ts`).
 */
export function SpeedChoice({ readingMode }: { readingMode?: string | null }): ReactNode {
  const [choice, setChoice] = useSpeedChoice();
  const active = choice ?? defaultSpeed(readingMode);
  return (
    <View accessibilityRole="radiogroup" style={{ gap: space[2] }}>
      <Text style={{ color: textColors.secondary, fontSize: 16, fontWeight: '600' }}>
        Reading speed
      </Text>
      <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
        {CHOICES.map((speed) => {
          const selected = active === speed;
          return (
            <Pressable
              key={speed}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              aria-checked={selected}
              accessibilityLabel={`Reading speed: ${SPEED_LABELS[speed]}`}
              onPress={() => setChoice(speed)}
              style={{
                minHeight: minTouchTarget,
                paddingHorizontal: space[4],
                borderRadius: radii.pill,
                borderWidth: 2,
                borderColor: selected ? teal.bar : palette.placeholderBorder,
                backgroundColor: selected ? teal.tint : palette.white,
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: selected ? '700' : '400',
                  color: textColors.body,
                }}
              >
                {SPEED_LABELS[speed]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
