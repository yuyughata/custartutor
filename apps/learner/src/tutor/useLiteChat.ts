import { useCallback, useEffect, useRef, useState } from 'react';
import type { Question } from '@custar/content-schema';
import type { SqlDriver } from '@custar/learner-core';
import { LITE_COPY } from './copy';
import type { LiteEngine } from './liteEngine';
import { LiteSession, type LiteView } from './liteSession';
import type { LiteTarget } from './sections';

export interface LiteItem {
  id: string;
  role: 'tutor' | 'child' | 'note';
  text: string;
}

export interface LiteChatState {
  target: LiteTarget | null;
  items: LiteItem[];
  expecting: boolean;
  finished: boolean;
  choices: string[] | null;
  busy: boolean;
}

const empty: LiteChatState = {
  target: null,
  items: [],
  expecting: false,
  finished: false,
  choices: null,
  busy: false,
};

export interface UseLiteChat {
  state: LiteChatState;
  /** Opens a part: resumes the saved place, or starts it. */
  choose(target: LiteTarget): void;
  reply(text: string): boolean;
  hint(): void;
  skip(): void;
  restart(): void;
  /** Back to the "Which part?" list. The saved place stays. */
  change(): void;
}

/**
 * Tutor Lite for one lesson visit. The saved place (engine state) is in SQLite; the words on screen are in
 * memory only, so what the child typed is never kept.
 */
export function useLiteChat(options: {
  engine: LiteEngine;
  db: SqlDriver;
  now: () => number;
  newId: () => string;
  childId: string;
  unitId: string;
  questions: Record<string, Question>;
}): UseLiteChat {
  const { engine, db, now, newId, childId, unitId, questions } = options;
  const [state, setState] = useState<LiteChatState>(empty);
  const session = useRef<LiteSession | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback(
    (view: LiteView, extra: LiteItem[] = []) => {
      if (!alive.current) return;
      setState((current) => ({
        ...current,
        busy: false,
        expecting: view.expecting,
        finished: view.finished,
        choices: view.choices,
        items: [
          ...current.items,
          ...extra,
          ...view.lines.map((line) => ({
            id: newId(),
            role: 'tutor' as const,
            text: line.kind === 'hint' ? `Hint: ${line.text}` : line.text,
          })),
          ...(view.finished && view.lines.length === 0
            ? [{ id: newId(), role: 'note' as const, text: LITE_COPY.finished }]
            : []),
        ],
      }));
    },
    [newId],
  );

  const run = useCallback(
    (action: () => Promise<LiteView>, extra: LiteItem[] = []) => {
      setState((current) => ({ ...current, busy: true }));
      void action()
        .then((view) => apply(view, extra))
        .catch(() => {
          if (alive.current) setState((current) => ({ ...current, busy: false }));
        });
    },
    [apply],
  );

  const choose = useCallback(
    (target: LiteTarget) => {
      session.current = new LiteSession({
        engine,
        db,
        now,
        childId,
        unitId,
        sectionId: target.sectionId,
        script: target.script,
        questions,
      });
      setState({ ...empty, target, busy: true });
      const current = session.current;
      void current
        .open()
        .then((view) =>
          apply(
            view,
            view.resumed ? [{ id: newId(), role: 'note', text: LITE_COPY.welcomeBack }] : [],
          ),
        )
        .catch(() => {
          if (alive.current) setState((value) => ({ ...value, busy: false }));
        });
    },
    [engine, db, now, childId, unitId, questions, apply, newId],
  );

  const reply = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      const live = session.current;
      if (!live || text.length === 0 || stateRef.current.busy || !stateRef.current.expecting) {
        return false;
      }
      const bubble: LiteItem = { id: newId(), role: 'child', text };
      setState((current) => ({ ...current, items: [...current.items, bubble] }));
      run(() => live.reply(text));
      return true;
    },
    [run, newId],
  );

  const hint = useCallback(() => {
    const live = session.current;
    if (live && !stateRef.current.busy) run(() => live.hint());
  }, [run]);

  const skip = useCallback(() => {
    const live = session.current;
    if (live && !stateRef.current.busy) run(() => live.skip());
  }, [run]);

  const restart = useCallback(() => {
    const live = session.current;
    if (!live || stateRef.current.busy) return;
    setState((current) => ({ ...current, items: [], busy: true }));
    void live
      .restart()
      .then((view) => apply(view))
      .catch(() => {
        if (alive.current) setState((current) => ({ ...current, busy: false }));
      });
  }, [apply]);

  const change = useCallback(() => {
    session.current = null;
    setState(empty);
  }, []);

  return { state, choose, reply, hint, skip, restart, change };
}
