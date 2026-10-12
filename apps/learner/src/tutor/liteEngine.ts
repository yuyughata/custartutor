import type { Question, TutorScript } from '@custar/content-schema';
import type { TutorLiteState, TutorLiteStep } from '@custar/tutor-core/client';

/**
 * What the Tutor Lite controller needs from the engine, so the controller and its tests do not depend on how
 * `@custar/tutor-core` spells its functions. The one adapter to the real engine is `lite.ts`.
 */
export interface LiteContext {
  script: TutorScript;
  /** The unit's questions, for nodes that grade a reply with a question. */
  questions: Record<string, Question>;
}

export interface LiteEngine {
  start(context: LiteContext): TutorLiteStep;
  reply(context: LiteContext, state: TutorLiteState, text: string): TutorLiteStep;
  hint(context: LiteContext, state: TutorLiteState): TutorLiteStep;
  skip(context: LiteContext, state: TutorLiteState): TutorLiteStep;
}
