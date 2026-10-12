// Normalises a child's message so the safety patterns can be written once, in plain lower-case words.
//
// Children (and people testing a tutor) type "dieee", "d i e", "k1ll", "i wann a", "im", "I’m", "ì wàn díe". The
// patterns therefore never see the raw text: they see a canonical form where case, accents, apostrophes,
// punctuation, leetspeak, repeated letters and text-speak are flattened. Patterns are normalised with the SAME
// function (collapseRepeats on the literal words), so "kill" is authored as "kill" and matches "kiiilll".
//
// Two views are returned: the normal one, and one where runs of three or more single letters ("d i e") are
// joined. Matching both costs little and keeps "i a m sad" working in the first view.

const LOOKALIKES: Record<string, string> = {
  ı: 'i',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ß: 'ss',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
};

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
};

/** Whole-token text-speak. Applied before leetspeak so "2" and "4" mean "to" and "for" when they stand alone. */
const TEXT_SPEAK: Record<string, string> = {
  u: 'you',
  ur: 'your',
  r: 'are',
  '2': 'to',
  '4': 'for',
  b4: 'before',
  cos: 'because',
  cus: 'because',
  bcos: 'because',
  coz: 'because',
  pls: 'please',
  plz: 'please',
  y: 'why',
  n: 'and',
  wanna: 'want to',
  gonna: 'going to',
  gotta: 'got to',
  dunno: 'do not know',
  cant: 'can not',
  dont: 'do not',
  wont: 'will not',
  im: 'i am',
  ive: 'i have',
  id: 'i would',
  isnt: 'is not',
  arent: 'are not',
  didnt: 'did not',
  doesnt: 'does not',
};

/** Collapses every run of the same letter to one: "diiie" -> "die", "kill" -> "kil". Used on text AND on patterns. */
export function collapseRepeats(text: string): string {
  return text.replace(/([a-z])\1+/g, '$1');
}

function foldAccents(text: string): string {
  const base = text
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  let out = '';
  for (const char of base.toLowerCase()) out += LOOKALIKES[char] ?? char;
  return out;
}

/** One alphanumeric piece: text-speak first, then digits that stand for letters inside a word ("k1ll", "d13"). */
function flattenPiece(piece: string, speak: boolean): string {
  const spoken = speak ? TEXT_SPEAK[piece] : undefined;
  if (spoken !== undefined) return spoken;
  if (!/[a-z]/.test(piece)) return piece;
  return piece.replace(/[0-9]/g, (digit) => LEET[digit] ?? digit);
}

function toWords(text: string, speak = true): string[] {
  const words: string[] = [];
  const tokens = foldAccents(text)
    .replace(/['’ʼ`´]/g, '')
    .split(/\s+/)
    .filter((token) => token !== '');
  for (const token of tokens) {
    // symbols between letters stand for letters ("k!ll", "su1c@de"); anywhere else they are punctuation
    const inner = token.replace(
      /([a-z])([@$!|+])(?=[a-z])/g,
      (_all, left: string, symbol: string) => {
        return `${left}${LEET[symbol] ?? ''}`;
      },
    );
    for (const piece of inner.split(/[^a-z0-9]+/)) {
      if (piece === '') continue;
      for (const word of flattenPiece(piece, speak).split(' ')) if (word !== '') words.push(word);
    }
  }
  return words;
}

function joinSingleLetters(words: string[]): string[] {
  // a segment made only of single letters ("T O") is one spaced-out word
  if (words.length >= 2 && words.every((word) => /^[a-z]$/.test(word))) return [words.join('')];
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };
  for (const word of words) {
    if (/^[a-z]$/.test(word)) run.push(word);
    else {
      flush();
      out.push(word);
    }
  }
  flush();
  return out;
}

/** The canonical forms of `text` to match patterns against: usually one, two when single letters were joined. */
export function normalizeViews(text: string): string[] {
  const plain = collapseRepeats(toWords(text).join(' ')).replace(/\s+/g, ' ').trim();
  // Letters spaced out one by one ("d i e") are joined per segment; two or more spaces keep words apart.
  const segments = text.split(/\s{2,}/);
  const joined = collapseRepeats(
    segments
      .map((segment) =>
        joinSingleLetters(toWords(segment, false))
          .map((word) => TEXT_SPEAK[word] ?? word)
          .join(' '),
      )
      .join(' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return plain === joined ? [plain] : [plain, joined];
}
