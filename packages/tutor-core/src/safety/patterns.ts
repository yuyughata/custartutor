// The matcher for the deterministic safety list (data: patternData.ts, guardData.ts). Pure; no model.
//
// A template is compiled once into a regular expression over the NORMALISED text (normalize.ts). The result of a
// scan is a list of hits {id, category, severity}: never the matched words, so no child text travels with it.
import { collapseRepeats, normalizeViews } from './normalize';
import { GUARD_PATTERN_DEFS } from './guardData';
import { SAFETY_PATTERN_DEFS } from './patternData';
import type { PatternCategory, PatternSeverity, SafetyPatternDef } from './patternData';

export interface SafetyHit {
  id: string;
  category: PatternCategory;
  severity: PatternSeverity;
}

export const SEVERITY_RANK: Record<'none' | PatternSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function literal(text: string): string {
  // templates are plain words, digits and spaces; anything else is escaped so a typo cannot become a pattern
  return collapseRepeats(text.trim())
    .replace(/[^a-z0-9 ]/g, (char) => `\\${char}`)
    .replace(/ +/g, ' ');
}

/** Compiles one template (syntax in patternData.ts) to a regular expression over normalised text. */
export function compileTemplate(template: string): RegExp {
  let source = '';
  let index = 0;
  while (index < template.length) {
    const char = template[index] as string;
    if (template.startsWith('...', index)) {
      source = `${source.replace(/ $/, '')}(?: [a-z0-9]+){0,3}`;
      index += 3;
      if (template[index] === ' ') {
        index += 1;
        source += ' ';
      }
    } else if (char === '(' || char === '[') {
      const close = template.indexOf(char === '(' ? ')' : ']', index);
      if (close === -1) throw new Error(`Unclosed group in safety template "${template}"`);
      const alternatives = template
        .slice(index + 1, close)
        .split('|')
        .map(literal)
        .filter((alt) => alt !== '');
      const group = `(?:${alternatives.join('|')})`;
      index = close + 1;
      const spaceFollows = template[index] === ' ';
      if (spaceFollows) index += 1;
      if (char === '[') {
        source = spaceFollows ? source : source.replace(/ $/, '');
        source += spaceFollows ? `(?:${group} )?` : `(?: ${group})?`;
      } else {
        source += spaceFollows ? `${group} ` : group;
      }
    } else {
      let end = index;
      while (end < template.length && !'([.'.includes(template[end] as string)) end += 1;
      if (end === index) end = index + 1;
      source += literal(template.slice(index, end)) + (/ $/.test(template.slice(index, end)) ? ' ' : '');
      index = end;
    }
  }
  return new RegExp(`(?:^| )${source.replace(/ $/, '')}(?= |$)`, 'g');
}

/** "I want to die laughing" is not a crisis. Checked on the words right after a self-harm match. */
const IDIOM_TAIL = /^ (?:laughing|laughter|of laughter|of laughing|from laughing|of shame|of boredom|of embarrassment)/;

export type PatternMatcher = (text: string) => SafetyHit[];

/** Builds a matcher over a list of definitions. Use this to test an extended list before shipping it. */
export function createPatternMatcher(defs: readonly SafetyPatternDef[]): PatternMatcher {
  const compiled = defs.map((def) => ({ def, regex: compileTemplate(def.template) }));
  return (text: string): SafetyHit[] => {
    const views = normalizeViews(text);
    const hits: SafetyHit[] = [];
    for (const { def, regex } of compiled) {
      let found = false;
      for (const view of views) {
        regex.lastIndex = 0;
        for (let match = regex.exec(view); match !== null; match = regex.exec(view)) {
          const tail = view.slice(match.index + match[0].length);
          if (!(def.category === 'self_harm' && IDIOM_TAIL.test(tail))) found = true;
          if (match[0] === '') regex.lastIndex += 1;
        }
        if (found) break;
      }
      if (found) hits.push({ id: def.id, category: def.category, severity: def.severity });
    }
    return hits;
  };
}

/** Self-harm, abuse or neglect, and strong distress hits for a child's message (raw or redacted text). */
export const detectSafetyPatterns: PatternMatcher = createPatternMatcher(SAFETY_PATTERN_DEFS);

/** Rule-breaking phrases ("ignore your instructions"); only used when the classifier gave no verdict. */
export const detectGuardPatterns: PatternMatcher = createPatternMatcher(GUARD_PATTERN_DEFS);

/** The hit with the highest severity (first one wins a tie), or undefined. */
export function strongestHit(hits: readonly SafetyHit[]): SafetyHit | undefined {
  let best: SafetyHit | undefined;
  for (const hit of hits) {
    if (best === undefined || SEVERITY_RANK[hit.severity] > SEVERITY_RANK[best.severity]) best = hit;
  }
  return best;
}
