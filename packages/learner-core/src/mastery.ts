import { gradeQuestion, isDeterministic, questionsOf, sectionsOf } from '@custar/content-schema';
import type { GradeOutcome, QuestionResponse, UnitContent } from '@custar/content-schema';
import type { UnitProgressStatus, WireEvent } from './wire';

/**
 * DETERMINISTIC mastery (CLAUDE.md rule 4). Only the graded `mastery_check` can make a unit mastered; tutor
 * "evidence" is advisory and never reaches this file.
 *
 *  - `gradeMasteryCheck`: scores a child's responses to the mastery-check questions of a unit.
 *  - `deriveUnitProgress`: the same fold the server runs over events (pure, commutative, idempotent).
 *  - `effectiveProgress`: what the UI shows: server row merged with events not yet synced.
 *  - `unlockStates`: mastery-gated pacing, which units are open.
 */

/** A unit is mastered when the mastery-check score reaches this fraction (brief section 11). */
export const MASTERY_THRESHOLD = 0.8;

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

// ---------------------------------------------------------------------------------------------
// Grading the mastery check
// ---------------------------------------------------------------------------------------------

export interface MasteryItem {
  question_id: string;
  /** `missing` when the child gave no response (counts as 0). */
  result: GradeOutcome | 'missing';
  /** 0 to 1. */
  score: number;
}

export interface MasteryOutcome {
  /** 0 to 1, rounded to 4 decimals. */
  score: number;
  /** `question_count > 0 && score >= MASTERY_THRESHOLD`. */
  passed: boolean;
  /** How many gradable (deterministic) questions the score is out of. */
  question_count: number;
  /** One entry per gradable question, in unit order. */
  items: MasteryItem[];
  /** Mastery-check questions that are not scored (draw, free_text, spoken). */
  unscored_question_ids: string[];
}

/** Question ids placed by `question` blocks in `mastery_check` sections, in order, without repeats. */
export function masteryQuestionIds(unit: UnitContent): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const section of sectionsOf(unit)) {
    if (section.type !== 'mastery_check') continue;
    for (const block of section.blocks) {
      if (block.type === 'question' && !seen.has(block.question_id)) {
        seen.add(block.question_id);
        ids.push(block.question_id);
      }
    }
  }
  return ids;
}

/**
 * Grades the mastery check.
 *
 * The check is every `question` block inside a `mastery_check` section. Open-ended kinds (draw, free_text,
 * spoken) are not scored and not counted. Every deterministic question counts: a missing response, or one
 * of the wrong kind, scores 0, so skipping a question can never help. A partially right answer counts its
 * fraction. A check with no gradable question can never pass.
 */
export function gradeMasteryCheck(
  unit: UnitContent,
  responses: Readonly<Record<string, QuestionResponse>>,
): MasteryOutcome {
  const questions = questionsOf(unit);
  const items: MasteryItem[] = [];
  const unscored: string[] = [];

  for (const id of masteryQuestionIds(unit)) {
    const question = Object.hasOwn(questions, id) ? questions[id] : undefined;
    if (!question) continue; // a dangling reference is a content error caught by lint
    if (!isDeterministic(question)) {
      unscored.push(id);
      continue;
    }
    const response = Object.hasOwn(responses, id) ? responses[id] : undefined;
    if (!response) {
      items.push({ question_id: id, result: 'missing', score: 0 });
      continue;
    }
    const graded = gradeQuestion(question, response);
    const score =
      graded.result === 'correct'
        ? 1
        : graded.result === 'partial'
          ? Math.min(1, Math.max(0, graded.detail.score ?? 0))
          : 0;
    items.push({ question_id: id, result: graded.result, score });
  }

  const total = items.reduce((sum, item) => sum + item.score, 0);
  const score = items.length === 0 ? 0 : round4(total / items.length);
  return {
    score,
    passed: items.length > 0 && score >= MASTERY_THRESHOLD,
    question_count: items.length,
    items,
    unscored_question_ids: unscored,
  };
}

