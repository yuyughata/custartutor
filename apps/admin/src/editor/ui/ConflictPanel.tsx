// The screen shown when a save is refused with `stale_base`: someone saved a newer version of the unit while this one
// was being edited, and nothing of the person's work was written. There is no "save as a separate copy" (two live
// copies of one unit is how children end up with two different lessons). The person reconciles instead: what they
// changed and what changed in the newer version are listed item by item, what only one side touched is taken
// automatically, and each item both touched is a choice.
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { UnitVersionSummary } from '../../api/types';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { formatDateTime } from '../../lib/format';
import { H2, P, Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import { changesBetween, mergeUnits, type Choice, type ItemChange } from '../merge';

function ChangeList({
  title,
  changes,
  empty,
}: {
  title: string;
  changes: ItemChange[];
  empty: string;
}): ReactNode {
  return (
    <View style={{ gap: space[1], flexGrow: 1, flexBasis: 260, minWidth: 240 }}>
      <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>{title}</Text>
      {changes.length === 0 ? <Small>{empty}</Small> : null}
      {changes.slice(0, 40).map((change) => (
        <Text key={change.key} style={{ fontSize: 14, color: colors.textSoft }}>
          {change.change === 'added'
            ? '+ added'
            : change.change === 'removed'
              ? '− removed'
              : '~ changed'}
          : {change.label}
        </Text>
      ))}
      {changes.length > 40 ? <Small>and {changes.length - 40} more.</Small> : null}
    </View>
  );
}

function Pick({
  label,
  name,
  on,
  onPress,
}: {
  label: string;
  /** The accessible name: the visible label plus what it is about. */
  name: string;
  on: boolean;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={name}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{
        minHeight: 40,
        paddingHorizontal: space[3],
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        borderRadius: radii.md,
        borderWidth: 1.5,
        borderColor: on ? colors.primary : colors.borderStrong,
        backgroundColor: on ? colors.primaryTint : colors.white,
      }}
    >
      <Text aria-hidden style={{ color: on ? colors.primaryDark : colors.subtle }}>
        {on ? '●' : '○'}
      </Text>
      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>{label}</Text>
    </Pressable>
  );
}

export function ConflictPanel({
  base,
  mine,
  theirs,
  newer,
  baseVersion,
  onUseMerged,
  onDiscardMine,
  onBack,
}: {
  base: unknown;
  mine: unknown;
  theirs: unknown;
  newer: UnitVersionSummary;
  baseVersion: number;
  onUseMerged: (merged: Record<string, unknown>) => void;
  onDiscardMine: () => void;
  onBack: () => void;
}): ReactNode {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const mineChanges = useMemo(() => changesBetween(base, mine), [base, mine]);
  const theirChanges = useMemo(() => changesBetween(base, theirs), [base, theirs]);
  const result = useMemo(
    () => mergeUnits(base, mine, theirs, choices),
    [base, mine, theirs, choices],
  );
  const open = result.clashes.filter((clash) => choices[clash.key] === undefined).length;
  const who = newer.generated_by === 'ai' ? 'Claude drafted' : 'a person saved';
  return (
    <View testID="conflict-panel" style={{ gap: space[4] }}>
      <Banner
        tone="danger"
        title="Your changes were not saved: the unit has a newer version"
        testID="conflict-banner"
      >
        <P>
          You started from version {baseVersion}. Since then {who} version {newer.version} (
          {formatDateTime(newer.created_at)}). Saving on top of it would silently throw its changes
          away, so nothing was written. Your edits are still here, and also kept on this device.
        </P>
      </Banner>
      <Card>
        <H2>What changed</H2>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[4] }}>
          <ChangeList
            title="You changed"
            changes={mineChanges}
            empty={`Nothing: your copy is the same as version ${baseVersion}.`}
          />
          <ChangeList
            title={`Version ${newer.version} changed`}
            changes={theirChanges}
            empty="Nothing in the content."
          />
        </View>
        <Small>
          Anything only one of you touched is taken as it is. Anything you both touched is below.
        </Small>
      </Card>
      {result.clashes.length > 0 ? (
        <Card>
          <H2>Items you both changed</H2>
          <Small>
            Choose whose version of each to keep. Nothing is lost until you save; you can still
            change the result afterwards.
          </Small>
          {result.clashes.map((clash) => (
            <View
              key={clash.key}
              style={{
                gap: space[2],
                paddingVertical: space[2],
                borderTopWidth: 1,
                borderTopColor: colors.border,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>
                {clash.label}
              </Text>
              <Small>
                You{' '}
                {clash.mine === 'removed'
                  ? 'removed it'
                  : clash.mine === 'added'
                    ? 'added it'
                    : 'changed it'}
                ; version {newer.version}{' '}
                {clash.theirs === 'removed'
                  ? 'removed it'
                  : clash.theirs === 'added'
                    ? 'added it'
                    : 'changed it'}
                .
              </Small>
              <View
                style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}
                accessibilityRole="radiogroup"
              >
                <Pick
                  label="Keep my version"
                  name={`Keep mine: ${clash.label}`}
                  on={choices[clash.key] === 'mine'}
                  onPress={() => setChoices({ ...choices, [clash.key]: 'mine' })}
                />
                <Pick
                  label={`Keep version ${newer.version}`}
                  name={`Keep version ${newer.version}: ${clash.label}`}
                  on={choices[clash.key] === 'theirs'}
                  onPress={() => setChoices({ ...choices, [clash.key]: 'theirs' })}
                />
              </View>
            </View>
          ))}
        </Card>
      ) : (
        <Banner tone="success" title="Nothing clashes">
          <P>
            You and version {newer.version} changed different things, so both sets of changes can be
            kept.
          </P>
        </Banner>
      )}
      <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
        <Button
          label={`Combine my changes with version ${newer.version}`}
          disabled={result.merged === null}
          reason={open > 0 ? `Choose for ${open} more item${open === 1 ? '' : 's'} above.` : null}
          onPress={() => result.merged && onUseMerged(result.merged)}
          testID="conflict-merge"
        />
        <Button label="Go back and keep editing" variant="secondary" onPress={onBack} />
        <Button
          label={`Throw my changes away and start from version ${newer.version}`}
          variant="danger"
          onPress={onDiscardMine}
        />
      </View>
      <Small>
        After combining you will still check the result and save it as version {newer.version + 1};
        combining does not save anything.
      </Small>
    </View>
  );
}
