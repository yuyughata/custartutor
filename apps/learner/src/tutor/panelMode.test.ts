import { describe, expect, it } from 'vitest';
import { CURRENT_TUTOR_CONSENT_VERSION as V, TutorApiError } from '@custar/tutor-core/client';
import { resolveTutorMode } from './panelMode';
import { CHILD, fakeTutorApi } from './testkit';

const online = () => Promise.resolve(true);

describe('resolveTutorMode', () => {
  it('goes to the offline tutor when the phone is offline, without asking the server', async () => {
    const api = fakeTutorApi();
    const consent = api.consent;
    let asked = 0;
    api.consent = (id) => {
      asked += 1;
      return consent(id);
    };
    expect(
      await resolveTutorMode({ isOnline: () => Promise.resolve(false), api, childId: CHILD }),
    ).toEqual({
      kind: 'lite',
      reason: 'offline',
    });
    expect(asked).toBe(0);
  });

  it('uses the live tutor when consent is on for the required wording', async () => {
    const api = fakeTutorApi({ consent: { granted: true, version: V, required_version: V } });
    expect(await resolveTutorMode({ isOnline: online, api, childId: CHILD })).toEqual({
      kind: 'live',
    });
  });

  it('asks for a grown-up when consent is off or for older wording', async () => {
    for (const consent of [
      { granted: false, version: null, required_version: V },
      { granted: true, version: 'tutor-v0', required_version: V },
    ]) {
      const api = fakeTutorApi({ consent });
      expect(await resolveTutorMode({ isOnline: online, api, childId: CHILD })).toEqual({
        kind: 'needs_consent',
      });
    }
  });

  it('falls back to the offline tutor when the server cannot be reached or there is no session', async () => {
    for (const code of ['offline', 'unauthenticated'] as const) {
      const api = fakeTutorApi();
      api.consent = () => Promise.reject(new TutorApiError(code));
      expect(await resolveTutorMode({ isOnline: online, api, childId: CHILD })).toEqual({
        kind: 'lite',
        reason: 'offline',
      });
    }
  });

  it('treats any other failure, and a check that hangs, as "tutor unavailable"', async () => {
    const broken = fakeTutorApi();
    broken.consent = () => Promise.reject(new Error('boom'));
    expect(await resolveTutorMode({ isOnline: online, api: broken, childId: CHILD })).toEqual({
      kind: 'lite',
      reason: 'unavailable',
    });
    const hanging = fakeTutorApi();
    hanging.consent = () => new Promise(() => undefined);
    expect(
      await resolveTutorMode({ isOnline: online, api: hanging, childId: CHILD, timeoutMs: 20 }),
    ).toEqual({ kind: 'lite', reason: 'unavailable' });
  });

  it('survives a network check that throws', async () => {
    const api = fakeTutorApi();
    expect(
      await resolveTutorMode({
        isOnline: () => Promise.reject(new Error('x')),
        api,
        childId: CHILD,
      }),
    ).toEqual({ kind: 'lite', reason: 'offline' });
  });
});
