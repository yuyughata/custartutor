import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getHousehold, purgeAccountData, removeUnit } from '@custar/learner-core';
import {
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  textColors,
} from '@custar/design-tokens';
import {
  AVATAR_CHOICES,
  avatarEmoji,
  formatBytes,
  loadGrownupSummary,
  type GrownupSummary,
} from '../data/queries';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, Card, ErrorText, Screen, TextField, Title, TopBar } from '../ui';

const LEVELS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
const teal = layerColors.CORE;

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: minTouchTarget,
        paddingHorizontal: space[4],
        borderRadius: radii.pill,
        borderWidth: 2,
        borderColor: selected ? teal.bar : palette.placeholderBorder,
        backgroundColor: selected ? teal.tint : palette.white,
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: selected ? '700' : '400', color: textColors.body }}>
        {label}
      </Text>
    </Pressable>
  );
}

function PinGateView({ onUnlocked }: { onUnlocked: () => void }) {
  const { runtime, setElevatedUntil } = useRuntime();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const lock = await runtime.pin.lockStatus();
      if (lock.locked) {
        setError(`Too many tries. Wait ${Math.ceil(lock.retryAfterMs / 1000)} seconds.`);
        return;
      }
      if (!(await runtime.pin.verifyLocal(pin))) {
        setError('That PIN is not right.');
        return;
      }
      // The server check is the real control; offline we still open the local settings.
      try {
        const elevation = await runtime.pin.elevate(pin);
        setElevatedUntil(elevation.expires_at_ms);
      } catch {
        setElevatedUntil(null);
      }
      onUnlocked();
    } finally {
      setBusy(false);
      setPin('');
    }
  }

  return (
    <Screen>
      <Title>Grown-ups only</Title>
      <Body>Enter your PIN to open settings.</Body>
      <TextField
        label="Grown-up PIN"
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={6}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {runtime.demoHint ? <Body muted>Demo PIN: {runtime.demoHint.pin}</Body> : null}
      <Button label="Open" onPress={submit} busy={busy} disabled={pin.length < 4} />
    </Screen>
  );
}

function AddChild({ onAdded }: { onAdded: () => void }) {
  const { runtime } = useRuntime();
  const [alias, setAlias] = useState('');
  const [avatar, setAvatar] = useState<string>(AVATAR_CHOICES[0] ?? 'owl');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('P1');
  const [readingMode, setReadingMode] = useState<'reader' | 'pre_reader'>('reader');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const household = await getHousehold(runtime.ports.db);
      if (!household) throw new Error('Set up your family first.');
      await runtime.households.createChild({
        id: runtime.ports.random.uuid(),
        householdId: household.id,
        alias: alias.trim(),
        avatar,
        levelCode: level,
        readingMode,
      });
      await runtime.sync.syncOnce();
      setAlias('');
      onAdded();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not add the child. Check your connection.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Body role="lead">Add a child</Body>
      <TextField
        label="Nickname (not their full name)"
        value={alias}
        onChangeText={setAlias}
        maxLength={40}
      />
      <Body>Picture</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {AVATAR_CHOICES.map((choice) => (
          <Chip
            key={choice}
            label={avatarEmoji(choice)}
            selected={avatar === choice}
            onPress={() => setAvatar(choice)}
          />
        ))}
      </View>
      <Body>Class</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {LEVELS.map((code) => (
          <Chip
            key={code}
            label={`Primary ${code.slice(1)}`}
            selected={level === code}
            onPress={() => setLevel(code)}
          />
        ))}
      </View>
      <Body>How do they learn?</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Chip
          label="Reads and writes"
          selected={readingMode === 'reader'}
          onPress={() => setReadingMode('reader')}
        />
        <Chip
          label="Listens (cannot read yet)"
          selected={readingMode === 'pre_reader'}
          onPress={() => setReadingMode('pre_reader')}
        />
      </View>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label="Save child" onPress={save} busy={busy} disabled={alias.trim().length === 0} />
    </Card>
  );
}

