// The original fixture preview, kept as a developer aid and reachable only from the "Dev" link in demo mode.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { UnitView, type UnitTab, type ViewMode } from '@custar/lesson-renderer';
import { FIXTURES } from '../fixtures';
import { usePageTitle } from '../hooks/usePageTitle';
import { useRuntime } from '../runtime/RuntimeProvider';
import { AppLink } from '../ui/AppLink';
import { Banner } from '../ui/Banner';
import { Card, Row, Stack } from '../ui/Card';
import { PageHeader } from '../ui/PageHeader';
import { H3, P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';

const MODES: ViewMode[] = ['student', 'grownup', 'admin'];
const TABS: UnitTab[] = ['textbook', 'workbook', 'manual'];

function DemoOnly({ children }: { children: ReactNode }): ReactNode {
  const { runtime } = useRuntime();
  if (runtime.mode !== 'demo') {
    return (
      <Banner tone="info" title="Only in demo mode">
        <P>The fixture preview is a developer aid and is not part of the live admin app.</P>
      </Banner>
    );
  }
  return <>{children}</>;
}

export function PreviewIndexScreen(): ReactNode {
  usePageTitle('Fixture preview');
  return (
    <DemoOnly>
      <Stack gap={space[4]}>
        <PageHeader
          title="Fixture preview"
          subtitle="Units from the content fixtures, rendered with the same renderer the learner app uses. For developers."
        />
        {FIXTURES.map((fixture) => (
          <Card key={fixture.slug}>
            <AppLink
              href={{ pathname: '/preview/[slug]', params: { slug: fixture.slug, mode: 'admin' } }}
            >
              {fixture.title}
            </AppLink>
            <Small>{fixture.description}</Small>
          </Card>
        ))}
      </Stack>
    </DemoOnly>
  );
}

export function PreviewUnitScreen(): ReactNode {
  const params = useLocalSearchParams<{ slug: string; mode?: string; tab?: string }>();
  const fixture = FIXTURES.find((entry) => entry.slug === params.slug);
  const mode = MODES.find((value) => value === params.mode) ?? 'admin';
  const tab = TABS.find((value) => value === params.tab) ?? 'textbook';
  usePageTitle(fixture ? fixture.title : 'Fixture preview');

  return (
    <DemoOnly>
      {!fixture ? (
        <Banner tone="warning" title="Unknown fixture">
          <AppLink href="/preview">Back to the fixtures</AppLink>
        </Banner>
      ) : (
        <Stack gap={space[3]}>
          <PageHeader
            title={fixture.title}
            crumbs={[{ label: 'Fixture preview', href: '/preview' }, { label: fixture.slug }]}
          />
          <Row gap={space[4]}>
            <H3>View as</H3>
            {MODES.map((value) => (
              <AppLink
                key={value}
                href={{ pathname: '/preview/[slug]', params: { slug: fixture.slug, mode: value } }}
                style={{ fontWeight: value === mode ? '800' : '500' }}
              >
                {value}
              </AppLink>
            ))}
          </Row>
          <View
            style={{
              height: 760,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.lg,
              overflow: 'hidden',
              backgroundColor: colors.white,
            }}
          >
            <UnitView key={`${fixture.slug}-${mode}-${tab}`} unit={fixture.unit} mode={mode} initialTab={tab} />
          </View>
        </Stack>
      )}
    </DemoOnly>
  );
}
