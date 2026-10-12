import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { getUnit } from '@custar/learner-core';
import {
  TutorApiError,
  type TutorSessionSummary,
  type TutorTranscriptMessage,
} from '@custar/tutor-core/client';
import { layerColors, palette, radii, space, typeScale } from '@custar/design-tokens';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, Card, ErrorText } from '../ui';
import { failureMessage } from './consentMachine';
import { formatWhen, sessionLines, transcriptLines, type TranscriptLine } from './transcript';

function Line({ line, alias }: { line: TranscriptLine; alias: string }) {
  const child = line.role === 'child';
  return (
    <View style={{ alignItems: child ? 'flex-end' : 'flex-start' }}>
      <View
        style={{
          maxWidth: '92%',
          backgroundColor: line.withheld
            ? palette.placeholderBg
            : child
              ? palette.white
              : layerColors.CORE.tint,
          borderWidth: 2,
          borderColor: line.withheld ? palette.placeholderBorder : layerColors.CORE.bar,
          borderStyle: line.withheld ? 'dashed' : 'solid',
          borderRadius: radii.lg,
          padding: space[3],
          gap: space[1],
        }}
      >
        <Text style={{ ...typeScale.caption, fontWeight: '700', color: palette.muted }}>
          {child ? alias : 'Tutor'}
        </Text>
        <Text
          style={{ ...typeScale.body, color: line.withheld ? palette.muted : palette.ink }}
          selectable
        >
          {line.text}
        </Text>
        {line.note ? (
          <Text style={{ ...typeScale.label, color: palette.muted }}>{line.note}</Text>
        ) : null}
      </View>
    </View>
  );
}

function SessionItem({
  session,
  alias,
  load,
}: {
  session: ReturnType<typeof sessionLines>[number];
  alias: string;
  load: (id: string) => Promise<TutorTranscriptMessage[]>;
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (lines) return;
    setBusy(true);
    setProblem(null);
    try {
      setLines(transcriptLines(await load(session.id)));
    } catch (error) {
      setProblem(failureMessage(error instanceof TutorApiError ? error.code : 'internal'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={{ ...typeScale.bodyLarge, fontWeight: '700', color: palette.ink }}>
        {session.title}
      </Text>
      <Body muted>
        {formatWhen(session.startedAt)} · {session.turns}{' '}
        {session.turns === 1 ? 'message' : 'messages'}
      </Body>
      {session.hasWithheld ? (
        <Body muted>A CUSTAR reviewer is looking at part of this conversation.</Body>
      ) : null}
      <Button
        label={open ? 'Hide this conversation' : 'Read this conversation'}
        variant="secondary"
        busy={busy}
        onPress={toggle}
      />
      {open && problem ? <ErrorText>{problem}</ErrorText> : null}
      {open && lines ? (
        <View style={{ gap: space[2] }}>
          {lines.length === 0 ? <Body muted>Nothing was said.</Body> : null}
          {lines.map((line) => (
            <Line key={line.id} line={line} alias={alias} />
          ))}
        </View>
      ) : null}
    </Card>
  );
}

/** Read-only list of the child's tutor conversations. Needs a live grown-up elevation. No export, no delete. */
export function ConversationsCard({
  childId,
  alias,
  locked,
  refreshKey,
  onLapsed,
}: {
  childId: string;
  alias: string;
  /** No live elevation: nothing is loaded. */
  locked: boolean;
  refreshKey: number;
  onLapsed: () => void;
}) {
  const { runtime } = useRuntime();
  const [sessions, setSessions] = useState<ReturnType<typeof sessionLines> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const list: TutorSessionSummary[] = await runtime.tutor.listSessions(childId, 30);
      const titles = new Map<string, string | null>();
      for (const session of list) {
        if (!titles.has(session.unit_id)) {
          titles.set(
            session.unit_id,
            (await getUnit(runtime.ports.db, session.unit_id))?.title ?? null,
          );
        }
      }
      setSessions(sessionLines(list, (unitId) => titles.get(unitId) ?? null));
    } catch (error) {
      const code = error instanceof TutorApiError ? error.code : 'internal';
      if (code === 'elevation_required') onLapsed();
      setProblem(failureMessage(code));
    }
  }, [runtime, childId, onLapsed]);

  useEffect(() => {
    if (!locked) void load();
  }, [locked, load, refreshKey]);

  return (
    <View style={{ gap: space[3] }}>
      <Body role="lead">Conversations</Body>
      <Body muted>
        What {alias} and the tutor said. Messages are saved with names, phone numbers and addresses
        removed where we can find them.
      </Body>
      {locked ? <Body muted>Enter your PIN above to read conversations.</Body> : null}
      {problem ? <ErrorText>{problem}</ErrorText> : null}
      {!locked && sessions === null && !problem ? <Body muted>Loading…</Body> : null}
      {!locked && sessions !== null && sessions.length === 0 ? (
        <Body muted>No conversations yet.</Body>
      ) : null}
      {!locked
        ? sessions?.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              alias={alias}
              load={(id) => runtime.tutor.getTranscript(id)}
            />
          ))
        : null}
    </View>
  );
}
