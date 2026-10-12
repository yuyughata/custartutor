// Removes personal data from a child's message BEFORE anything else sees it: before the moderation classifier,
// before the tutor model, before storage (ADR 0008, CLAUDE.md rule 3). Pure and synchronous.
//
// THIS IS A SAFETY NET, NOT A GUARANTEE. It is built from patterns, and a determined or merely unlucky child can
// get personal data past patterns. What it does NOT catch:
//   - a name that is not introduced by one of the phrases below and is not in `knownNames` ("Tunde is in my
//     class", "I sit next to Ada"). The guardian-supplied real names are the strongest protection: pass them;
//   - an address without a street word, a "I live ..." phrase or a house/plot/flat number ("the yellow house
//     behind the big mango tree near Mama Tolu's shop");
//   - introductions in other languages than English, Pidgin and a few Yoruba, Igbo and Hausa phrases;
//   - numbers broken up by words ("zero eight oh three, my number, one two three..."), digits spelt in a
//     language other than English, and any run shorter than the thresholds (a 5-digit pin, a 7-digit local number
//     with spaces);
//   - a photo, a voice, a drawing, or an identifying description ("the tall man who sells pure water");
//   - a typing obfuscation nobody thought of.
// It is deliberately biased to over-redact on explicit phrases ("my name is", "call me", "I live at") and to
// stay quiet on lesson content: sums, prices, measurements, years, dates, counting runs, round numbers, and
// ordinary words must pass unchanged (redact.test.ts has the tables for both directions).
//
// Replacement tokens are neutral ([phone], [email], ...). `count` is the number of replaced spans and `kinds`
// the distinct kinds in order of first appearance, so the server can store "redaction_count" without the data.
import { findDigitRuns } from './digits';
import {
  DIGIT_WORDS,
  GENERIC_PLACE_WORDS,
  HONORIFICS,
  NOT_NAMES,
  SAFE_SPACED_TLDS,
  SCHOOL_WORDS,
  TLDS,
  stripApostrophes,
} from './words';

export const REDACTION_KINDS = [
  'phone',
  'email',
  'link',
  'handle',
  'address',
  'name',
  'school',
  'number',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export const REDACTION_TOKENS: Readonly<Record<RedactionKind, string>> = {
  phone: '[phone]',
  email: '[email]',
  link: '[link]',
  handle: '[handle]',
  address: '[address]',
  name: '[name]',
  school: '[school]',
  number: '[number]',
};

export interface RedactOptions {
  /** Real names (full names and parts) that must never survive: replaced case-insensitively, whole word, possessives too. */
  knownNames?: readonly string[];
  /** Only look for these kinds (the reply sanitiser asks for the contact kinds only). Default: all. */
  kinds?: readonly RedactionKind[];
}

export interface RedactionResult {
  text: string;
  /** Number of replaced spans. */
  count: number;
  kinds: RedactionKind[];
}

interface Span {
  start: number;
  end: number;
  token: string;
}

type Hit = (kind: RedactionKind) => void;

function applySpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + span.token;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

// ---------------------------------------------------------------------------------------------
// Emails, links, handles
// ---------------------------------------------------------------------------------------------

const AT_WORD = String.raw`(?:\(\s*at\s*\)|\[\s*at\s*\]|\{\s*at\s*\}|\s+at\s+|@)`;
const DOT_WORD = String.raw`(?:\(\s*dot\s*\)|\[\s*dot\s*\]|\s+dot\s+|\.)`;
const EMAIL_PROVIDERS = 'gmail|yahoo|ymail|hotmail|outlook|icloud|protonmail|aol|live|mail';

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const EMAIL_SPOKEN = new RegExp(
  String.raw`\b[\p{L}\p{N}._%+-]+\s*${AT_WORD}\s*[\p{L}\p{N}-]+(?:\s*${DOT_WORD}\s*[\p{L}\p{N}-]+)*\s*${DOT_WORD}\s*(?:${TLDS})\b`,
  'giu',
);
const EMAIL_PROVIDER = new RegExp(
  String.raw`\b[\p{L}\p{N}._%+-]+\s*(?:\(\s*at\s*\)|\[\s*at\s*\]|\s+at\s+|@)\s*(?:${EMAIL_PROVIDERS})\b`,
  'giu',
);

function redactEmails(text: string, hit: Hit): string {
  const token = REDACTION_TOKENS.email;
  return text
    .replace(EMAIL, () => (hit('email'), token))
    .replace(EMAIL_SPOKEN, () => (hit('email'), token))
    .replace(EMAIL_PROVIDER, () => (hit('email'), token));
}

const TRAILING_PUNCT = /[.,;:!?)\]'"]+$/;

