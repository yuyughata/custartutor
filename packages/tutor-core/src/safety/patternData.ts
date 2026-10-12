// THE DETERMINISTIC SAFETY LIST. Data only; the matcher is patterns.ts.
//
// WHAT THIS IS. A backstop beside the moderation classifier (ADR 0008): if EITHER the classifier OR this list
// flags self-harm, abuse or neglect, or strong distress, the child gets the fixed safe reply and a person reviews
// the case. It is wide on purpose. A false positive costs a short caring message and a reviewer's minute; a
// false negative can cost a child. It is English plus a little Nigerian Pidgin, and it WILL miss things (other
// languages, indirect talk, new slang). A quiet queue is not proof of safety.
//
// HOW THE OWNER EXTENDS IT.
//   1. Add an entry to SAFETY_PATTERN_DEFS below (or build your own array and pass it to createPatternMatcher).
//   2. `template` is plain lower-case words in their canonical spelling: no apostrophes ("do not", "i am"; the
//      normaliser turns "dont" and "I'm" into those), no leetspeak, no repeated letters. Syntax:
//        (a|b|c)   one of the alternatives; an alternative may hold several words
//        [x|y]     the same, but optional
//        ...       up to three filler words
//   3. Give `severity`: 'high' for explicit intent or ongoing harm, 'medium' for a wish or a clear signal,
//      'low' for a weak signal. Self-harm and abuse hits are never below 'low' (and any hit of those two
//      categories gets the fixed safe reply, whatever its severity).
//   4. Give at least one `example` a child might really type. patterns.test.ts checks that every example matches
//      its own entry, so a typo in a template is caught.
//   5. Keep this file clinical and short. Sexual or graphic phrasing is NOT kept here: that content is the
//      classifier's job, and the owner's private case list belongs outside the repository.
// Entries are matched on the normalised text (case, accents, apostrophes, punctuation, leetspeak, repeated
// letters and spaced-out letters are flattened first), so one template covers many spellings.

export type PatternCategory = 'self_harm' | 'abuse_disclosure' | 'distress' | 'jailbreak';
export type PatternSeverity = 'low' | 'medium' | 'high';

export interface SafetyPatternDef {
  id: string;
  category: PatternCategory;
  severity: PatternSeverity;
  template: string;
  examples: string[];
}

const WANT = '(want|wish|need|decided|ready|plan|planning|wan|going|about)';
const END = '(die|kill myself|end my life|end it all|hurt myself|be dead|disappear)';
const CARER =
  '(mum|mummy|dad|daddy|uncle|aunty|auntie|teacher|stepmother|stepfather|master|madam|oga|neighbour)';
const HURT = '(hits|hit|beats|beat|slaps|slapped|hurts|hurt|punches|punched|locks|locked)';

