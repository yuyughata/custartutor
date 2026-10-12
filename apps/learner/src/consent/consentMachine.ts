import {
  CURRENT_TUTOR_CONSENT_VERSION,
  type TutorApiError,
  type TutorConsentState,
} from '@custar/tutor-core/client';

/**
 * The state of the "AI tutor for this child" card in the grown-ups area, as a pure reducer.
 * The rules it enforces: the box is never pre-ticked, "Turn on" needs the box, and nothing is switched on
 * against a wording the guardian was not shown (the app's version must be the one the server requires).
 */

export type ConsentFailureCode = TutorApiError['code'];

export interface ConsentMessage {
  tone: 'good' | 'problem';
  text: string;
}

export interface ConsentScreenState {
  load: 'loading' | 'ready' | 'failed';
  loadFailure: ConsentFailureCode | null;
  consent: TutorConsentState | null;
  /** The required checkbox. Starts false; never pre-ticked. */
  agreed: boolean;
  saving: 'grant' | 'withdraw' | null;
  message: ConsentMessage | null;
  /** The elevation lapsed during an action: the screen asks for the PIN again. */
  needsPin: boolean;
}

export const initialConsentState: ConsentScreenState = {
  load: 'loading',
  loadFailure: null,
  consent: null,
  agreed: false,
  saving: null,
  message: null,
  needsPin: false,
};

export type ConsentAction =
  | { type: 'load' }
  | { type: 'loaded'; consent: TutorConsentState }
  | { type: 'loadFailed'; code: ConsentFailureCode }
  | { type: 'toggleAgree' }
  | { type: 'saveStart'; action: 'grant' | 'withdraw' }
  | { type: 'saved'; action: 'grant' | 'withdraw' }
  | { type: 'saveFailed'; code: ConsentFailureCode }
  | { type: 'pinDone' }
  | { type: 'dismiss' };

export function failureMessage(code: ConsentFailureCode): string {
  switch (code) {
    case 'offline':
      return 'You need the internet to do this. Please connect and try again.';
    case 'elevation_required':
      return 'Please enter your grown-up PIN again.';
    case 'forbidden':
      return 'This account cannot change the tutor for this child.';
    case 'unauthenticated':
      return 'Please sign in again to do this.';
    default:
      return 'That did not work. Please try again.';
  }
}

export function consentReducer(
  state: ConsentScreenState,
  action: ConsentAction,
): ConsentScreenState {
  switch (action.type) {
    case 'load':
      return { ...state, load: 'loading', loadFailure: null };
    case 'loaded':
      return { ...state, load: 'ready', loadFailure: null, consent: action.consent };
    case 'loadFailed':
      return { ...state, load: 'failed', loadFailure: action.code };
    case 'toggleAgree':
      return state.saving ? state : { ...state, agreed: !state.agreed };
    case 'saveStart':
      return { ...state, saving: action.action, message: null };
    case 'saved':
      return {
        ...state,
        saving: null,
        agreed: false,
        needsPin: false,
        message:
          action.action === 'grant'
            ? { tone: 'good', text: 'The AI tutor is now on.' }
            : { tone: 'good', text: 'The AI tutor is now off.' },
      };
    case 'saveFailed':
      return {
        ...state,
        saving: null,
        needsPin: action.code === 'elevation_required' ? true : state.needsPin,
        message: { tone: 'problem', text: failureMessage(action.code) },
      };
    case 'pinDone':
      return { ...state, needsPin: false, message: null };
    case 'dismiss':
      return { ...state, message: null };
  }
}

/** Consent is on for the wording the server requires. */
export function consentIsOn(consent: TutorConsentState | null): boolean {
  return consent !== null && consent.granted && consent.version === consent.required_version;
}

/** Granted once, but for older wording: the guardian must read and accept the new text. */
export function consentIsStale(consent: TutorConsentState | null): boolean {
  return consent !== null && consent.granted && consent.version !== consent.required_version;
}

/** The server needs wording this build of the app does not have. Turning on is blocked until the app updates. */
export function wordingMismatch(consent: TutorConsentState | null): boolean {
  return consent !== null && consent.required_version !== CURRENT_TUTOR_CONSENT_VERSION;
}

export function canTurnOn(state: ConsentScreenState): boolean {
  return (
    state.load === 'ready' &&
    state.agreed &&
    state.saving === null &&
    !consentIsOn(state.consent) &&
    !wordingMismatch(state.consent)
  );
}

export function canTurnOff(state: ConsentScreenState): boolean {
  return (
    state.load === 'ready' &&
    state.saving === null &&
    (consentIsOn(state.consent) || consentIsStale(state.consent))
  );
}
