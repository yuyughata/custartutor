// The unit exactly as the learner app renders it, in `admin` mode: all three tabs (Textbook, Workbook, Teacher's
// manual) and everything the tutor will consume (tutor scripts, alt text, helper scripts). The preview sits in a
// fixed-height frame with its own scroll, so the checks stay beside it.
import { useEffect, type ReactNode } from 'react';
import { View } from 'react-native';
import type { UnitContent } from '@custar/content-schema';
import { UnitView } from '@custar/lesson-renderer';
import type { JumpTarget, PreviewTab } from '../lib/lintPaths';
import { scrollToText } from '../platform/scroll';
import { colors, radii } from '../ui/theme';

export interface PreviewJump {
  target: JumpTarget;
  /** Changes on every jump, so the same target can be jumped to again. */
  nonce: number;
}

export function UnitPreview({
  versionId,
  unit,
  jump,
  height = 760,
}: {
  versionId: string;
  unit: UnitContent;
  jump: PreviewJump | null;
  height?: number;
}): ReactNode {
  const tab: PreviewTab = jump?.target.tab ?? 'textbook';
  const heading = jump?.target.heading;
  const nonce = jump?.nonce ?? 0;

  useEffect(() => {
    if (!heading) return undefined;
    // The tab may have just been remounted: give the renderer a moment to lay out.
    const timer = setTimeout(() => scrollToText(heading), 250);
    return () => clearTimeout(timer);
  }, [heading, nonce]);

  return (
    <View
      {...({ dataSet: { previewFrame: 'true' } } as object)}
      testID="unit-preview"
      style={{
        height,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.lg,
        overflow: 'hidden',
        backgroundColor: colors.white,
      }}
    >
      <UnitView key={`${versionId}-${tab}`} unit={unit} mode="admin" initialTab={tab} maxWidth={760} />
    </View>
  );
}
