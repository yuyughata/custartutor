import { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { UnitContent } from '@custar/content-schema';
import { layerColors, palette, radii, space, typeScale } from '@custar/design-tokens';
import { Button } from '../ui';
import { ChildBubble, TutorBubble, type ReadAloudProps } from './Bubble';
import { Composer } from './Composer';
import { PRE_READER_QUICK_REPLIES, TUTOR_COPY } from './copy';
import { activityInfo } from './sections';
import type { useReadAloud } from './useReadAloud';
import type { UseTutorChat } from './useTutorChat';
import { isBusy, type TutorBubble as BubbleModel } from './turnState';

function SuggestedQuestion({ unit, bubble }: { unit: UnitContent; bubble: BubbleModel }) {
  const [shown, setShown] = useState(false);
  const info = bubble.activity ? activityInfo(unit, bubble.activity.questionId) : null;
  if (!info) return null;
  return (
    <View style={{ gap: space[2] }}>
      <Button
        label={shown ? TUTOR_COPY.hideQuestion : TUTOR_COPY.tryQuestion}
        variant="secondary"
        onPress={() => setShown((value) => !value)}
      />
      {shown ? (
        <View
          style={{
            backgroundColor: palette.white,
            borderWidth: 2,
            borderColor: layerColors.CORE.bar,
            borderRadius: radii.md,
            padding: space[3],
            gap: space[1],
          }}
        >
          <Text style={{ ...typeScale.body, fontWeight: '700' }}>{info.prompt}</Text>
          {info.where ? (
            <Text style={{ ...typeScale.label, color: palette.muted }}>
              {TUTOR_COPY.questionWhere} “{info.where}”.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The AI tutor chat. The server decides every reply; this only shows what it sends, calmly. */
export function LiveChat({
  chat,
  unit,
  preReader,
  demo,
  voice,
  onUseLite,
}: {
  chat: UseTutorChat;
  unit: UnitContent;
  preReader: boolean;
  demo: boolean;
  voice: ReturnType<typeof useReadAloud>;
  onUseLite: () => void;
}) {
  const scroll = useRef<ScrollView>(null);
  const { state } = chat;
  const busy = isBusy(state);
  const failed = state.phase === 'failed';

  const readAloudFor = (bubble: BubbleModel): ReadAloudProps | null =>
    voice.available
      ? {
          available: true,
          speaking: voice.speakingId === bubble.id,
          big: preReader,
          onPress: () => voice.toggle(bubble.id, bubble.text),
        }
      : null;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space[4], gap: space[3], flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {state.bubbles.length === 0 ? (
          <Text style={{ ...typeScale.bodyLarge, color: palette.muted }}>
            {TUTOR_COPY.emptyLive}
          </Text>
        ) : null}
        {state.bubbles.map((bubble) =>
          bubble.role === 'child' ? (
            <ChildBubble key={bubble.id} text={bubble.text} />
          ) : (
            <TutorBubble
              key={bubble.id}
              text={bubble.text}
              thinking={bubble.streaming === true}
              demoTag={demo}
              readAloud={bubble.streaming ? null : readAloudFor(bubble)}
              footer={<SuggestedQuestion unit={unit} bubble={bubble} />}
            />
          ),
        )}
        {state.error ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              backgroundColor: palette.placeholderBg,
              borderWidth: 2,
              borderColor: palette.placeholderBorder,
              borderRadius: radii.lg,
              padding: space[4],
              gap: space[2],
            }}
          >
            <Text style={{ ...typeScale.bodyLarge, fontWeight: '700' }}>{state.error.title}</Text>
            <Text style={typeScale.body}>{state.error.body}</Text>
            {state.error.canRetry ? <Button label={TUTOR_COPY.retry} onPress={chat.retry} /> : null}
            {state.error.offerLite ? (
              <Button label={TUTOR_COPY.useLite} variant="secondary" onPress={onUseLite} />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      <View
        style={{
          padding: space[4],
          gap: space[3],
          borderTopWidth: 1,
          borderTopColor: palette.placeholderBorder,
          backgroundColor: palette.white,
        }}
      >
        {preReader && !busy && !failed ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {PRE_READER_QUICK_REPLIES.map((reply) => (
              <Button
                key={reply.label}
                label={reply.label}
                variant="secondary"
                onPress={() => chat.send(reply.text)}
              />
            ))}
          </View>
        ) : null}
        <Composer onSend={chat.send} disabled={busy || failed} />
      </View>
    </View>
  );
}
