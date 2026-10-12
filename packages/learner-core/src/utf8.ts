/**
 * UTF-8 helpers that work without `TextEncoder`/`TextDecoder` (older Hermes builds lack them). The fast path
 * uses the platform implementation when it exists.
 */

interface Utf8Platform {
  TextEncoder?: new () => { encode(text: string): Uint8Array };
  TextDecoder?: new () => { decode(bytes: Uint8Array): string };
}

const platform = globalThis as unknown as Utf8Platform;

export function encodeUtf8(text: string): Uint8Array {
  if (platform.TextEncoder) return new platform.TextEncoder().encode(text);
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

export function decodeUtf8(bytes: Uint8Array): string {
  if (platform.TextDecoder) return new platform.TextDecoder().decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i] ?? 0;
    let code: number;
    let extra: number;
    if (b0 < 0x80) [code, extra] = [b0, 0];
    else if (b0 < 0xe0) [code, extra] = [b0 & 0x1f, 1];
    else if (b0 < 0xf0) [code, extra] = [b0 & 0x0f, 2];
    else [code, extra] = [b0 & 0x07, 3];
    for (let k = 1; k <= extra; k += 1) code = (code << 6) | ((bytes[i + k] ?? 0) & 0x3f);
    out += String.fromCodePoint(code);
    i += 1 + extra;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
