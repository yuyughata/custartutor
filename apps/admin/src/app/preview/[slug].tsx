import { Link, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { UnitView, type UnitTab, type ViewMode } from '@custar/lesson-renderer';
import { layerColors, palette, space } from '@custar/design-tokens';
import { FIXTURES } from '../../fixtures';

const MODES: ViewMode[] = ['student', 'grownup', 'admin'];
const TABS: UnitTab[] = ['textbook', 'workbook', 'manual'];

export default function Preview() {
  const params = useLocalSearchParams<{ slug: string; mode?: string; tab?: string }>();
  const fixture = FIXTURES.find((entry) => entry.slug === params.slug);
  const mode = MODES.find((value) => value === params.mode) ?? 'grownup';
  const tab = TABS.find((value) => value === params.tab) ?? 'textbook';

  if (!fixture) {
    return (
      <View style={{ padding: space[6] }}>
        <Text>Unknown fixture.</Text>
        <Link href="/">Back</Link>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.white }}>
      <View
        style={{
          flexDirection: 'row',
          gap: space[4],
          alignItems: 'center',
          paddingHorizontal: space[4],
          paddingVertical: space[2],
          backgroundColor: layerColors.CORE.tint,
        }}
      >
        <Link href="/" style={{ color: layerColors.CORE.text, fontWeight: '700' }}>
          ← All units
        </Link>
        {MODES.map((value) => (
          <Link
            key={value}
            href={{ pathname: '/preview/[slug]', params: { slug: fixture.slug, mode: value } }}
            style={{
              color: layerColors.CORE.text,
              fontWeight: value === mode ? '700' : '400',
              textDecorationLine: value === mode ? 'underline' : 'none',
            }}
          >
            {value}
          </Link>
        ))}
      </View>
      <UnitView
        key={`${fixture.slug}-${mode}-${tab}`}
        unit={fixture.unit}
        mode={mode}
        initialTab={tab}
      />
    </View>
  );
}