// ---------------------------------------------------------------------------------------------
// Deriving progress from events
// ---------------------------------------------------------------------------------------------

/** The part of a wire event that progress depends on. */
type Slim<T extends WireEvent> = T extends WireEvent
  ? Pick<T, 'client_event_id' | 'event_type' | 'occurred_at' | 'payload'>
  : never;
export type ProgressEvent = Slim<WireEvent>;

export interface DerivedProgress {
  /** Derivation only produces these two; `locked`/`available` come from `unlockStates`. */
  status: 'in_progress' | 'mastered';
  /** Best mastery-check score, or null when no check was taken. */
  mastery_score: number | null;
  /** Number of distinct `mastery_check_completed` events. */
  attempts: number;
  /** Section of the newest `section_completed` event. */
  last_section: string | null;
  /** `occurred_at` of the newest event. */
  updated_at: string;
}

function instant(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Orders by time, then by id, so ties break the same way whatever order the events arrived in. */
function newer(a: ProgressEvent, b: ProgressEvent): boolean {
  const ta = instant(a.occurred_at);
  const tb = instant(b.occurred_at);
  if (ta !== tb) return ta > tb;
  if (a.client_event_id !== b.client_event_id) return a.client_event_id > b.client_event_id;
  return a.occurred_at > b.occurred_at;
}

/**
 * Derives one child's progress on ONE unit from that unit's events. Mirrors the server function exactly:
 *
 *  - duplicates (same `client_event_id`) count once;
 *  - `mastered` iff any `mastery_check_completed` has `passed = true`; otherwise `in_progress`;
 *  - `attempts` = distinct `mastery_check_completed` events; `mastery_score` = best score;
 *  - `last_section` = `section_id` of the newest `section_completed`;
 *  - the result does not depend on the order of `events` (commutative) and re-applying the same events
 *    changes nothing (idempotent). No events means no progress: returns null.
 *
 * Nothing here can lower a status: more events can only move `in_progress` to `mastered`.
 */
export function deriveUnitProgress(events: readonly ProgressEvent[]): DerivedProgress | null {
  // Dedupe by id. If two different events share an id (a bug or an attack) keep the greater JSON, so the
  // choice does not depend on arrival order either.
  const unique = new Map<string, ProgressEvent>();
  for (const event of events) {
    const known = unique.get(event.client_event_id);
    if (!known || JSON.stringify(event) > JSON.stringify(known)) {
      unique.set(event.client_event_id, event);
    }
  }
  if (unique.size === 0) return null;

  let mastered = false;
  let attempts = 0;
  let best: number | null = null;
  let lastSection: ProgressEvent | null = null;
  let latest: ProgressEvent | null = null;

  for (const event of unique.values()) {
    if (latest === null || newer(event, latest)) latest = event;
    if (event.event_type === 'mastery_check_completed') {
      attempts += 1;
      if (event.payload.passed) mastered = true;
      best = best === null ? event.payload.score : Math.max(best, event.payload.score);
    } else if (event.event_type === 'section_completed') {
      if (lastSection === null || newer(event, lastSection)) lastSection = event;
    }
  }

  return {
    status: mastered ? 'mastered' : 'in_progress',
    mastery_score: best,
    attempts,
    last_section:
      lastSection && lastSection.event_type === 'section_completed'
        ? lastSection.payload.section_id
        : null,
    updated_at: latest ? latest.occurred_at : '',
  };
}

// ---------------------------------------------------------------------------------------------
// Effective progress (server row + unsynced local events)
// ---------------------------------------------------------------------------------------------

/** The server-derived row, as stored locally (`unit_progress`). */
export interface ServerProgress {
  status: UnitProgressStatus;
  mastery_score: number | null;
  attempts: number;
  last_section: string | null;
  updated_at: string;
}

export interface EffectiveProgress extends ServerProgress {
  /** True when unsynced local events contributed (the UI may show a small "saving" hint). */
  has_pending: boolean;
}

const STATUS_RANK: Record<UnitProgressStatus, number> = {
  locked: 0,
  available: 1,
  in_progress: 2,
  mastered: 3,
};

function maxScore(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * What the child sees: the server-derived row merged with events that are still in the outbox.
 *
 *  - The server is authoritative for what it already knows; pending events are by definition not in its
 *    numbers yet, so attempts add up and the best score wins.
 *  - Status takes the higher rank: `mastered` is terminal and is never downgraded, whichever side holds
 *    it. A pending passing check shows as mastered at once, even offline, but it only became real when
 *    the server derives it; `has_pending` tells the UI.
 *  - `last_section` prefers the pending (newer) value.
 * Returns null when neither side has anything.
 */
export function effectiveProgress(
  server: ServerProgress | null,
  pendingLocalEvents: readonly ProgressEvent[],
): EffectiveProgress | null {
  const local = deriveUnitProgress(pendingLocalEvents);
  if (!server && !local) return null;
  if (!local) return server ? { ...server, has_pending: false } : null;
  if (!server) return { ...local, has_pending: true };

  const status =
    STATUS_RANK[local.status] > STATUS_RANK[server.status] ? local.status : server.status;
  return {
    status,
    mastery_score: maxScore(server.mastery_score, local.mastery_score),
    attempts: server.attempts + local.attempts,
    last_section: local.last_section ?? server.last_section,
    updated_at:
      instant(local.updated_at) > instant(server.updated_at) ? local.updated_at : server.updated_at,
    has_pending: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Mastery-gated pacing
// ---------------------------------------------------------------------------------------------

export interface OrderableUnit {
  level_code: string;
  term: number;
  chapter_number: number;
  unit_no: number;
}

/** Teaching order inside one subject: level, term, chapter, unit. */
export function compareUnitOrder(a: OrderableUnit, b: OrderableUnit): number {
  return (
    a.level_code.localeCompare(b.level_code) ||
    a.term - b.term ||
    a.chapter_number - b.chapter_number ||
    a.unit_no - b.unit_no
  );
}

export interface GatedUnit {
  id: string;
  /** `lesson`, `mini_project`, `term_project`, `revision` or `assessment`. */
  kind: string;
}

/**
 * Mastery-gated pacing (brief section 11). `orderedUnits` is ONE chain, normally the units of one subject at
 * the child's level in teaching order (sort with `compareUnitOrder`). Result per unit id:
 *
 *  - a unit with progress keeps it (`in_progress` / `mastered`); the gate never takes access away;
 *  - otherwise it is `available` iff there is no earlier lesson in the chain (it is the first teaching unit)
 *    or the nearest earlier LESSON is `mastered`; else `locked`.
 *
 * Only lessons gate: they have a graded mastery check. Revision, assessment and project units follow the
 * same rule to OPEN (they unlock once the previous lesson is mastered) but they never gate the next unit,
 * since they have no mastery check and could otherwise never be mastered. Server-sent `locked`/`available`
 * values are ignored: this function is the single source of truth for them.
 */
export function unlockStates(
  orderedUnits: readonly GatedUnit[],
  progressByUnit: ReadonlyMap<string, { status: UnitProgressStatus }>,
): Map<string, UnitProgressStatus> {
  const states = new Map<string, UnitProgressStatus>();
  let gate: string | null = null; // id of the nearest earlier lesson

  for (const unit of orderedUnits) {
    const own = progressByUnit.get(unit.id)?.status;
    if (own === 'mastered' || own === 'in_progress') {
      states.set(unit.id, own);
    } else {
      const open = gate === null || states.get(gate) === 'mastered';
      states.set(unit.id, open ? 'available' : 'locked');
    }
    if (unit.kind === 'lesson') gate = unit.id;
  }
  return states;
}
