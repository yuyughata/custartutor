// The worked example in the system prompt: P1 Basic Science, Term 1, Unit 2 "Exploring Our Environment (Part 2)",
// the golden unit transcribed from the owner's template PDF (packages/content-schema/src/fixtures/golden-unit2.ts),
// trimmed to what teaches shape and voice and written in the AUTHORING format. Every sentence of text is the
// golden unit's own (a test checks that each string occurs in the fixture); the only changes are structural:
// ids become refs, and a tutor line that graded a question owned by another section lists the accepted answers.
//
// It lives here as data, not as an import of the fixture, because the fixtures are deliberately kept out of the
// vendored edge bundle.
import type {
  AuthorBlock,
  AuthorQuestion,
  AuthorSectionBody,
  AuthorTutorLine,
  ManualOutput,
  WorkbookOutput,
} from './schemas';

function block(partial: Partial<AuthorBlock> & Pick<AuthorBlock, 'type'>): AuthorBlock {
  // keys in schema order (type first), so the rendered example matches the format the model must write
  const { type, ...rest } = partial;
  return {
    type,
    text: '',
    label: '',
    brief: '',
    alt: '',
    tone: 'none',
    items: [],
    headers: [],
    rows: [],
    question_ref: '',
    ...rest,
  };
}

const para = (text: string) => block({ type: 'paragraph', text });
const bullets = (...texts: string[]) =>
  block({ type: 'bullets', items: texts.map((text) => ({ head: '', text })) });
const example = (label: string, text: string) => block({ type: 'example', label, text });
const illustration = (brief: string, alt: string) => block({ type: 'illustration', brief, alt });
const callout = (tone: 'info' | 'tip' | 'not_yet', text: string) =>
  block({ type: 'callout', tone, text });
const steps = (...items: [string, string][]) =>
  block({ type: 'activity_steps', items: items.map(([head, text]) => ({ head, text })) });
const ask = (question_ref: string) => block({ type: 'question', question_ref });

function question(
  partial: Partial<AuthorQuestion> & Pick<AuthorQuestion, 'ref' | 'kind' | 'prompt'>,
): AuthorQuestion {
  const { ref, kind, prompt, ...rest } = partial;
  return {
    ref,
    kind,
    tier: 1,
    prompt,
    hint: '',
    explanation: '',
    skill_tag: '',
    options: [],
    answers: [],
    blanks: [],
    numeric: false,
    units: [],
    pairs: [],
    checks: [],
    exemplar: '',
    ...rest,
  };
}

function line(partial: Partial<AuthorTutorLine> & Pick<AuthorTutorLine, 'say'>): AuthorTutorLine {
  const { say, ...rest } = partial;
  return {
    say,
    accepted: [],
    question_ref: '',
    on_correct: [],
    on_incorrect: [],
    hint: [],
    ...rest,
  };
}

export interface ExemplarSection {
  /** `type — "heading"`. */
  caption: string;
  body: AuthorSectionBody;
}

