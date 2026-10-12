// "Is this message too long, odd or unclear to hand to the tutor without a classifier verdict?" Used only when the
// classifier failed (router.ts): a short, plain message is answered, anything else gets the fixed redirect.
// Deterministic and deliberately blunt; it never sees more than the already-redacted text.
import { SEVERITY_RANK } from './patterns';
import type { SafetyHit } from './patterns';

export const UNCLEAR_MAX_CHARS = 200;

export function isUnclearMessage(redactedText: string, guardHits: readonly SafetyHit[] = []): boolean {
  const text = redactedText.trim();
  if (text.length > UNCLEAR_MAX_CHARS) return true;
  if (guardHits.some((hit) => hit.category === 'jailbreak' && SEVERITY_RANK[hit.severity] >= 2)) {
    return true;
  }
  const visible = text.replace(/\s+/g, '');
  if (visible === '') return true;
  const letters = visible.match(/\p{L}/gu)?.length ?? 0;
  if (letters / visible.length < 0.5) return true;
  const latin = visible.match(/[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/g)?.length ?? 0;
  if (letters > 0 && latin / letters < 0.8) return true;
  return /[<>{}]|```/.test(text);
}
