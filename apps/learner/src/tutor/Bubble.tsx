import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  textColors,
  typeScale,
} from '@custar/design-tokens';
import { TUTOR_COPY } from './copy';
import { splitBold } from './sections';

const teal = layerColors.CORE;

/** Text with `**bold**` markers shown as bold, never as markup. */
export function BubbleText({ text, color = textColors.body }: { text: string; color?: string }) {
  return (
    <Text style={{ ...typeScale.body, color }} selectable>
      {splitBold(text).map((run, index) => (
        <Text key={index} style={run.bold ? { fontWeight: '700' } : undefined}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

export interface ReadAloudProps {
  available: boolean;
  speaking: boolean;
  /** Pre-readers get a big labelled button; readers a smaller speaker. */
  big: boolean;
  onPress: () => void;
}

function ReadAloudButton({ available, speaking, big, onPress }: ReadAloudProps) {
  if (!available) return null;
  const label = speaking ? TUTOR_COPY.stopListening : TUTOR_COPY.listen;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speaking ? 'Stop reading' : 'Read this out loud'}
      onPress={onPress}
      style={{
        alignSelf: 'flex-start',
        minHeight: big ? minTouchTarget + 8 : minTouchTarget,
        minWidth: minTouchTarget,
        paddingHorizontal: big ? space[5] : space[3],
        borderRadius: radii.pill,
        borderWidth: 2,
        borderColor: teal.bar,
        backgroundColor: speaking ? teal.bar : palette.white,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: space[2],
      }}
    >
      <Text style={{ fontSize: big ? 24 : 18 }}>{speaking ? '⏹' : '🔊'}</Text>
      {big ? (
        <Text
          style={{
            fontSize: 20,
            fontWeight: '700',
            color: speaking ? palette.white : teal.text,
          }}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function TutorBubble({
  text,
  thinking = false,
  demoTag = false,
  readAloud,
  footer,
}: {
  text: string;
  /** No text yet: show a calm "Thinking…". */
  thinking?: boolean;
  demoTag?: boolean;
  readAloud?: ReadAloudProps | null;
  footer?: ReactNode;
}) {
  return (
    <View style={{ alignItems: 'flex-start' }}>
      <View
        style={{
          maxWidth: '92%',
          backgroundColor: teal.tint,
          borderWidth: 2,
          borderColor: teal.bar,
          borderRadius: radii.lg,
          padding: space[3],
          gap: space[2],
        }}
      >
        {demoTag ? (
          <Text style={{ fontSize: 14, fontWeight: '700', color: palette.enrichDark }}>
            {TUTOR_COPY.demoTag}
          </Text>
        ) : null}
        {thinking && text.length === 0 ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{ ...typeScale.body, color: palette.muted }}
          >
            {TUTOR_COPY.thinking}
          </Text>
        ) : (
          <BubbleText text={text} />
        )}
        {readAloud && text.length > 0 ? <ReadAloudButton {...readAloud} /> : null}
        {footer}
      </View>
    </View>
  );
}

export function ChildBubble({ text }: { text: string }) {
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <View
        style={{
          maxWidth: '88%',
          backgroundColor: palette.placeholderBg,
          borderWidth: 2,
          borderColor: palette.placeholderBorder,
          borderRadius: radii.lg,
          padding: space[3],
        }}
      >
        <BubbleText text={text} />
      </View>
    </View>
  );
}
