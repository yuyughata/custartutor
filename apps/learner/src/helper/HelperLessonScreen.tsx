import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { LessonUnit } from '@custar/content-schema';
import {
  LessonSession,
  getChild,
  loadActiveLesson,
  loadGrownupContent,
  packStatuses,
  releaseSuperseded,
  type LoadedLesson,
  type LocalChild,
  type MasterySubmission,
} from '@custar/learner-core';
import {
  HelperScriptView,
  RichText,
  SectionView,
  questionSpeechText,
  sectionSpeechText,
} from '@custar/lesson-renderer';
import { layerColors, minTouchTarget, palette, space, textColors } from '@custar/design-tokens';
import { avatarEmoji } from '../data/queries';
import { assetUri } from '../platform/assetUri';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, Card, ErrorText, Screen, Title } from '../ui';
import { SpeakerButton } from '../voice/SpeakerButton';
import { useReadAloud } from '../voice/useReadAloud';
import { downloadMessage } from './downloadMessage';
import { HelperBar } from './HelperBar';
import { HelperPresenceContext } from './HelperContext';
import { HelperTabs, type HelperTab } from './HelperTabs';
import { loadHelperLesson } from './loadHelperLesson';
import { PinPrompt } from './PinPrompt';
import { PrepareView } from './PrepareView';
import { hasHelp, helpForSection, retryIndex } from './script';
import {
  checkButton,
  currentSectionId,
  helperReducer,
  initialHelperState,
  isFirstSection,
  isLastSection,
  progressLabel,
  sectionToNarrate,
} from './session';

const teal = layerColors.CORE;

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'needs_grownup_pack'; lesson: LoadedLesson; child: LocalChild }
  | { status: 'ready'; lesson: LoadedLesson; unit: LessonUnit; child: LocalChild };

/** The bar across the top of a helper session: no back arrow (this is child mode), only "Finish" which asks the PIN. */
function HelperTopBar({
  alias,
  avatar,
  onFinish,
}: {
  alias: string;
  avatar: string | null;
  onFinish: () => void;
}): ReactNode {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        paddingHorizontal: space[4],
        backgroundColor: teal.tint,
        borderBottomWidth: 1,
        borderBottomColor: palette.placeholderBorder,
        minHeight: minTouchTarget + 8,
      }}
    >
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{ flex: 1, color: teal.text, fontSize: 20, fontWeight: '700' }}
      >
        {`${avatarEmoji(avatar)} Helper session · ${alias}`}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Finish helper session"
        accessibilityHint="Asks for the grown-up PIN"
        onPress={onFinish}
        style={{ minHeight: minTouchTarget, justifyContent: 'center', paddingHorizontal: space[2] }}
      >
        <Text style={{ color: teal.text, fontSize: 16, fontWeight: '700' }}>Finish</Text>
      </Pressable>
    </View>
  );
}

/** Segments, one per section: the one on screen, the ones the helper has read, and the ones still to come. */
function ProgressStrip({
  label,
  heading,
  count,
  index,
  readIndexes,
}: {
  label: string;
  heading: string;
  count: number;
  index: number;
  readIndexes: ReadonlySet<number>;
}): ReactNode {
  return (
    <View
      accessible
      accessibilityLabel={`${label}. ${readIndexes.size} read.`}
      style={{
        paddingHorizontal: space[4],
        paddingVertical: space[2],
        gap: space[1],
        backgroundColor: palette.white,
        borderBottomWidth: 1,
        borderBottomColor: palette.placeholderBorder,
      }}
    >
      <Text numberOfLines={1} style={{ fontSize: 15, color: textColors.secondary }}>
        <Text style={{ fontWeight: '700' }}>{label}</Text>
        {` · ${heading}`}
      </Text>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {Array.from({ length: count }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: i === index ? 10 : 8,
              borderRadius: 4,
              backgroundColor:
                i === index
                  ? layerColors.ENRICH.bar
                  : readIndexes.has(i)
                    ? teal.bar
                    : palette.placeholderBorder,
            }}
          />
        ))}
      </View>
    </View>
  );
}

