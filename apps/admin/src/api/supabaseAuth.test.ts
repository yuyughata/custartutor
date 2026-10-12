import { describe, expect, it } from 'vitest';
import { isAdminApiError, type AdminApiError } from './errors';
import { createSupabaseAuth } from './supabaseAuth';
import { FakeSupabase } from './testing/fakeSupabase';

function setup() {
  const supabase = new FakeSupabase();
  const auth = createSupabaseAuth(supabase.asClient());
  return { supabase, auth };
}

async function caught(promise: Promise<unknown>): Promise<AdminApiError> {
  try {
    await promise;
  } catch (error) {
    if (isAdminApiError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('email code', () => {
  it('sends the code without creating users', async () => {
    const { supabase, auth } = setup();
    await auth.sendCode(' admin@example.com ');
    expect(supabase.authCalls).toEqual([
      { method: 'signInWithOtp', args: { email: 'admin@example.com', options: { shouldCreateUser: false } } },
    ]);
  });

  it('says so when the email is not registered', async () => {
    const { supabase, auth } = setup();
    supabase.authState.errors.signInWithOtp = { message: 'Signups not allowed for otp', status: 422 };
    const error = await caught(auth.sendCode('stranger@example.com'));
    expect(error).toMatchObject({ code: 'no_such_user', kind: 'forbidden' });
    expect(error.message).toMatch(/not registered/);
  });

  it('verifies the code with type email', async () => {
    const { supabase, auth } = setup();
    supabase.authState.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    supabase.authState.factors = [{ id: 'f1', factor_type: 'totp', status: 'verified' }];
    const state = await auth.verifyCode('admin@example.com', ' 123456 ');
    expect(supabase.authCalls[0]).toEqual({
      method: 'verifyOtp',
      args: { email: 'admin@example.com', token: '123456', type: 'email' },
    });
    expect(state).toEqual({ step: 'mfa_challenge', email: 'admin@example.com', factorId: 'f1' });
  });

  it('explains a wrong or expired code and rate limiting', async () => {
    const { supabase, auth } = setup();
    supabase.authState.errors.verifyOtp = { message: 'Token has expired or is invalid', status: 403 };
    expect(await caught(auth.verifyCode('a@b.c', '000000'))).toMatchObject({ code: 'wrong_code', kind: 'invalid' });
    supabase.authState.errors.signInWithOtp = {
      message: 'For security purposes, you can only request this after 49 seconds.',
      status: 429,
    };
    expect(await caught(auth.sendCode('a@b.c'))).toMatchObject({ code: 'rate_limited' });
  });
});

describe('where the sign-in has got to', () => {
  it('is signed out without a session', async () => {
    const { supabase, auth } = setup();
    supabase.authState.session = null;
    expect(await auth.state()).toEqual({ step: 'signed_out' });
  });

  it('asks for the authenticator code when a verified TOTP factor exists', async () => {
    const { supabase, auth } = setup();
    supabase.authState.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    supabase.authState.factors = [
      { id: 'old', factor_type: 'totp', status: 'unverified' },
      { id: 'f1', factor_type: 'totp', status: 'verified' },
    ];
    expect(await auth.state()).toEqual({ step: 'mfa_challenge', email: 'admin@example.com', factorId: 'f1' });
  });

  it('offers enrolment when there is no verified factor', async () => {
    const { supabase, auth } = setup();
    supabase.authState.aal = { currentLevel: 'aal1', nextLevel: 'aal1' };
    expect(await auth.state()).toEqual({ step: 'mfa_enrol', email: 'admin@example.com' });
  });

  it('checks admin_users after aal2 and refuses an account that is not in it', async () => {
    const { supabase, auth } = setup();
    supabase.onTable('admin_users', { data: null });
    expect(await auth.state()).toEqual({ step: 'not_admin', email: 'admin@example.com' });
    const query = supabase.queries[0]!;
    expect(query.table).toBe('admin_users');
    expect(query.select).toBe('role');
    expect(query.filters).toEqual([{ op: 'eq', column: 'user_id', value: 'user-1' }]);
  });

  it('is ready with the role from admin_users', async () => {
    const { supabase, auth } = setup();
    supabase.onTable('admin_users', { data: { role: 'reviewer' } });
    expect(await auth.state()).toEqual({
      step: 'ready',
      email: 'admin@example.com',
      userId: 'user-1',
      role: 'reviewer',
    });
  });

  it('rejects an unknown role instead of guessing', async () => {
    const { supabase, auth } = setup();
    supabase.onTable('admin_users', { data: { role: 'owner' } });
    expect((await caught(auth.state())).kind).toBe('bad_response');
  });

  it('never reads admin_users before aal2 (every admin policy needs it)', async () => {
    const { supabase, auth } = setup();
    supabase.authState.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    supabase.authState.factors = [{ id: 'f1', factor_type: 'totp', status: 'verified' }];
    await auth.state();
    expect(supabase.queries).toEqual([]);
  });
});

describe('authenticator', () => {
  it('removes unverified factors, then enrols a TOTP factor and returns the secret and QR code', async () => {
    const { supabase, auth } = setup();
    supabase.authState.factors = [
      { id: 'stale', factor_type: 'totp', status: 'unverified' },
      { id: 'keep', factor_type: 'totp', status: 'verified' },
    ];
    const enrolment = await auth.startEnrolment();
    expect(supabase.unenrolled).toEqual(['stale']);
    expect(supabase.authCalls).toEqual([
      { method: 'mfa.enroll', args: { factorType: 'totp', friendlyName: 'CUSTAR admin' } },
    ]);
    expect(enrolment).toEqual({
      factorId: 'factor-new',
      secret: 'JBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/x',
      qrCode: 'data:image/svg+xml;utf-8,<svg/>',
    });
  });

  it('challenges and verifies the code, then reaches ready at aal2', async () => {
    const { supabase, auth } = setup();
    supabase.authState.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    supabase.onTable('admin_users', { data: { role: 'super_admin' } });
    const seen: string[] = [];
    auth.subscribe((state) => seen.push(state.step));
    const state = await auth.verifyTotp('f1', ' 654321 ');
    expect(supabase.authCalls[0]).toEqual({
      method: 'mfa.challengeAndVerify',
      args: { factorId: 'f1', code: '654321' },
    });
    expect(state.step).toBe('ready');
    expect(seen).toEqual(['ready']);
  });

  it('explains a wrong authenticator code', async () => {
    const { supabase, auth } = setup();
    supabase.authState.errors['mfa.challengeAndVerify'] = { message: 'Invalid TOTP code entered', status: 400 };
    const error = await caught(auth.verifyTotp('f1', '000000'));
    expect(error).toMatchObject({ code: 'wrong_totp', kind: 'invalid' });
    expect(error.message).toMatch(/change every 30 seconds/);
  });
});

describe('signing out and session changes', () => {
  it('signs out and tells listeners', async () => {
    const { supabase, auth } = setup();
    const seen: string[] = [];
    auth.subscribe((state) => seen.push(state.step));
    await auth.signOut();
    expect(supabase.authCalls).toEqual([{ method: 'signOut', args: null }]);
    expect(seen).toEqual(['signed_out']);
  });

  it('re-evaluates after a sign-in event from supabase-js, outside the callback', async () => {
    const { supabase, auth } = setup();
    supabase.onTable('admin_users', { data: { role: 'analyst' } });
    const seen = new Promise<string>((resolve) => auth.subscribe((state) => resolve(state.step)));
    supabase.emitAuth('SIGNED_IN');
    expect(await seen).toBe('ready');
  });

  it('ignores the initial-session and token-refresh events', async () => {
    const { supabase, auth } = setup();
    let calls = 0;
    auth.subscribe(() => (calls += 1));
    supabase.emitAuth('INITIAL_SESSION');
    supabase.emitAuth('TOKEN_REFRESHED');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(0);
  });
});
