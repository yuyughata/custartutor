/** A voice as the speech engines report it. `language` is a BCP 47 tag such as `en-NG` (or `en_NG`). */
export interface VoiceInfo {
  identifier: string;
  name?: string;
  language: string;
  quality?: string;
}

/** `en_NG` and `EN-ng` both become `en-ng`. */
export function normalizeLang(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase();
}

function primary(tag: string): string {
  return normalizeLang(tag).split('-')[0] ?? '';
}

function region(tag: string): string {
  return normalizeLang(tag).split('-')[1] ?? '';
}

/**
 * Regions to prefer, in order, when the exact one is not installed. British, South African and Indian
 * English sit closest to Nigerian English; American comes last.
 */
const REGION_FALLBACKS: Record<string, readonly string[]> = {
  en: ['ng', 'gb', 'za', 'au', 'in', 'us'],
};

function rank(voice: VoiceInfo, wanted: string): number {
  const have = normalizeLang(voice.language);
  if (have === normalizeLang(wanted)) return 1000;
  if (primary(have) !== primary(wanted)) return -1;
  const order = REGION_FALLBACKS[primary(wanted)] ?? [];
  const at = order.indexOf(region(have));
  return 500 - (at === -1 ? order.length : at) * 10;
}

/**
 * The best installed voice for `lang`: the exact tag, then the same language with a nearby region, then any
 * voice of the language. Among equals an enhanced voice wins, then the first listed. Null when the device has
 * no voice of that language at all (the caller then asks the engine for the bare language).
 */
export function pickVoice(voices: readonly VoiceInfo[], lang: string): VoiceInfo | null {
  let best: VoiceInfo | null = null;
  let bestScore = -1;
  for (const voice of voices) {
    const base = rank(voice, lang);
    if (base < 0) continue;
    const score = base + (voice.quality?.toLowerCase() === 'enhanced' ? 5 : 0);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}