function ReadyHelper({
  lesson,
  unit,
  child,
  childId,
  unitId,
  autoplayInitial,
  onFinishRequest,
}: {
  lesson: LoadedLesson;
  unit: LessonUnit;
  child: LocalChild;
  childId: string;
  unitId: string;
  autoplayInitial: boolean;
  onFinishRequest: () => void;
}): ReactNode {
  const { runtime, refresh } = useRuntime();
  const preReader = child.reading_mode === 'pre_reader';
  const ids = useMemo(() => unit.sections.map((section) => section.id), [unit]);
  const [state, dispatch] = useReducer(helperReducer, undefined, () =>
    initialHelperState(ids, autoplayInitial && preReader),
  );
  const read = useReadAloud({ readingMode: child.reading_mode });
  const session = useRef<LessonSession | null>(null);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<MasterySubmission | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<HelperTab>('helper');
  const scroller = useRef<ScrollView>(null);
  const { width } = useWindowDimensions();
  const wide = width >= 900;

  useEffect(() => {
    session.current = new LessonSession({
      unit,
      unitId,
      versionNo: lesson.versionNo,
      childId,
      ports: runtime.ports,
    });
    return () => {
      session.current = null;
    };
  }, [unit, unitId, lesson.versionNo, childId, runtime]);

  const sectionId = currentSectionId(state);
  const section = sectionId
    ? unit.sections.find((candidate) => candidate.id === sectionId)
    : undefined;
  const sectionText = useCallback(
    (target: { id: string }) => {
      const found = unit.sections.find((candidate) => candidate.id === target.id);
      return found ? sectionSpeechText(found, unit.questions) : '';
    },
    [unit],
  );

  // A new section: stop whatever was being read, and go back to the top. With narration on, the child's page comes
  // first (they watch while it is read); otherwise the helper's script does.
  const narrating = state.autoplay && preReader && read.available;
  useEffect(() => {
    void read.stop();
    setTab(narrating ? 'child' : 'helper');
  }, [state.index, state.phase]);
  useEffect(() => {
    scroller.current?.scrollTo({ y: 0, animated: false });
  }, [state.index, state.phase, tab]);

  // Auto-play narration: once per section, only after the helper started the lesson, only for a pre-reader.
  const narrateId = sectionToNarrate(state, child.reading_mode);
  const narrateText = narrateId ? sectionText({ id: narrateId }) : '';
  useEffect(() => {
    if (!narrateId || !read.available) return;
    dispatch({ type: 'narrated', sectionId: narrateId });
    void read.speak(narrateText, `section:${narrateId}`);
  }, [narrateId, read.available]);

  async function begin() {
    setBusy(true);
    try {
      await session.current?.start().catch(() => undefined);
      dispatch({ type: 'start' });
    } finally {
      setBusy(false);
    }
  }

  function markRead() {
    if (sectionId) void session.current?.completeSection(sectionId).catch(() => undefined);
    dispatch({ type: 'markRead' });
  }

  async function check() {
    if (!session.current) return;
    setBusy(true);
    try {
      const submission = await session.current.submitMasteryCheck();
      setResult(submission);
      dispatch({ type: 'showResult' });
      refresh();
      void runtime.sync.syncOnce().then(refresh);
    } finally {
      setBusy(false);
    }
  }

  function retry() {
    setResult(null);
    setReady(false);
    setRound((value) => value + 1);
    dispatch({ type: 'retry', index: retryIndex(unit) });
  }

  const presence = {
    helperPresent: true as const,
    childId,
    unitId,
    readingMode: child.reading_mode,
    sectionId,
  };

  if (state.phase === 'prepare') {
    return (
      <HelperPresenceContext.Provider value={presence}>
        <PrepareView
          unit={unit}
          childAlias={child.display_alias}
          preReader={preReader}
          readAloudAvailable={read.available}
          narrate={state.autoplay}
          onToggleNarrate={() => dispatch({ type: 'setAutoplay', on: !state.autoplay })}
          onStart={begin}
          starting={busy}
        />
      </HelperPresenceContext.Provider>
    );
  }

  if (state.phase === 'result' && result) {
    const percent = Math.round(result.score * 100);
    return (
      <HelperPresenceContext.Provider value={presence}>
        <Screen>
          <Title>{result.passed ? 'Well done! 🎉' : 'Not yet'}</Title>
          <Card tone={result.passed ? 'enrich' : 'core'}>
            <Body role="lead">
              {result.passed
                ? `${child.display_alias} mastered this lesson with ${percent}%. The next lesson is now open.`
                : `${child.display_alias} got ${percent}%. Mastery needs 80%. Let's try again.`}
            </Body>
            {!result.passed && unit.workbook.not_yet ? <Body>{unit.workbook.not_yet}</Body> : null}
          </Card>
          {!result.passed ? (
            <HelperScriptView
              title="For the helper: if the child has not got it yet"
              say={unit.teacher_manual.mastery_guidance.not_yet}
            />
          ) : null}
          {!result.passed ? <Button label="Try again" onPress={retry} /> : null}
          <Button
            label="Finish helper session"
            variant={result.passed ? 'primary' : 'secondary'}
            onPress={onFinishRequest}
          />
        </Screen>
      </HelperPresenceContext.Provider>
    );
  }

  if (!section) return null;

  const help = helpForSection(unit.teacher_manual, section.id);
  const onMastery = section.type === 'mastery_check';
  const check_ = checkButton({ onMasterySection: onMastery, ready });
  const readIndexes = new Set(ids.flatMap((id, i) => (state.read.includes(id) ? [i] : [])));

  const content = (
    <View style={{ gap: space[6] }}>
      {unit.sections.map((candidate, i) =>
        state.visited.includes(candidate.id) ? (
          <View
            key={`${round}:${candidate.id}`}
            style={{ display: i === state.index ? 'flex' : 'none' }}
          >
            <SectionView
              section={candidate}
              questions={unit.questions}
              mode="student"
              largeTargets={preReader}
              resolveAsset={(assetId) => {
                const path = lesson.assetPath(assetId);
                return path && runtime.mode === 'live' ? assetUri(path) : undefined;
              }}
              renderQuestionExtras={(question) => (
                <SpeakerButton
                  text={questionSpeechText(question)}
                  speakKey={`question:${question.id}`}
                  readingMode={child.reading_mode}
                  large={preReader}
                />
              )}
              onQuestionResult={(_result, response, question) => {
                void session.current
                  ?.answer(question.id, response)
                  .then(() => setReady(session.current?.masteryCheckReady() ?? false))
                  .catch(() => undefined);
              }}
            />
          </View>
        ) : null,
      )}
    </View>
  );

  const panelBody = (
    <View style={{ gap: space[3] }}>
      <HelperScriptView
        title={`For the helper · ${section.heading}`}
        steps={help.steps}
        {...(help.say ? { say: help.say } : {})}
        {...(help.ask ? { ask: help.ask } : {})}
        {...(help.watchFor ? { watchFor: help.watchFor } : {})}
        {...(hasHelp(help)
          ? {}
          : { emptyText: 'Read this part with the child and let them answer in their own words.' })}
      />
      {onMastery ? (
        <View
          style={{
            backgroundColor: layerColors.ENRICH.tint,
            borderLeftWidth: 5,
            borderLeftColor: layerColors.ENRICH.bar,
            padding: space[3],
          }}
        >
          <RichText>{`**This is the mastery check.** Read each question aloud and let ${child.display_alias} tap the answer. Please do not give hints or answers.`}</RichText>
        </View>
      ) : null}
      <RichText color={textColors.muted} role="caption">
        {`**Objective (NERDC):** ${unit.header.objective}`}
      </RichText>
    </View>
  );

  return (
    <HelperPresenceContext.Provider value={presence}>
      <View style={{ flex: 1 }}>
        <ProgressStrip
          label={progressLabel(state)}
          heading={section.heading}
          count={ids.length}
          index={state.index}
          readIndexes={readIndexes}
        />
        {wide ? (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <ScrollView
              ref={scroller}
              style={{ flex: 3 }}
              contentContainerStyle={{ padding: space[5], paddingBottom: space[8] }}
            >
              {content}
            </ScrollView>
            <ScrollView
              style={{ flex: 2, borderLeftWidth: 1, borderLeftColor: palette.placeholderBorder }}
              contentContainerStyle={{ padding: space[5], paddingBottom: space[8] }}
            >
              {panelBody}
            </ScrollView>
          </View>
        ) : (
          <>
            <HelperTabs tab={tab} childName={child.display_alias} onChange={setTab} />
            <ScrollView
              ref={scroller}
              style={{ flex: 1 }}
              contentContainerStyle={{
                alignItems: 'center',
                padding: space[4],
                paddingBottom: space[8],
              }}
            >
              <View style={{ width: '100%', maxWidth: 760 }}>
                {/* Both stay mounted; a hidden page keeps what the child has half answered. */}
                <View style={{ display: tab === 'helper' ? 'flex' : 'none', gap: space[4] }}>
                  {panelBody}
                  <Button
                    label={`Show ${child.display_alias} the page`}
                    variant="secondary"
                    onPress={() => setTab('child')}
                  />
                </View>
                <View style={{ display: tab === 'child' ? 'flex' : 'none' }}>{content}</View>
              </View>
            </ScrollView>
          </>
        )}
        <HelperBar
          sectionText={sectionText(section)}
          sectionKey={`section:${section.id}`}
          readingMode={child.reading_mode}
          isFirst={isFirstSection(state)}
          isLast={isLastSection(state)}
          onPrevious={() => dispatch({ type: 'previous' })}
          onNext={() => dispatch({ type: 'next' })}
          onRead={markRead}
          mastery={{
            visible: check_.visible,
            enabled: check_.enabled,
            onCheck: check,
            busy,
          }}
        />
      </View>
    </HelperPresenceContext.Provider>
  );
}