function Dashboard() {
  const { runtime, email, tick, refresh, elevatedUntil } = useRuntime();
  const router = useRouter();
  const [summary, setSummary] = useState<GrownupSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => setSummary(await loadGrownupSummary(runtime)), [runtime]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  async function syncNow() {
    setMessage('Syncing…');
    const result = await runtime.sync.syncOnce();
    setMessage(
      result.ok
        ? `Synced. Sent ${result.push.sent} update(s).`
        : 'Could not reach the server. Everything is saved on this phone and will sync later.',
    );
    refresh();
  }

  async function signOut() {
    await runtime.households.signOut();
    await runtime.pin.clear();
    await purgeAccountData(runtime.ports.db);
    router.replace('/');
  }

  if (!summary) {
    return (
      <Screen>
        <Body>Loading…</Body>
      </Screen>
    );
  }

  const elevated = elevatedUntil !== null && elevatedUntil > Date.now();
  return (
    <Screen>
      <Title>{summary.householdName ?? 'Your family'}</Title>
      <Body muted>
        {elevated
          ? 'Grown-up access confirmed with the server.'
          : 'Offline or not confirmed: changes that need the server are unavailable.'}
      </Body>

      <Body role="lead">Children</Body>
      {summary.children.map((child) => (
        <Card key={child.id}>
          <Text style={{ fontSize: 20, fontWeight: '700', color: textColors.heading }}>
            {avatarEmoji(child.avatar)} {child.display_alias}
          </Text>
          <Body muted>
            Primary {child.level_code.slice(1)} ·{' '}
            {child.reading_mode === 'pre_reader' ? 'listens' : 'reads and writes'}
          </Body>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button
              label="AI tutor"
              variant="ghost"
              onPress={() => router.push(`/grownups/tutor/${child.id}`)}
            />
            <Button
              label="Worksheets"
              variant="ghost"
              onPress={() => router.push(`/grownups/worksheets/${child.id}`)}
            />
            <Button
              label="Helper mode"
              variant="ghost"
              onPress={() => router.push(`/grownups/helper/${child.id}`)}
            />
          </View>
        </Card>
      ))}
      {adding ? (
        <AddChild
          onAdded={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : (
        <Button label="Add a child" variant="secondary" onPress={() => setAdding(true)} />
      )}

      <Body role="lead">Downloaded lessons</Body>
      <Body muted>
        Using {formatBytes(summary.storage.totalBytes)} · {formatBytes(summary.storage.freeBytes)}{' '}
        free on this phone
      </Body>
      {summary.packs.length === 0 ? <Body muted>Nothing downloaded yet.</Body> : null}
      {summary.packs.map(({ unit, pack }) => (
        <Card key={unit.id}>
          <Body>
            Unit {unit.unit_no}: {unit.title}
          </Body>
          <Body muted>
            {pack.availability === 'not_downloaded'
              ? 'Not downloaded'
              : pack.availability === 'update_available'
                ? 'Downloaded · update available'
                : 'Downloaded · up to date'}
          </Body>
          {pack.availability !== 'not_downloaded' ? (
            <Button
              label="Remove from this phone"
              variant="ghost"
              onPress={async () => {
                await removeUnit(runtime.ports, unit.id);
                refresh();
              }}
            />
          ) : null}
        </Card>
      ))}

      <Body role="lead">Sync</Body>
      <Body muted>
        {summary.pendingEvents} update(s) waiting to send
        {summary.deadEvents > 0 ? ` · ${summary.deadEvents} could not be sent` : ''}
      </Body>
      <Body muted>
        Last checked with the server:{' '}
        {summary.lastVerifiedAt ? new Date(summary.lastVerifiedAt).toLocaleString() : 'never'}
      </Body>
      {!summary.graceValid ? (
        <ErrorText>Please connect to the internet soon so we can re-check this phone.</ErrorText>
      ) : null}
      {message ? <Body>{message}</Body> : null}
      <Button label="Sync now" variant="secondary" onPress={syncNow} />

      <Body role="lead">Account</Body>
      <Body muted>{email}</Body>
      <Button label="Sign out" variant="danger" onPress={signOut} />
    </Screen>
  );
}

export default function Grownups() {
  const [unlocked, setUnlocked] = useState(false);
  return (
    <View style={{ flex: 1 }}>
      <TopBar title="Grown-ups" />
      {unlocked ? <Dashboard /> : <PinGateView onUnlocked={() => setUnlocked(true)} />}
    </View>
  );
}