export const SAFETY_PATTERN_DEFS: readonly SafetyPatternDef[] = [
  // --- self-harm -----------------------------------------------------------------------------------
  {
    id: 'sh_intent',
    category: 'self_harm',
    severity: 'high',
    template: `(i|i am) ${WANT} [to] ${END}`,
    examples: ['I want to die', 'i wan die', 'I am ready to end it all'],
  },
  {
    id: 'sh_will',
    category: 'self_harm',
    severity: 'high',
    template: `i (will|might|may|could|go|shall) ${END}`,
    examples: ['I will kill myself', 'i go die'],
  },
  {
    id: 'sh_not_live',
    category: 'self_harm',
    severity: 'high',
    template: 'i do not want to (live|be alive|be here|wake up)',
    examples: ["I don't want to live anymore"],
  },
  {
    id: 'sh_no_more',
    category: 'self_harm',
    severity: 'high',
    template: 'i no wan (live|stay)',
    examples: ['i no wan live again'],
  },
  {
    id: 'sh_pidgin_die',
    category: 'self_harm',
    severity: 'high',
    template: '(i go|make i) (die|kill myself)',
    examples: ['make i die', 'i go kill myself'],
  },
  {
    id: 'sh_wish_dead',
    category: 'self_harm',
    severity: 'medium',
    template: 'i wish ... (dead|not here|never born|gone forever)',
    examples: ['I wish I was never born', 'i wish i was dead'],
  },
  {
    id: 'sh_disappear',
    category: 'self_harm',
    severity: 'medium',
    template: 'i (want|wish|wanna) to disappear',
    examples: ['I want to disappear'],
  },
  {
    id: 'sh_thinking',
    category: 'self_harm',
    severity: 'medium',
    template: 'i am thinking (of|about) (suicide|dying|killing myself|ending it)',
    examples: ['I am thinking about dying'],
  },
  {
    id: 'sh_word',
    category: 'self_harm',
    severity: 'medium',
    template: '(suicide|suicidal)',
    examples: ['what is suicide'],
  },
  {
    id: 'sh_hurt_self',
    category: 'self_harm',
    severity: 'medium',
    template: 'i (hurt|harm) myself',
    examples: ['I hurt myself'],
  },
  {
    id: 'sh_tired_life',
    category: 'self_harm',
    severity: 'medium',
    template: 'i (am tired of|have tire for|don tire for) (life|living|this life)',
    examples: ['I am tired of life'],
  },
  {
    id: 'sh_cut',
    category: 'self_harm',
    severity: 'low',
    template: 'i cut myself',
    examples: ['I cut myself'],
  },
  {
    id: 'sh_better_off',
    category: 'self_harm',
    severity: 'medium',
    template: '(everyone|everybody|they) (would be|will be) better [off] without me',
    examples: ['everyone would be better without me'],
  },

  // --- abuse or neglect ----------------------------------------------------------------------------
  {
    id: 'ab_someone',
    category: 'abuse_disclosure',
    severity: 'high',
    template: '(somebody|someone|people) [is|are|keep|keeps] hurting me',
    examples: ['somebody is hurting me'],
  },
  {
    id: 'ab_carer',
    category: 'abuse_disclosure',
    severity: 'high',
    template: `my ${CARER} ${HURT} me`,
    examples: ['my uncle beats me', 'my teacher hit me'],
  },
  {
    id: 'ab_pidgin',
    category: 'abuse_disclosure',
    severity: 'high',
    template: '(dem|they) [dey] (beat|flog|punish|lock) me',
    examples: ['dem dey beat me', 'dem dey lock me inside'],
  },
  {
    id: 'ab_every_day',
    category: 'abuse_disclosure',
    severity: 'high',
    template: '(hits|hit|beats|beat) me (every|each) (day|night|time)',
    examples: ['he hits me every day'],
  },
  {
    id: 'ab_touch',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: '(touched|touches) me',
    examples: ['he touched me'],
  },
  {
    id: 'ab_scared_home',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: 'i am (scared|afraid|frightened) (to|of) (go|going) home',
    examples: ['I am scared to go home'],
  },
  {
    id: 'ab_not_go_home',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: 'i do not want to go home',
    examples: ['I do not want to go home'],
  },
  {
    id: 'ab_not_safe',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: 'i (am not|do not feel|no dey) safe ...',
    examples: ['I am not safe at home', 'I do not feel safe'],
  },
  {
    id: 'ab_secret',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: '(told|tell) me (not to tell|to keep it a secret|to keep a secret)',
    examples: ['he told me not to tell'],
  },
  {
    id: 'ab_must_not_tell',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: 'i (must|should|can) not tell (anyone|anybody|mummy|mum|daddy|dad)',
    examples: ['I must not tell anyone'],
  },
  {
    id: 'ab_no_food',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: '(no one|nobody|they do not) (feeds|feed|give) me [food|to eat]',
    examples: ['no one feeds me', 'they do not feed me'],
  },
  {
    id: 'ab_hungry_home',
    category: 'abuse_disclosure',
    severity: 'low',
    template: 'i am (always|every day) hungry at home',
    examples: ['I am always hungry at home'],
  },
  {
    id: 'ab_locked',
    category: 'abuse_disclosure',
    severity: 'medium',
    template: '(locked|lock) me (in|out|inside)',
    examples: ['they locked me out'],
  },

  // --- strong distress -----------------------------------------------------------------------------
  {
    id: 'di_unloved',
    category: 'distress',
    severity: 'medium',
    template:
      '(nobody|no one|nobody dey) (loves|love|likes|like|cares about|care about|wants|want) me',
    examples: ['nobody loves me', 'no one likes me'],
  },
  {
    id: 'di_hated',
    category: 'distress',
    severity: 'medium',
    template: '(everybody|everyone|all of them) hates me',
    examples: ['everybody hates me'],
  },
  {
    id: 'di_hate_life',
    category: 'distress',
    severity: 'medium',
    template: 'i hate (my life|myself|my self)',
    examples: ['I hate my life'],
  },
  {
    id: 'di_cry',
    category: 'distress',
    severity: 'medium',
    template: 'i (cry|dey cry) (every|each) (day|night)',
    examples: ['I cry every night'],
  },
  {
    id: 'di_all_time',
    category: 'distress',
    severity: 'medium',
    template: 'i (am|feel) [so|very] (sad|scared|lonely|afraid|worried) (all the time|every day)',
    examples: ['I feel sad all the time'],
  },
  {
    id: 'di_bullied',
    category: 'distress',
    severity: 'medium',
    template: '(they|everyone|the boys|the girls|children) (bully|bullies|tease|teases) me',
    examples: ['they bully me'],
  },
  {
    id: 'di_bullied2',
    category: 'distress',
    severity: 'medium',
    template: 'i am [being] bullied',
    examples: ['I am being bullied'],
  },
  {
    id: 'di_no_friends',
    category: 'distress',
    severity: 'low',
    template: '(i have no friends|i am all alone|i am lonely)',
    examples: ['I have no friends'],
  },
  {
    id: 'di_sad',
    category: 'distress',
    severity: 'low',
    template: 'i am [so|very] (sad|scared|afraid|frightened)',
    examples: ['I am very sad'],
  },
  {
    id: 'di_pidgin',
    category: 'distress',
    severity: 'low',
    template: '(i dey fear|body dey fear me|i dey cry|my heart dey pain me)',
    examples: ['i dey fear'],
  },
  {
    id: 'di_mummy',
    category: 'distress',
    severity: 'low',
    template: 'i want (my mummy|my mum|my daddy|to go home)',
    examples: ['I want my mummy'],
  },
];
