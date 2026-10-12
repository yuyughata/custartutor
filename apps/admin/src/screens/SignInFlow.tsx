// Sign-in: email code -> authenticator code (or first-time authenticator setup) -> admin check.
// Rendered by the auth gate in place of the app until the session is `ready`, so a deep link survives sign-in.
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Text, View } from 'react-native';
import type { AuthState, TotpEnrolment } from '../api/types';
import { useAction } from '../hooks/useAction';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { TextField } from '../ui/Fields';
import { Loading } from '../ui/States';
import { H1, H2, P, Small } from '../ui/Text';
import { colors, space } from '../ui/theme';

function CodeField({
  label,
  value,
  onChange,
  onSubmit,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  hint?: string;
  error?: string | null;
}): ReactNode {
  return (
    <TextField
      label={label}
      value={value}
      onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, 6))}
      onSubmitEditing={onSubmit}
      keyboardType="number-pad"
      autoComplete="one-time-code"
      autoCorrect={false}
      maxLength={6}
      autoFocus
      {...(hint ? { hint } : {})}
      {...(error !== undefined ? { error } : {})}
    />
  );
}

function EmailStep(): ReactNode {
  const { runtime } = useRuntime();
  const { auth } = runtime.api;
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const send = useAction(async () => {
    await auth.sendCode(email.trim());
    setSentTo(email.trim());
    setCode('');
  });
  const verify = useAction(async () => {
    if (sentTo) await auth.verifyCode(sentTo, code);
  });

  if (sentTo === null) {
    return (
      <Card>
        <H2>Sign in</H2>
        <P>Enter your staff email. We will send you a 6-digit code.</P>
        <TextField
          label="Email address"
          value={email}
          onChangeText={setEmail}
          onSubmitEditing={() => void send.run()}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          autoFocus
          error={send.error?.message}
        />
        <Button
          label="Send me a code"
          onPress={() => void send.run()}
          busy={send.busy}
          disabled={!email.includes('@')}
        />
      </Card>
    );
  }
  return (
    <Card>
      <H2>Check your email</H2>
      <P>We sent a 6-digit code to {sentTo}. It is valid for a few minutes.</P>
      <CodeField
        label="6-digit email code"
        value={code}
        onChange={setCode}
        onSubmit={() => code.length === 6 && void verify.run()}
        error={verify.error?.message}
      />
      <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
        <Button label="Check code" onPress={() => void verify.run()} busy={verify.busy} disabled={code.length !== 6} />
        <Button label="Use a different email" variant="secondary" onPress={() => setSentTo(null)} disabled={verify.busy} />
      </View>
    </Card>
  );
}

function ChallengeStep({ state }: { state: Extract<AuthState, { step: 'mfa_challenge' }> }): ReactNode {
  const { runtime, signOut } = useRuntime();
  const [code, setCode] = useState('');
  const verify = useAction(async () => {
    await runtime.api.auth.verifyTotp(state.factorId, code);
  });
  return (
    <Card>
      <H2>Authenticator code required</H2>
      <P>
        Every admin action needs your authenticator app as well as your email. Open the app and type the
        current 6-digit code for CUSTAR.
      </P>
      <CodeField
        label="Authenticator code"
        value={code}
        onChange={setCode}
        onSubmit={() => code.length === 6 && void verify.run()}
        hint={`Signed in as ${state.email}`}
        error={verify.error?.message}
      />
      <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
        <Button label="Verify" onPress={() => void verify.run()} busy={verify.busy} disabled={code.length !== 6} />
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} disabled={verify.busy} />
      </View>
    </Card>
  );
}

function EnrolStep({ state }: { state: Extract<AuthState, { step: 'mfa_enrol' }> }): ReactNode {
  const { runtime, signOut } = useRuntime();
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [code, setCode] = useState('');
  const start = useAction(async () => {
    setEnrolment(await runtime.api.auth.startEnrolment());
  });
  const verify = useAction(async () => {
    if (enrolment) await runtime.api.auth.verifyTotp(enrolment.factorId, code);
  });
  const run = start.run;
  useEffect(() => {
    void run();
  }, [run]);

  return (
    <Card>
      <H2>Set up your authenticator app</H2>
      <P>
        Admin accounts must use a second step. Scan the QR code with an authenticator app (Google
        Authenticator, Microsoft Authenticator, 1Password, Authy), then type the 6-digit code it shows.
      </P>
      {start.error ? (
        <Banner tone="danger" title="Could not start setup">
          <P>{start.error.message}</P>
          <Button label="Try again" variant="secondary" small onPress={() => void start.run()} />
        </Banner>
      ) : enrolment === null ? (
        <Loading label="Preparing your authenticator…" />
      ) : (
        <View style={{ gap: space[3] }}>
          <View style={{ flexDirection: 'row', gap: space[4], flexWrap: 'wrap', alignItems: 'center' }}>
            <Image
              accessibilityLabel="QR code for your authenticator app"
              source={{ uri: enrolment.qrCode }}
              style={{ width: 160, height: 160, backgroundColor: colors.white }}
            />
            <View style={{ gap: space[1], flexShrink: 1 }}>
              <Small>Cannot scan? Type this secret into the app instead:</Small>
              <Text selectable style={{ fontFamily: 'monospace', fontSize: 15, color: colors.text }}>
                {enrolment.secret}
              </Text>
            </View>
          </View>
          <CodeField
            label="Authenticator code"
            value={code}
            onChange={setCode}
            onSubmit={() => code.length === 6 && void verify.run()}
            hint={`Signed in as ${state.email}`}
            error={verify.error?.message}
          />
        </View>
      )}
      <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>
        <Button
          label="Verify and finish"
          onPress={() => void verify.run()}
          busy={verify.busy}
          disabled={enrolment === null || code.length !== 6}
        />
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} disabled={verify.busy} />
      </View>
    </Card>
  );
}

function NotAdminStep({ email }: { email: string }): ReactNode {
  const { signOut } = useRuntime();
  return (
    <Card>
      <Banner tone="danger" title="This account is not an admin account" testID="not-admin">
        <P>
          {email} signed in correctly, but it has not been given a staff role. Ask a super admin to add it, then
          sign in again.
        </P>
      </Banner>
      <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
    </Card>
  );
}

/** The whole sign-in journey. `state` is the current step reported by the auth port. */
export function SignInFlow({ state }: { state: AuthState | undefined }): ReactNode {
  const { runtime } = useRuntime();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[4] }}>
      <View style={{ width: '100%', maxWidth: 460, gap: space[4] }}>
        <View style={{ gap: space[1] }}>
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '800', letterSpacing: 1 }}>
            CUSTAR TUTOR · ADMIN
          </Text>
          <H1>Content engine</H1>
        </View>
        {state === undefined ? (
          <Loading label="Checking your sign-in…" />
        ) : state.step === 'signed_out' ? (
          <EmailStep />
        ) : state.step === 'mfa_challenge' ? (
          <ChallengeStep state={state} />
        ) : state.step === 'mfa_enrol' ? (
          <EnrolStep state={state} />
        ) : state.step === 'not_admin' ? (
          <NotAdminStep email={state.email} />
        ) : null}
        {runtime.demoHint ? (
          <Card tone="muted">
            <Small>
              Demo mode: use any email address. The email code is {runtime.demoHint.emailCode}; the authenticator
              code is {runtime.demoHint.totpCode}. An email containing &quot;new&quot; shows authenticator setup;
              one containing &quot;visitor&quot; shows the not-an-admin screen.
            </Small>
          </Card>
        ) : null}
      </View>
    </View>
  );
}
