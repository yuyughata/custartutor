import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  LessonSession,
  loadActiveLesson,
  releaseSuperseded,
  type LoadedLesson,
  type MasterySubmission,
} from '@custar/learner-core';
import { UnitView } from '@custar/lesson-renderer';
import { palette, space } from '@custar/design-tokens';
import { assetUri } from '../../../../platform/assetUri';
import { useRuntime } from '../../../../runtime/RuntimeProvider';
import { TutorLauncher } from '../../../../tutor/TutorLauncher';
import { Body, Button, Card, ErrorText, Screen, Title, TopBar } from '../../../../ui';

/**
 * The lesson player. Works fully offline: content comes from the downloaded pack, answers are graded on the
 * device, and every action becomes an event queued for sync. Only the deterministic mastery check can grant
 * mastery.
 */
export default function Player() {
  const { childId, unitId } = useLocalSearchParams<{ childId: string; unitId: string }>();
  const { runtime, refresh } = useRuntime();
  const router = useRouter();
  const [lesson, setLesson] = useState<LoadedLesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<MasterySubmission | null>(null);
  const [round, setRound] = useState(0);
  // The last question the child answered: tells the tutor where in the lesson the child is.
  const [lastQuestionId, setLastQuestionId] = useState<string | null>(null);
  const session = useRef<LessonSession | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await loadActiveLesson(runtime.ports, runtime.appVersion, unitId);
        const created = new LessonSession({
          unit: loaded.unit,
          unitId,
          versionNo: loaded.versionNo,
          childId,
          ports: runtime.ports,
        });
        await created.start();
        if (!alive) return;
        session.current = created;
        setLesson(loaded);
      } catch (cause) {
        if (alive)
          setError(cause instanceof Error ? cause.message : 'This lesson could not be opened.');
      }
    })();
    return () => {
      alive = false;
      // The old pack version is safe to delete once the child leaves the lesson.
      void releaseSuperseded(runtime.ports, unitId).catch(() => undefined);
    };
  }, [runtime, unitId, childId]);

  async function finish() {
    if (!session.current) return;
    const submission = await session.current.submitMasteryCheck();
    setResult(submission);
    refresh();
    void runtime.sync.syncOnce().then(refresh);
  }

  if (error) {
    return (
      <View style={{ flex: 1 }}>
        <TopBar title="Lesson" />
        <Screen>
          <ErrorText>{error}</ErrorText>
          <Body>Go back to your lessons and download it again.</Body>
        </Screen>
      </View>
    );
  }
  if (!lesson) {
    return (
      <Screen>
        <Body role="lead">Opening your lesson…</Body>
      </Screen>
    );
  }

  if (result) {
    const percent = Math.round(result.score * 100);
    return (
      <View style={{ flex: 1 }}>
        <TopBar title="Lesson" back={false} />
        <Screen>
          <Title>{result.passed ? 'Well done! 🎉' : 'Not yet'}</Title>
          <Card tone={result.passed ? 'enrich' : 'core'}>
            <Body role="lead">
              {result.passed
                ? `You mastered this lesson with ${percent}%. Look for your next lesson in My lessons.`
                : `You got ${percent}%. You need 80% to move on. Let's try again.`}
            </Body>
            {!result.passed && lesson.unit.workbook.not_yet ? (
              <Body>{lesson.unit.workbook.not_yet}</Body>
            ) : null}
          </Card>
          {!result.passed ? (
            <Button
              label="Try again"
              onPress={() => {
                setResult(null);
                setReady(false);
                setRound((value) => value + 1);
              }}
            />
          ) : null}
          <Button
            label="Back to my lessons"
            variant={result.passed ? 'primary' : 'secondary'}
            onPress={() => router.dismissTo(`/children/${childId}`)}
          />
        </Screen>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <TopBar title={lesson.unit.header.title} />
      <UnitView
        key={round}
        unit={lesson.unit}
        mode="student"
        resolveAsset={(assetId) => {
          const path = lesson.assetPath(assetId);
          return path && runtime.mode === 'live' ? assetUri(path) : undefined;
        }}
        onQuestionResult={(_result, response, question) => {
          setLastQuestionId(question.id);
          void session.current
            ?.answer(question.id, response)
            .then(() => setReady(session.current?.masteryCheckReady() ?? false))
            .catch(() => undefined);
        }}
      />
      <View
        style={{
          padding: space[4],
          gap: space[2],
          backgroundColor: palette.white,
          borderTopWidth: 1,
          borderTopColor: palette.placeholderBorder,
        }}
      >
        {!ready ? (
          <Body muted>Answer every question in "Have I Got It?" and press Check on each.</Body>
        ) : null}
        <TutorLauncher
          childId={childId}
          unitId={unitId}
          versionNo={lesson.versionNo}
          unit={lesson.unit}
          lastQuestionId={lastQuestionId}
        />
        <Button label="I'm finished: check my progress" onPress={finish} disabled={!ready} />
      </View>
    </View>
  );
}