export const EXEMPLAR_SECTIONS: readonly ExemplarSection[] = [
  {
    caption: 'story_opener — "Come and Explore! (Our Story)"',
    body: {
      blocks: [
        para(
          'Zari and Zuri now know that their environment is everything around them. Today they want to explore it more.',
        ),
        para(
          '“Our school has so many places!” said Zuri. They peeped into the classroom, ran across the playground, found the toilets, and waved at the teachers in the staff room.',
        ),
        para('“And our homes have many places too,” said Zari. “Come, let us explore them all!”'),
        illustration(
          'Zari and Zuri exploring their school — classroom, playground, toilets and staff room — with the teacher.',
          'Two children, Zari and Zuri, walk around their school with a teacher. Behind them are a classroom, a playground and the toilets.',
        ),
      ],
      questions: [],
      tutor_script: [
        line({
          say: 'Hello! Zari and Zuri are going to explore today. Let us listen to their story together.',
        }),
        line({
          say: 'Where did Zari and Zuri go to explore first?',
          accepted: ['school', 'their school', 'the school', 'to school'],
          on_correct: ['Yes! They explored their school. Well done!'],
          on_incorrect: [
            'Not quite. They peeped into the classroom and ran across the playground. Where are those places?',
          ],
          hint: ['Think about where there is a classroom and a playground.'],
        }),
        line({ say: 'Their homes have many places too. Are you ready to explore with them?' }),
      ],
    },
  },
  {
    caption: 'remember — "Remember?"',
    body: {
      blocks: [
        para(
          'Last week we learned that our environment is everything around us, and we used our five senses.',
        ),
        para('**Quick — name the five senses!** (see, hear, smell, touch, taste)'),
      ],
      questions: [],
      tutor_script: [
        line({
          say: 'Last week we used our five senses. Can you tell me one of them?',
          accepted: [
            'see',
            'hear',
            'smell',
            'touch',
            'taste',
            'seeing',
            'hearing',
            'smelling',
            'touching',
            'tasting',
          ],
          on_correct: ['Yes, that is one of our five senses!'],
          on_incorrect: [
            'Our five senses are see, hear, smell, touch and taste. Can you say one of them?',
          ],
          hint: ['We see with our eyes. What do we do with our ears?'],
        }),
      ],
    },
  },
  {
    caption: 'concept — "Places in Our School"',
    body: {
      blocks: [
        para('Our school has many places. In each place we do something different:'),
        bullets(
          'The **classroom** — where we learn.',
          'The **playground** — where we play.',
          'The **toilet** — where we wash and keep clean.',
          'The **staff room** — where our teachers work and rest.',
        ),
      ],
      questions: [],
      tutor_script: [
        line({
          say: 'Our school has many places. Where do we learn?',
          accepted: ['classroom', 'the classroom', 'in the classroom'],
          on_correct: ['Yes! We learn in the classroom.'],
          on_incorrect: ['We learn in the classroom. Say it with me: classroom.'],
          hint: ['It is the place with desks and a board.'],
        }),
        line({
          say: 'And where do we play?',
          accepted: ['playground', 'the playground', 'at the playground'],
          on_correct: ['Yes, we play on the playground!'],
          on_incorrect: ['We play on the playground.'],
          hint: ['It is the open place outside where we run and play.'],
        }),
      ],
    },
  },
  {
    caption:
      'concept — "Staying Safe in Our Environment" (a concept section that owns one question and lets the tutor grade it)',
    body: {
      blocks: [
        para('We must always stay safe:'),
        bullets(
          'Do not touch fire or hot things in the kitchen.',
          'Do not play near dirty water or deep gutters.',
          "Hold a grown-up's hand near the road.",
          'Tell a grown-up at once if something is not safe.',
        ),
        ask('gutter'),
      ],
      questions: [
        question({
          ref: 'gutter',
          kind: 'mcq',
          tier: 1,
          prompt: 'Should you play near a deep gutter? Yes or no?',
          skill_tag: 'staying_safe',
          options: ['Yes', 'No'],
          answers: ['No'],
          explanation: 'No. A deep gutter is not safe to play near.',
        }),
      ],
      tutor_script: [
        line({
          say: 'Here is a safety question. Is it safe to play near a deep gutter?',
          question_ref: 'gutter',
          on_correct: ['That is right. We never play near a deep gutter.'],
          on_incorrect: [
            'No, it is not safe. A deep gutter can hurt us. We tell a grown-up if something is not safe.',
          ],
          hint: ['Think about what could happen if you fell in.'],
        }),
      ],
    },
  },
  {
    caption: 'worked_examples — "Let\'s Look Together (Examples)"',
    body: {
      blocks: [
        example(
          'Example 1 — Places',
          'Where do we cook food? The kitchen. Where do we sleep? The bedroom. Where do we learn? The classroom.',
        ),
        example(
          'Example 2 — People',
          'Who teaches you at school? The teacher. Who lives beside your house? A neighbour.',
        ),
        example(
          'Example 3 — Safe or not?',
          'Point to one safe thing and one thing that is not safe that you can see right now.',
        ),
      ],
      questions: [],
      tutor_script: [],
    },
  },
  {
    caption: 'do_and_discover — "Do & Discover: Our Places Walk"',
    body: {
      blocks: [
        para('Walk with your teacher around the school. As you go:'),
        steps(
          ['NAME', 'each place you pass — classroom, playground, toilet, staff room.'],
          ['TELL', 'what we do in each place.'],
          ['GREET', 'wave and greet one person you meet — a teacher or a friend.'],
        ),
        para('**At home:** with a grown-up, walk through your home and name every room.'),
        illustration(
          'Children on a walk around the school, naming the playground and toilets, greeting a teacher.',
          'A group of children walk with their teacher past the playground and the toilets. One child waves hello to the teacher.',
        ),
      ],
      questions: [],
      tutor_script: [],
    },
  },
  {
    caption: 'character_values — "Keeping Our Environment Clean"',
    body: {
      blocks: [
        para('A good child keeps their environment clean and safe:'),
        bullets(
          'Put rubbish in the bin, not on the ground.',
          'Keep your classroom and your bedroom tidy.',
          'Do not draw on the walls.',
          'Wash your hands after using the toilet.',
        ),
        para('When we keep our environment clean, everyone stays **healthy and happy.**'),
      ],
      questions: [],
      tutor_script: [
        line({
          say: 'A good child keeps their environment clean. Where does rubbish go?',
          accepted: ['bin', 'the bin', 'dustbin', 'the dustbin'],
          on_correct: ['Yes! Rubbish goes in the bin.'],
          on_incorrect: ['Rubbish goes in the bin, not on the ground. Say it with me: bin.'],
          hint: ['It is the container we use to keep the place tidy.'],
        }),
      ],
    },
  },
  {
    caption: 'tell_it_back — "Tell It Back & My Notebook"',
    body: {
      blocks: [
        para('**Tell a friend:** "In my home there is a ____ and a ____." (name two rooms.)'),
        para(
          '**In my notebook:** I draw my favourite place in my school or home, and I write its name under it.',
        ),
      ],
      questions: [],
      tutor_script: [],
    },
  },
  {
    caption:
      'practice — "Practice Time (Workbook Tiers 1 to 3)": tiers 1, 2 and 3 are all present, every question is placed with a question block',
    body: {
      blocks: [
        callout(
          'info',
          'Exercises move from supported (Tier 1) to independent (Tier 3). You can check your answers at the back of your workbook.',
        ),
        ask('match_places'),
        ask('circle_people'),
        ask('fill_cook'),
        ask('neighbour'),
        ask('two_places'),
        ask('keep_clean'),
      ],
      questions: [
        question({
          ref: 'match_places',
          kind: 'match',
          tier: 1,
          prompt: 'Match the place to what we do there. Draw a line to join them.',
          skill_tag: 'places_and_uses',
          hint: 'Where do we cook? Where do we sleep?',
          pairs: [
            { left: 'Kitchen', right: 'Cook' },
            { left: 'Bedroom', right: 'Sleep' },
            { left: 'Playground', right: 'Play' },
            { left: 'Classroom', right: 'Learn' },
            { left: 'Bathroom', right: 'Bath' },
          ],
          explanation:
            'Kitchen-Cook, Bedroom-Sleep, Playground-Play, Classroom-Learn, Bathroom-Bath.',
        }),
        question({
          ref: 'circle_people',
          kind: 'circle',
          tier: 1,
          prompt: 'Circle the people you meet at school.',
          skill_tag: 'people_in_environment',
          options: ['teacher', 'friend', 'classmate', 'astronaut'],
          answers: ['teacher', 'friend', 'classmate'],
          explanation:
            'A teacher, a friend and a classmate. An astronaut is not someone we meet at school.',
        }),
        question({
          ref: 'fill_cook',
          kind: 'fill_blank',
          tier: 2,
          prompt: 'Fill in the blank. We cook our food in the ____.',
          skill_tag: 'places_and_uses',
          blanks: [['kitchen', 'the kitchen']],
        }),
        question({
          ref: 'neighbour',
          kind: 'free_text',
          tier: 2,
          prompt: 'Write the name of one person who lives near your home.',
          skill_tag: 'people_in_environment',
          checks: ['Names a real person who lives near the child (a neighbour).'],
          exemplar: 'Mama Tolu',
          explanation: 'Any correct answer: a neighbour is someone who lives near your home.',
        }),
        question({
          ref: 'two_places',
          kind: 'free_text',
          tier: 3,
          prompt: 'Name two places in your school and say what we do in each one.',
          skill_tag: 'places_and_uses',
          checks: [
            'Names two different places in the school.',
            'Says what we do in each place, correctly.',
          ],
          exemplar: 'Classroom: we learn. Playground: we play.',
        }),
        question({
          ref: 'keep_clean',
          kind: 'free_text',
          tier: 3,
          prompt: 'Keeping clean. Write one way you can keep your classroom clean.',
          skill_tag: 'caring_for_environment',
          checks: ['Gives one sensible way to keep the classroom clean.'],
          exemplar: 'I put rubbish in the bin.',
        }),
      ],
      tutor_script: [],
    },
  },
  {
    caption:
      'think_deeper — "Think Deeper" (this unit moves from absorb to connect, so the prompts sit on the connect rung)',
    body: {
      blocks: [
        bullets(
          'Why do we cook food in the kitchen and not in the bedroom?',
          'Which is safe: playing on the playground, or playing near a deep gutter?',
          'Same or different: how is your classroom different from your bedroom?',
          'What would happen if nobody kept the classroom clean?',
        ),
      ],
      questions: [],
      tutor_script: [],
    },
  },
  {
    caption:
      'quick_fire — "Quick-Fire! (Answer Fast)": short tier 1 questions, one or two words each',
    body: {
      blocks: [ask('learn'), ask('cook'), ask('gutter')],
      questions: [
        question({
          ref: 'learn',
          kind: 'fill_blank',
          tier: 1,
          prompt: 'Where do we learn in school? ____',
          skill_tag: 'places_and_uses',
          blanks: [['classroom', 'the classroom', 'in the classroom']],
        }),
        question({
          ref: 'cook',
          kind: 'fill_blank',
          tier: 1,
          prompt: 'Where is food cooked at home? ____',
          skill_tag: 'places_and_uses',
          blanks: [['kitchen', 'the kitchen', 'in the kitchen']],
        }),
        question({
          ref: 'gutter',
          kind: 'mcq',
          tier: 1,
          prompt: 'Should you play near a deep gutter? Yes or no?',
          skill_tag: 'staying_safe',
          options: ['Yes', 'No'],
          answers: ['No'],
          explanation: 'No. A deep gutter is not safe to play near.',
        }),
      ],
      tutor_script: [],
    },
  },
  {
    caption:
      'mastery_check — "Have I Got It? (Mastery Check)": "I can ..." items that the app can grade by itself, then a not_yet callout',
    body: {
      blocks: [
        para('You have mastered this unit when you can:'),
        ask('places'),
        ask('people'),
        ask('safe_clean'),
        callout(
          'not_yet',
          '**Not yet?** Take another short places-walk and name each place aloud, then try again. We move on when you are ready.',
        ),
      ],
      questions: [
        question({
          ref: 'places',
          kind: 'sort',
          tier: 2,
          prompt: 'I can name places at school and at home. Put each place where it belongs.',
          skill_tag: 'places_and_uses',
          hint: 'Think about where you find each place.',
          pairs: [
            { left: 'classroom', right: 'At school' },
            { left: 'playground', right: 'At school' },
            { left: 'staff room', right: 'At school' },
            { left: 'kitchen', right: 'At home' },
            { left: 'bedroom', right: 'At home' },
            { left: 'living room', right: 'At home' },
          ],
        }),
        question({
          ref: 'people',
          kind: 'match',
          tier: 2,
          prompt:
            'I can name the people in my environment. Match where we are to the people we meet.',
          skill_tag: 'people_in_environment',
          hint: 'Who do you see at home? At school? Near your home?',
          pairs: [
            { left: 'At home', right: 'family' },
            { left: 'At school', right: 'teachers and friends' },
            { left: 'Near our home', right: 'neighbours' },
          ],
        }),
        question({
          ref: 'safe_clean',
          kind: 'circle',
          tier: 2,
          prompt:
            'I can say one way to stay safe and one way to keep my environment clean. Circle everything that keeps us safe or keeps our environment clean.',
          skill_tag: 'staying_safe',
          hint: 'Three are good choices. Three are not.',
          options: [
            "Hold a grown-up's hand near the road",
            'Play near a deep gutter',
            'Put rubbish in the bin',
            'Draw on the walls',
            'Touch the fire in the kitchen',
            'Wash your hands after using the toilet',
          ],
          answers: [
            "Hold a grown-up's hand near the road",
            'Put rubbish in the bin',
            'Wash your hands after using the toilet',
          ],
        }),
      ],
      tutor_script: [],
    },
  },
];

