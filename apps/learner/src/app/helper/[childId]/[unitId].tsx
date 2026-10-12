import { useLocalSearchParams } from 'expo-router';
import { HelperLessonScreen } from '../../../helper/HelperLessonScreen';

/**
 * The helper lesson screen (child mode). Reached only from the grown-ups launcher, which is behind the PIN; leaving
 * needs the PIN again. `?autoplay=1` turns on narration for a child who cannot read yet.
 */
export default function HelperLessonRoute() {
  const { childId, unitId, autoplay } = useLocalSearchParams<{
    childId: string;
    unitId: string;
    autoplay?: string;
  }>();
  return <HelperLessonScreen childId={childId} unitId={unitId} autoplay={autoplay === '1'} />;
}
