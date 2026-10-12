import type { ReactNode } from 'react';
import { colors } from './theme';

/**
 * A plain <img> on the web. The SVG data URI that supabase-js returns contains quotes and spaces, which break
 * a CSS background-image url(), so react-native-web's Image cannot show it reliably.
 */
export function QrImage({ uri, label }: { uri: string; label: string }): ReactNode {
  return (
    <img
      src={uri}
      alt={label}
      width={160}
      height={160}
      style={{ width: 160, height: 160, backgroundColor: colors.white, display: 'block' }}
    />
  );
}