export const EXEMPLAR_WORKBOOK: WorkbookOutput = {
  tier1_title: "Let's Start Together",
  tier2_title: 'Now You Try',
  tier3_title: 'Stretch Yourself',
  drill: [
    question({
      ref: 'learn',
      kind: 'fill_blank',
      tier: 1,
      prompt: 'We learn in the ____.',
      skill_tag: 'places_and_uses',
      blanks: [['classroom', 'the classroom', 'school', 'the school']],
    }),
    question({
      ref: 'rubbish',
      kind: 'fill_blank',
      tier: 1,
      prompt: 'Rubbish goes in the ____.',
      skill_tag: 'caring_for_environment',
      blanks: [['bin', 'the bin', 'dustbin', 'the dustbin']],
    }),
  ],
  drill_seconds: 60,
  take_it_home:
    'This evening, walk through your home with a grown-up. Name every room, and help to tidy one of them.',
  application: question({
    ref: 'take_it_home',
    kind: 'draw',
    tier: 3,
    prompt:
      'Take It Home. This evening, walk through your home with a grown-up. Name every room, and help to tidy one of them.',
    skill_tag: 'places_and_uses',
    checks: [
      'I walked through my home with a grown-up.',
      'I named every room.',
      'I helped to tidy one room.',
    ],
  }),
  not_yet:
    'Take another short places-walk and name each place aloud, then try again. We move on when you are ready.',
  variants: [
    {
      questions: [
        question({
          ref: 'play',
          kind: 'mcq',
          tier: 1,
          prompt: 'Where do we play at school?',
          skill_tag: 'places_and_uses',
          options: ['classroom', 'playground', 'staff room'],
          answers: ['playground'],
        }),
        question({
          ref: 'sit',
          kind: 'fill_blank',
          tier: 2,
          prompt: 'The family sits together in the ____.',
          skill_tag: 'places_and_uses',
          blanks: [['living room', 'the living room']],
        }),
      ],
    },
  ],
};

