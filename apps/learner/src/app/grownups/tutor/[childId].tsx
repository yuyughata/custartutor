import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { getChild, type LocalChild } from '@custar/learner-core';
import { ConversationsCard } from '../../../consent/ConversationsCard';
import { ElevationGate } from '../../../consent/ElevationGate';
import { TutorConsentCard } from '../../../consent/TutorConsentCard';
import { useElevation } from '../../../consent/useElevation';
import { avatarEmoji } from '../../../data/queries';
import { useRuntime } from '../../../runtime/RuntimeProvider';
import { Body, Screen, Title, TopBar } from '../../../ui';

/**
 * Grown-ups: the AI tutor for one child. Consent (with the full wording, never pre-ticked), turning the tutor on
 * and off, and the read-only transcripts. Needs the grown-up PIN: if the elevation has lapsed it asks again.
 */
export default function GrownupTutor() {
  const { childId } = useLocalSearchParams<{ childId: string }>();
  const { runtime } = useRuntime();
  const elevation = useElevation();
  const [child, setChild] = useState<LocalChild | null | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let alive = true;
    void getChild(runtime.ports.db, childId).then((row) => alive && setChild(row));
    return () => {
      alive = false;
    };
  }, [runtime, childId]);

  if (child === undefined) {
    return (
      <View style={{ flex: 1 }}>
        <TopBar title="AI tutor" />
        <Screen>
          <Body>Loading…</Body>
        </Screen>
      </View>
    );
  }
  if (child === null) {
    return (
      <View style={{ flex: 1 }}>
        <TopBar title="AI tutor" />
        <Screen>
          <Body>We could not find this child. Go back and pick again.</Body>
        </Screen>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <TopBar title={`AI tutor · ${avatarEmoji(child.avatar)} ${child.display_alias}`} />
      <Screen>
        <Title>AI tutor for {child.display_alias}</Title>
        {elevation.needsPin ? (
          <ElevationGate reason="Enter your PIN to turn the tutor on or read conversations. It is asked again after a few minutes." />
        ) : null}
        <TutorConsentCard
          childId={child.id}
          alias={child.display_alias}
          ensureElevated={elevation.ensure}
          onLapsed={elevation.markLapsed}
          onChanged={() => setRefreshKey((value) => value + 1)}
        />
        <ConversationsCard
          childId={child.id}
          alias={child.display_alias}
          locked={elevation.needsPin}
          refreshKey={refreshKey}
          onLapsed={elevation.markLapsed}
        />
      </Screen>
    </View>
  );
}
