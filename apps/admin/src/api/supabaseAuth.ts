// Live sign-in: email code (no sign-ups), then TOTP at aal2, then a check that the caller is in admin_users.
// Written against supabase-js `auth` and `auth.mfa`; tested with a fake client (supabaseAuth.test.ts). Not
// verifiable from the sandbox against the real project.
import type { SupabaseClient } from '@supabase/supabase-js';
import { AdminApiError, fromPostgrest, toAdminError } from './errors';
import { AdminUserRow, parseResponse } from './schemas';
import type { AdminAuth, AuthState, TotpEnrolment } from './types';

function authError(
  error: { message?: string; code?: string; status?: number },
  fallback: string,
): AdminApiError {
  const message = error.message ?? '';
  if (/invalid|expired|incorrect|token/i.test(message) && /otp|token|code/i.test(message)) {
    return new AdminApiError(
      'invalid',
      'wrong_code',
      'That code is not right, or it has expired. Check it and try again.',
      error.status,
      error,
    );
  }
  if (/signups? not allowed|user not found/i.test(message)) {
    return new AdminApiError(
      'forbidden',
      'no_such_user',
      'This email is not registered. Ask a super admin to add you first.',
      error.status,
      error,
    );
  }
  if (
    /rate limit|too many|only request this (?:after|once)/i.test(message) ||
    error.status === 429
  ) {
    return new AdminApiError(
      'unknown',
      'rate_limited',
      'Too many tries. Wait a minute and try again.',
      429,
      error,
    );
  }
  if (/failed to fetch|network/i.test(message)) return toAdminError(new Error(message));
  return new AdminApiError(
    'unknown',
    error.code ?? 'auth_error',
    `${fallback} ${message}`.trim(),
    error.status,
    error,
  );
}

export function createSupabaseAuth(supabase: SupabaseClient): AdminAuth {
  const listeners = new Set<(state: AuthState) => void>();

  async function evaluate(): Promise<AuthState> {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw authError(error, 'Could not read the session.');
    const session = data.session;
    if (!session) return { step: 'signed_out' };
    const email = session.user.email ?? '';

    const level = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (level.error) throw authError(level.error, 'Could not check the sign-in level.');
    if (level.data.currentLevel !== 'aal2') {
      const factors = await supabase.auth.mfa.listFactors();
      if (factors.error) throw authError(factors.error, 'Could not list authenticators.');
      const verified = factors.data.totp.find((factor) => factor.status === 'verified');
      return verified
        ? { step: 'mfa_challenge', email, factorId: verified.id }
        : { step: 'mfa_enrol', email };
    }

    const row = await supabase
      .from('admin_users')
      .select('role')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (row.error) throw fromPostgrest(row.error, 'Could not check your admin role.');
    if (!row.data) return { step: 'not_admin', email };
    const { role } = parseResponse(AdminUserRow, row.data, 'your admin role');
    return { step: 'ready', email, userId: session.user.id, role };
  }

  function publish(state: AuthState): AuthState {
    listeners.forEach((listener) => listener(state));
    return state;
  }

  // supabase-js warns against awaiting other client calls inside the auth callback, so hop out of it first.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
    setTimeout(() => {
      evaluate().then(publish, () => publish({ step: 'signed_out' }));
    }, 0);
  });

  return {
    state: evaluate,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sendCode(email) {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false },
      });
      if (error) throw authError(error, 'Could not send the code.');
    },
    async verifyCode(email, code) {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: 'email',
      });
      if (error) throw authError(error, 'Could not check the code.');
      return publish(await evaluate());
    },
    async startEnrolment(): Promise<TotpEnrolment> {
      // An abandoned enrolment leaves an unverified factor behind, and enrolling again with the same name fails.
      const existing = await supabase.auth.mfa.listFactors();
      if (existing.error) throw authError(existing.error, 'Could not list authenticators.');
      for (const factor of existing.data.all) {
        if (factor.factor_type === 'totp' && factor.status !== 'verified') {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'CUSTAR admin',
      });
      if (error) throw authError(error, 'Could not start authenticator setup.');
      return {
        factorId: data.id,
        secret: data.totp.secret,
        uri: data.totp.uri,
        qrCode: data.totp.qr_code,
      };
    },
    async verifyTotp(factorId, code) {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (error) {
        throw /invalid|incorrect|expired/i.test(error.message)
          ? new AdminApiError(
              'invalid',
              'wrong_totp',
              'That authenticator code is not right. Codes change every 30 seconds; try the new one.',
              error.status,
              error,
            )
          : authError(error, 'Could not check the authenticator code.');
      }
      return publish(await evaluate());
    },
    async signOut() {
      await supabase.auth.signOut();
      publish({ step: 'signed_out' });
    },
  };
}
