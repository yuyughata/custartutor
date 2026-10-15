// "Edit by hand": a structured text editor for a unit, so everything Claude drafted can be revised by a person without
// touching raw JSON. Forms for every part of the unit (header, sections and blocks, questions with answer builders and a
// Try-it box that uses the real offline marker, tutor scripts, the session plan, the workbook, the teacher's manual and
// the helper script), live checks beside the fields, a preview exactly as the learner app renders it, undo and redo,
// a local autosave, and one save: "Save as new version", which creates a new HUMAN draft version based on the latest
// one. Nothing is ever edited in place, approved or published from here: a person reviews and approves afterwards.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Stage, UnitContent, UnitKind } from '@custar/content-schema';
import type { PublishedSnapshot, UnitContext, UnitVersionSummary } from '../api/types';
import { UnitPreview, type PreviewJump } from '../components/UnitPreview';
import { DiffView } from '../components/DiffView';
import { useAction } from '../hooks/useAction';
import { useLoad } from '../hooks/useLoad';
import { usePageTitle } from '../hooks/usePageTitle';
import { diffUnits } from '../lib/diff';
import { formatDateTime } from '../lib/format';
import { jumpTarget } from '../lib/lintPaths';
import { can, roleLabel, whyNot } from '../lib/roles';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { useUnsavedChanges } from '../runtime/UnsavedGuard';
import { focusField } from '../platform/focusField';
import {
  browserStorage,
  clearAutosave,
  readAutosave,
  sameContent,
  writeAutosave,
  type Autosaved,
} from '../editor/autosave';
import {
  createHistory,
  canRedo,
  canUndo,
  push,
  redo as redoHistory,
  undo as undoHistory,
  type History,
} from '../editor/history';
import { stampHeader, headerDrift, type HeaderContext } from '../editor/headerStamp';
import { TAB_LABELS, jumpPlan, tabForKind, tabsFor, type EditorTab } from '../editor/jump';
import { ownerOf } from '../editor/owners';
import { questionOptions, type Unit } from '../editor/ops';
import { getAt, pathKey, setAt, type Path } from '../editor/path';
import { allPublishedIds, publishedIdsOf } from '../editor/stableIds';
import { starterUnit } from '../editor/starter';
import { storedReportFor, validateUnit, type ValidationResult } from '../editor/validate';
import { ConflictPanel } from '../editor/ui/ConflictPanel';
import {
  EditorProviders,
  indexIssues,
  type DeleteRequest,
  type EditorActions,
  type EditorEnv,
} from '../editor/ui/context';
import { IssueSummary } from '../editor/ui/IssueSummary';
import { ManualEditor } from '../editor/ui/ManualEditor';
import { OverviewEditor } from '../editor/ui/OverviewEditor';
import { ProjectEditor } from '../editor/ui/ProjectEditor';
import { SessionPlanEditor } from '../editor/ui/SessionPlanEditor';
import { QuestionsTab, SectionsTab } from '../editor/ui/Tabs';
import { WorkbookEditor } from '../editor/ui/WorkbookEditor';
import { sectionsOutsidePlan } from '../editor/ops';
import { Badge, ContentStatusBadge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/Dialog';
import { PageHeader } from '../ui/PageHeader';
import { Async, ErrorState, Loading } from '../ui/States';
import { P, Small } from '../ui/Text';
import { colors, radii, space } from '../ui/theme';

type Rec = Record<string, unknown>;

const SPLIT_WIDTH = 1180;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timeOf(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// --- what the editor starts from ---------------------------------------------------------------------------------------

interface Seed {
  /** The latest version this editing session is based on; null for a unit that has none yet. */
  base: UnitVersionSummary | null;
  /** Its content (the baseline "unsaved changes" is measured against). */
  content: Unit;
  /** What to start with instead of the baseline (a combined result after a conflict). */
  startWith?: Unit;
  /** A message to show at the top (what just happened). */
  notice?: string;
}

function headerContextOf(context: UnitContext): HeaderContext {
  return {
    unit_no: context.unit.unit_no,
    week_no: context.unit.week_no,
    chapter: { number: context.chapter.number, title: context.chapter.title },
  };
}

function starterFor(context: UnitContext): Unit {
  return starterUnit({
    kind: context.unit.kind,
    title: context.unit.title,
    objective: context.unit.objective,
    stage: context.unit.stage,
    unit_no: context.unit.unit_no,
    week_no: context.unit.week_no,
    chapter: { number: context.chapter.number, title: context.chapter.title },
    subject_slug: context.subject.slug,
    level_code: context.scheme.level_code,
    term: context.scheme.term,
  }) as unknown as Unit;
}

// --- the tabs ----------------------------------------------------------------------------------------------------------

function TabBar({
  tabs,
  active,
  onPick,
  counts,
}: {
  tabs: EditorTab[];
  active: EditorTab;
  onPick: (tab: EditorTab) => void;
  counts: Record<string, { errors: number; warnings: number }>;
}): ReactNode {
  return (
    <View
      role="tablist"
      aria-label="Parts of the unit"
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}
    >
      {tabs.map((tab) => {
        const selected = tab === active;
        const c = counts[tab] ?? { errors: 0, warnings: 0 };
        return (
          <Pressable
            key={tab}
            role="tab"
            aria-selected={selected}
            accessibilityLabel={`${TAB_LABELS[tab]}${c.errors > 0 ? `, ${c.errors} errors` : ''}${c.warnings > 0 ? `, ${c.warnings} warnings` : ''}`}
            testID={`tab-${tab}`}
            onPress={() => onPick(tab)}
            style={{
              minHeight: 40,
              paddingHorizontal: space[3],
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[2],
              borderRadius: radii.md,
              borderWidth: 1.5,
              borderColor: selected ? colors.primary : colors.border,
              backgroundColor: selected ? colors.primary : colors.white,
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: '700',
                color: selected ? colors.white : colors.text,
              }}
            >
              {TAB_LABELS[tab]}
            </Text>
            {c.errors > 0 ? (
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '800',
                  color: selected ? colors.white : colors.danger,
                }}
              >
                ✕ {c.errors}
              </Text>
            ) : null}
            {c.warnings > 0 ? (
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '800',
                  color: selected ? colors.white : colors.amberText,
                }}
              >
                ⚠ {c.warnings}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// --- the editor ---------------------------------------------------------------------------------------------------------

function EditorBody({
  context,
  seed,
  snapshots,
  onReseed,
}: {
  context: UnitContext;
  seed: Seed;
  snapshots: PublishedSnapshot[];
  onReseed: (next: Seed) => void;
}): ReactNode {
  const api = useApi();
  const router = useRouter();
  const { role } = useSession();
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_WIDTH;
  const readOnly = !can(role, 'unit.edit');
  const unitId = context.unit.id;
  const kind: UnitKind = context.unit.kind;
  const baseId = seed.base?.id ?? 'none';
  const headerCtx = useMemo(() => headerContextOf(context), [context]);
  const published = useMemo(() => publishedIdsOf(snapshots), [snapshots]);
  const publishedTaken = useMemo(() => allPublishedIds(published), [published]);
  const options = useMemo(
    () => ({ snapshots, publishedIds: published, context: headerCtx }),
    [snapshots, published, headerCtx],
  );
  const storage = useMemo(() => browserStorage(), []);

  // The working copy and its undo history. The ref is the truth between renders, so two changes made in one event
  // (create something, then open it) both land.
  const [history, setHistoryState] = useState<History<Unit>>(() =>
    createHistory(seed.startWith ?? seed.content),
  );
  const historyRef = useRef(history);
  const setHistory = useCallback((next: History<Unit>): void => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);
  const present = history.present;
  const baseline = seed.content;
  const dirty = !Object.is(present, baseline);

  // The checks, a moment after the last keystroke.
  const [validation, setValidation] = useState<ValidationResult>(() =>
    validateUnit(present, options),
  );
  const validatedFor = useRef<Unit>(present);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (Object.is(validatedFor.current, present)) return undefined;
    setPending(true);
    const timer = setTimeout(() => {
      validatedFor.current = present;
      setValidation(validateUnit(present, options));
      setPending(false);
    }, 280);
    return () => clearTimeout(timer);
  }, [present, options]);

  const lastParsed = useRef<UnitContent | null>(validation.parsed);
  if (validation.parsed) lastParsed.current = validation.parsed;

  const issueIndex = useRef<
    ReadonlyMap<string, ReturnType<typeof indexIssues> extends Map<string, infer V> ? V : never>
  >(new Map());
  const issues = useMemo(() => {
    const next = indexIssues(validation.issues, issueIndex.current);
    issueIndex.current = next;
    return next;
  }, [validation.issues]);

  // Tabs, open cards, dialogs.
  const tabs = tabsFor(kind);
  const [tab, setTab] = useState<EditorTab>('overview');
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');
  const [openState, setOpenState] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [previewJump, setPreviewJump] = useState<PreviewJump | null>(null);
  const [announce, setAnnounce] = useState('');
  const [notice, setNotice] = useState(seed.notice ?? '');
  const [showChanges, setShowChanges] = useState(false);

  const openKeys = useCallback((keys: readonly string[]): void => {
    setOpenState((state) => {
      const next = new Map(state);
      for (const key of keys) next.set(key, true);
      return next;
    });
  }, []);

  const jump = useCallback(
    (path: Path): void => {
      const current = historyRef.current.present;
      const plan = jumpPlan(current, path);
      const target = tabForKind(kind, plan);
      setTab(target);
      setPane('edit');
      openKeys(plan.open);
      const owner = ownerOf(path);
      const candidates: string[] = [pathKey(path), pathKey(owner)];
      for (let n = owner.length - 1; n > 0; n -= 1) candidates.push(pathKey(owner.slice(0, n)));
      let tries = 0;
      const attempt = (): void => {
        if (focusField(candidates)) return;
        tries += 1;
        if (tries < 10) setTimeout(attempt, 80);
      };
      setTimeout(attempt, 40);
      const found = jumpTarget(pathKey(owner), current);
      if (found)
        setPreviewJump((previous) => ({ target: found, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [kind, openKeys],
  );

  const actions = useMemo<EditorActions>(
    () => ({
      current: () => historyRef.current.present,
      commit: (update, key) => {
        const next = push(historyRef.current, update(historyRef.current.present), {
          key: key ?? null,
        });
        if (next !== historyRef.current) setHistory(next);
      },
      setField: (path, value) => {
        const next = push(historyRef.current, setAt(historyRef.current.present, path, value), {
          key: pathKey(path),
        });
        if (next !== historyRef.current) setHistory(next);
      },
      confirmDelete: (request) => setDeleteRequest(request),
      jump,
      toggle: (key, defaultOpen) =>
        setOpenState((state) => {
          const next = new Map(state);
          next.set(key, !(state.get(key) ?? defaultOpen));
          return next;
        }),
      open: (key) => openKeys([key]),
    }),
    [jump, openKeys, setHistory],
  );

  const env = useMemo<EditorEnv>(
    () => ({
      readOnly,
      kind,
      stage: context.unit.stage,
      publishedTaken,
      published,
      header: headerCtx,
      weekEditable: context.unit.week_no === null && kind === 'lesson',
    }),
    [
      readOnly,
      kind,
      context.unit.stage,
      context.unit.week_no,
      publishedTaken,
      published,
      headerCtx,
    ],
  );

  // Undo and redo.
  const undo = useCallback((): void => {
    if (!canUndo(historyRef.current)) return;
    setHistory(undoHistory(historyRef.current));
    setAnnounce('Undone');
  }, [setHistory]);
  const redo = useCallback((): void => {
    if (!canRedo(historyRef.current)) return;
    setHistory(redoHistory(historyRef.current));
    setAnnounce('Redone');
  }, [setHistory]);

  // Autosave on this device, per (unit, base version).
  const [autosaved, setAutosaved] = useState<{ at: Date } | { problem: string } | null>(null);
  const [restorable, setRestorable] = useState<Autosaved | null>(() => {
    if (readOnly || seed.startWith) return null;
    const found = readAutosave(storage, unitId, baseId);
    return found && !sameContent(found.content, seed.content) ? found : null;
  });
  useEffect(() => {
    if (readOnly || restorable) return undefined;
    if (!dirty) {
      clearAutosave(storage, unitId, baseId);
      return undefined;
    }
    const timer = setTimeout(() => {
      const result = writeAutosave(storage, {
        savedAt: new Date().toISOString(),
        unitId,
        baseVersionId: baseId,
        content: present,
      });
      setAutosaved(result.ok ? { at: new Date() } : { problem: result.reason });
    }, 800);
    return () => clearTimeout(timer);
  }, [present, dirty, readOnly, restorable, storage, unitId, baseId]);

  useUnsavedChanges(dirty && !readOnly);

  // A newer version saved by someone else while this one is open.
  const [newer, setNewer] = useState<UnitVersionSummary | null>(null);
  const checkNewer = useCallback(async (): Promise<UnitVersionSummary | null> => {
    try {
      const list = await api.units.versions(unitId);
      const latest = list[0] ?? null;
      const found = latest && latest.id !== seed.base?.id ? latest : null;
      setNewer(found);
      return found;
    } catch {
      return null;
    }
  }, [api, unitId, seed.base?.id]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const onFocus = (): void => void checkNewer();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [checkNewer]);

  // The conflict screen.
  const [conflict, setConflict] = useState<{ newer: UnitVersionSummary; theirs: Unit } | null>(
    null,
  );
  const openConflict = useCallback(
    async (target: UnitVersionSummary): Promise<void> => {
      try {
        const full = await api.units.version(target.id);
        setConflict({ newer: target, theirs: full.content as unknown as Unit });
      } catch (cause) {
        setNotice(
          cause instanceof Error ? cause.message : 'The newer version could not be loaded.',
        );
      }
    },
    [api],
  );

  // Saving.
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = useAction(async () => {
    setSaveError(null);
    const stamped = stampHeader(historyRef.current.present as UnitContent, headerCtx) as Unit;
    const result = validateUnit(stamped, options);
    setValidation(result);
    validatedFor.current = historyRef.current.present;
    if (!result.canSave || !result.parsed) {
      setSaveError(
        `${result.errors} error${result.errors === 1 ? '' : 's'} must be fixed before this can be saved. They are listed under Checks.`,
      );
      return null;
    }
    try {
      const created = await api.units.saveHumanVersion({
        unitId,
        content: result.parsed as never,
        lintReport: storedReportFor(result),
        baseVersionId: seed.base?.id ?? null,
      });
      clearAutosave(storage, unitId, baseId);
      return created;
    } catch (cause) {
      if (
        typeof cause === 'object' &&
        cause !== null &&
        (cause as { code?: string }).code === 'stale_base'
      ) {
        const latest = await checkNewer();
        if (latest) {
          await openConflict(latest);
          return null;
        }
      }
      throw cause;
    }
  });
  const onSave = useCallback(async (): Promise<void> => {
    if (readOnly) return;
    const created = await save.run();
    if (created) {
      setAnnounce(`Saved as version ${created.version}`);
      router.replace({
        pathname: '/units/[unitId]',
        params: { unitId, saved: String(created.version) },
      } as never);
    }
  }, [readOnly, save, router, unitId]);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  // Keyboard: Ctrl/Cmd+Z, Shift+Z or Y, S.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || readOnly) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        event.preventDefault();
        redo();
      } else if (key === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, undo, redo]);

  const counts = useMemo(() => {
    const out: Record<string, { errors: number; warnings: number }> = {};
    for (const issue of validation.issues) {
      const where = tabForKind(kind, jumpPlan(present, issue.owner));
      const entry = out[where] ?? { errors: 0, warnings: 0 };
      if (issue.severity === 'error') entry.errors += 1;
      else entry.warnings += 1;
      out[where] = entry;
    }
    return out;
    // `present` only names sections for the lookup; the issues are what changes the counts.
  }, [validation.issues, kind]);

  const drift = useMemo(() => headerDrift(present as UnitContent, headerCtx), [present, headerCtx]);
  const stage: Stage =
    (getAt(present, ['header', 'stage']) as Stage | undefined) ?? context.unit.stage;
  const diff = useMemo(
    () => (showChanges ? diffUnits(baseline, present) : null),
    [showChanges, baseline, present],
  );

  usePageTitle(`Edit by hand: Unit ${context.unit.unit_no}`);

  // --- the body of the active tab ---
  const unitRec = present as unknown as Rec;
  const questions = useMemo(() => questionOptions(present), [unitRec.questions]);
  const sectionList = useMemo(
    () =>
      Array.isArray(unitRec.sections)
        ? (unitRec.sections as Rec[]).map((s) => ({
            id: String(s.id ?? ''),
            heading: String(s.heading ?? ''),
          }))
        : [],
    [unitRec.sections],
  );
  let panel: ReactNode = null;
  switch (tab) {
    case 'overview':
      panel = (
        <OverviewEditor
          header={isRec(unitRec.header) ? unitRec.header : {}}
          kind={kind}
          context={headerCtx}
          scoring={isRec(unitRec.scoring) ? unitRec.scoring : undefined}
        />
      );
      break;
    case 'project':
      panel = <ProjectEditor unit={unitRec} questions={questions} />;
      break;
    case 'sections':
      panel = <SectionsTab unit={present} kind={kind} stage={stage} />;
      break;
    case 'questions':
      panel = <QuestionsTab unit={present} />;
      break;
    case 'plan':
      panel = (
        <SessionPlanEditor
          plan={Array.isArray(unitRec.session_plan) ? (unitRec.session_plan as Rec[]) : []}
          sectionList={sectionList}
          outside={sectionsOutsidePlan(present)}
        />
      );
      break;
    case 'workbook':
      panel = (
        <WorkbookEditor
          workbook={isRec(unitRec.workbook) ? unitRec.workbook : {}}
          questions={questions}
        />
      );
      break;
    case 'manual':
      panel = (
        <ManualEditor
          manual={isRec(unitRec.teacher_manual) ? unitRec.teacher_manual : {}}
          sectionList={sectionList}
        />
      );
      break;
  }

  if (conflict) {
    return (
      <ConflictPanel
        base={baseline}
        mine={present}
        theirs={conflict.theirs}
        newer={conflict.newer}
        baseVersion={seed.base?.version ?? 0}
        onUseMerged={(merged) => {
          clearAutosave(storage, unitId, baseId);
          onReseed({
            base: conflict.newer,
            content: conflict.theirs,
            startWith: merged as unknown as Unit,
            notice: `Your changes are combined with version ${conflict.newer.version}. Check the result and save it as version ${conflict.newer.version + 1}.`,
          });
        }}
        onDiscardMine={() =>
          setDeleteRequest({
            title: 'Throw your changes away?',
            notes: [
              `Your edits since version ${seed.base?.version ?? 0} are discarded and the editor starts again from version ${conflict.newer.version}.`,
            ],
            confirmLabel: 'Throw my changes away',
            onConfirm: () => {
              clearAutosave(storage, unitId, baseId);
              onReseed({
                base: conflict.newer,
                content: conflict.theirs,
                notice: `Started again from version ${conflict.newer.version}.`,
              });
            },
          })
        }
        onBack={() => setConflict(null)}
      />
    );
  }

  const editor = (
    <View style={{ gap: space[3], minWidth: 0 }}>
      <IssueSummary
        issues={validation.issues}
        errors={validation.errors}
        warnings={validation.warnings}
        unit={present}
        onJump={jump}
        pending={pending}
      />
      <TabBar tabs={tabs} active={tab} onPick={(next) => setTab(next)} counts={counts} />
      <View
        role="tabpanel"
        aria-label={TAB_LABELS[tab]}
        style={{ gap: space[3] }}
        testID={`panel-${tab}`}
      >
        {panel}
      </View>
    </View>
  );

  const preview = (
    <View style={{ gap: space[2], minWidth: 0 }} testID="editor-preview">
      <Text
        style={{ fontSize: 15, fontWeight: '800', color: colors.text }}
        accessibilityRole="header"
      >
        Preview, as the learner app shows it
      </Text>
      {validation.parsed === null ? (
        <Banner
          tone="warning"
          title={
            lastParsed.current ? 'Showing the last preview that worked' : 'Nothing to preview yet'
          }
        >
          <Small>
            {lastParsed.current
              ? 'Your latest edits are not complete enough to display, so this is the last complete state. The checks list what is missing.'
              : 'The unit has to pass the format checks before it can be displayed. The checks list what is missing.'}
          </Small>
        </Banner>
      ) : null}
      {lastParsed.current ? (
        <UnitPreview
          versionId="working"
          unit={lastParsed.current}
          jump={previewJump}
          height={split ? 780 : 640}
        />
      ) : null}
    </View>
  );

  return (
    <EditorProviders actions={actions} env={env} issues={issues} openState={openState}>
      <View style={{ gap: space[3] }} testID="unit-editor">
        {/* Toolbar */}
        <View
          style={{
            gap: space[2],
            padding: space[3],
            borderRadius: radii.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.white,
            // Sticky while there is room; on a phone the toolbar would cover half the screen.
            ...(Platform.OS === 'web' && width >= 820
              ? ({ position: 'sticky', top: 0, zIndex: 20 } as object)
              : {}),
          }}
        >
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2], alignItems: 'center' }}
          >
            {!readOnly ? (
              <>
                <Button
                  label="Undo"
                  accessibilityLabel="Undo (Ctrl+Z)"
                  small
                  variant="secondary"
                  disabled={!canUndo(history)}
                  onPress={undo}
                  testID="undo"
                />
                <Button
                  label="Redo"
                  accessibilityLabel="Redo (Ctrl+Shift+Z)"
                  small
                  variant="secondary"
                  disabled={!canRedo(history)}
                  onPress={redo}
                  testID="redo"
                />
              </>
            ) : null}
            <Text
              style={{ fontSize: 13, color: colors.textSoft, flexShrink: 1 }}
              testID="save-state"
            >
              {readOnly ? 'Read only' : dirty ? 'Unsaved changes' : 'No changes yet'}
              {!readOnly && dirty
                ? autosaved
                  ? 'at' in autosaved
                    ? ` · kept on this device at ${timeOf(autosaved.at)}`
                    : ` · ${autosaved.problem}`
                  : ''
                : ''}
            </Text>
            <View style={{ flexGrow: 1 }} />
            {!readOnly ? (
              <>
                <Button
                  label={dirty ? 'Review my changes' : 'No changes to review'}
                  small
                  variant="secondary"
                  disabled={!dirty}
                  onPress={() => setShowChanges((v) => !v)}
                  testID="review-changes"
                />
                <Button
                  label="Save as new version"
                  onPress={() => void onSave()}
                  busy={save.busy}
                  disabled={!dirty || !validation.canSave || pending}
                  reason={
                    !dirty
                      ? 'Nothing has changed yet.'
                      : pending
                        ? 'Checking your latest edit…'
                        : !validation.canSave
                          ? `${validation.errors} error${validation.errors === 1 ? '' : 's'} to fix first (see Checks).`
                          : null
                  }
                  testID="save-version"
                />
              </>
            ) : null}
          </View>
          <Small>
            {seed.base
              ? `Editing the latest version, version ${seed.base.version}${seed.base.generated_by === 'ai' ? ' (drafted by Claude)' : ' (written by a person)'}. Saving creates version ${seed.base.version + 1} as a draft; nothing is published or approved from here.`
              : 'This unit has no version yet. Saving creates its first version as a draft; nothing is published or approved from here.'}
          </Small>
        </View>

        <Text
          role="status"
          aria-live="polite"
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}
          testID="live-region"
        >
          {announce}
        </Text>

        {readOnly ? (
          <Banner
            tone="info"
            title={`Read only: the ${roleLabel(role).toLowerCase()} role can read this editor but not change the unit`}
            testID="readonly-banner"
          >
            <P>
              {whyNot(role, 'unit.edit') ?? ''} You can still look at every field, the checks and
              the preview.
            </P>
          </Banner>
        ) : null}
        {notice ? (
          <Banner tone="info" title={notice} testID="editor-notice">
            <Button label="Dismiss" small variant="ghost" onPress={() => setNotice('')} />
          </Banner>
        ) : null}
        {restorable ? (
          <Banner
            tone="warning"
            title={`Unsaved work from ${formatDateTime(restorable.savedAt)} was found on this device`}
            testID="restore-prompt"
          >
            <P>
              It was written on top of version {seed.base?.version ?? 0} of this unit and was never
              saved. Restore it to carry on, or discard it to start from the saved version.
            </P>
            <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
              <Button
                label="Restore my work"
                testID="restore-yes"
                onPress={() => {
                  setHistory(createHistory(restorable.content as Unit));
                  setRestorable(null);
                  setAnnounce('Restored the unsaved work');
                }}
              />
              <Button
                label="Discard it"
                variant="secondary"
                testID="restore-no"
                onPress={() => {
                  clearAutosave(storage, unitId, baseId);
                  setRestorable(null);
                }}
              />
            </View>
          </Banner>
        ) : null}
        {newer && !readOnly ? (
          <Banner
            tone="warning"
            title={`Version ${newer.version} was saved while you were editing`}
            testID="newer-banner"
          >
            <P>
              You can keep editing. Saving will ask you to combine your changes with it first,
              because it would otherwise be overwritten. You can also do that now.
            </P>
            <Button
              label={`Combine with version ${newer.version} now`}
              small
              variant="secondary"
              onPress={() => void openConflict(newer)}
            />
          </Banner>
        ) : null}
        {drift.length > 0 && !readOnly ? (
          <Banner
            tone="info"
            title="The unit's place in the scheme has changed since this version was written"
            testID="drift-banner"
          >
            <P>
              {drift.map((d) => `${d.label}: ${d.have} → ${d.want}`).join('; ')}. Saving writes the
              current values into the header.
            </P>
          </Banner>
        ) : null}
        {saveError || save.error ? (
          <Banner tone="danger" title="This was not saved" testID="save-error">
            <P>{saveError ?? save.error?.message}</P>
          </Banner>
        ) : null}
        {diff ? (
          <Card>
            <DiffView
              diff={diff}
              fromLabel={`version ${seed.base?.version ?? 0}`}
              toLabel="your changes"
            />
          </Card>
        ) : null}

        {split ? (
          <View style={{ flexDirection: 'row', gap: space[4], alignItems: 'flex-start' }}>
            <View style={{ flex: 3, minWidth: 0 }}>{editor}</View>
            <View
              style={{
                flex: 2,
                minWidth: 0,
                ...(Platform.OS === 'web' ? ({ position: 'sticky', top: 150 } as object) : {}),
              }}
            >
              {preview}
            </View>
          </View>
        ) : (
          <>
            <View
              role="tablist"
              aria-label="Editor or preview"
              style={{ flexDirection: 'row', gap: space[2] }}
            >
              {(['edit', 'preview'] as const).map((which) => (
                <Pressable
                  key={which}
                  role="tab"
                  aria-selected={pane === which}
                  testID={`pane-${which}`}
                  onPress={() => setPane(which)}
                  style={{
                    flex: 1,
                    minHeight: 40,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radii.md,
                    borderWidth: 1.5,
                    borderColor: pane === which ? colors.primary : colors.border,
                    backgroundColor: pane === which ? colors.primary : colors.white,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '700',
                      color: pane === which ? colors.white : colors.text,
                    }}
                  >
                    {which === 'edit' ? 'Edit' : 'Preview'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {pane === 'edit' ? editor : preview}
          </>
        )}

        <ConfirmDialog
          visible={deleteRequest !== null}
          title={deleteRequest?.title ?? ''}
          confirmLabel={deleteRequest?.confirmLabel ?? 'Remove'}
          confirmVariant="danger"
          cancelLabel="Keep it"
          onConfirm={() => {
            const request = deleteRequest;
            setDeleteRequest(null);
            request?.onConfirm();
          }}
          onCancel={() => setDeleteRequest(null)}
        >
          <View style={{ gap: space[2] }}>
            {(deleteRequest?.notes ?? []).map((note, index) => (
              <P key={index}>{note}</P>
            ))}
            <Small>You can undo this with the Undo button.</Small>
          </View>
        </ConfirmDialog>
      </View>
    </EditorProviders>
  );
}

// --- loading --------------------------------------------------------------------------------------------------------------

function Session({
  context,
  versions,
  snapshots,
}: {
  context: UnitContext;
  versions: UnitVersionSummary[];
  snapshots: PublishedSnapshot[];
}): ReactNode {
  const api = useApi();
  const latest = versions[0] ?? null;
  const [override, setOverride] = useState<{ seed: Seed; key: number } | null>(null);
  // The skeleton of a unit with no version is made once: a new object on every render would look like an edit.
  const skeleton = useMemo<Seed | null>(
    () =>
      latest
        ? null
        : {
            base: null,
            content: starterFor(context),
            notice:
              'This unit has no version yet, so the editor starts from an empty skeleton: the structure is there and every text is blank, for you to write.',
          },
    [latest, context],
  );
  const content = useLoad(
    () => (latest && !override ? api.units.version(latest.id) : Promise.resolve(null)),
    [api, latest?.id, override],
  );

  if (override) {
    return (
      <EditorBody
        key={override.key}
        context={context}
        seed={override.seed}
        snapshots={snapshots}
        onReseed={(seed) => setOverride({ seed, key: override.key + 1 })}
      />
    );
  }
  if (!latest) {
    return skeleton ? (
      <EditorBody
        key="new"
        context={context}
        seed={skeleton}
        snapshots={snapshots}
        onReseed={(seed) => setOverride({ seed, key: 1 })}
      />
    ) : null;
  }
  if (content.error) return <ErrorState error={content.error} onRetry={content.reload} />;
  if (!content.data) return <Loading label="Loading the latest version…" />;
  if (!isRec(content.data.content)) {
    return (
      <Banner
        tone="danger"
        title="This version cannot be opened in the editor"
        testID="bad-content"
      >
        <P>
          Its content is not a unit (it is not an object). Draft it again with Claude, or ask for
          help.
        </P>
      </Banner>
    );
  }
  return (
    <EditorBody
      key={latest.id}
      context={context}
      seed={{ base: latest, content: content.data.content as unknown as Unit }}
      snapshots={snapshots}
      onReseed={(seed) => setOverride({ seed, key: 1 })}
    />
  );
}

export default function UnitEditorScreen(): ReactNode {
  const { unitId } = useLocalSearchParams<{ unitId: string }>();
  const api = useApi();
  const { recheckAuth } = useRuntime();
  const { role } = useSession();
  const context = useLoad(() => api.units.get(unitId), [api, unitId]);
  const versions = useLoad(() => api.units.versions(unitId), [api, unitId]);
  const snapshots = useLoad(() => api.units.publishedHistory(unitId), [api, unitId]);
  usePageTitle(context.data ? `Edit by hand: Unit ${context.data.unit.unit_no}` : 'Edit by hand');

  return (
    <Async
      state={context}
      loadingLabel="Loading the unit…"
      onSignInAgain={() => void recheckAuth()}
    >
      {(data) => (
        <View style={{ gap: space[4] }}>
          <PageHeader
            title={`Edit by hand: Unit ${data.unit.unit_no}, ${data.unit.title}`}
            subtitle={`Chapter ${data.chapter.number}: ${data.chapter.title}${data.unit.week_no ? ` · Week ${data.unit.week_no}` : ''}`}
            crumbs={[
              { label: 'Schemes', href: '/schemes' },
              {
                label: 'Chapters',
                href: {
                  pathname: '/schemes/[schemeId]/chapters',
                  params: { schemeId: data.scheme.id },
                },
              },
              {
                label: `Unit ${data.unit.unit_no}`,
                href: { pathname: '/units/[unitId]', params: { unitId: data.unit.id } },
              },
              { label: 'Edit by hand' },
            ]}
            badges={
              <>
                <ContentStatusBadge status={data.unit.status} />
                <Badge label={data.unit.kind.replace(/_/g, ' ')} tone="neutral" />
                {!can(role, 'unit.edit') ? <Badge label="Read only" tone="info" /> : null}
              </>
            }
          />
          <Async
            state={versions}
            loadingLabel="Loading versions…"
            onSignInAgain={() => void recheckAuth()}
          >
            {(list) => (
              <Async
                state={snapshots}
                loadingLabel="Loading the published history…"
                onSignInAgain={() => void recheckAuth()}
              >
                {(history) => (
                  <Session
                    key={`${data.unit.id}-${role}`}
                    context={data}
                    versions={list}
                    snapshots={history}
                  />
                )}
              </Async>
            )}
          </Async>
        </View>
      )}
    </Async>
  );
}
