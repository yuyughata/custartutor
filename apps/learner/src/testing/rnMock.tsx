import { createElement, type ReactNode } from 'react';

/**
 * A stand-in for `react-native` so screens' small components can be rendered to static HTML in Vitest (Node cannot
 * load the real package). Style and layout are dropped on purpose: tests built on it check WHAT is rendered (text,
 * accessible names, which pieces appear), never how it looks; the browser run (scripts/e2e-*.mjs) checks looks.
 */
interface MockProps {
  children?: ReactNode;
  'aria-pressed'?: boolean;
  'aria-checked'?: boolean;
  'aria-selected'?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: {
    selected?: boolean;
    disabled?: boolean;
    busy?: boolean;
    checked?: boolean;
  };
  disabled?: boolean;
  testID?: string;
  value?: string;
}

function host(tag: string, roleFallback?: string) {
  return function Mock({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    disabled,
    testID,
    ...aria
  }: MockProps): ReactNode {
    const role = accessibilityRole ?? roleFallback;
    const pressed =
      aria['aria-pressed'] ??
      aria['aria-checked'] ??
      aria['aria-selected'] ??
      accessibilityState?.selected ??
      accessibilityState?.checked;
    return createElement(
      tag,
      {
        ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
        ...(role ? { role } : {}),
        ...(pressed !== undefined ? { 'aria-pressed': pressed } : {}),
        ...(disabled || accessibilityState?.disabled ? { 'aria-disabled': true } : {}),
        ...(testID ? { 'data-testid': testID } : {}),
      },
      children,
    );
  };
}

export const reactNativeMock = {
  View: host('div'),
  Text: host('span'),
  Pressable: host('button', 'button'),
  ScrollView: host('div'),
  TextInput: host('input'),
  Image: host('img'),
  ActivityIndicator: host('span', 'progressbar'),
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'web' as const },
  StyleSheet: { create: <T,>(styles: T): T => styles },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
};
