import { describe, expect, it } from 'vitest';
import { TUTOR_ERROR_CODES, TutorApiError } from '@custar/tutor-core/client';
import { errorView, shouldFallBackToLite, toFailure } from './errorCopy';

const ALL_CODES = [...TUTOR_ERROR_CODES, 'offline', 'elevation_required'] as const;

describe('errorView', () => {
  it('has calm copy for every error code, retryable or not', () => {
    for (const code of ALL_CODES) {
      for (const retryable of [true, false]) {
        const view = errorView({ code, retryable });
        const text = `${view.title} ${view.body}`;
        expect(view.title.length, code).toBeGreaterThan(5);
        expect(text, code).not.toMatch(
          /error|exception|stack|http|\b[45]\d\d\b|_|undefined|null|token|jwt/i,
        );
        expect(text.length, code).toBeLessThan(160);
      }
    }
  });

  it('asks for a grown-up when consent is missing, with no PIN and no retry', () => {
    const view = errorView({ code: 'consent_required', retryable: false });
    expect(view.title).toBe('Ask a grown-up to turn on the tutor');
    expect(view.canRetry).toBe(false);
    expect(view.offerLite).toBe(true);
    expect(`${view.title} ${view.body}`).not.toMatch(/pin/i);
  });

  it('uses the agreed words for the daily limit', () => {
    expect(errorView({ code: 'daily_limit', retryable: false }).title).toBe(
      'That is enough tutor chat for today',
    );
  });

  it('treats a disabled tutor and the kill switch the same way', () => {
    const a = errorView({ code: 'tutor_disabled', retryable: false });
    const b = errorView({ code: 'kill_switch', retryable: false });
    expect(a).toEqual(b);
    expect(a.offerLite).toBe(true);
  });

  it('offers a retry only when the failure is retryable', () => {
    expect(errorView({ code: 'upstream', retryable: true }).canRetry).toBe(true);
    expect(errorView({ code: 'upstream', retryable: false }).canRetry).toBe(false);
    expect(errorView({ code: 'busy', retryable: false }).canRetry).toBe(true);
  });
});

describe('toFailure / shouldFallBackToLite', () => {
  it('reads TutorApiError and ignores the message of anything else', () => {
    expect(toFailure(new TutorApiError('daily_limit', 'secret detail', false))).toEqual({
      code: 'daily_limit',
      retryable: false,
    });
    expect(toFailure(new Error('boom'))).toEqual({ code: 'internal', retryable: true });
    expect(toFailure('weird')).toEqual({ code: 'internal', retryable: true });
  });

  it('falls back to the offline tutor when there is no network or session', () => {
    expect(shouldFallBackToLite({ code: 'offline', retryable: true })).toBe(true);
    expect(shouldFallBackToLite({ code: 'unauthenticated', retryable: false })).toBe(true);
    expect(shouldFallBackToLite({ code: 'daily_limit', retryable: false })).toBe(false);
  });
});
