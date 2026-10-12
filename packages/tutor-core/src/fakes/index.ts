// Test doubles and demo backends. Platform neutral (no Node built-ins): usable in the learner app's demo mode.
export * from './scriptedTutorLlm';
export {
  DEMO_REPLY_PREFIX,
  DEMO_TUTOR_MODEL_ID,
  createDemoModerationLlm,
  createDemoTutorLlm,
  demoReplyText,
} from './demoTutor';
export { WITHHELD_PLACEHOLDER, createDemoTutorApi } from './demoTutorApi';
export type { DemoTutorApi, DemoTutorOptions, DemoUnit } from './demoTutorApi';
