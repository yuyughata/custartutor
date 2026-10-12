import { useRef } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { layerColors, minTouchTarget, palette, space, typeScale } from '@custar/design-tokens';
import { Button } from '../ui';
import { ChildBubble, TutorBubble, type ReadAloudProps } from './Bubble';
import { Composer } from './Composer';
import { LITE_COPY } from './copy';
import type { LiteTarget } from './sections';
import type { useReadAloud } from './useReadAloud';
import type { UseLiteChat } from './useLiteChat';

/** "Which part?": the sections that have an offline script. */
function PartPicker({
  targets,
  onPick,
}: {
  targets: LiteTarget[];
  onPick: (t: LiteTarget) => void;
}) {
  return (
    <ScrollView contentContainerStyle={{ padding: space[4], gap: space[3] }}>
      <Text style={{ ...typeScale.bodyLarge, fontWeight: '700' }}>
        {targets.length > 0 ? LITE_COPY.whichPart : LITE_COPY.noScript}
      </Text>
      {targets.map((target) => (
        <Button
          key={target.sectionId}
          label={target.heading}
          variant="secondary"
          onPress={() => onPick(target)}
        />
      ))}
    </ScrollView>
  );
}

/** Tutor Lite: the scripted offline tutor. Never touches mastery. */
export function LiteChatView({
  lite,
  targets,
  preReader,
  voice,
}: {
  lite: UseLiteChat;
  targets: LiteTarget[];
  preReader: boolean;
  voice: ReturnType<typeof useReadAloud>;
}) {
  const scroll = useRef<ScrollView>(null);
  const { state } = lite;

  if (!state.target) return <PartPicker targets={targets} onPick={lite.choose} />;

  const readAloudFor = (id: string, text: string): ReadAloudProps | null =>
    voice.available
      ? {
          available: true,
          speaking: voice.speakingId === id,
          big: preReader,
          onPress: () => voice.toggle(id, text),
        }
      : null;

  const showContinue = !state.busy && !state.expecting && !state.finished && state.items.length > 0;

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          paddingHorizontal: space[4],
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[3],
          borderBottomWidth: 1,
          borderBottomColor: palette.placeholderBorder,
          minHeight: minTouchTarget,
        }}
      >
        <Text
          numberOfLines={2}
          style={{ ...typeScale.body, fontWeight: '700', flex: 1, color: palette.ink }}
        >
          {state.target.heading}
        </Text>
        {targets.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            onPress={lite.change}
            style={{ minHeight: minTouchTarget, justifyContent: 'center' }}
          >
            <Text
              style={{
                ...typeScale.label,
                color: layerColors.CORE.text,
                textDecorationLine: 'underline',
              }}
            >
              {LITE_COPY.change}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space[4], gap: space[3], flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {state.items.map((item) =>
          item.role === 'child' ? (
            <ChildBubble key={item.id} text={item.text} />
          ) : item.role === 'note' ? (
            <Text key={item.id} style={{ ...typeScale.label, color: palette.muted }}>
              {item.text}
            </Text>
          ) : (
            <TutorBubble
              key={item.id}
              text={item.text}
              readAloud={readAloudFor(item.id, item.text)}
            />
          ),
        )}
        {state.busy ? <Text style={{ ...typeScale.label, color: palette.muted }}>…</Text> : null}
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
        {state.finished ? (
          <>
            <Button label={LITE_COPY.again} onPress={lite.restart} />
            {targets.length > 1 ? (
              <Button label={LITE_COPY.change} variant="secondary" onPress={lite.change} />
            ) : null}
          </>
        ) : null}
        {showContinue ? <Button label="Next" onPress={lite.skip} /> : null}
        {state.expecting ? (
          <>
            {state.choices ? (
              <View style={{ gap: space[2] }}>
                {state.choices.map((choice) => (
                  <Button
                    key={choice}
                    label={choice}
                    variant="secondary"
                    disabled={state.busy}
                    onPress={() => lite.reply(choice)}
                  />
                ))}
              </View>
            ) : (
              <Composer
                onSend={lite.reply}
                disabled={state.busy}
                label={LITE_COPY.typeAnswer}
                sendLabel={LITE_COPY.send}
              />
            )}
            <View style={{ flexDirection: 'row', gap: space[3] }}>
              <View style={{ flex: 1 }}>
                <Button
                  label={LITE_COPY.hint}
                  variant="secondary"
                  onPress={lite.hint}
                  disabled={state.busy}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label={LITE_COPY.skip}
                  variant="secondary"
                  onPress={lite.skip}
                  disabled={state.busy}
                />
              </View>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}
