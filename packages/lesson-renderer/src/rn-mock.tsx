import { createElement, type ReactNode } from 'react';

/**
 * A stand-in for `react-native` so the renderer's components can be rendered to static HTML in Vitest (which
 * runs in Node, where the real package cannot be loaded). Layout and style are dropped on purpose: tests
 * built on it check WHAT is rendered (text, labels, roles, which pieces appear), never how it looks.
 * The browser run (apps/learner/scripts/e2e-*.mjs) is where looks are checked.
 */
interface MockProps {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean; busy?: boolean };
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
}

function host(tag: string, roleFallback?: string) {
  return function Mock({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    disabled,
    testID,
  }: MockProps): ReactNode {
    const role = accessibilityRole ?? roleFallback;
    return createElement(
      tag,
      {
        ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
        ...(role ? { role } : {}),
        ...(accessibilityState?.selected !== undefined
          ? { 'aria-pressed': accessibilityState.selected }
          : {}),
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
  Platform: { OS: 'web' as const },
  StyleSheet: { create: <T,>(styles: T): T => styles },
};
