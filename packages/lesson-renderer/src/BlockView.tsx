import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { AnyBlock } from '@custar/content-schema';
import {
  calloutColors,
  layerColors,
  palette,
  radii,
  space,
  textColors,
  type LayerKey,
} from '@custar/design-tokens';
import { Illustration } from './IllustrationPlaceholder';
import { RichText } from './RichText';

export interface BlockViewProps {
  block: AnyBlock;
  layer: LayerKey;
  /** Maps an `asset_id` to a loadable URL. Without it (or when it returns nothing) a placeholder shows. */
  resolveAsset?: (assetId: string) => string | undefined;
  /** Renders the question referenced by a `question` block; supplied by the unit view. */
  renderQuestion?: (questionId: string) => ReactNode;
  /** Admins see a marker for unknown blocks; children and guardians see nothing. */
  showUnknown?: boolean;
}

/** Renders one content block. Unknown block types degrade to nothing so old app builds never crash. */
export function BlockView({
  block,
  layer,
  resolveAsset,
  renderQuestion,
  showUnknown = false,
}: BlockViewProps): ReactNode {
  const accent = layerColors[layer].accent;

  switch (block.type) {
    case 'paragraph':
      return <RichText>{block.text}</RichText>;

    case 'bullets':
      return (
        <View style={{ gap: space[2] }}>
          {block.items.map((item, index) => (
            <View key={index} style={{ flexDirection: 'row', gap: space[3] }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: radii.pill,
                  backgroundColor: accent,
                  marginTop: 11,
                }}
              />
              <View style={{ flex: 1 }}>
                <RichText>{item.lead ? `**${item.lead}** — ${item.text}` : item.text}</RichText>
              </View>
            </View>
          ))}
        </View>
      );

    case 'definition':
      return (
        <View style={{ gap: space[1] }}>
          <RichText color={layerColors[layer].text} style={{ fontWeight: '700' }}>
            {block.term}
          </RichText>
          <RichText>{block.meaning}</RichText>
        </View>
      );

    case 'example':
      return <RichText>{`**${block.label}** ${block.text}`}</RichText>;

    case 'dialogue':
      return (
        <View style={{ gap: space[2] }}>
          {block.lines.map((line, index) => (
            <RichText key={index}>{`**${line.character}:** ${line.text}`}</RichText>
          ))}
        </View>
      );

    case 'illustration': {
      const uri = block.asset_id ? resolveAsset?.(block.asset_id) : undefined;
      return <Illustration brief={block.brief} alt={block.alt} {...(uri ? { uri } : {})} />;
    }

    case 'callout': {
      const tone = calloutColors[block.tone];
      return (
        <View
          style={{
            backgroundColor: tone.background,
            borderLeftWidth: 5,
            borderLeftColor: tone.stripe,
            paddingVertical: space[3],
            paddingHorizontal: space[4],
          }}
        >
          <RichText role="body">{block.text}</RichText>
        </View>
      );
    }

    case 'activity_steps':
      return (
        <View style={{ gap: space[2] }}>
          {block.steps.map((step, index) => (
            <View key={index} style={{ flexDirection: 'row', gap: space[3] }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: radii.pill,
                  backgroundColor: accent,
                  marginTop: 11,
                }}
              />
              <View style={{ flex: 1 }}>
                <RichText>{`**${step.label}:** ${step.text}`}</RichText>
              </View>
            </View>
          ))}
        </View>
      );

    case 'table':
      return (
        <View style={{ borderWidth: 1, borderColor: palette.placeholderBorder }}>
          <View style={{ flexDirection: 'row', backgroundColor: layerColors[layer].bar }}>
            {block.headers.map((header, index) => (
              <Text
                key={index}
                style={{
                  flex: 1,
                  color: palette.white,
                  fontSize: 16,
                  fontWeight: '700',
                  padding: space[2],
                }}
              >
                {header}
              </Text>
            ))}
          </View>
          {block.rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={{
                flexDirection: 'row',
                backgroundColor: rowIndex % 2 === 0 ? palette.placeholderBg : palette.white,
              }}
            >
              {row.map((cell, cellIndex) => (
                <Text
                  key={cellIndex}
                  style={{ flex: 1, color: textColors.body, fontSize: 16, padding: space[2] }}
                >
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );

    case 'question':
      return <>{renderQuestion?.(block.question_id) ?? null}</>;

    case 'unknown':
      return showUnknown ? (
        <Text style={{ color: palette.muted, fontSize: 14, fontStyle: 'italic' }}>
          Unsupported block "{block.original_type}" (newer content than this app understands).
        </Text>
      ) : null;
  }
}
