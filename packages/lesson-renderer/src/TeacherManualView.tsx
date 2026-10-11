import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { LessonUnit } from '@custar/content-schema';
import { layerColors, palette, space, textColors } from '@custar/design-tokens';
import { RichText } from './RichText';

const teal = layerColors.CORE;

function Heading({ children }: { children: string }): ReactNode {
  return (
    <Text
      accessibilityRole="header"
      style={{ color: textColors.heading, fontSize: 24, lineHeight: 32, fontWeight: '700' }}
    >
      {children}
    </Text>
  );
}

function List({ items }: { items: string[] }): ReactNode {
  return (
    <View style={{ gap: space[2] }}>
      {items.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: space[3] }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: teal.bar,
              marginTop: 11,
            }}
          />
          <View style={{ flex: 1 }}>
            <RichText>{item}</RichText>
          </View>
        </View>
      ))}
    </View>
  );
}

function sectionHeading(unit: LessonUnit, sectionId: string): string {
  return unit.sections.find((section) => section.id === sectionId)?.heading ?? sectionId;
}

/** The integrated teacher's manual entry: script, theme map, timing, materials, mastery guidance, helper script. */
export function TeacherManualView({ unit }: { unit: LessonUnit }): ReactNode {
  const manual = unit.teacher_manual;
  return (
    <View style={{ gap: space[6] }}>
      <View style={{ gap: space[3] }}>
        <Heading>Timing</Heading>
        <RichText>{manual.timing}</RichText>
        {unit.session_plan.map((period) => (
          <View
            key={period.period}
            style={{ backgroundColor: palette.placeholderBg, padding: space[3], gap: space[1] }}
          >
            <RichText style={{ fontWeight: '700' }}>{`Period ${period.period}`}</RichText>
            <RichText color={textColors.secondary}>
              {period.minutes
                .map((entry) => `${entry.segment.replace(/_/g, ' ')} ${entry.minutes} min`)
                .join(' · ')}
            </RichText>
            <RichText color={textColors.secondary}>
              {`Sections: ${period.sections.map((id) => sectionHeading(unit, id)).join(', ')}`}
            </RichText>
          </View>
        ))}
      </View>

      <View style={{ gap: space[3] }}>
        <Heading>Say it, ask it, watch for it</Heading>
        {manual.script.map((step) => (
          <View
            key={step.section_id}
            style={{
              borderLeftWidth: 5,
              borderLeftColor: teal.bar,
              paddingLeft: space[3],
              gap: space[1],
            }}
          >
            <RichText style={{ fontWeight: '700' }}>
              {sectionHeading(unit, step.section_id)}
            </RichText>
            <RichText>{`**Say:** ${step.say}`}</RichText>
            <RichText>{`**Ask:** ${step.ask}`}</RichText>
            <RichText>{`**Watch for:** ${step.watch_for}`}</RichText>
          </View>
        ))}
      </View>

      {manual.theme_map ? (
        <View style={{ gap: space[3] }}>
          <Heading>Theme map</Heading>
          {manual.theme_map.lenses.map((lens, index) => (
            <RichText
              key={index}
            >{`**${lens.subject} (${lens.lens}):** ${lens.what_child_does}`}</RichText>
          ))}
          <View
            style={{
              backgroundColor: teal.tint,
              borderLeftWidth: 5,
              borderLeftColor: teal.bar,
              padding: space[4],
            }}
          >
            <RichText>{`**Connection moment:** ${manual.theme_map.connection_moment}`}</RichText>
          </View>
        </View>
      ) : null}

      <View style={{ gap: space[3] }}>
        <Heading>Materials</Heading>
        <List items={manual.materials} />
      </View>

      <View style={{ gap: space[3] }}>
        <Heading>Mastery guidance</Heading>
        <RichText style={{ fontWeight: '700' }}>Got it looks like:</RichText>
        <List items={manual.mastery_guidance.got_it} />
        <View
          style={{
            backgroundColor: teal.tint,
            borderLeftWidth: 5,
            borderLeftColor: teal.bar,
            padding: space[4],
          }}
        >
          <RichText>{`**Not yet?** ${manual.mastery_guidance.not_yet}`}</RichText>
        </View>
      </View>

      <View style={{ gap: space[3] }}>
        <Heading>Helper script (co-pilot for a child who cannot read yet)</Heading>
        {manual.helper_script.map((entry) => (
          <View key={entry.section_id} style={{ gap: space[2] }}>
            <RichText style={{ fontWeight: '700' }}>
              {sectionHeading(unit, entry.section_id)}
            </RichText>
            <List items={entry.steps} />
          </View>
        ))}
      </View>
    </View>
  );
}
