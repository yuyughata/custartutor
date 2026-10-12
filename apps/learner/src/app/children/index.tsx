import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { LocalChild } from '@custar/learner-core';
import { textColors } from '@custar/design-tokens';
import { avatarEmoji, loadChildList } from '../../data/queries';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { Body, Button, Card, Screen, Title, TopBar } from '../../ui';

/** "Who is learning?": the child picker. Child mode is the default state of the app. */
export default function Children() {
  const { runtime, tick } = useRuntime();
  const router = useRouter();
  const [children, setChildren] = useState<LocalChild[] | null>(null);

  useEffect(() => {
    void loadChildList(runtime).then(setChildren);
  }, [runtime, tick]);

  return (
    <View style={{ flex: 1 }}>
      <TopBar
        title="CUSTAR Tutor"
        back={false}
        action={{ label: 'Grown-ups', onPress: () => router.push('/grownups') }}
      />
      <Screen>
        <Title>Who is learning today?</Title>
        {children === null ? <Body>Loading…</Body> : null}
        {children?.length === 0 ? (
          <>
            <Body>
              No children have been added yet. A grown-up can add one in the Grown-ups area.
            </Body>
            <Button label="Open Grown-ups" onPress={() => router.push('/grownups')} />
          </>
        ) : null}
        {children?.map((child) => (
          <Card
            key={child.id}
            tone="core"
            accessibilityLabel={`Start as ${child.display_alias}`}
            onPress={() => router.push(`/children/${child.id}`)}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <Text style={{ fontSize: 48 }}>{avatarEmoji(child.avatar)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 26, fontWeight: '700', color: textColors.heading }}>
                  {child.display_alias}
                </Text>
                <Body muted>Primary {child.level_code.slice(1)}</Body>
              </View>
            </View>
          </Card>
        ))}
      </Screen>
    </View>
  );
}
