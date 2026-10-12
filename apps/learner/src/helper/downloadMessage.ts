import {
  DiskSpaceError,
  DownloadError,
  IntegrityError,
  NetworkPolicyError,
  PackTooNewError,
} from '@custar/learner-core';

/** Plain-language reason a lesson or grown-up pack download failed (the same wording as the child's lesson list). */
export function downloadMessage(error: unknown): string {
  if (error instanceof NetworkPolicyError) return 'Connect to Wi-Fi to download lessons.';
  if (error instanceof DiskSpaceError) return 'Not enough space on this phone for this lesson.';
  if (error instanceof PackTooNewError) return 'Please update the app to open this lesson.';
  if (error instanceof IntegrityError) return 'The download was damaged. Please try again.';
  if (error instanceof DownloadError) return 'The download did not finish. Please try again.';
  return error instanceof Error ? error.message : 'The download failed.';
}