/**
 * The helper lesson screen: the child's lesson one section at a time, with the helper's script beside it, big buttons
 * for a child who cannot read yet and a PIN to leave. CHILD MODE: no back arrow, the swipe-back gesture and the
 * Android back button ask for the PIN instead, and the only exit is "Finish helper session".
 *
 * Everything the child does goes through the normal `LessonSession`: answers are graded on the phone and queued as
 * ordinary events, and only the graded mastery check can grant mastery. That a helper was present is kept in local UI
 * state only (see `HelperContext`); no new event type exists.
 */
export function HelperLessonScreen({
  childId,
  unitId,
  autoplay,
}: {
  childId: string;
  unitId: string;
  autoplay: boolean;
}): ReactNode {
  const { runtime, refresh } = useRuntime();
  const router = useRouter();
  const read = useReadAloud();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const child = await getChild(runtime.ports.db, childId);
        if (!child) throw new Error('We could not find this child.');
        const result = await loadHelperLesson({
          loadLesson: () => loadActiveLesson(runtime.ports, runtime.appVersion, unitId),
          loadGrownup: () => loadGrownupContent(runtime.ports, unitId),
        });
        if (!alive) return;
        setLoaded(
          result.status === 'ready'
            ? { status: 'ready', lesson: result.lesson, unit: result.unit, child }
            : { status: 'needs_grownup_pack', lesson: result.lesson, child },
        );
      } catch (cause) {
        if (alive)
          setLoaded({
            status: 'error',
            message: cause instanceof Error ? cause.message : 'This lesson could not be opened.',
          });
      }
    })();
    return () => {
      alive = false;
      // The old pack version is safe to delete once the helper session ends.
      void releaseSuperseded(runtime.ports, unitId).catch(() => undefined);
    };
  }, [runtime, unitId, childId, reload]);

  // Android back button: ask for the PIN instead of leaving. (Not available in a browser.)
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setFinishing(true);
      return true;
    });
    return () => subscription.remove();
  }, []);

  async function leave() {
    await read.stop();
    router.replace('/grownups');
  }

  async function downloadGrownupPack() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const status = (await packStatuses(runtime.ports.db)).find((item) => item.unitId === unitId);
      const versionNo = status?.activeVersionNo ?? status?.latestVersionNo;
      if (versionNo === undefined) throw new Error('This lesson is not on this phone.');
      await runtime.downloads.downloadUnit(unitId, versionNo, {
        wifiOnly: true,
        includeGrownup: true,
      });
      refresh();
      setReload((value) => value + 1);
    } catch (cause) {
      setDownloadError(downloadMessage(cause));
    } finally {
      setDownloading(false);
    }
  }

  const alias =
    loaded.status === 'ready' || loaded.status === 'needs_grownup_pack'
      ? loaded.child.display_alias
      : '';
  const avatar =
    loaded.status === 'ready' || loaded.status === 'needs_grownup_pack'
      ? loaded.child.avatar
      : null;

  let body: ReactNode;
  if (loaded.status === 'loading') {
    body = (
      <Screen>
        <Body role="lead">Opening the lesson…</Body>
      </Screen>
    );
  } else if (loaded.status === 'error') {
    body = (
      <Screen>
        <ErrorText>{loaded.message}</ErrorText>
        <Body>Ask a grown-up to download the lesson again.</Body>
      </Screen>
    );
  } else if (loaded.status === 'needs_grownup_pack') {
    body = (
      <Screen>
        <Title>The grown-up pack is missing</Title>
        <Body>
          The lesson is on this phone but the helper script is not. Download the grown-up pack to
          start the helper session.
        </Body>
        {downloadError ? <ErrorText>{downloadError}</ErrorText> : null}
        <Button
          label="Download the grown-up pack"
          onPress={downloadGrownupPack}
          busy={downloading}
        />
      </Screen>
    );
  } else {
    body = (
      <ReadyHelper
        lesson={loaded.lesson}
        unit={loaded.unit}
        child={loaded.child}
        childId={childId}
        unitId={unitId}
        autoplayInitial={autoplay}
        onFinishRequest={() => setFinishing(true)}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.white }}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <HelperTopBar alias={alias || 'Helper'} avatar={avatar} onFinish={() => setFinishing(true)} />
      {/* The lesson stays mounted behind the PIN prompt, so nothing the child has done is lost. */}
      <View style={{ flex: 1, display: finishing ? 'none' : 'flex' }}>{body}</View>
      {finishing ? (
        <Screen>
          <PinPrompt
            title="Finish helper session"
            body="Enter the grown-up PIN to leave. Anything answered so far is saved."
            submitLabel="Finish and go to Grown-ups"
            onVerified={leave}
            onCancel={() => setFinishing(false)}
            cancelLabel="Keep going"
          />
        </Screen>
      ) : null}
    </View>
  );
}
