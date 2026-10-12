import { describe, expect, it } from 'vitest';
import { CURRENT_TUTOR_CONSENT_VERSION, type TutorConsentState } from '@custar/tutor-core/client';
import {
  canTurnOff,
  canTurnOn,
  consentIsOn,
  consentIsStale,
  consentReducer,
  failureMessage,
  initialConsentState,
  wordingMismatch,
  type ConsentAction,
  type ConsentScreenState,
} from './consentMachine';

const V = CURRENT_TUTOR_CONSENT_VERSION;
const off: TutorConsentState = { granted: false, version: null, required_version: V };
const on: TutorConsentState = { granted: true, version: V, required_version: V };

function run(actions: ConsentAction[], from = initialConsentState): ConsentScreenState {
  return actions.reduce(consentReducer, from);
}

describe('consent screen state machine', () => {
  it('starts loading with the box NOT ticked', () => {
    expect(initialConsentState.load).toBe('loading');
    expect(initialConsentState.agreed).toBe(false);
    expect(canTurnOn(initialConsentState)).toBe(false);
  });

  it('needs the box before Turn on is possible, and the box can be un-ticked', () => {
    let state = run([{ type: 'loaded', consent: off }]);
    expect(canTurnOn(state)).toBe(false);
    state = run([{ type: 'toggleAgree' }], state);
    expect(state.agreed).toBe(true);
    expect(canTurnOn(state)).toBe(true);
    state = run([{ type: 'toggleAgree' }], state);
    expect(canTurnOn(state)).toBe(false);
  });

  it('cannot turn on while saving, or when it is already on', () => {
    const ticked = run([{ type: 'loaded', consent: off }, { type: 'toggleAgree' }]);
    expect(canTurnOn(run([{ type: 'saveStart', action: 'grant' }], ticked))).toBe(false);
    const alreadyOn = run([{ type: 'loaded', consent: on }, { type: 'toggleAgree' }]);
    expect(canTurnOn(alreadyOn)).toBe(false);
    expect(canTurnOff(alreadyOn)).toBe(true);
  });

  it('does not let the box change while a save is running', () => {
    const state = run([
      { type: 'loaded', consent: off },
      { type: 'toggleAgree' },
      { type: 'saveStart', action: 'grant' },
      { type: 'toggleAgree' },
    ]);
    expect(state.agreed).toBe(true);
  });

  it('a successful grant clears the box and says so; a withdraw says it is off', () => {
    const granted = run([
      { type: 'loaded', consent: off },
      { type: 'toggleAgree' },
      { type: 'saveStart', action: 'grant' },
      { type: 'saved', action: 'grant' },
    ]);
    expect(granted.agreed).toBe(false);
    expect(granted.saving).toBeNull();
    expect(granted.message).toEqual({ tone: 'good', text: 'The AI tutor is now on.' });

    const withdrawn = run(
      [
        { type: 'saveStart', action: 'withdraw' },
        { type: 'saved', action: 'withdraw' },
      ],
      granted,
    );
    expect(withdrawn.message?.text).toBe('The AI tutor is now off.');
  });

  it('a lapsed elevation asks for the PIN again and keeps the ticked box', () => {
    let state = run([
      { type: 'loaded', consent: off },
      { type: 'toggleAgree' },
      { type: 'saveStart', action: 'grant' },
      { type: 'saveFailed', code: 'elevation_required' },
    ]);
    expect(state.needsPin).toBe(true);
    expect(state.agreed).toBe(true);
    expect(state.saving).toBeNull();
    expect(state.message?.tone).toBe('problem');
    state = run([{ type: 'pinDone' }], state);
    expect(state.needsPin).toBe(false);
    expect(canTurnOn(state)).toBe(true);
  });

  it('explains an offline failure in plain words', () => {
    expect(failureMessage('offline')).toMatch(/internet/);
    const state = run([{ type: 'loadFailed', code: 'offline' }]);
    expect(state.load).toBe('failed');
    expect(state.loadFailure).toBe('offline');
    expect(canTurnOn(state)).toBe(false);
  });

  it('treats a granted but older wording as stale: the guardian must accept the new text', () => {
    const stale: TutorConsentState = { granted: true, version: 'tutor-v0', required_version: V };
    expect(consentIsOn(stale)).toBe(false);
    expect(consentIsStale(stale)).toBe(true);
    const state = run([{ type: 'loaded', consent: stale }, { type: 'toggleAgree' }]);
    expect(canTurnOn(state)).toBe(true);
    expect(canTurnOff(state)).toBe(true);
  });

  it('blocks Turn on when the server needs wording this app does not have', () => {
    const newer: TutorConsentState = {
      granted: false,
      version: null,
      required_version: 'tutor-v9',
    };
    expect(wordingMismatch(newer)).toBe(true);
    const state = run([{ type: 'loaded', consent: newer }, { type: 'toggleAgree' }]);
    expect(canTurnOn(state)).toBe(false);
    expect(wordingMismatch(off)).toBe(false);
  });
});
