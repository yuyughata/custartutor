import type { Random } from '../ports';

/** Deterministic `Random` (xorshift128) for reproducible tests. `uuid()` returns valid RFC 4122 v4 strings. */
export class SeededRandom implements Random {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number | string = 1) {
    let h = 2166136261 >>> 0;
    for (const char of String(seed)) {
      h ^= char.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // splitmix32 to spread the seed over the state
    const next = (): number => {
      h = (h + 0x9e3779b9) >>> 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next() || 1;
  }

  private nextUint32(): number {
    let t = this.s3;
    const s = this.s0;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.s0 = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.s0;
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) out[i] = this.nextUint32() & 0xff;
    return out;
  }

  uuid(): string {
    const b = this.bytes(16);
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
