import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { LessonUnit } from '@custar/content-schema';
import { loadActiveLesson } from '@custar/learner-core';
import { palette, space, textColors } from '@custar/design-tokens';
import { avatarEmoji, loadHome, type Home } from '../data/queries';
import { Toggle } from '../helper/Toggle';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, Card, ErrorText, Screen, Title } from '../ui';
import { buildWorksheet, type WorksheetDocument, type WorksheetKind } from './buildWorksheetHtml';
import { createDefaultPrinter } from './defaultPrinter';
import { loadWorksheetUnits, type WorksheetUnits } from './loadWorksheetUnits';
import { HAS_PREVIEW, WorksheetPreview } from './WorksheetPreview';

interface Choice {
  unit: LessonUnit;
  unitId: string;
  kind: WorksheetKind;
  variantId?: string;
}

/** One sheet is open: build it, preview it (in a browser), print it or share it as a PDF. */
function DocumentView({
  choice,
  alias,
  onBack,
}: {
  choice: Choice;
  alias: string;
  onBack: () => void;
}): ReactNode {
  const printer = useRef(createDefaultPrinter()).current;
  const [prefill, setPrefill] = useState(true);
  const [doc, setDoc] = useState<WorksheetDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<'print' | 'share' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Building is quick, but it still happens off the press so the buttons show "busy" and stay off until it is done.
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError(null);
    setMessage(null);
    const timer = setTimeout(() => {
      try {
        const built = buildWorksheet(choice.unit, {
          kind: choice.kind,
          ...(choice.variantId ? { variantId: choice.variantId } : {}),
          ...(choice.kind === 'worksheet' && prefill ? { childAlias: alias } : {}),
        });
        if (alive) setDoc(built);
      } catch {
        if (alive) setError('This sheet could not be made. Please go back and try another.');
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [choice, alias, prefill]);

  const building = doc === null && error === null;
  const disabled = building || working !== null || doc === null;

  async function run(kind: 'print' | 'share') {
    if (!doc) return;
    setWorking(kind);
    setMessage(null);
    const result = await (kind === 'print'
      ? printer.print(doc.html)
      : printer.share(doc.html, doc.title));
    setMessage({ ok: result.ok, text: result.message });
    setWorking(null);
  }

  return (
    <Screen>
      <Button label="← All worksheets" variant="ghost" onPress={onBack} />
      <Title>{doc?.title ?? 'Making the sheet…'}</Title>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {doc ? (
        <Body muted>
          {doc.questionCount} questions · A4 page
          {choice.kind === 'answers' ? ' · for the grown-up' : ''}
        </Body>
      ) : null}
      {choice.kind === 'worksheet' ? (
        <Toggle
          label={`Write ${alias} on the Name line`}
          hint="Only the nickname is printed. Leave it off to write the name by hand."
          on={prefill}
          onToggle={() => setPrefill(!prefill)}
        />
      ) : null}
      <View style={{ gap: space[2] }}>
        <Button
          label="Print"
          onPress={() => run('print')}
          disabled={disabled}
          busy={building || working === 'print'}
        />
        {printer.canShare ? (
          <Button
            label="Share as PDF"
            variant="secondary"
            onPress={() => run('share')}
            disabled={disabled}
            busy={working === 'share'}
          />
        ) : null}
      </View>
      {message ? (
        message.ok ? (
          <Body>{message.text}</Body>
        ) : (
          <ErrorText>{message.text}</ErrorText>
        )
      ) : null}
      {HAS_PREVIEW && doc ? <WorksheetPreview html={doc.html} title={doc.title} /> : null}
    </Screen>
  );
}

/**
 * The grown-ups' worksheets for one child (`/grownups/worksheets/[childId]`): printable A4 sheets of the child's
 * downloaded lessons. Everything is made on the phone from the lesson already downloaded, so it works with no internet.
 * "More practice" offers each lesson's reviewed practice pools; nothing is generated on demand.
 */
export function WorksheetsScreen({ childId }: { childId: string }): ReactNode {
  const { runtime, tick } = useRuntime();
  const [home, setHome] = useState<Home | null | undefined>(undefined);
  const [loaded, setLoaded] = useState<WorksheetUnits | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const found = await loadHome(runtime, childId);
      if (!alive) return;
      setHome(found);
      if (!found) return;
      const units = await loadWorksheetUnits(found, (unitId) =>
        loadActiveLesson(runtime.ports, runtime.appVersion, unitId),
      );
      if (alive) setLoaded(units);
    })();
    return () => {
      alive = false;
    };
  }, [runtime, childId, tick]);

  const alias = home?.child.display_alias ?? '';
  const subjects = useMemo(
    () => [...new Set((loaded?.units ?? []).map((u) => u.subject))],
    [loaded],
  );

  if (home === undefined || (home !== null && loaded === null)) {
    return (
      <Screen>
        <Body>Loading…</Body>
      </Screen>
    );
  }
  if (home === null || loaded === null) {
    return (
      <Screen>
        <Body>We could not find this child. Go back and pick again.</Body>
      </Screen>
    );
  }
  if (choice) {
    return <DocumentView choice={choice} alias={alias} onBack={() => setChoice(null)} />;
  }

  return (
    <Screen>
      <Title>Worksheets</Title>
      <Card tone="core">
        <Text style={{ fontSize: 22, fontWeight: '700', color: textColors.heading }}>
          {avatarEmoji(home.child.avatar)} {alias}
        </Text>
        <Body>
          Printable sheets for {alias}, made on this phone from the lessons already downloaded. They
          work without internet.
        </Body>
      </Card>

      {loaded.units.length === 0 ? (
        <Card>
          <Body>
            No lessons are downloaded yet. Open {alias}&apos;s lessons, download one, and its
            worksheet will appear here.
          </Body>
        </Card>
      ) : null}

      {subjects.map((subject) => (
        <View key={subject} style={{ gap: space[3] }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: textColors.heading }}>
            {subject}
          </Text>
          {loaded.units
            .filter((unit) => unit.subject === subject)
            .map((unit) => (
              <Card key={unit.unitId}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: textColors.heading }}>
                  Unit {unit.unitNo}: {unit.title}
                </Text>
                <Button
                  label="Worksheet (for the child)"
                  onPress={() =>
                    setChoice({ unit: unit.lesson, unitId: unit.unitId, kind: 'worksheet' })
                  }
                />
                <Button
                  label="Answers (for the grown-up)"
                  variant="secondary"
                  onPress={() =>
                    setChoice({ unit: unit.lesson, unitId: unit.unitId, kind: 'answers' })
                  }
                />
                {unit.listing.variants.length > 0 ? (
                  <View style={{ gap: space[2], marginTop: space[2] }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: palette.muted }}>
                      MORE PRACTICE (checked by our reviewers)
                    </Text>
                    {unit.listing.variants.map((variant) => (
                      <View key={variant.id} style={{ gap: space[2] }}>
                        <Body>
                          {variant.label} · {variant.questionCount} questions
                        </Body>
                        <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
                          <Button
                            label={`${variant.label}: worksheet`}
                            variant="secondary"
                            onPress={() =>
                              setChoice({
                                unit: unit.lesson,
                                unitId: unit.unitId,
                                kind: 'worksheet',
                                variantId: variant.id,
                              })
                            }
                          />
                          <Button
                            label={`${variant.label}: answers`}
                            variant="ghost"
                            onPress={() =>
                              setChoice({
                                unit: unit.lesson,
                                unitId: unit.unitId,
                                kind: 'answers',
                                variantId: variant.id,
                              })
                            }
                          />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Card>
            ))}
        </View>
      ))}

      {loaded.problems.map((problem) => (
        <Card key={problem.unitId} tone="muted">
          <Body>{problem.title}</Body>
          <ErrorText>{problem.message}</ErrorText>
          <Body muted>Download this lesson again to print its worksheet.</Body>
        </Card>
      ))}
    </Screen>
  );
}
