import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  DiskSpaceError,
  DownloadError,
  IntegrityError,
  NetworkPolicyError,
  PackTooNewError,
} from '@custar/learner-core';
import { layerColors, palette, textColors } from '@custar/design-tokens';
import { avatarEmoji, loadHome, type Home, type HomeUnit } from '../../../data/queries';
import { useRuntime } from '../../../runtime/RuntimeProvider';
import { Body, Button, Card, ErrorText, Screen, Title, TopBar } from '../../../ui';

const STATE_LABEL: Record<HomeUnit['state'], string> = {
  locked: '🔒 Locked',
  available: '▶ Ready',
  in_progress: '⏳ Keep going',
  mastered: '✅ Mastered',
};

function downloadMessage(error: unknown): string {
  if (error instanceof NetworkPolicyError) return 'Connect to Wi-Fi to download lessons.';
  if (error instanceof DiskSpaceError) return 'Not enough space on this phone for this lesson.';
  if (error instanceof PackTooNewError) return 'Please update the app to open this lesson.';
  if (error instanceof IntegrityError) return 'The download was damaged. Please try again.';
  if (error instanceof DownloadError) return 'The download did not finish. Please try again.';
  return error instanceof Error ? error.message : 'The download failed.';
}

export default function ChildHome() {
  const { childId } = useLocalSearchParams<{ childId: string }>();
  const { runtime, tick, refresh } = useRuntime();
  const router = useRouter();
  const [home, setHome] = useState<Home | null | undefined>(undefined);
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    void loadHome(runtime, childId).then(setHome);
  }, [runtime, childId, tick]);

  const download = useCallback(
    async (item: HomeUnit) => {
      if (!item.pack) return;
      setBusyUnit(item.unit.id);
      setMessage(null);
      try {
        await runtime.downloads.downloadUnit(item.unit.id, item.pack.latestVersionNo, {
          wifiOnly: true,
        });
        refresh();
      } catch (error) {
        setMessage(downloadMessage(error));
      } finally {
        setBusyUnit(null);
      }
    },
    [runtime, refresh],
  );

  async function syncNow() {
    setSyncing(true);
    const result = await runtime.sync.syncOnce();
    setMessage(
      result.ok ? 'Up to date.' : 'Could not reach the server. Your work is saved on this phone.',
    );
    setSyncing(false);
    refresh();
  }

  if (home === undefined) {
    return (
      <Screen>
        <Body>Loading…</Body>
      </Screen>
    );
  }
  if (home === null) {
    return (
      <View style={{ flex: 1 }}>
        <TopBar title="Lessons" />
        <Screen>
          <Body>We could not find this child. Go back and pick again.</Body>
        </Screen>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <TopBar
        title={`${avatarEmoji(home.child.avatar)} ${home.child.display_alias}`}
        action={{ label: syncing ? 'Syncing…' : 'Sync', onPress: syncNow }}
      />
      <Screen>
        <Title>My lessons</Title>
        {message ? <Body muted>{message}</Body> : null}
        {home.groups.length === 0 ? (
          <Body>No lessons are ready yet. Connect to the internet and tap Sync.</Body>
        ) : null}
        {home.groups.map((group) => (
          <View key={group.subject.id} style={{ gap: 12 }}>
            <Text style={{ fontSize: 22, fontWeight: '700', color: layerColors.CORE.text }}>
              {group.subject.name}
            </Text>
            {group.units.map((item) => {
              const downloaded = item.pack?.availability !== 'not_downloaded';
              const locked = item.state === 'locked';
              return (
                <Card
                  key={item.unit.id}
                  tone={locked ? 'muted' : item.state === 'mastered' ? 'enrich' : 'core'}
                >
                  <Text style={{ fontSize: 14, color: palette.muted, fontWeight: '700' }}>
                    CHAPTER {item.unit.chapter_number} · {item.unit.chapter_title.toUpperCase()}
                  </Text>
                  <Text style={{ fontSize: 22, fontWeight: '700', color: textColors.heading }}>
                    Unit {item.unit.unit_no}: {item.unit.title}
                  </Text>
                  <Body muted>
                    {STATE_LABEL[item.state]}
                    {item.score !== null ? ` · best ${Math.round(item.score * 100)}%` : ''}
                    {downloaded ? ' · saved on this phone' : ''}
                  </Body>
                  {locked ? (
                    <Body muted>Finish the lesson before this one to open it.</Body>
                  ) : downloaded ? (
                    <Button
                      label={
                        item.state === 'mastered'
                          ? 'Practise again'
                          : item.state === 'in_progress'
                            ? 'Continue'
                            : 'Start'
                      }
                      onPress={() => router.push(`/children/${childId}/unit/${item.unit.id}`)}
                    />
                  ) : (
                    <Button
                      label="Download to this phone"
                      variant="secondary"
                      busy={busyUnit === item.unit.id}
                      onPress={() => download(item)}
                    />
                  )}
                  {item.pack?.availability === 'update_available' ? (
                    <Button
                      label="Update this lesson"
                      variant="ghost"
                      busy={busyUnit === item.unit.id}
                      onPress={() => download(item)}
                    />
                  ) : null}
                </Card>
              );
            })}
          </View>
        ))}
        {message && /wi-?fi|space|update|damaged|finish/i.test(message) ? (
          <ErrorText>{message}</ErrorText>
        ) : null}
      </Screen>
    </View>
  );
}
