import { createDemoTutorApi } from '@custar/tutor-core/fakes';
import type { TutorApi } from '@custar/tutor-core/client';

/** The in-memory stand-in for demo mode. Every reply it makes is labelled "Demo tutor: not Claude" by the UI. */
export function createDemoTutor(options: { isElevated: () => boolean }): TutorApi {
  return createDemoTutorApi(options);
}
