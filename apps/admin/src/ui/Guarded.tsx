import type { ComponentType, ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { canOpenRoute, roleLabel } from '../lib/roles';
import { useRuntime } from '../runtime/RuntimeProvider';
import { AppLink } from './AppLink';
import { Banner } from './Banner';
import { P } from './Text';

/**
 * Wraps a route's screen so a role without access to that page is told why, instead of seeing an error or
 * stale data. The navigator itself stays mounted (unmounting it would reset the address), and the blocked
 * screen is never rendered, so it makes no requests.
 */
export function guarded(Screen: ComponentType): ComponentType {
  function Guarded(): ReactNode {
    const { auth } = useRuntime();
    const pathname = usePathname();
    const role = auth?.step === 'ready' ? auth.role : null;
    if (role !== null && !canOpenRoute(role, pathname)) {
      return (
        <Banner tone="warning" title="Your role cannot open this page" testID="no-access">
          <P>
            The {roleLabel(role).toLowerCase()} role does not include this page. Ask a super admin
            if you need access.
          </P>
          <AppLink href="/">Go to Home</AppLink>
        </Banner>
      );
    }
    return <Screen />;
  }
  Guarded.displayName = `Guarded(${Screen.displayName ?? Screen.name ?? 'Screen'})`;
  return Guarded;
}
