import { Link } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { layerColors, palette, space, textColors } from '@custar/design-tokens';
import { FIXTURES } from '../fixtures';

export default function Home() {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.white }}
      contentContainerStyle={{ alignItems: 'center', padding: space[6] }}
    >
      <View style={{ width: '100%', maxWidth: 760, gap: space[4] }}>
        <Text
          style={{
            color: layerColors.CORE.bar,
            fontSize: 14,
            fontWeight: '700',
            letterSpacing: 0.8,
          }}
        >
          CUSTAR TUTOR · ADMIN
        </Text>
        <Text
          accessibilityRole="header"
          style={{ color: textColors.heading, fontSize: 34, lineHeight: 42, fontWeight: '700' }}
        >
          Unit preview
        </Text>
        <Text style={{ color: textColors.secondary, fontSize: 18, lineHeight: 28 }}>
          Preview units with the same renderer the learner app uses. Content-engine screens come in
          the next milestone.
        </Text>
        {FIXTURES.map((fixture) => (
          <Link
            key={fixture.slug}
            href={{ pathname: '/preview/[slug]', params: { slug: fixture.slug, mode: 'grownup' } }}
            style={{
              padding: space[4],
              borderWidth: 2,
              borderColor: palette.placeholderBorder,
              borderRadius: 12,
            }}
          >
            <View style={{ gap: space[1] }}>
              <Text style={{ color: textColors.heading, fontSize: 20, fontWeight: '700' }}>
                {fixture.title}
              </Text>
              <Text style={{ color: textColors.muted, fontSize: 16 }}>{fixture.description}</Text>
            </View>
          </Link>
        ))}
      </View>
    </ScrollView>
  );
}
