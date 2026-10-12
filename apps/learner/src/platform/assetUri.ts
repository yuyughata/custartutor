import { File, Paths } from 'expo-file-system';

/** A loadable `file://` URI for a path inside the learner file store (see `expoFiles.ts`). */
export function assetUri(path: string): string {
  return new File(Paths.document, 'custar', path).uri;
}
