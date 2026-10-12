import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UnitContent } from '@custar/content-schema';
import { getChild, type LocalChild } from '@custar/learner-core';
import {
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  typeScale,
} from '@custar/design-tokens';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Button } from '../ui';
import { LiteChatView } from './LiteChatView';
import { LiveChat } from './LiveChat';
import { LITE_COPY, TUTOR_COPY } from './copy';
import { tutorLiteEngine } from './lite';
import { resolveTutorMode, type TutorMode } from './panelMode';
import { defaultLiteTarget, liteQuestions, liteTargets, positionFor } from './sections';
import { useLiteChat } from './useLiteChat';
import { useReadAloud } from './useReadAloud';
import { useTutorChat } from './useTutorChat';

const teal = layerColors.CORE;

function Notice({ children, tone }: { children: ReactNode; tone: 'plain' | 'demo' }) {
  return (
    <View
      style={{
        paddingHorizontal: space[4],
        paddingVertical: space[2],
        backgroundColor: tone === 'demo' ? layerColors.ENRICH.tint : teal.tint,
        borderBottomWidth: 1,
        borderBottomColor: palette.placeholderBorder,
      }}
    >
      <Text style={{ ...typeScale.label, color: tone === 'demo' ? palette.enrichDark : teal.text }}>
        {children}
      </Text>
    </View>
  );
}

/**
 * "Ask my tutor": a button on the lesson screen and the sheet it opens. Owns the chat state of this lesson
 * visit (in memory only), so closing the sheet to look at the lesson does not lose the conversation.
 */
export function TutorLauncher({
  childId,
  unitId,
  versionNo,
  unit,
  lastQuestionId,
  helperPresent = false,
}: {
  childId: string;
  unitId: string;
  versionNo: number;
  unit: UnitContent;
  /** The last question the child answered in the lesson, if any (where the tutor thinks the child is). */
  lastQuestionId: string | null;
  helperPresent?: boolean;
}) {
  const { runtime } = useRuntime();
  const insets = useSafeAreaInsets();
  const voice = useReadAloud();
  const [open, setOpen] = useState(false);
  const [child, setChild] = useState<LocalChild | null>(null);
  const [mode, setMode] = useState<TutorMode>({ kind: 'checking' });
  const [forceLite, setForceLite] = useState(false);
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    let alive = true;
    void getChild(runtime.ports.db, childId).then((row) => alive && setChild(row));
    return () => {
      alive = false;
    };
  }, [runtime, childId]);

  const newId = useCallback(() => runtime.ports.random.uuid(), [runtime]);
  const questions = useMemo(() => liteQuestions(unit), [unit]);
  const targets = useMemo(() => liteTargets(unit), [unit]);
  const lastQuestion = useRef(lastQuestionId);
  lastQuestion.current = lastQuestionId;

  const chat = useTutorChat({
    api: runtime.tutor,
    newId,
    target: () => {
      const position = positionFor(unit, lastQuestion.current);
      return {
        childId,
        unitId,
        versionNo,
        sectionId: position.sectionId,
        questionId: position.questionId,
        helperPresent,
      };
    },
  });
  const lite = useLiteChat({
    engine: tutorLiteEngine,
    db: runtime.ports.db,
    now: () => runtime.ports.clock.now(),
    newId,
    childId,
    unitId,
    questions,
  });

  // Each time the sheet opens, decide which tutor to offer.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setMode({ kind: 'checking' });
    void resolveTutorMode({
      isOnline: () => runtime.network.isOnline(),
      api: runtime.tutor,
      childId,
    }).then((resolved) => alive && setMode(resolved));
    return () => {
      alive = false;
    };
  }, [open, recheck, runtime, childId]);

  const inLite = mode.kind === 'lite' || (forceLite && mode.kind !== 'checking');

  // In the offline tutor, start straight away on the part the child was last working on, if it has a script.
  const chooseLite = lite.choose;
  const hasTarget = lite.state.target !== null;
  useEffect(() => {
    if (!open || !inLite || hasTarget) return;
    const preferred = defaultLiteTarget(unit, lastQuestion.current);
    if (preferred) chooseLite(preferred);
    else if (targets.length === 1 && targets[0]) chooseLite(targets[0]);
  }, [open, inLite, hasTarget, unit, targets, chooseLite]);

  const close = () => {
    voice.stop();
    setOpen(false);
    setForceLite(false);
  };

  const demo = runtime.mode === 'demo';
  const preReader = child?.reading_mode === 'pre_reader';
  const controls = runtime.demoControls;

  return (
    <>
      <Button label={TUTOR_COPY.entryButton} variant="secondary" onPress={() => setOpen(true)} />
      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1, backgroundColor: palette.white, paddingTop: insets.top }}
        >
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
              {TUTOR_COPY.panelTitle}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close the tutor"
              onPress={close}
              style={{
                minHeight: minTouchTarget,
                minWidth: minTouchTarget,
                paddingHorizontal: space[4],
                borderRadius: radii.pill,
                borderWidth: 2,
                borderColor: teal.bar,
                justifyContent: 'center',
                backgroundColor: palette.white,
              }}
            >
              <Text style={{ color: teal.text, fontSize: 18, fontWeight: '700' }}>
                {TUTOR_COPY.close}
              </Text>
            </Pressable>
          </View>
          {inLite ? (
            <Notice tone="plain">{LITE_COPY.notice}</Notice>
          ) : (
            <Notice tone="plain">{TUTOR_COPY.notice}</Notice>
          )}
          {demo ? <Notice tone="demo">{TUTOR_COPY.demoNotice}</Notice> : null}
          {controls ? (
            <View style={{ paddingHorizontal: space[4], paddingTop: space[2] }}>
              <Button
                label={
                  controls.isOnline()
                    ? 'Demo only: pretend the internet is off'
                    : 'Demo only: pretend the internet is back'
                }
                variant="ghost"
                onPress={() => {
                  controls.setOnline(!controls.isOnline());
                  setForceLite(false);
                  setRecheck((value) => value + 1);
                }}
              />
            </View>
          ) : null}

          <View style={{ flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
            {mode.kind === 'checking' ? (
              <View style={{ padding: space[5] }}>
                <Text style={{ ...typeScale.bodyLarge, color: palette.muted }}>
                  {TUTOR_COPY.checking}
                </Text>
              </View>
            ) : inLite ? (
              <LiteChatView lite={lite} targets={targets} preReader={preReader} voice={voice} />
            ) : mode.kind === 'needs_consent' ? (
              <View style={{ padding: space[4], gap: space[3] }}>
                <Text style={{ ...typeScale.bodyLarge, fontWeight: '700' }}>
                  Ask a grown-up to turn on the tutor
                </Text>
                <Text style={typeScale.body}>
                  A grown-up can turn it on in the Grown-ups area. You can still practise with the
                  offline tutor.
                </Text>
                <Button
                  label={TUTOR_COPY.litePractice}
                  variant="secondary"
                  onPress={() => setForceLite(true)}
                />
              </View>
            ) : (
              <LiveChat
                chat={chat}
                unit={unit}
                preReader={preReader}
                demo={demo}
                voice={voice}
                onUseLite={() => setForceLite(true)}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
