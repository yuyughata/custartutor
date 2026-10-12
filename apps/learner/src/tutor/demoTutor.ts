import { loadActiveUnit, getChild, listSubjects, getUnit, type Ports } from '@custar/learner-core';
import type { TutorApi, TutorStreamEvent } from '@custar/tutor-core/client';
import { createDemoTutorApi } from '@custar/tutor-core/fakes';
import type { TutorTurnInput } from '@custar/tutor-core/client';

/**
 * The in-memory stand-in for DEMO MODE: consent, sessions and transcripts live in memory, and a turn runs through
 * the real redaction, safety router and sanitiser of tutor-core with a scripted "model". Its replies start with
 * "Demo tutor (not Claude):" and the screens label every bubble, so it can never be mistaken for the real tutor.
 * This file is the only place the app imports `createDemoTutorApi`.
 */

/** Pause between streamed pieces, so the demo streams visibly instead of appearing all at once. */
const STREAM_STEP_MS = 45;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createDemoTutor(options: {
  ports: Pick<Ports, 'db' | 'files'>;
  appVersion: string;
  /** True while a grown-up PIN elevation is live (the demo's stand-in for the server's check). */
  isElevated: () => boolean;
}): TutorApi {
  const { ports, appVersion } = options;
  const profiles = new Map<string, TutorTurnInput['child']>();

  const inner = createDemoTutorApi({
    now: () => new Date(),
    elevated: options.isElevated,
    async getUnit(unitId) {
      try {
        const loaded = await loadActiveUnit(ports, appVersion, unitId);
        const row = await getUnit(ports.db, unitId);
        const subject = row
          ? (await listSubjects(ports.db)).find((candidate) => candidate.id === row.subject_id)
          : undefined;
        return { unit: loaded.unit, ...(subject ? { subject_name: subject.name } : {}) };
      } catch {
        return null; // the lesson is not downloaded on this phone
      }
    },
    // Only the alias ever reaches the (demo) pipeline, never anything else about the child.
    getChild: (childId) =>
      profiles.get(childId) ?? {
        alias: 'Friend',
        level_code: 'P1',
        stage: 'absorb',
        reading_mode: 'pre_reader',
      },
  });

  async function remember(childId: string, unitId: string): Promise<void> {
    const child = await getChild(ports.db, childId);
    if (!child) return;
    const stage = await loadActiveUnit(ports, appVersion, unitId)
      .then((loaded) => loaded.unit.header.stage)
      .catch(() => 'absorb' as const);
    profiles.set(childId, {
      alias: child.display_alias,
      level_code: child.level_code as TutorTurnInput['child']['level_code'],
      stage,
      reading_mode: child.reading_mode === 'pre_reader' ? 'pre_reader' : 'reader',
    });
  }

  return {
    ...inner,
    async sendTurn(request, onEvent, signal) {
      await remember(request.child_id, request.unit_id);
      // Run the whole turn, then play its events back a little at a time (the demo has no network to wait for).
      const events: TutorStreamEvent[] = [];
      const result = await inner.sendTurn(request, (event) => events.push(event), signal);
      for (const event of events) {
        if (signal?.aborted) {
          const aborted = new Error('Aborted');
          aborted.name = 'AbortError';
          throw aborted;
        }
        onEvent(event);
        if (event.type === 'delta' || event.type === 'meta') await sleep(STREAM_STEP_MS);
      }
      return result;
    },
  };
}
