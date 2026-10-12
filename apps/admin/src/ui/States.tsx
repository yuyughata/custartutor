import type { ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { isAdminApiError, type AdminApiError } from '../api/errors';
import { Banner } from './Banner';
import { Button } from './Button';
import { Card } from './Card';
import { H3, P } from './Text';
import { colors, space } from './theme';

export function Loading({ label = 'Loading…' }: { label?: string }): ReactNode {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[4] }}
    >
      <ActivityIndicator color={colors.primary} />
      <P>{label}</P>
    </View>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <Card tone="muted" style={{ alignItems: 'flex-start' }}>
      <H3>{title}</H3>
      {typeof children === 'string' ? <P>{children}</P> : children}
      {action}
    </Card>
  );
}

/** The one place an API failure is shown. `mfa_required` and an ended session get their own wording and action. */
export function ErrorState({
  error,
  onRetry,
  onSignInAgain,
  title,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
  onSignInAgain?: (() => void) | undefined;
  title?: string;
}): ReactNode {
  const known: AdminApiError | null = isAdminApiError(error) ? error : null;
  const message = known
    ? known.message
    : error instanceof Error
      ? error.message
      : 'Something went wrong.';
  if (known?.kind === 'mfa_required') {
    return (
      <Banner tone="warning" title="Authenticator code required" testID="error-mfa">
        <P>Every admin action needs your authenticator code. Enter it again to continue.</P>
        {onSignInAgain ? <Button label="Enter authenticator code" onPress={onSignInAgain} /> : null}
      </Banner>
    );
  }
  if (known?.kind === 'session_expired' || known?.kind === 'unauthenticated') {
    return (
      <Banner tone="warning" title="Please sign in again" testID="error-session">
        <P>{message}</P>
        {onSignInAgain ? <Button label="Sign in" onPress={onSignInAgain} /> : null}
      </Banner>
    );
  }
  return (
    <Banner
      tone={known?.kind === 'forbidden' ? 'warning' : 'danger'}
      title={title ?? (known?.kind === 'forbidden' ? 'Not allowed' : 'Something went wrong')}
      testID="error-state"
      action={
        onRetry && (!known || known.retryable || known.kind === 'unknown') ? (
          <Button label="Try again" variant="secondary" onPress={onRetry} small />
        ) : undefined
      }
    >
      <P>{message}</P>
    </Banner>
  );
}

/** Loading, error or the content. Pass the result of `useLoad`. */
export function Async<T>({
  state,
  children,
  loadingLabel,
  onSignInAgain,
}: {
  state: { data: T | undefined; error: unknown; loading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
  loadingLabel?: string;
  onSignInAgain?: () => void;
}): ReactNode {
  if (state.error) {
    return <ErrorState error={state.error} onRetry={state.reload} onSignInAgain={onSignInAgain} />;
  }
  if (state.data === undefined)
    return <Loading {...(loadingLabel ? { label: loadingLabel } : {})} />;
  return <>{children(state.data)}</>;
}
