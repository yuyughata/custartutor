import { gradeQuestion } from '@custar/content-schema';
import type { LessonUnit, QuestionResponse } from '@custar/content-schema';
import { UnknownQuestionError, UnknownSectionError } from './errors';
import { appendEvents } from './db/events';
import type { NewEvent } from './db/events';
import { gradeMasteryCheck, masteryQuestionIds } from './mastery';
import type { MasteryOutcome } from './mastery';
import type { Ports } from './ports';

/**
 * One child playing one lesson. Every action becomes an event written to `local_event` AND `outbox` in a
 * single transaction (see `appendEvents`), so progress survives a crash and reaches the server later.
 *
 * Rule 4 (CLAUDE.md): mastery is deterministic. The ONLY way to a `mastery_check_completed` event is
 * `submitMasteryCheck()`, which grades the stored responses with the offline grader. Answering practice
 * questions, finishing sections or tutor "evidence" never grants mastery.
 */

export interface LessonSessionOptions {
  /** The parsed lesson (from `DownloadManager.loadActiveUnit`). */
  unit: LessonUnit;
  /** The unit's database id (the pack's `unit_id`); progress is keyed by it, not by version. */
  unitId: string;
  /** The pack version being played; recorded on the mastery event. */
  versionNo: number;
  childId: string;
  ports: Pick<Ports, 'db' | 'random' | 'clock'>;
}

export interface AnswerOutcome {
  result: 'correct' | 'incorrect' | 'partial' | 'ungraded';
  /** 0 to 1, or null when the question is not graded here (draw, free_text, spoken). */
  score: number | null;
  /** 1 for the first answer to this question in this session. */
  attempt: number;
  /** Machine-readable reason from the grader (for example `wrong_option`). */
  reason: string;
}

export interface MasterySubmission extends MasteryOutcome {
  /** The pack version the check was taken on. */
  version_no: number;
}

export class LessonSession {
  private readonly unit: LessonUnit;
  private readonly unitId: string;
  private readonly versionNo: number;
  private readonly childId: string;
  private readonly ports: Pick<Ports, 'db' | 'random' | 'clock'>;

  private starting: Promise<void> | null = null;
  private readonly attempts = new Map<string, number>();
  private readonly responses = new Map<string, QuestionResponse>();
  private readonly completedSections = new Set<string>();
  private readonly masteryIds: ReadonlySet<string>;

  constructor(options: LessonSessionOptions) {
    this.unit = options.unit;
    this.unitId = options.unitId;
    this.versionNo = options.versionNo;
    this.childId = options.childId;
    this.ports = options.ports;
    this.masteryIds = new Set(masteryQuestionIds(options.unit));
  }

  private event<T extends NewEvent['event_type']>(
    type: T,
    payload: Extract<NewEvent, { event_type: T }>['payload'],
  ): NewEvent {
    return {
      child_id: this.childId,
      unit_id: this.unitId,
      occurred_at: new Date(this.ports.clock.now()).toISOString(),
      event_type: type,
      payload,
    } as NewEvent;
  }

  /** Emits `unit_started` the first time it is called in this session; later calls do nothing. */
  start(): Promise<void> {
    this.starting ??= appendEvents(this.ports, [this.event('unit_started', {})]).then(
      () => undefined,
      (error: unknown) => {
        this.starting = null; // let the caller retry
        throw error;
      },
    );
    return this.starting;
  }

  /**
   * Grades the child's response offline and records a `question_answered` event. The latest response to each
   * question is kept for `submitMasteryCheck`. Throws `UnknownQuestionError` for an id outside the unit.
   */
  async answer(questionId: string, response: QuestionResponse): Promise<AnswerOutcome> {
    const question = Object.hasOwn(this.unit.questions, questionId)
      ? this.unit.questions[questionId]
      : undefined;
    if (!question) throw new UnknownQuestionError(questionId);

    await this.start();
    const graded = gradeQuestion(question, response);
    const attempt = (this.attempts.get(questionId) ?? 0) + 1;
    const score = graded.result === 'ungraded' ? null : (graded.detail.score ?? 0);

    await appendEvents(this.ports, [
      this.event('question_answered', {
        question_id: questionId,
        result: graded.result,
        score,
        attempt,
      }),
    ]);
    this.attempts.set(questionId, attempt);
    this.responses.set(questionId, response);
    return { result: graded.result, score, attempt, reason: graded.detail.reason };
  }

  /** Records `section_completed` (once per section per session; returns false if it was already recorded). */
  async completeSection(sectionId: string): Promise<boolean> {
    if (!this.unit.sections.some((section) => section.id === sectionId)) {
      throw new UnknownSectionError(sectionId);
    }
    if (this.completedSections.has(sectionId)) return false;
    await this.start();
    this.completedSections.add(sectionId);
    try {
      await appendEvents(this.ports, [this.event('section_completed', { section_id: sectionId })]);
    } catch (error) {
      this.completedSections.delete(sectionId);
      throw error;
    }
    return true;
  }

  /**
   * Grades the stored responses to the mastery-check questions and records `mastery_check_completed`; when it
   * passes, `unit_completed` follows in the SAME transaction. Unanswered questions score 0. Afterwards the
   * mastery-check responses and attempt counters are cleared, so a retry after "Not yet" starts clean.
   */
  async submitMasteryCheck(): Promise<MasterySubmission> {
    await this.start();
    const stored: Record<string, QuestionResponse> = {};
    for (const [id, response] of this.responses) {
      if (this.masteryIds.has(id)) stored[id] = response;
    }
    const outcome = gradeMasteryCheck(this.unit, stored);

    const events: NewEvent[] = [
      this.event('mastery_check_completed', {
        score: outcome.score,
        passed: outcome.passed,
        question_count: outcome.question_count,
        version_no: this.versionNo,
      }),
    ];
    if (outcome.passed) events.push(this.event('unit_completed', {}));
    await appendEvents(this.ports, events);

    for (const id of this.masteryIds) {
      this.responses.delete(id);
      this.attempts.delete(id);
    }
    return { ...outcome, version_no: this.versionNo };
  }

  /** The ids of the questions that make up the mastery check, in order. */
  masteryQuestions(): string[] {
    return [...this.masteryIds];
  }

  /** True once every gradable mastery question has a stored response (the UI can enable "Check"). */
  masteryCheckReady(): boolean {
    const outcome = gradeMasteryCheck(this.unit, Object.fromEntries(this.responses));
    return outcome.items.length > 0 && outcome.items.every((item) => item.result !== 'missing');
  }
}
