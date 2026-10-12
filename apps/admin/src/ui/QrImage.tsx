import type { ReactNode } from 'react';
import { Image } from 'react-native';
import { colors } from './theme';

/** The QR code of an authenticator enrolment (an SVG data URI). */
export function QrImage({ uri, label }: { uri: string; label: string }): ReactNode {
  return (
    <Image
      accessibilityLabel={label}
      source={{ uri }}
      style={{ width: 160, height: 160, backgroundColor: colors.white }}
    />
  );
}
