import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { layerColors, palette, radii, space, textColors } from '@custar/design-tokens';
import { RichText } from './RichText';

export interface HelperScriptViewProps {
  /** The helper's steps for this section (`teacher_manual.helper_script`). */
  steps?: readonly string[];
  /** The teacher's manual line for this section (`teacher_manual.script`): say it, ask it, watch for it. */
  say?: string;
  ask?: string;
  watchFor?: string;
  /** Shown above the steps, for example "For the helper". Defaults to that. */
  title?: string;
  /** Shown when nothing is scripted for this section. */
  emptyText?: string;
}

const teal = layerColors.CORE;

function Labelled({ label, text }: { label: string; text: string }): ReactNode {
  return (
    <View style={{ gap: space[1] }}>
      <Text
        style={{
          color: teal.text,
          fontSize: 14,
          lineHeight: 20,
          fontWeight: '700',
          letterSpacing: 0.6,
        }}
      >
        {label.toUpperCase()}
      </Text>
      <RichText>{text}</RichText>
    </View>
  );
}

/**
 * The helper's script for ONE section: the numbered steps from the helper script and the teacher's
 * say / ask / watch-for lines, for a grown-up who co-pilots a child who cannot read yet. Grown-up eyes
 * only: it is not shown to the child as lesson content, and it carries no answers of its own beyond what
 * the reviewed manual says.
 */
export function HelperScriptView({
  steps = [],
  say,
  ask,
  watchFor,
  title = 'For the helper',
  emptyText = 'Nothing is scripted for this part. Read it with the child and let them answer in their own words.',
}: HelperScriptViewProps): ReactNode {
  const hasContent = steps.length > 0 || Boolean(say) || Boolean(ask) || Boolean(watchFor);
  return (
    <View
      accessibilityLabel={title}
      style={{
        backgroundColor: palette.placeholderBg,
        borderWidth: 2,
        borderColor: palette.placeholderBorder,
        borderLeftWidth: 6,
        borderLeftColor: teal.bar,
        borderRadius: radii.md,
        padding: space[4],
        gap: space[3],
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: teal.text, fontSize: 18, lineHeight: 26, fontWeight: '700' }}
      >
        {title}
      </Text>
      {steps.length > 0 ? (
        <View style={{ gap: space[2] }}>
          {steps.map((step, index) => (
            <View key={index} style={{ flexDirection: 'row', gap: space[3] }}>
              <Text
                style={{
                  color: teal.bar,
                  fontSize: 18,
                  lineHeight: 28,
                  fontWeight: '700',
                  minWidth: 22,
                }}
              >
                {`${index + 1}.`}
              </Text>
              <View style={{ flex: 1 }}>
                <RichText>{step}</RichText>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {say ? <Labelled label="Say" text={say} /> : null}
      {ask ? <Labelled label="Ask" text={ask} /> : null}
      {watchFor ? <Labelled label="Watch for" text={watchFor} /> : null}
      {!hasContent ? (
        <Text style={{ color: textColors.secondary, fontSize: 16, lineHeight: 24 }}>
          {emptyText}
        </Text>
      ) : null}
    </View>
  );
}