const URL_SCHEME = /\b(?:https?|ftps?|sftp):\/\/[^\s<>"]+/giu;
const WWW = /\bwww\s*\.\s*[^\s<>"]+/giu;
const WWW_SPACED = new RegExp(
  String.raw`\bw\s?w\s?w\s*(?:\.|\s+dot\s+|\s*\(\s*dot\s*\)\s*)\s*[\p{L}\p{N}-]+(?:\s*(?:\.|\s+dot\s+|\(\s*dot\s*\))\s*[\p{L}\p{N}-]+)*`,
  'giu',
);
const BARE_DOMAIN = new RegExp(
  String.raw`(^|[^\p{L}\p{N}@._-])((?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+(?:${TLDS}))(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])((?:\/[^\s<>"]*)?)`,
  'giu',
);
const SPOKEN_DOMAIN = new RegExp(
  String.raw`\b[\p{L}\p{N}-]{2,}\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\]|\s+dot\s+)\s*(?:${TLDS})\b`,
  'giu',
);
const SPACED_DOMAIN = new RegExp(
  String.raw`\b[\p{L}\p{N}-]{2,}\s+\.\s+(?:${SAFE_SPACED_TLDS})\b`,
  'giu',
);
const SPELLED_TLD = /\b[\p{L}\p{N}-]{2,}\s*(?:\.|\bdot\b)\s*c\s+o\s+m\b/giu;
const DOT_COM = /\bdot\s*(?:com|net|org|ng)\b/giu;

function redactLinks(text: string, hit: Hit): string {
  const token = REDACTION_TOKENS.link;
  const keepTail = (match: string): string => {
    const tail = TRAILING_PUNCT.exec(match)?.[0] ?? '';
    hit('link');
    return token + tail;
  };
  return text
    .replace(URL_SCHEME, keepTail)
    .replace(WWW, keepTail)
    .replace(WWW_SPACED, () => (hit('link'), token))
    .replace(BARE_DOMAIN, (_all, before: string) => {
      hit('link');
      return `${before}${token}`;
    })
    .replace(SPOKEN_DOMAIN, () => (hit('link'), token))
    .replace(SPELLED_TLD, () => (hit('link'), token))
    .replace(SPACED_DOMAIN, () => (hit('link'), token))
    .replace(DOT_COM, () => (hit('link'), token));
}

const HANDLE = /(^|[^\p{L}\p{N}_@.])@[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*/gu;
const USERNAME_PHRASE =
  /(\b(?:user\s?name|handle|gamer\s?tag|insta(?:gram)?|snap(?:chat)?|tik\s?tok|whatsapp)\s*(?:is|na|=|:)\s*)(@?[\p{L}\p{N}_.]{3,})/giu;

function redactHandles(text: string, hit: Hit): string {
  const token = REDACTION_TOKENS.handle;
  return text
    .replace(HANDLE, (_all, before: string) => (hit('handle'), `${before}${token}`))
    .replace(USERNAME_PHRASE, (match: string, lead: string, value: string) => {
      // "my insta is cool" must stay: a handle has a digit, an underscore, a dot or an @
      if (!/[\d_.@]/.test(value)) return match;
      hit('handle');
      return `${lead}${token}`;
    });
}

// ---------------------------------------------------------------------------------------------
// Phone numbers and long digit runs
// ---------------------------------------------------------------------------------------------

function mapForeignDigits(text: string): string {
  return text.replace(/[０-９٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 0xff10 ? 0xff10 : code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String.fromCharCode(48 + code - base);
  });
}

function redactDigitRuns(text: string, hit: Hit): string {
  const runs = findDigitRuns(mapForeignDigits(text));
  const spans: Span[] = runs.map((run) => {
    hit(run.kind);
    return { start: run.start, end: run.end, token: REDACTION_TOKENS[run.kind] };
  });
  return applySpans(text, spans);
}

const SPOKEN_DIGITS = new RegExp(
  String.raw`(?:\bplus\s+)?(?:(?:\b(?:double|triple)\s+)?\b(?:zero|oh|o|nought|naught|one|two|three|four|five|six|seven|eight|nine)\b[\s,.\-]*)+`,
  'giu',
);

function spokenDigitValues(run: string): number[] {
  const words = run.toLowerCase().match(/[a-z]+/g) ?? [];
  const values: number[] = [];
  let repeat = 1;
  for (const word of words) {
    if (word === 'plus') continue;
    if (word === 'double') repeat = 2;
    else if (word === 'triple') repeat = 3;
    else {
      const value = DIGIT_WORDS[word];
      if (value === undefined) continue;
      for (let i = 0; i < repeat; i += 1) values.push(value);
      repeat = 1;
    }
  }
  return values;
}

function isCounting(values: number[]): boolean {
  if (values.length < 3) return false;
  const step = (values[1] as number) - (values[0] as number);
  if (Math.abs(step) !== 1) return false;
  return values.every((value, i) => i === 0 || value - (values[i - 1] as number) === step);
}

/** "zero eight zero three one two three four five six seven": nine or more spoken digits that are not counting. */
function redactSpokenDigits(text: string, hit: Hit): string {
  return text.replace(SPOKEN_DIGITS, (match) => {
    const values = spokenDigitValues(match);
    if (values.length < 9 || isCounting(values)) return match;
    hit('phone');
    const trailing = /[\s,.-]*$/.exec(match)?.[0] ?? '';
    return REDACTION_TOKENS.phone + trailing;
  });
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

const STREET_TYPES =
  'street|road|rd|avenue|ave|close|crescent|cresent|estate|lane|drive|way|layout|quarters|junction|expressway|boulevard|court|terrace|gardens?|phase|st';

const STREET = new RegExp(
  String.raw`(?:\b(no|number|plot|house|block|flat|suite|shop)\b\.?\s*#?\s*)?\b(\d{1,4}[A-Za-z]?)\b[,.]?\s+((?:\p{L}[\p{L}'’-]*\s+){0,4}?)(${STREET_TYPES})\b\.?`,
  'giu',
);
const UNIT_NUMBER =
  /\b(?:plot|block|flat|house\s+(?:no\.?|number))\s*#?\s*\d{1,4}[A-Za-z]?\b(?:\s*[,/]\s*(?:flat|block|room|plot)\s*\d{1,4}[A-Za-z]?)?/giu;

const LIVE_PREFIX = new RegExp(
  String.raw`\b(?:i|we)\s+(?:(?:now|still|just|dey|de|don|go|am|are)\s+)*(?:live|lives|living|stay|stays|staying|reside|resides|residing)\s+(?:(?:at|on|in|inside|near|around|by|for|along|off|opposite|beside|behind|under|within|close\s+to|next\s+to)\s+)`,
  'giu',
);
const HOUSE_PREFIX = new RegExp(
  String.raw`\bmy\s+(?:house|home|compound|school|street|area|estate)\s+(?:dey|de|is|na|be)\s+(?:(?:for|at|near|inside|beside|behind|opposite|in|on|off)\s+)`,
  'giu',
);
const ADDRESS_PREFIX = new RegExp(
  String.raw`\bmy\s+(?:home\s+|house\s+|street\s+|postal\s+|residential\s+|full\s+)?address\s*(?:is|na|be|:|=)\s*`,
  'giu',
);
const NA_FOR_PLACE =
  /\bna\s+(?:for|inside|near)\s+([^.!?\n,]{2,40}?)\s+(?:i|we)\s+(?:dey\s+)?(?:stay|live)\b/giu;

const STOP_CONJUNCTIONS = new Set([
  'and',
  'but',
  'so',
  'because',
  'with',
  'then',
  'when',
  'while',
  'if',
  'as',
  'that',
  'which',
  'who',
  'or',
  'na',
  'wey',
  'cos',
  'coz',
]);

/**
 * How many characters of `rest` belong to the place named at its start: words up to a sentence end, a stop word
 * or a comma that is followed by a lower-case word. "12 Adeola Odeku Street, Victoria Island, Lagos and my uncle
 * beats me" is taken up to "Lagos".
 */
function placeSpanLength(rest: string, maxWords = 10): number {
  let index = 0;
  let consumed = 0;
  let words = 0;
  while (index < rest.length && words < maxWords) {
    const wordMatch = /^(\s*)([^\s,.!?;:()]+)/u.exec(rest.slice(index));
    if (!wordMatch) break;
    const word = wordMatch[2] as string;
    if (words > 0 && STOP_CONJUNCTIONS.has(stripApostrophes(word))) break;
    index += wordMatch[0].length;
    consumed = index;
    words += 1;
    const comma = /^\s*,\s*(\S)/u.exec(rest.slice(index));
    if (comma) {
      const next = comma[1] as string;
      if (!(/\p{Lu}/u.test(next) || /\d/.test(next))) break;
      index += comma[0].length - 1;
      continue;
    }
    // an inner full stop belongs to an abbreviation ("St. Mary") only when a capital follows
    const stop = /^\.\s*(\p{Lu})/u.exec(rest.slice(index));
    if (stop && /^[\p{L}]{1,3}$/u.test(word)) {
      index += 1;
      continue;
    }
    if (/^\s*[.!?;:]/u.test(rest.slice(index)) || /^\s*$/u.test(rest.slice(index))) break;
  }
  return consumed;
}

function firstWordOf(rest: string): string {
  return stripApostrophes(/^\s*([^\s,.!?;:()]+)/u.exec(rest)?.[1] ?? '');
}

function redactAddresses(text: string, hit: Hit): string {
  const token = REDACTION_TOKENS.address;
  let out = text;

  // 1. phrases that introduce a place: "I live at ...", "my house dey for ...", "my address is ...". They run
  //    first so that the whole place ("5 Palm Road, Ikeja") is replaced as one span.
  for (const pattern of [LIVE_PREFIX, HOUSE_PREFIX, ADDRESS_PREFIX]) {
    out = replacePlaceAfter(out, pattern, token, hit, 'address');
  }
  out = out.replace(NA_FOR_PLACE, (match: string, place: string) => {
    if (GENERIC_PLACE_WORDS.has(firstWordOf(place)) || place.trimStart().startsWith('[')) {
      return match;
    }
    hit('address');
    return match.replace(place, token);
  });

  // 2. "12 Adeola Odeku Street", "no. 5 Palm Road", "Plot 7 Ikota Estate", "Block 5, Flat 3"
  out = out.replace(
    STREET,
    (match: string, prefix: string | undefined, _number: string, middle: string, kind: string) => {
      const words = middle.trim() === '' ? [] : middle.trim().split(/\s+/);
      if (prefix === undefined) {
        // Without "no." or "plot", lower-case words are plain counting: "I saw 5 big cars on the road".
        if (words.length === 0) return match;
        if (!words.every((word) => /^\p{Lu}/u.test(word))) return match;
      }
      if (kind.toLowerCase() === 'st' && !/^S/.test(kind)) return match;
      hit('address');
      // the full stop belongs to the sentence unless the street type is an abbreviation ("Rd.")
      const sentenceStop = match.endsWith('.') && !/^(?:st|rd|ave)$/i.test(kind);
      return sentenceStop ? `${token}.` : token;
    },
  );
  return out.replace(UNIT_NUMBER, () => (hit('address'), token));
}

/** Replaces the place that follows every match of `prefix`, unless it starts with a generic word ("a house", "home"). */
function replacePlaceAfter(
  text: string,
  prefix: RegExp,
  token: string,
  hit: Hit,
  kind: RedactionKind,
  validate: (rest: string, length: number) => boolean = () => true,
): string {
  const spans: Span[] = [];
  prefix.lastIndex = 0;
  for (let match = prefix.exec(text); match !== null; match = prefix.exec(text)) {
    const rest = text.slice(match.index + match[0].length);
    if (GENERIC_PLACE_WORDS.has(firstWordOf(rest)) || rest.trimStart().startsWith('[')) continue;
    const length = placeSpanLength(rest);
    if (length === 0 || !validate(rest, length)) continue;
    const start = match.index + match[0].length + (/^\s*/u.exec(rest)?.[0].length ?? 0);
    spans.push({ start, end: match.index + match[0].length + length, token });
    hit(kind);
    prefix.lastIndex = match.index + match[0].length + length;
  }
  return applySpans(text, spans);
}

// ---------------------------------------------------------------------------------------------
// Schools
// ---------------------------------------------------------------------------------------------

const SCHOOL_PREFIX = new RegExp(
  [
    String.raw`\b(?:i|we)\s+(?:(?:dey|now|still|am|are)\s+)*(?:go(?:ing)?|attend(?:ing)?|school|study(?:ing)?|read(?:ing)?)\s+(?:to|at|in|for)\s+`,
    String.raw`\b(?:i|we)\s+(?:(?:dey|now|still|am|are)\s+)*attend(?:ing)?\s+`,
    String.raw`\bmy\s+school\s+(?:name\s+)?(?:is|na|be|:)\s*`,
    String.raw`\b(?:i\s+am|i'm|im)\s+(?:a\s+)?(?:pupil|student)\s+(?:of|at|in)\s+`,
    String.raw`\bmy\s+school\s+(?:is\s+called|name)\s+`,
  ].join('|'),
  'giu',
);

function schoolSpanLength(rest: string): number {
  let index = 0;
  let consumed = 0;
  let words = 0;
  let capital = false;
  let schoolWord = false;
  while (index < rest.length && words < 7) {
    const wordMatch = /^(\s*)([^\s,.!?;:()]+)/u.exec(rest.slice(index));
    if (!wordMatch) break;
    const word = wordMatch[2] as string;
    const lower = stripApostrophes(word);
    if (words > 0 && STOP_CONJUNCTIONS.has(lower)) break;
    if (words === 0 && GENERIC_PLACE_WORDS.has(lower)) return 0;
    index += wordMatch[0].length;
    consumed = index;
    words += 1;
    if (/^\p{Lu}/u.test(word)) capital = true;
    if (SCHOOL_WORDS.has(lower)) {
      schoolWord = true;
      // the name ends at "School" unless another school word follows ("Primary School")
      const next = firstWordOf(rest.slice(index));
      if (!SCHOOL_WORDS.has(next)) break;
    }
    if (/^\s*[.!?;:,]/u.test(rest.slice(index))) break;
  }
  return capital || schoolWord ? consumed : 0;
}

function redactSchools(text: string, hit: Hit): string {
  const token = REDACTION_TOKENS.school;
  const spans: Span[] = [];
  SCHOOL_PREFIX.lastIndex = 0;
  for (let match = SCHOOL_PREFIX.exec(text); match !== null; match = SCHOOL_PREFIX.exec(text)) {
    const end = match.index + match[0].length;
    const rest = text.slice(end);
    const length = schoolSpanLength(rest);
    SCHOOL_PREFIX.lastIndex = Math.max(end, SCHOOL_PREFIX.lastIndex);
    if (length === 0) continue;
    const lead = /^\s*/u.exec(rest)?.[0].length ?? 0;
    spans.push({ start: end + lead, end: end + length, token });
    hit('school');
    SCHOOL_PREFIX.lastIndex = end + length;
  }
  return applySpans(text, spans);
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

function foldChar(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Lower-cased text with diacritics removed, plus for every folded character the span of the original it came from,
 * so a match in the folded text maps back to the exact original span.
 */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = foldChar(char);
    for (let i = 0; i < piece.length; i += 1) {
      starts.push(index);
      ends.push(index + char.length);
    }
    folded += piece;
    index += char.length;
  }
  return { folded, starts, ends };
}

const NAME_PART_IGNORE = new Set([
  'and',
  'the',
  'for',
  'bin',
  'van',
  'von',
  'del',
  'dos',
  'ibn',
  'ben',
]);

function nameVariants(names: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const raw of names) {
    const whole = foldChar(raw)
      .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (whole.length < 2) continue;
    variants.add(whole);
    const parts = whole.split(/[\s-]+/).filter((part) => part !== '');
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length >= 3 && !NAME_PART_IGNORE.has(part)) variants.add(part);
      }
    }
  }
  // longest first so "ada obi" wins over "ada"
  return [...variants].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactKnownNames(text: string, names: readonly string[], hit: Hit): string {
  const variants = nameVariants(names);
  if (variants.length === 0) return text;
  const { folded, starts, ends } = foldWithMap(text);
  const pattern = new RegExp(
    String.raw`(^|[^\p{L}\p{N}])(${variants.map((name) => escapeRegExp(name).replace(/\s+/g, String.raw`\s+`)).join('|')})(?![\p{L}\p{N}])`,
    'gu',
  );
  const spans: Span[] = [];
  for (let match = pattern.exec(folded); match !== null; match = pattern.exec(folded)) {
    const before = (match[1] as string).length;
    const start = match.index + before;
    const end = start + (match[2] as string).length;
    const from = starts[start];
    const to = ends[end - 1];
    if (from === undefined || to === undefined) continue;
    spans.push({ start: from, end: to, token: REDACTION_TOKENS.name });
    hit('name');
    pattern.lastIndex = end;
  }
  return applySpans(text, spans);
}

const NAME_TOKEN = /^\s*(\p{L}[\p{L}'’-]*)/u;

/**
 * The length of the name that starts `rest`. `strict` (after "I am", "this is", "my teacher is") demands a capital
 * letter; the explicit forms ("my name is", "call me") also take a lower-case word. Anything in NOT_NAMES is not a
 * name: "I'm happy", "this is hard", "my name is not important".
 */
function nameSpanLength(rest: string, strict: boolean): number {
  const first = NAME_TOKEN.exec(rest);
  if (!first) return 0;
  const word = first[1] as string;
  const lower = stripApostrophes(word);
  if (NOT_NAMES.has(lower) || lower.length < 2) return 0;
  const capital = /^\p{Lu}/u.test(word);
  if (strict && !capital) return 0;
  if (strict && /ing$/u.test(lower)) return 0;
  let consumed = first[0].length;
  const maxExtra = capital ? 2 : 1;
  for (let i = 0; i < maxExtra; i += 1) {
    const next = NAME_TOKEN.exec(rest.slice(consumed));
    if (!next) break;
    const nextWord = next[1] as string;
    const nextLower = stripApostrophes(nextWord);
    if (NOT_NAMES.has(nextLower) || nextLower.length < 2) break;
    // After a capitalised first name only capitalised words follow ("Ngozi Chioma Okonkwo"); a name typed in
    // lower case after "my name is" is taken as far as the words are not ordinary words.
    if (!strict ? capital && !/^\p{Lu}/u.test(nextWord) : !/^\p{Lu}/u.test(nextWord)) break;
    consumed += next[0].length;
  }
  return consumed;
}

const LENIENT_NAME_PREFIX = new RegExp(
  [
    String.raw`\b(?:my|me|our)\s+(?:(?:first|last|full|real|other|sur|nick|pet|family)\s*)?names?\s*(?:is|na|be|are|:)\s*`,
    String.raw`\b(?:i\s+am|i'm|im|i\s+be)\s+called\s+`,
    String.raw`\bcall\s+me\s+`,
    String.raw`\b(?:they|dem|people|everyone|everybody|friends)\s+(?:dey\s+)?call(?:ed)?\s+me\s+`,
    String.raw`\bor[uù]k[oọóò]\s+mi\s+ni\s+`,
    String.raw`\baha\s+m\s+b[ụu]\s+`,
    String.raw`\bsunana\s+`,
    String.raw`\bsuna\s+na\s+`,
  ].join('|'),
  'giu',
);
const STRICT_NAME_PREFIX = new RegExp(
  [
    String.raw`\b(?:i\s+am|i'm|im|i’m)\s+`,
    String.raw`\bthis\s+is\s+`,
    String.raw`\bmy\s+(?:mum|mummy|mom|mother|dad|daddy|father|brother|sister|teacher|friend|uncle|aunty|auntie|grandma|grandpa|neighbour|neighbor|cousin|guardian|baby)(?:'s)?\s+(?:name\s+)?(?:is|na|be)\s+`,
  ].join('|'),
  'giu',
);
const NA_NAME_BE = /\bna\s+(\p{Lu}[\p{L}'’-]*)\s+be\s+my\s+name\b/gu;
const HONORIFIC_NAME = new RegExp(
  String.raw`\b(${HONORIFICS})\.?\s+(\p{L}[\p{L}'’-]*(?:\s+\p{L}[\p{L}'’-]*){0,2})`,
  'giu',
);
const RELATION_NAME = new RegExp(
  String.raw`\b(?:my|our)\s+(?:friend|cousin|neighbour|neighbor|classmate|teacher|brother|sister|mum|dad|mummy|daddy|uncle|aunty|auntie|grandma|grandpa|baby)\s+(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,2})`,
  'gu',
);

function replaceNamesAfter(text: string, prefix: RegExp, strict: boolean, hit: Hit): string {
  const spans: Span[] = [];
  prefix.lastIndex = 0;
  for (let match = prefix.exec(text); match !== null; match = prefix.exec(text)) {
    const end = match.index + match[0].length;
    const rest = text.slice(end);
    const length = nameSpanLength(rest, strict);
    if (length === 0) {
      prefix.lastIndex = Math.max(end, match.index + 1);
      continue;
    }
    const lead = /^\s*/u.exec(rest)?.[0].length ?? 0;
    spans.push({ start: end + lead, end: end + length, token: REDACTION_TOKENS.name });
    hit('name');
    prefix.lastIndex = end + length;
  }
  return applySpans(text, spans);
}

function redactIntroducedNames(text: string, hit: Hit): string {
  let out = replaceNamesAfter(text, LENIENT_NAME_PREFIX, false, hit);
  out = replaceNamesAfter(out, STRICT_NAME_PREFIX, true, hit);
  out = out.replace(NA_NAME_BE, (match: string, name: string) => {
    if (NOT_NAMES.has(stripApostrophes(name))) return match;
    hit('name');
    return `na ${REDACTION_TOKENS.name} be my name`;
  });
  out = out.replace(HONORIFIC_NAME, (match: string, title: string, name: string) => {
    const words = name.trim().split(/\s+/);
    const kept: string[] = [];
    for (const word of words) {
      if (!/^\p{Lu}/u.test(word) || NOT_NAMES.has(stripApostrophes(word))) break;
      kept.push(word);
    }
    if (kept.length === 0) return match;
    hit('name');
    const keptLength = kept.join(' ').length;
    const nameStart = match.length - name.length;
    return `${match.slice(0, nameStart)}${REDACTION_TOKENS.name}${name.slice(keptLength)}`;
  });
  out = out.replace(RELATION_NAME, (match: string, name: string) => {
    const words = name.trim().split(/\s+/);
    if (NOT_NAMES.has(stripApostrophes(words[0] as string))) return match;
    hit('name');
    return match.slice(0, match.length - name.length) + REDACTION_TOKENS.name;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

/**
 * Redacts personal data from `input`. Kinds, in the order the passes run: email, link, phone/number (digit
 * runs, then spoken digits), handle, address, school, known names, introduced names. A pass never sees the tokens
 * of an earlier pass as data, so the function is idempotent: redacting redacted text changes nothing.
 */
export function redactPii(input: string, options: RedactOptions = {}): RedactionResult {
  const wanted: ReadonlySet<RedactionKind> | null = options.kinds ? new Set(options.kinds) : null;
  const kinds: RedactionKind[] = [];
  let count = 0;
  const hit: Hit = (kind) => {
    count += 1;
    if (!kinds.includes(kind)) kinds.push(kind);
  };
  // `options.kinds` chooses passes: a pass runs when any of the kinds it can produce is wanted.
  const runs = (...produces: RedactionKind[]): boolean =>
    wanted === null || produces.some((kind) => wanted.has(kind));

  let text = input.replace(INVISIBLE, '');
  if (runs('email')) text = redactEmails(text, hit);
  if (runs('link')) text = redactLinks(text, hit);
  if (runs('phone', 'number')) text = redactSpokenDigits(redactDigitRuns(text, hit), hit);
  if (runs('handle')) text = redactHandles(text, hit);
  if (runs('address')) text = redactAddresses(text, hit);
  if (runs('school')) text = redactSchools(text, hit);
  if (runs('name')) {
    if (options.knownNames && options.knownNames.length > 0) {
      text = redactKnownNames(text, options.knownNames, hit);
    }
    text = redactIntroducedNames(text, hit);
  }
  return { text, count, kinds };
}

/** True when the text contains one of the given real names (whole word, any case, accents ignored). */
export function mentionsKnownName(text: string, names: readonly string[]): boolean {
  let found = false;
  redactKnownNames(text, names, () => {
    found = true;
  });
  return found;
}

/** True when the text holds something `redactPii` would replace. Convenience for guards and tests. */
export function containsPii(input: string, options: RedactOptions = {}): boolean {
  return redactPii(input, options).count > 0;
}
