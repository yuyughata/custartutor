import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { layerColors, minTouchTarget, palette, radii, space } from '@custar/design-tokens';
import { SpeakerButton } from '../voice/SpeakerButton';

const teal = layerColors.CORE;

const BAR_HEIGHT = minTouchTarget + 8;

function BarButton({
  label,
  accessibilityLabel,
  disabled = false,
  busy = false,
  primary = false,
  grow = true,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  primary?: boolean;
  grow?: boolean;
  onPress: () => void;
}): ReactNode {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={{
        flex: grow ? 1 : 0,
        minHeight: BAR_HEIGHT,
        paddingHorizontal: space[4],
        borderRadius: radii.pill,
        borderWidth: 2,
        borderColor: teal.bar,
        backgroundColor: primary ? teal.bar : palette.white,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space[2],
        opacity: inactive ? 0.45 : 1,
      }}
    >
      {busy ? <ActivityIndicator color={primary ? palette.white : teal.text} /> : null}
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        numberOfLines={1}
        style={{ fontSize: 20, fontWeight: '700', color: primary ? palette.white : teal.text }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The helper's controls, pinned to the bottom in two rows: previous / next section, then "Listen" (read this section
 * aloud, hidden when the phone cannot speak) beside "I read it". On the mastery check "I read it" gives way to the
 * check button, which only submits the check: the score and the pass come from the deterministic grader.
 */
export function HelperBar({
  sectionText,
  sectionKey,
  readingMode,
  isFirst,
  isLast,
  onPrevious,
  onNext,
  onRead,
  mastery,
}: {
  sectionText: string;
  sectionKey: string;
  readingMode: string;
  isFirst: boolean;
  isLast: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onRead: () => void;
  mastery: { visible: boolean; enabled: boolean; onCheck: () => void; busy: boolean };
}): ReactNode {
  return (
    <View
      style={{
        padding: space[3],
        backgroundColor: palette.white,
        borderTopWidth: 1,
        borderTopColor: palette.placeholderBorder,
        alignItems: 'center',
      }}
    >
      <View style={{ width: '100%', maxWidth: 640, gap: space[2] }}>
        <View style={{ flexDirection: 'row', gap: space[2] }}>
          <BarButton
            label="← Previous"
            accessibilityLabel="Previous"
            disabled={isFirst}
            onPress={onPrevious}
          />
          <BarButton label="Next →" accessibilityLabel="Next" disabled={isLast} onPress={onNext} />
        </View>
        <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center' }}>
          <SpeakerButton
            text={sectionText}
            speakKey={sectionKey}
            label="Listen"
            readingMode={readingMode}
            large
          />
          {mastery.visible ? (
            <BarButton
              label="I'm finished"
              accessibilityLabel="I'm finished: check my progress"
              primary
              disabled={!mastery.enabled}
              busy={mastery.busy}
              onPress={mastery.onCheck}
            />
          ) : (
            <BarButton label="✓ I read it" accessibilityLabel="I read it" onPress={onRead} />
          )}
        </View>
      </View>
    </View>
  );
}
