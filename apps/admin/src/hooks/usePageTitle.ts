import { useEffect } from 'react';
import { Platform } from 'react-native';

/** Sets the browser tab title (web only). Screen readers announce it on navigation. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.title = `${title} · CUSTAR Admin`;
  }, [title]);
}
