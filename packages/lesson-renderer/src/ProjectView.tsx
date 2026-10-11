import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { ProjectUnit } from '@custar/content-schema';
import { layerColors, palette, space, textColors } from '@custar/design-tokens';
import { RichText } from './RichText';
import { SectionBar } from './SectionBar';
import { isGrownUpMode, type ViewMode } from './labels';

const teal = layerColors.CORE;

function Bar({ children, mode }: { children: string; mode: ViewMode }): ReactNode {
  return <SectionBar heading={children} layer="CORE" showBadge={isGrownUpMode(mode)} />;
}

/** A mini or end-of-term project: brief, steps, materials, rubric, evidence and reflection. */
export function ProjectView({ unit, mode }: { unit: ProjectUnit; mode: ViewMode }): ReactNode {
  return (
    <View style={{ gap: space[6] }}>
      <View style={{ gap: space[3] }}>
        <Bar mode={mode}>What we will make</Bar>
        <RichText>{unit.brief}</RichText>
      </View>

      <View style={{ gap: space[3] }}>
        <Bar mode={mode}>Steps</Bar>
        {unit.steps.map((step) => (
          <View key={step.n} style={{ flexDirection: 'row', gap: space[3] }}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: teal.bar,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: palette.white, fontSize: 18, fontWeight: '700' }}>
                {step.n}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <RichText>{step.text}</RichText>
            </View>
          </View>
        ))}
      </View>

      <View style={{ gap: space[3] }}>
        <Bar mode={mode}>What you need</Bar>
        {unit.materials.map((material, index) => (
          <RichText key={index}>{`• ${material}`}</RichText>
        ))}
      </View>

      <View style={{ gap: space[3] }}>
        <Bar mode={mode}>How we will look at it</Bar>
        {unit.rubric.map((row) => (
          <View
            key={row.criterion}
            style={{ backgroundColor: palette.placeholderBg, padding: space[3], gap: space[1] }}
          >
            <RichText style={{ fontWeight: '700' }}>{row.criterion}</RichText>
            {row.levels.map((level) => (
              <RichText key={level.level} color={textColors.secondary}>
                {`${level.level}. ${level.descriptor}`}
              </RichText>
            ))}
          </View>
        ))}
      </View>

      <View style={{ gap: space[3] }}>
        <Bar mode={mode}>Show it</Bar>
        <RichText>{`Share your work as: ${unit.evidence_options.join(', ')}.`}</RichText>
        {unit.reflection_prompts.map((prompt, index) => (
          <RichText key={index}>{`**Think:** ${prompt}`}</RichText>
        ))}
      </View>
    </View>
  );
}
