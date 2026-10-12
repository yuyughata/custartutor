import type { TutorApi } from '@custar/tutor-core/client';
import { consentIsOn } from '../consent/consentMachine';
import { shouldFallBackToLite, toFailure } from './errorCopy';

/**
 * Which tutor the panel opens with:
 *  - `live`          online, consent is on: the AI tutor (the server also checks that it is enabled)
 *  - `needs_consent` online but a grown-up has not turned the tutor on: a gentle card, and Tutor Lite
 *  - `lite`          offline or the tutor cannot be reached: the scripted offline tutor
 */
export type TutorMode =
  | { kind: 'checking' }
  | { kind: 'live' }
  | { kind: 'needs_consent' }
  | { kind: 'lite'; reason: 'offline' | 'unavailable' };

export const CONSENT_CHECK_TIMEOUT_MS = 6000;

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('failed'));
      },
    );
  });
}

/** Decides the mode when the panel opens. Never throws; a slow or failing check means the offline tutor. */
export async function resolveTutorMode(options: {
  isOnline: () => Promise<boolean>;
  api: Pick<TutorApi, 'consent'>;
  childId: string;
  timeoutMs?: number;
}): Promise<TutorMode> {
  const online = await options.isOnline().catch(() => false);
  if (!online) return { kind: 'lite', reason: 'offline' };
  try {
    const consent = await timeout(
      options.api.consent(options.childId),
      options.timeoutMs ?? CONSENT_CHECK_TIMEOUT_MS,
    );
    return consentIsOn(consent) ? { kind: 'live' } : { kind: 'needs_consent' };
  } catch (error) {
    const failure = toFailure(error);
    return { kind: 'lite', reason: shouldFallBackToLite(failure) ? 'offline' : 'unavailable' };
  }
}
