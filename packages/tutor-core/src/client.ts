// The client-safe entry point: only what the learner app (and the admin app) may import. No model code, no
// pipeline, no prompts, no classifier or patterns, nothing that pulls the content engine into a phone bundle.
// clientBoundary.test.ts walks the import graph from this file and fails if it reaches any of them.
export * from './contract';
export * from './voice';
export {
  LITE_WRAP_TEXT,
  MAX_REPLY_CHARS,
  hintLite,
  initialLiteState,
  replyLite,
  skipLite,
  startLite,
} from './lite/engine';
export type { TutorLiteContext, TutorLiteOptions } from './lite/engine';
export {
  DEFAULT_MAX_EVENT_CHARS,
  SSE_KEEP_ALIVE,
  createSseParser,
  encodeSseComment,
  encodeSseEvent,
} from './stream/sse';
export type { SseParser, SseParserOptions } from './stream/sse';
