import type { ReactNode } from 'react';
import { Link, useRouter, type Href } from 'expo-router';
import type { StyleProp, TextStyle } from 'react-native';
import { useLeaveGuard } from '../runtime/UnsavedGuard';
import { colors } from './theme';

interface ClickLike {
  preventDefault?: () => void;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

function isPlainClick(event: ClickLike): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && (event.button ?? 0) === 0;
}

/** A real link (an <a> on the web) that asks before leaving a screen with unsaved changes. */
export function AppLink({
  href,
  children,
  style,
  accessibilityLabel,
  testID,
}: {
  href: Href;
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  testID?: string;
}): ReactNode {
  const router = useRouter();
  const guard = useLeaveGuard();
  return (
    <Link
      href={href}
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      {...(testID ? { testID } : {})}
      onPress={(event: unknown) => {
        const click = event as ClickLike;
        if (guard.isDirty() && isPlainClick(click)) {
          click.preventDefault?.();
          guard.confirmLeave(() => router.push(href));
        }
      }}
      style={[{ color: colors.primary, fontWeight: '600', textDecorationLine: 'underline' }, style]}
    >
      {children}
    </Link>
  );
}
