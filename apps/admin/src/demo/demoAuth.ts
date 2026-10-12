// Demo sign-in: any email, the email code 123456, the authenticator code 654321, signed in as a super admin.
// Two shortcuts show the other states: an email containing "new" goes through authenticator ENROLMENT, and an
// email containing "visitor" ends at "This account is not an admin account". Nothing here talks to a server.
import type { AdminRole } from '../lib/roles';
import { AdminApiError } from '../api/errors';
import type { AdminAuth, AuthState } from '../api/types';

export const DEMO_EMAIL_CODE = '123456';
export const DEMO_TOTP_CODE = '654321';
export const DEMO_USER_ID = 'de0d0000-0000-4000-8000-00000000ad01';
export const DEMO_FACTOR_ID = 'demo-factor';

/** A recognisably fake QR code (an SVG data URI): a framed square that says DEMO, not a scannable code. */
const DEMO_QR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" fill="#ffffff"/>' +
      '<rect x="8" y="8" width="144" height="144" fill="none" stroke="#1f2a2a" stroke-width="4" stroke-dasharray="10 6"/>' +
      '<text x="80" y="76" font-family="monospace" font-size="20" font-weight="700" text-anchor="middle" fill="#1f2a2a">DEMO</text>' +
      '<text x="80" y="102" font-family="monospace" font-size="12" text-anchor="middle" fill="#1f2a2a">not a real QR</text>' +
      '</svg>',
  );

export interface DemoAuth {
  auth: AdminAuth;
  /** The signed-in role, or null while signed out. */
  role(): AdminRole | null;
  userId(): string;
}

export function createDemoAuth(initialRole: AdminRole = 'super_admin'): DemoAuth {
  let state: AuthState = { step: 'signed_out' };
  let role: AdminRole = initialRole;
  const listeners = new Set<(next: AuthState) => void>();

  const set = (next: AuthState): AuthState => {
    state = next;
    listeners.forEach((listener) => listener(next));
    return next;
  };

  const auth: AdminAuth = {
    async state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sendCode(email) {
      if (!email.includes('@')) {
        throw new AdminApiError('invalid', 'invalid_email', 'Enter a full email address.');
      }
    },
    async verifyCode(email, code) {
      if (code.trim() !== DEMO_EMAIL_CODE) {
        throw new AdminApiError(
          'invalid',
          'wrong_code',
          'That code is not right, or it has expired. Check it and try again.',
        );
      }
      const clean = email.trim();
      return set(
        clean.toLowerCase().includes('new')
          ? { step: 'mfa_enrol', email: clean }
          : { step: 'mfa_challenge', email: clean, factorId: DEMO_FACTOR_ID },
      );
    },
    async startEnrolment() {
      return {
        factorId: DEMO_FACTOR_ID,
        secret: 'DEMO-ONLY-NOT-A-SECRET',
        uri: 'otpauth://totp/CUSTAR%20demo?secret=DEMOONLY&issuer=CUSTAR',
        qrCode: DEMO_QR,
      };
    },
    async verifyTotp(_factorId, code) {
      if (code.trim() !== DEMO_TOTP_CODE) {
        throw new AdminApiError(
          'invalid',
          'wrong_totp',
          'That authenticator code is not right. Codes change every 30 seconds; try the new one.',
        );
      }
      const email = 'email' in state ? state.email : 'demo@example.com';
      return set(
        email.toLowerCase().includes('visitor')
          ? { step: 'not_admin', email }
          : { step: 'ready', email, userId: DEMO_USER_ID, role },
      );
    },
    async signOut() {
      set({ step: 'signed_out' });
    },
    setDemoRole(next) {
      role = next;
      if (state.step === 'ready') set({ ...state, role: next });
    },
  };

  return {
    auth,
    role: () => (state.step === 'ready' ? state.role : null),
    userId: () => DEMO_USER_ID,
  };
}
