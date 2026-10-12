import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { LessonUnit } from '@custar/content-schema';
import { RichText } from '@custar/lesson-renderer';
import {
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  textColors,
} from '@custar/design-tokens';
import { Body, Button, Card, Screen, Title } from '../ui';
import { SpeedChoice } from '../voice/SpeedChoice';
import { getReady } from './script';

const teal = layerColors.CORE;

function Checkbox({ label }: { label: string }): ReactNode {
  const [checked, setChecked] = useState(false);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      aria-checked={checked}
      accessibilityLabel={label}
      onPress={() => setChecked(!checked)}
      style={{
        minHeight: minTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: radii.sm,
          borderWidth: 2,
          borderColor: teal.bar,
          backgroundColor: checked ? teal.bar : palette.white,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? (
          <Text style={{ color: palette.white, fontSize: 20, fontWeight: '700' }}>✓</Text>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <RichText>{label}</RichText>
      </View>
    </Pressable>
  );
}

/**
 * The page before the lesson starts: the NERDC objective (dominant, as everywhere), what to gather, how long it
 * takes, and the reading options. Nothing is read aloud here: narration begins only after "Start the lesson".
 */
export function PrepareView({
  unit,
  childAlias,
  preReader,
  readAloudAvailable,
  narrate,
  onToggleNarrate,
  onStart,
  starting,
}: {
  unit: LessonUnit;
  childAlias: string;
  preReader: boolean;
  readAloudAvailable: boolean;
  narrate: boolean;
  onToggleNarrate: () => void;
  onStart: () => void;
  starting: boolean;
}): ReactNode {
  const ready = getReady(unit, unit.teacher_manual);
  return (
    <Screen>
      <View style={{ gap: space[1] }}>
        <Text style={{ color: teal.bar, fontSize: 14, fontWeight: '700', letterSpacing: 0.8 }}>
          {`HELPER SESSION FOR ${childAlias.toUpperCase()}`}
        </Text>
        <Title>{`Unit ${unit.header.unit_no}: ${unit.header.title}`}</Title>
      </View>

      <View
        style={{
          backgroundColor: teal.tint,
          borderLeftWidth: 6,
          borderLeftColor: teal.bar,
          padding: space[4],
        }}
      >
        <RichText
          color={textColors.secondary}
        >{`**Objective (NERDC):** ${unit.header.objective}`}</RichText>
      </View>

      <Card>
        <Body role="lead">Before you start</Body>
        {ready.materials.length === 0 ? (
          <Body muted>Nothing special is needed.</Body>
        ) : (
          <View style={{ gap: space[2] }}>
            {ready.materials.map((item, index) => (
              <Checkbox key={index} label={item} />
            ))}
          </View>
        )}
      </Card>

      <Card>
        <Body role="lead">How long</Body>
        <RichText>{ready.timing}</RichText>
        {ready.periods.map((period) => (
          <View
            key={period.period}
            style={{ backgroundColor: palette.placeholderBg, padding: space[3], gap: space[1] }}
          >
            <RichText
              style={{ fontWeight: '700' }}
            >{`Period ${period.period} · ${period.totalMinutes} minutes`}</RichText>
            <RichText color={textColors.secondary}>{period.timing}</RichText>
          </View>
        ))}
        <Body muted>You can stop after a period and carry on another day.</Body>
      </Card>

      <Card>
        <Body role="lead">How helping works</Body>
        <Body>
          1. Read each part to {childAlias}, using the helper script on the screen.{'\n'}
          2. {childAlias} taps the big buttons to answer. You may tap for them if they point.{'\n'}
          3. Press "I read it" to move on. The last part is a short check: please do not give hints
          there.
        </Body>
      </Card>

      <View style={{ gap: space[3] }}>
        {readAloudAvailable ? (
          <SpeedChoice readingMode={preReader ? 'pre_reader' : 'reader'} />
        ) : null}
        {preReader && readAloudAvailable ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: narrate }}
            aria-checked={narrate}
            accessibilityLabel="Read each part aloud when it opens"
            onPress={onToggleNarrate}
            style={{
              minHeight: minTouchTarget + 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[3],
              borderWidth: 2,
              borderColor: narrate ? teal.bar : palette.placeholderBorder,
              backgroundColor: narrate ? teal.tint : palette.white,
              borderRadius: radii.lg,
              padding: space[3],
            }}
          >
            <Text style={{ fontSize: 24 }}>{narrate ? '🔊' : '🔈'}</Text>
            <Text style={{ flex: 1, fontSize: 18, fontWeight: '700', color: textColors.body }}>
              {narrate ? 'Reading each part aloud: on' : 'Reading each part aloud: off'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <Button label="Start the lesson" onPress={onStart} busy={starting} />
    </Screen>
  );
}
