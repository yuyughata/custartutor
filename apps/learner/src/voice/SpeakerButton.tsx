import { useId, type ReactNode } from 'react';
import { Pressable, Text } from 'react-native';
import { layerColors, minTouchTarget, palette, radii, space } from '@custar/design-tokens';
import { useReadAloud } from './useReadAloud';

const teal = layerColors.CORE;

export interface SpeakerButtonProps {
  /** What to read. Bold markers are removed before speaking. */
  text: string;
  /** Identifies this button when several are on screen. Default: unique per button. */
  speakKey?: string;
  /** Visible words next to the icon, for example "Listen". The accessible name stays "Read this aloud". */
  label?: string;
  /** The child's reading mode, for the default speed. */
  readingMode?: string | null;
  /** Bigger target and text, for buttons a child presses. */
  large?: boolean;
}

/**
 * A speaker button: press to hear `text`, press again to stop. A 48 px target (taller when `large`), labelled
 * "Read this aloud" for screen readers. It renders NOTHING while read-aloud is unavailable, so a phone with no voice
 * never shows a button that does nothing.
 */
export function SpeakerButton({
  text,
  speakKey,
  label,
  readingMode,
  large = false,
}: SpeakerButtonProps): ReactNode {
  const generated = useId();
  const key = speakKey ?? generated;
  const read = useReadAloud({ readingMode });
  if (!read.available) return null;

  const speaking = read.isSpeaking(key);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speaking ? 'Stop reading aloud' : 'Read this aloud'}
      accessibilityState={{ selected: speaking }}
      onPress={() => read.toggle(key, text)}
      style={{
        alignSelf: 'flex-start',
        minHeight: large ? 60 : minTouchTarget,
        minWidth: large ? 60 : minTouchTarget,
        paddingHorizontal: label ? space[4] : space[2],
        borderRadius: radii.pill,
        borderWidth: 2,
        borderColor: teal.bar,
        backgroundColor: speaking ? teal.bar : palette.white,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space[2],
      }}
    >
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: large ? 28 : 22 }}>
        {speaking ? '⏹' : '🔊'}
      </Text>
      {label ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            fontSize: large ? 22 : 18,
            fontWeight: '700',
            color: speaking ? palette.white : teal.text,
          }}
        >
          {speaking ? 'Stop' : label}
        </Text>
      ) : null}
    </Pressable>
  );
}
