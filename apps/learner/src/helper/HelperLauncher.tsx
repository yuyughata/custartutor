import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { loadGrownupContent, type PackStatus } from '@custar/learner-core';
import { palette, space, textColors } from '@custar/design-tokens';
import { avatarEmoji, loadHome, type Home, type HomeUnit } from '../data/queries';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, Card, ErrorText, Screen, Title } from '../ui';
import { SpeedChoice } from '../voice/SpeedChoice';
import { useReadAloud } from '../voice/useReadAloud';
import { downloadMessage } from './downloadMessage';
import { Toggle } from './Toggle';

type GrownupPack = 'ready' | 'missing' | 'unknown';

interface Row {
  subject: string;
  item: HomeUnit;
  grownup: GrownupPack;
}

interface Launcher {
  home: Home;
  rows: Row[];
}

/** The lessons this child could do with a helper, and whether each one has its grown-up pack on the phone. */
async function loadLauncher(
  runtime: ReturnType<typeof useRuntime>['runtime'],
  childId: string,
): Promise<Launcher | null> {
  const home = await loadHome(runtime, childId);
  if (!home) return null;
  const rows: Row[] = [];
  for (const group of home.groups) {
    for (const item of group.units) {
      if (item.unit.kind !== 'lesson') continue; // only lessons have a helper script
      let grownup: GrownupPack = 'unknown';
      if (item.pack && item.pack.availability !== 'not_downloaded') {
        try {
          grownup = (await loadGrownupContent(runtime.ports, item.unit.id)) ? 'ready' : 'missing';
        } catch {
          grownup = 'unknown'; // damaged or unreadable: the lesson screen explains it
        }
      }
      rows.push({ subject: group.subject.name, item, grownup });
    }
  }
  return { home, rows };
}

/**
 * The grown-ups' launcher for a helper session (`/grownups/helper/[childId]`). Lists the child's lessons: download a
 * lesson or its grown-up pack here if needed, then start. Starting opens the helper lesson screen, which runs in
 * child mode and needs the PIN to leave.
 */
export function HelperLauncher({ childId }: { childId: string }): ReactNode {
  const { runtime, tick, refresh } = useRuntime();
  const router = useRouter();
  const [launcher, setLauncher] = useState<Launcher | null | undefined>(undefined);
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState<boolean | null>(null);
  const read = useReadAloud();

  useEffect(() => {
    let alive = true;
    void loadLauncher(runtime, childId).then((value) => alive && setLauncher(value));
    return () => {
      alive = false;
    };
  }, [runtime, childId, tick]);

  /**
   * Opens the helper lesson with NOTHING of the grown-ups area left behind it: the navigation stack is cleared first,
   * so no back gesture, back button or browser Back can return to an unlocked grown-ups screen. (The only way out of a
   * helper session is "Finish", which asks for the PIN.)
   */
  function startSession(unitId: string) {
    const narrateParam = narrate && preReader ? '1' : '0';
    if (router.canDismiss()) router.dismissAll();
    router.replace(`/helper/${childId}/${unitId}?autoplay=${narrateParam}`);
  }

  const download = useCallback(
    async (unitId: string, pack: PackStatus, what: 'lesson' | 'grownup') => {
      setBusyUnit(unitId);
      setMessage(null);
      try {
        // The grown-up pack is fetched with the version that is already playing, so an update never swaps in
        // under a child who is part way through.
        const versionNo =
          what === 'grownup'
            ? (pack.activeVersionNo ?? pack.latestVersionNo)
            : pack.latestVersionNo;
        await runtime.downloads.downloadUnit(unitId, versionNo, {
          wifiOnly: true,
          includeGrownup: true,
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

  if (launcher === undefined) {
    return (
      <Screen>
        <Body>Loading…</Body>
      </Screen>
    );
  }
  if (launcher === null) {
    return (
      <Screen>
        <Body>We could not find this child. Go back and pick again.</Body>
      </Screen>
    );
  }

  const { child } = launcher.home;
  const preReader = child.reading_mode === 'pre_reader';
  // Narration is on by default for a child who cannot read yet, and only offered when this phone can speak.
  const narrate = autoplay ?? (preReader && read.available);

  return (
    <Screen>
      <Title>Helper mode</Title>

      <Card tone={preReader ? 'enrich' : 'core'}>
        <Text style={{ fontSize: 22, fontWeight: '700', color: textColors.heading }}>
          {avatarEmoji(child.avatar)} {child.display_alias}
        </Text>
        {preReader ? (
          <Body>
            {child.display_alias} cannot read yet, so helper mode is made for you both. You read and
            explain from the helper script; {child.display_alias} taps the big buttons.
          </Body>
        ) : (
          <Body>
            {child.display_alias} reads and writes. You can still sit beside them with the helper
            script if they would like company.
          </Body>
        )}
      </Card>

      <Card>
        <Body role="lead">How it works</Body>
        <Body>
          The app stays in child mode: it cannot open the grown-ups area. When you finish, you will
          need your PIN. It works without internet once the lesson and its grown-up pack are on this
          phone.
        </Body>
      </Card>

      <View style={{ gap: space[3] }}>
        {read.available ? <SpeedChoice readingMode={child.reading_mode} /> : null}
        {preReader ? (
          read.available ? (
            <Toggle
              label="Read each part aloud when it opens"
              hint="Starts only after you press Start the lesson. You can stop it any time."
              on={narrate}
              onToggle={() => setAutoplay(!narrate)}
            />
          ) : (
            <Body muted>
              Reading aloud is not available on this phone, so you read to {child.display_alias}.
            </Body>
          )
        ) : null}
      </View>

      {message ? <ErrorText>{message}</ErrorText> : null}

      {launcher.rows.length === 0 ? (
        <Body>
          No lessons are ready for {child.display_alias} yet. Connect to the internet and sync.
        </Body>
      ) : null}

      {launcher.rows.map(({ subject, item, grownup }) => {
        const downloaded = item.pack !== null && item.pack.availability !== 'not_downloaded';
        const locked = item.state === 'locked';
        const busy = busyUnit === item.unit.id;
        return (
          <Card key={item.unit.id} tone={locked ? 'muted' : 'core'}>
            <Text style={{ fontSize: 14, color: palette.muted, fontWeight: '700' }}>
              {subject.toUpperCase()} · CHAPTER {item.unit.chapter_number}
            </Text>
            <Text style={{ fontSize: 22, fontWeight: '700', color: textColors.heading }}>
              Unit {item.unit.unit_no}: {item.unit.title}
            </Text>
            {locked ? (
              <Body muted>Finish the lesson before this one to open it.</Body>
            ) : !downloaded && item.pack ? (
              <>
                <Body muted>Not on this phone yet. Download it once, then it works offline.</Body>
                <Button
                  label="Download to this phone"
                  variant="secondary"
                  busy={busy}
                  onPress={() => download(item.unit.id, item.pack as PackStatus, 'lesson')}
                />
              </>
            ) : grownup === 'missing' && item.pack ? (
              <>
                <Body>
                  The lesson is on this phone but the grown-up pack (the helper script) is not. A
                  helper session needs it.
                </Body>
                <Button
                  label="Download the grown-up pack"
                  variant="secondary"
                  busy={busy}
                  onPress={() => download(item.unit.id, item.pack as PackStatus, 'grownup')}
                />
              </>
            ) : (
              <>
                <Body muted>
                  {grownup === 'ready'
                    ? 'Lesson and helper script are on this phone.'
                    : 'On this phone.'}
                </Body>
                <Button label="Start helper session" onPress={() => startSession(item.unit.id)} />
              </>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}
