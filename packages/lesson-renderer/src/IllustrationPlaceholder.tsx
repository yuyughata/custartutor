import type { ReactNode } from 'react';
import { Image, Text, View } from 'react-native';
import { illustrationPlaceholder, radii, space } from '@custar/design-tokens';

export interface IllustrationProps {
  /** Text brief for the illustrator or AI; shown as the placeholder caption until an asset is attached. */
  brief: string;
  /** Accessible description of the picture. */
  alt: string;
  /** Resolved image URL, once an asset has been uploaded or generated. */
  uri?: string;
}

/** An illustration: the real image when available, otherwise a dashed placeholder showing the brief. */
export function Illustration({ brief, alt, uri }: IllustrationProps): ReactNode {
  if (uri) {
    return (
      <Image
        accessibilityLabel={alt}
        source={{ uri }}
        resizeMode="contain"
        style={{ width: '100%', height: 220, borderRadius: radii.md }}
      />
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={alt}
      style={{
        backgroundColor: illustrationPlaceholder.background,
        borderColor: illustrationPlaceholder.border,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderRadius: radii.md,
        padding: space[4],
        minHeight: 96,
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: illustrationPlaceholder.caption,
          fontSize: 15,
          lineHeight: 22,
          fontStyle: 'italic',
          textAlign: 'center',
        }}
      >
        Illustration: {brief}
      </Text>
    </View>
  );
}