export const EXEMPLAR_MANUAL: ManualOutput = {
  script: [
    {
      section_id: 'come_and_explore',
      say: 'Read the story slowly and point to the picture. Pause after "Come, let us explore them all!"',
      ask: 'Where did Zari and Zuri go to explore first?',
      watch_for: 'Children who name only one place. Invite them to name another from the story.',
    },
    {
      section_id: 'places_in_school',
      say: 'Read each place and point to it if you can see it from where you are. Say: "classroom, where we learn."',
      ask: 'What do we do on the playground? What do we do in the toilet?',
      watch_for:
        'Children mixing up the toilet at school (wash and keep clean) with the bathroom at home.',
    },
  ],
  theme_lenses: [
    {
      subject: 'Basic Science',
      lens: 'Observation',
      what_child_does: 'Names and describes the places and people in school and at home.',
    },
    {
      subject: 'English Studies',
      lens: 'Language',
      what_child_does: 'Says "In my home there is a ... and a ..." and names rooms aloud.',
    },
  ],
  connection_moment:
    'Today we looked at our school and our home as scientists who observe, as speakers who name things, and as helpers who keep our places clean and safe.',
  materials: [
    'Chalk or marker and a board, to list places and people.',
    "Crayons or coloured pencils and each child's notebook, for the My Notebook drawing.",
    'A bin or basket, to show that rubbish goes in the bin.',
  ],
  got_it: [
    'Names at least three places in school and three places at home.',
    'Names the people in the environment: family, teacher, friend, neighbour.',
    'Says one way to stay safe and one way to keep the environment clean.',
  ],
  not_yet_guidance:
    'Take another short places-walk and name each place aloud, then try again. Move on only when the child is ready; mastery sets the pace, not the calendar.',
  helper_script: [
    {
      section_id: 'come_and_explore',
      steps: [
        'Read the story aloud, one paragraph at a time.',
        'Point to the picture and ask the child what they can see.',
        'Ask where Zari and Zuri went first. Wait for the answer; do not answer for the child.',
      ],
    },
  ],
};

