// Pure base64 for the PDF handed to Claude. No btoa, no Buffer: the same code runs in Deno, Node and the browser.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding and no line breaks (what the API expects). */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = '';
  const length = bytes.length;
  let i = 0;
  for (; i + 2 < length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk +=
      ALPHABET[(n >> 18) & 63]! +
      ALPHABET[(n >> 12) & 63]! +
      ALPHABET[(n >> 6) & 63]! +
      ALPHABET[n & 63]!;
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  const rest = length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    chunk += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    chunk += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + '=';
  }
  chunks.push(chunk);
  return chunks.join('');
}
