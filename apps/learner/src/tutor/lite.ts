import { hintLite, replyLite, skipLite, startLite } from '@custar/tutor-core/client';
import type { LiteEngine } from './liteEngine';

/**
 * The one adapter to the Tutor Lite engine of `@custar/tutor-core/client` (pure, deterministic, no model, no
 * network). Everything else in the app talks to `LiteEngine`.
 */
export const tutorLiteEngine: LiteEngine = {
  start: ({ script, questions }) => startLite(script, { questions }),
  reply: ({ script, questions }, state, text) => replyLite(state, text, { script, questions }),
  hint: ({ script, questions }, state) => hintLite(state, { script, questions }),
  skip: ({ script, questions }, state) => skipLite(state, { script, questions }),
};
