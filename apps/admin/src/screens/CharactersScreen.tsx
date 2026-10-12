// The cast bible: the facts the owner has stated about each character, plus guidance derived from age. Only facts
// entered here are treated as facts by the generator; anything left blank stays "not stated".
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { CharacterRecord } from '../api/types';
import { useAction } from '../hooks/useAction';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatDateTime } from '../lib/format';
import {
  formsEqual,
  fromForm,
  statedFacts,
  toForm,
  validateForm,
  type CharacterForm,
} from '../lib/characterForm';
import { whyNot } from '../lib/roles';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { useUnsavedChanges } from '../runtime/UnsavedGuard';
import { Badge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card, Row } from '../ui/Card';
import { TextField, Toggle } from '../ui/Fields';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { Async, EmptyState } from '../ui/States';
import { H2, H3, P, Small } from '../ui/Text';
import { space } from '../ui/theme';

function CharacterCard({ character }: { character: CharacterRecord }): ReactNode {
  const api = useApi();
  const { role } = useSession();
  const denied = whyNot(role, 'characters.edit');
  const [baseline, setBaseline] = useState(character);
  const [form, setForm] = useState<CharacterForm>(toForm(character));
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  const problems = validateForm(form);
  const dirty = !formsEqual(form, toForm(baseline));
  useUnsavedChanges(dirty);
  const set = (patch: Partial<CharacterForm>): void => setForm({ ...form, ...patch });

  const save = useAction(async () => {
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    const saved = await api.characters.save(fromForm(baseline, form));
    // Only after the table write resolved does the card show the saved values.
    setBaseline(saved);
    setForm(toForm(saved));
    setSavedAt(new Date());
    setShowProblems(false);
  });

  const facts = statedFacts(baseline);
  return (
    <Card testID={`character-${character.slug}`}>
      <Row>
        <H2>{baseline.name}</H2>
        <Badge
          label={baseline.active ? 'Active' : 'Inactive'}
          glyph={baseline.active ? '✓' : '■'}
          tone={baseline.active ? 'success' : 'neutral'}
        />
        <Small>slug: {baseline.slug}</Small>
      </Row>
      <Small>
        {facts.length > 0
          ? `Stated so far: ${facts.join(', ')}.`
          : 'No facts have been stated yet. The generator will not guess any.'}
      </Small>

      <View style={{ gap: space[3] }}>
        <H3>Facts (only these are treated as facts)</H3>
        <Row align="flex-start" gap={space[4]}>
          <View style={{ minWidth: 220, flexGrow: 1 }}>
            <TextField
              label={`Name, ${baseline.name}`}
              value={form.name}
              onChangeText={(name) => set({ name })}
              error={showProblems ? problems.name : null}
              editable={!denied}
            />
          </View>
          <View style={{ width: 130 }}>
            <TextField
              label={`Age in years, ${baseline.name}`}
              value={form.ageYears}
              onChangeText={(ageYears) => set({ ageYears })}
              keyboardType="number-pad"
              error={showProblems ? problems.ageYears : null}
              editable={!denied}
            />
          </View>
          <View style={{ width: 170 }}>
            <TextField
              label={`Age note, ${baseline.name}`}
              hint='For example "almost 5".'
              value={form.ageNote}
              onChangeText={(ageNote) => set({ ageNote })}
              editable={!denied}
            />
          </View>
        </Row>
        <Row align="flex-start" gap={space[4]}>
          <View style={{ width: 200 }}>
            <Select
              label={`Gender, ${baseline.name}`}
              value={form.gender}
              options={[
                { value: '', label: 'Not stated' },
                { value: 'female', label: 'Female' },
                { value: 'male', label: 'Male' },
              ]}
              onChange={(gender) =>
                set({ gender: gender === 'female' || gender === 'male' ? gender : '' })
              }
              disabled={Boolean(denied)}
            />
          </View>
          <View style={{ width: 200 }}>
            <TextField
              label={`Pronouns, ${baseline.name}`}
              value={form.pronouns}
              onChangeText={(pronouns) => set({ pronouns })}
              editable={!denied}
            />
          </View>
        </Row>
        <TextField
          label={`Relationship note, ${baseline.name}`}
          hint="How the characters are related, once you decide. Until this is filled in, the generator never calls two characters siblings or friends."
          value={form.relationshipNote}
          onChangeText={(relationshipNote) => set({ relationshipNote })}
          lines={2}
          editable={!denied}
        />
        <TextField
          label={`Personality, ${baseline.name}`}
          hint="One trait per line. Leave empty until you decide."
          value={form.personality}
          onChangeText={(personality) => set({ personality })}
          lines={3}
          editable={!denied}
        />
        <TextField
          label={`Voice notes, ${baseline.name}`}
          hint="How the character speaks (owner-supplied)."
          value={form.voiceNotes}
          onChangeText={(voiceNotes) => set({ voiceNotes })}
          lines={2}
          editable={!denied}
        />
      </View>

      <View style={{ gap: space[2] }}>
        <H3>Guidance (derived from age, editable)</H3>
        <TextField
          label={`Derived guidance, ${baseline.name}`}
          hint="A suggestion for how to write this character, worked out from the age alone. It is not a fact about the character; change or clear it as you like."
          value={form.derivedGuidance}
          onChangeText={(derivedGuidance) => set({ derivedGuidance })}
          lines={3}
          editable={!denied}
        />
      </View>

      <Toggle
        label={`Active, ${baseline.name}`}
        value={form.active}
        onChange={(active) => set({ active })}
        disabled={Boolean(denied)}
        hint="Inactive characters are not used in new drafts."
      />

      {save.error ? (
        <Banner tone="danger" title="The character was not saved" testID="save-error">
          <P>{save.error.message}</P>
        </Banner>
      ) : null}
      <Row align="flex-start" gap={space[4]}>
        <Button
          label={`Save ${baseline.name}`}
          onPress={() => void save.run()}
          busy={save.busy}
          disabled={Boolean(denied) || !dirty}
          reason={denied ?? (!dirty ? 'Nothing has changed.' : null)}
        />
        <Small>
          {save.busy
            ? 'Saving…'
            : dirty
              ? 'Unsaved changes.'
              : savedAt
                ? `Saved at ${formatDateTime(savedAt.toISOString())}.`
                : 'Up to date.'}
        </Small>
      </Row>
    </Card>
  );
}

export default function CharactersScreen(): ReactNode {
  usePageTitle('Characters');
  const api = useApi();
  const { recheckAuth } = useRuntime();
  const characters = useLoad(() => api.characters.list(), [api]);
  return (
    <View style={{ gap: space[4] }}>
      <PageHeader
        title="Characters"
        subtitle="The cast bible the generator uses in stories and examples."
      />
      <Banner tone="info" title="Only facts entered here are treated as facts" testID="facts-note">
        <P>
          Whatever you leave blank stays unknown, and the generator will not invent it. Guidance
          derived from a character’s age is labelled as derived and you can edit or clear it.
        </P>
      </Banner>
      <Async state={characters} onSignInAgain={() => void recheckAuth()}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No characters yet">
              <P>The cast table is empty. Characters are created by the project setup.</P>
            </EmptyState>
          ) : (
            <View style={{ gap: space[4] }}>
              {list.map((character) => (
                <CharacterCard key={character.id} character={character} />
              ))}
            </View>
          )
        }
      </Async>
    </View>
  );
}
