// Word lists used by the redactor. They exist to keep the "looks like a name" rules from eating ordinary
// speech: "I'm happy" and "my name is not important" must not become "[name]". Everything is lower case and
// compared after stripping apostrophes. The lists are deliberately generous: a missed name is a (small) privacy
// leak, a swallowed ordinary word only makes the tutor's context a little poorer, but a list that is too small
// would make the redactor damage lesson content, so both directions are tested (redact.test.ts).

/** Words that can follow "I am / I'm / this is / my name is" without being a name. */
export const NOT_NAMES: ReadonlySet<string> = new Set(
  (
    'a an the and or but so if then than that this these those it its is am are was were be been being ' +
    'i me my mine we us our you your he him his she her they them their ' +
    'in on at to from with without for of by about like into onto over under up down out off near ' +
    'not no yes maybe please thanks thank hello hi hey bye okay ok fine well good great nice bad ' +
    'happy sad sorry tired hungry thirsty sick ill angry scared afraid frightened worried lonely bored ' +
    'excited ready here there back late early new old big small tall short young kind clever smart ' +
    'brilliant fast slow strong weak cold hot sleepy sleeping going coming doing trying learning ' +
    'reading writing playing eating drinking walking running standing sitting looking thinking ' +
    'very too also just still always never now today tomorrow yesterday tonight ' +
    'can will would should could must may might do does did dont cant wont ' +
    'nigerian nigeria african africa igbo yoruba hausa muslim christian boy girl child pupil student ' +
    'primary nursery class year years age aged days day week months month ' +
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen ' +
    'seventeen eighteen nineteen twenty thirty forty fifty hundred first second third last next other ' +
    'afraid alone safe unsafe lost found stuck confused curious interested proud shy brave careful ' +
    'wrong right correct true false sure certain able unable allowed supposed trying wanting ' +
    'hard easy fun funny boring difficult simple important special different same ' +
    'later soon again more less much many some any all every each both few little ' +
    'what who whom whose which when where why how ' +
    // Pidgin function words and common replies
    'dey don na wey wan go come get dem una abeg wetin make fit sabi no be im ' +
    'tire tired hungry pain pains well fine gbam oya sha o ' +
    // greetings and filler a child may type after "this is"
    'call calling called'
  )
    .split(/\s+/)
    .filter((word) => word !== ''),
);

/** The first word after "I live at" and the like that means this is NOT an address. */
export const GENERIC_PLACE_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'my',
  'our',
  'your',
  'his',
  'her',
  'their',
  'this',
  'that',
  'home',
  'house',
  'here',
  'there',
  'town',
  'city',
  'village',
  'compound',
  'school',
  'flat',
  'nigeria',
  'africa',
  'world',
  'earth',
  'bush',
  'farm',
  'hostel',
  'boarding',
  'church',
  'mosque',
  'market',
  'shop',
  'hospital',
  'bed',
  'class',
  'room',
  'bedroom',
  'kitchen',
  'sleep',
  'work',
  'lesson',
  'lessons',
  'learn',
  'play',
  'one',
  'two',
  'three',
  'big',
  'small',
  'nice',
  'good',
  'new',
  'old',
  'with',
  'and',
  'but',
  'because',
  'when',
  'if',
  'so',
  'very',
  'too',
]);

/** Words that, inside a school name, close it: "St Mary Primary School" ends at "School". */
export const SCHOOL_WORDS: ReadonlySet<string> = new Set([
  'school',
  'schools',
  'academy',
  'college',
  'primary',
  'nursery',
  'secondary',
  'international',
  'institute',
  'comprehensive',
  'grammar',
  'montessori',
  'preparatory',
  'prep',
  'seminary',
  'islamiyya',
  'madrasa',
]);

/** Honorifics and family titles that precede a person's name. */
export const HONORIFICS =
  'mr|mrs|ms|miss|dr|prof|engr|chief|alhaji|alhaja|hajia|mallam|malam|pastor|imam|rev|reverend|sir|madam|mama|papa|baba|mummy|daddy|aunty|auntie|uncle|oga|bros|sis|brother|sister|teacher|coach|nurse|doctor|officer|principal|headmaster|headmistress|oluwa';

/** Top level domains worth recognising in a bare "name.tld". Short ones that are ordinary English words are left out. */
export const TLDS =
  'com|net|org|edu|gov|ng|co|io|me|info|biz|app|xyz|tv|uk|us|link|online|site|shop|store|club|dev|ai|ly|gl|cc|live|blog|page|website|space|tech|cloud';

/** The tlds that are safe to recognise even when written with spaces around the dot ("google . com"). */
export const SAFE_SPACED_TLDS = 'com|net|org|edu|gov';

/** Spoken digits for "zero eight zero three ...". */
export const DIGIT_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  oh: 0,
  o: 0,
  nought: 0,
  naught: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

export function stripApostrophes(word: string): string {
  return word.replace(/['’ʼ`]/g, '').toLowerCase();
}
