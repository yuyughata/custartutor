import {
  deleteTutorLiteState,
  getTutorLiteState,
  saveTutorLiteState,
  type TutorLiteKey,
} from '@custar/learner-core';
import type { SqlDriver } from '@custar/learner-core';
import type { Question, TutorScript } from '@custar/content-schema';
import type { TutorLiteLine, TutorLiteState, TutorLiteStep } from '@custar/tutor-core/client';
import type { LiteEngine } from './liteEngine';

/**
 * Tutor Lite for one part of one lesson: runs the pure engine, saves the engine's state after every step so a
 * restart resumes, and describes each step for the screen.
 *
 * It NEVER changes mastery and never writes progress events (mastery stays with the lesson's mastery check).
 * What the child types goes to the engine and no further: only the engine's own state is saved.
 */

export interface LiteView {
  /** The tutor's new lines, in order. */
  lines: TutorLiteLine[];
  /** The child must reply before the script goes on. */
  expecting: boolean;
  finished: boolean;
  /** The grading of the reply that led here (feedback only; it grants nothing). */
  graded: { correct: boolean } | null;
  /** True when this view re-presents the saved place instead of starting. */
  resumed: boolean;
  /** Answer options of the question being asked, when it is a multiple-choice one. */
  choices: string[] | null;
}

export interface LiteSessionDeps {
  engine: LiteEngine;
  db: SqlDriver;
  now(): number;
  childId: string;
  unitId: string;
  sectionId: string;
  script: TutorScript;
  questions: Record<string, Question>;
}

/** Parses and checks saved state against the script; anything odd (an older pack, damage) returns null. */
export function parseLiteState(json: string, script: TutorScript): TutorLiteState | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const nodeId = record.node_id;
  if (nodeId !== null && typeof nodeId !== 'string') return null;
  if (typeof nodeId === 'string' && !script.nodes.some((node) => node.id === nodeId)) return null;
  if (typeof record.attempts !== 'number' || typeof record.hints_used !== 'number') return null;
  if (typeof record.finished !== 'boolean') return null;
  const cursors = record.cursors;
  if (typeof cursors !== 'object' || cursors === null || Array.isArray(cursors)) return null;
  for (const entry of Object.values(cursors)) if (typeof entry !== 'number') return null;
  return {
    node_id: nodeId,
    attempts: record.attempts,
    hints_used: record.hints_used,
    cursors: { ...(cursors as Record<string, number>) },
    finished: record.finished,
  };
}

export class LiteSession {
  private state: TutorLiteState | null = null;
  private readonly key: TutorLiteKey;

  constructor(private readonly deps: LiteSessionDeps) {
    this.key = { childId: deps.childId, unitId: deps.unitId, sectionId: deps.sectionId };
  }

  private get context() {
    return { script: this.deps.script, questions: this.deps.questions };
  }

  /** Loads the saved place (and shows it again), or starts the script. */
  async open(): Promise<LiteView> {
    const row = await getTutorLiteState(this.deps.db, this.key).catch(() => null);
    const saved = row ? parseLiteState(row.state_json, this.deps.script) : null;
    if (!saved) return this.begin();
    this.state = saved;
    if (saved.finished) {
      return {
        lines: [],
        expecting: false,
        finished: true,
        graded: null,
        resumed: true,
        choices: null,
      };
    }
    const node = this.deps.script.nodes.find((candidate) => candidate.id === saved.node_id);
    if (!node) return this.begin();
    return {
      lines: [{ node_id: node.id, text: node.say, kind: 'say' }],
      expecting: node.expect !== undefined,
      finished: false,
      graded: null,
      resumed: true,
      choices: this.choicesFor(saved),
    };
  }

  /** Clears the saved place and starts the script again. */
  async restart(): Promise<LiteView> {
    await deleteTutorLiteState(this.deps.db, this.key).catch(() => undefined);
    return this.begin();
  }

  async reply(text: string): Promise<LiteView> {
    return this.advance((state) => this.deps.engine.reply(this.context, state, text));
  }

  async hint(): Promise<LiteView> {
    return this.advance((state) => this.deps.engine.hint(this.context, state));
  }

  async skip(): Promise<LiteView> {
    return this.advance((state) => this.deps.engine.skip(this.context, state));
  }

  private async begin(): Promise<LiteView> {
    const step = this.deps.engine.start(this.context);
    return this.settle(step, false);
  }

  private async advance(run: (state: TutorLiteState) => TutorLiteStep): Promise<LiteView> {
    const state = this.state;
    if (!state) return this.begin();
    return this.settle(run(state), false);
  }

  private async settle(step: TutorLiteStep, resumed: boolean): Promise<LiteView> {
    this.state = step.state;
    try {
      await saveTutorLiteState(this.deps.db, this.key, JSON.stringify(step.state), this.deps.now());
    } catch {
      // The place could not be saved; the conversation goes on and starts over after a restart.
    }
    return {
      lines: step.lines,
      expecting: step.expecting,
      finished: step.state.finished,
      graded: step.graded,
      resumed,
      choices: step.expecting ? this.choicesFor(step.state) : null,
    };
  }

  /** The options of the question being asked, when it is multiple choice (so a child can tap an answer). */
  private choicesFor(state: TutorLiteState): string[] | null {
    const node = this.deps.script.nodes.find((candidate) => candidate.id === state.node_id);
    const questionId = node?.expect?.question_id;
    if (!questionId) return null;
    const question = this.deps.questions[questionId];
    return question?.kind === 'mcq' ? [...question.options] : null;
  }
}
