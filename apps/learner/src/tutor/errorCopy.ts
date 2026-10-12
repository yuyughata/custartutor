import { TutorApiError } from '@custar/tutor-core/client';

/** Every way a tutor call can fail, reduced to what the screens need. Never carries a message from the server. */
export interface TutorFailure {
  code: TutorApiError['code'];
  retryable: boolean;
}

/** What the child sees for a failure. Calm words only: no codes, no technical text. */
export interface ErrorView {
  kind: 'consent' | 'unavailable' | 'limit' | 'offline' | 'retry' | 'generic';
  title: string;
  body: string;
  /** Show a "Try again" button (the retry first asks the server whether the turn already finished). */
  canRetry: boolean;
  /** Offer the offline tutor, which needs no internet and no consent. */
  offerLite: boolean;
}

/** `TutorApiError` carries a code; anything else is an unknown problem that is worth one more try. */
export function toFailure(error: unknown): TutorFailure {
  if (error instanceof TutorApiError) return { code: error.code, retryable: error.retryable };
  return { code: 'internal', retryable: true };
}

/** True when the failure means "talk to the offline tutor instead" (no session, no network). */
export function shouldFallBackToLite(failure: TutorFailure): boolean {
  return failure.code === 'offline' || failure.code === 'unauthenticated';
}

export function errorView(failure: TutorFailure): ErrorView {
  switch (failure.code) {
    case 'consent_required':
      return {
        kind: 'consent',
        title: 'Ask a grown-up to turn on the tutor',
        body: 'A grown-up can turn it on in the Grown-ups area. You can still practise with the offline tutor.',
        canRetry: false,
        offerLite: true,
      };
    case 'tutor_disabled':
    case 'kill_switch':
      // Both look the same to a child: the tutor is not available right now.
      return {
        kind: 'unavailable',
        title: 'The tutor is resting right now',
        body: 'You can still practise with the offline tutor.',
        canRetry: false,
        offerLite: true,
      };
    case 'daily_limit':
      return {
        kind: 'limit',
        title: 'That is enough tutor chat for today',
        body: 'Come back tomorrow. The offline tutor is still here if you want to practise.',
        canRetry: false,
        offerLite: true,
      };
    case 'offline':
    case 'unauthenticated':
      return {
        kind: 'offline',
        title: 'No internet right now',
        body: 'The offline tutor can still help you with this lesson.',
        canRetry: false,
        offerLite: true,
      };
    case 'unit_not_found':
      return {
        kind: 'unavailable',
        title: 'The tutor cannot help with this lesson yet',
        body: 'You can still practise with the offline tutor.',
        canRetry: false,
        offerLite: true,
      };
    case 'busy':
      return {
        kind: 'retry',
        title: 'One moment please',
        body: 'I am still thinking about your last message.',
        canRetry: true,
        offerLite: false,
      };
    case 'upstream':
    case 'internal':
    case 'forbidden':
    case 'invalid_request':
    case 'elevation_required':
      return {
        kind: failure.retryable ? 'retry' : 'generic',
        title: failure.retryable ? 'I lost the thread' : 'Something went wrong',
        body: failure.retryable
          ? 'That did not go through. Do you want to try again?'
          : 'The tutor cannot answer right now. Please try again later.',
        canRetry: failure.retryable,
        offerLite: !failure.retryable,
      };
  }
}