function compactList(items: readonly unknown[]): string {
  return items.length === 0
    ? '[]'
    : `[\n  ${items.map((item) => JSON.stringify(item)).join(',\n  ')}\n]`;
}

export function renderSectionBody(body: AuthorSectionBody): string {
  return `{\n"blocks": ${compactList(body.blocks)},\n"questions": ${compactList(body.questions)},\n"tutor_script": ${compactList(body.tutor_script)}\n}`;
}

/** The worked-example part of the system prompt. */
export function renderExemplar(): string {
  const parts: string[] = [
    '## WORKED EXAMPLE',
    '',
    'Below is a real unit from the owner\'s template: Primary 1 Basic Science, Term 1, Unit 2, "Exploring Our Environment (Part 2)", stage absorb to connect, scheme topic "Exploring Our Environment (Part 2)". It is shown in the authoring format. Study its shape, its rhythm, its voice and how much each section holds. Do not copy its content into another unit.',
    '',
    'Notes on reading it:',
    "- The template's five enrichment sections are story_opener, remember, do_and_discover, character_values and tell_it_back; a unit may use 2 to 5 enrichment sections (the owner's decision), and later units rotate the set.",
    "- The ids you see in the teacher's-manual example below (come_and_explore, places_in_school) belong to the template. In your task you are given the ids to use.",
    '- Its story puts two characters in one scene. That is storytelling, not a fact you may reuse about the cast (see the cast rules).',
    '',
  ];
  for (const { caption, body } of EXEMPLAR_SECTIONS) {
    parts.push(`### Section: ${caption}`, renderSectionBody(body), '');
  }
  parts.push(
    '### Workbook parts (the tiers themselves come from the practice section; these are the rest)',
    JSON.stringify(EXEMPLAR_WORKBOOK, null, 1),
    '',
    "### Teacher's manual parts (script per section, theme map, materials, mastery guidance, helper script)",
    JSON.stringify(EXEMPLAR_MANUAL, null, 1),
  );
  return parts.join('\n');
}
