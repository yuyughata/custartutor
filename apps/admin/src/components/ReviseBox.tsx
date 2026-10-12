// "Revise with Claude": an instruction and, optionally, which sections it may touch. It makes a NEW draft
// version; the version being read is kept as it is.
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { UnitContent } from '@custar/content-schema';
import { sectionsOf } from '@custar/content-schema';
import { Button } from '../ui/Button';
import { Section } from '../ui/Card';
import { TextField } from '../ui/Fields';
import { Small } from '../ui/Text';
import { MIN_TARGET, colors, radii, space } from '../ui/theme';

export function ReviseBox({
  unit,
  versionNo,
  busy,
  disabledReason,
  onRevise,
}: {
  unit: UnitContent | null;
  versionNo: number;
  busy: boolean;
  disabledReason: string | null;
  onRevise: (instruction: string, sectionIds: string[]) => void;
}): ReactNode {
  const [instruction, setInstruction] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [limiting, setLimiting] = useState(false);
  const sections = unit ? sectionsOf(unit) : [];
  const tooLong = instruction.length > 4000;

  return (
    <Section title="Revise with Claude" testID="revise-box">
      <Small>
        Describe what to change in version {versionNo}. Claude writes a NEW draft version with the
        change; this version stays as it is, and the new one has to be reviewed and approved like
        any other.
      </Small>
      <TextField
        label="What should change?"
        hint="For example: make the market story use cassava instead of rice, and shorten the practice questions."
        value={instruction}
        onChangeText={setInstruction}
        lines={4}
        error={tooLong ? 'Keep it under 4,000 characters.' : null}
        editable={!busy}
      />
      {sections.length > 0 ? (
        <View style={{ gap: space[2] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: limiting }}
            onPress={() => {
              if (limiting) setPicked([]);
              setLimiting(!limiting);
            }}
          >
            <Text
              style={{
                color: colors.primary,
                fontWeight: '700',
                fontSize: 13,
                textDecorationLine: 'underline',
              }}
            >
              {limiting
                ? 'Let Claude decide which sections change'
                : 'Limit the change to specific sections (optional)'}
            </Text>
          </Pressable>
          {limiting ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {sections.map((section) => {
                const on = picked.includes(section.id);
                return (
                  <Pressable
                    key={section.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on, disabled: busy }}
                    accessibilityLabel={`Limit to section ${section.heading}`}
                    disabled={busy}
                    onPress={() =>
                      setPicked(
                        on ? picked.filter((id) => id !== section.id) : [...picked, section.id],
                      )
                    }
                    style={{
                      minHeight: MIN_TARGET - 8,
                      justifyContent: 'center',
                      paddingHorizontal: space[3],
                      borderRadius: radii.pill,
                      borderWidth: 1.5,
                      borderColor: on ? colors.primary : colors.borderStrong,
                      backgroundColor: on ? colors.primaryTint : colors.white,
                    }}
                  >
                    <Text
                      style={{ fontSize: 13, fontWeight: on ? '700' : '400', color: colors.text }}
                    >
                      {on ? '✓ ' : ''}
                      {section.heading}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
      <Button
        label="Revise with Claude"
        onPress={() => onRevise(instruction.trim(), picked)}
        busy={busy}
        disabled={Boolean(disabledReason) || instruction.trim() === '' || tooLong}
        reason={disabledReason ?? (instruction.trim() === '' ? 'Describe the change first.' : null)}
      />
    </Section>
  );
}
