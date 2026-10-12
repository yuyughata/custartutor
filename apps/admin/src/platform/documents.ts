// Picking a file and reading it. The web build uses the browser's file chooser (expo-document-picker); the
// admin app is not shipped to phones, so the other platforms only get the same code path without `File`.
import * as DocumentPicker from 'expo-document-picker';
import { classifyDocument, type DocumentKind } from '../lib/documents';

export interface PickedDocument {
  name: string;
  mimeType: string;
  size: number;
  kind: DocumentKind;
  read: () => Promise<ArrayBuffer>;
}

export async function pickSchemeDocument(): Promise<PickedDocument | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
    ],
    copyToCacheDirectory: false,
    multiple: false,
    base64: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const mimeType = asset.mimeType ?? asset.file?.type ?? '';
  return {
    name: asset.name,
    mimeType,
    size: asset.size ?? asset.file?.size ?? 0,
    kind: classifyDocument(asset.name, mimeType),
    read: async () => {
      if (asset.file) return asset.file.arrayBuffer();
      const response = await fetch(asset.uri);
      return response.arrayBuffer();
    },
  };
}

export function decodeText(data: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(data);
}
