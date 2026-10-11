import type { Question } from '../question';
import type { LessonUnit } from '../unit';
import { ask, bullets, callout, example, illustration, node, para, steps } from './helpers';

/**
 * GOLDEN UNIT: P1 Basic Science, Term 1, Chapter 1 "Our World Around Us", Unit/Week 2
 * "Exploring Our Environment (Part 2)". Transcribed from
 * docs/reference/P1_BasicScience_T1_Unit2_Template.pdf (pages 1-3 textbook, 4-5 workbook).
 *
 * DECISION: enrichment count. The template shows FIVE enrichment-tagged sections (Come and Explore!,
 * Remember?, Do & Discover, Keeping Our Environment Clean, Tell It Back & My Notebook), but the brief
 * (section 3.7 and 7) and the plan (section 4 lint: "2-3 enrichment sections", an ERROR) allow two or three.
 * To keep the content faithful AND pass lint, this fixture keeps three enrichment sections
 * (story_opener, remember, do_and_discover) and:
 *   - folds "Keeping Our Environment Clean" into the CORE concept section "Staying Safe in Our
 *     Environment" (it is the NERDC subtopic "taking care of our environment (keeping it clean)", so it is
 *     core content, not enrichment);
 *   - folds "Tell It Back & My Notebook" into the workbook: its "Tell a friend" and "In my notebook"
 *     prompts become the application task (`wb_application`), beside `take_it_home`.
 * The real template therefore exceeds the brief's own 2-3 rule; this should be raised with the author.
 *
 * Other deliberate additions the PDF does not contain (marked here so reviewers can find them):
 *   - a `practice` section ("Practice Time"): the lint requires one, and in the template the practice IS the
 *     workbook, so the section simply places the workbook's Tier 1-3 questions in the lesson flow;
 *   - `header.theme`, `teacher_manual`, `session_plan`, `practice_variants` and the tutor scripts are
 *     authored here (the template shows textbook and workbook pages only);
 *   - Think Deeper is tagged CORE+ (brief section 7); the template prints it as CORE.
 * Where the template uses a deterministic answer ("Name one person in your family") the fixture uses
 * `free_text` (graded online); everything else is graded offline.
 *
 * Allowed lint WARNING for this fixture: `no_global_window` (the template has no Window to the World).
 */

const questions: Record<string, Question> = {
  // ---- Workbook, Tier 1 ----
  wb_match_places: {
    id: 'wb_match_places',
    kind: 'match',
    tier: 1,
    prompt: 'Match the place to what we do there. Draw a line to join them.',
    skill_tag: 'places_and_uses',
    hint: 'Where do we cook? Where do we sleep?',
    answer: {
      pairs: [
        { left: 'Kitchen', right: 'Cook' },
        { left: 'Bedroom', right: 'Sleep' },
        { left: 'Playground', right: 'Play' },
        { left: 'Classroom', right: 'Learn' },
        { left: 'Bathroom', right: 'Bath' },
      ],
    },
    explanation: 'Kitchen-Cook, Bedroom-Sleep, Playground-Play, Classroom-Learn, Bathroom-Bath.',
  },
  wb_circle_people: {
    id: 'wb_circle_people',
    kind: 'circle',
    tier: 1,
    prompt: 'Circle the people you meet at school.',
    skill_tag: 'people_in_environment',
    options: ['teacher', 'friend', 'classmate', 'astronaut'],
    answer: { correct: ['teacher', 'friend', 'classmate'] },
    explanation:
      'A teacher, a friend and a classmate. An astronaut is not someone we meet at school.',
  },
  // ---- Workbook, Tier 2 ----
  wb_fill_cook: {
    id: 'wb_fill_cook',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'Fill in the blank. We cook our food in the ____.',
    skill_tag: 'places_and_uses',
    answer: { blanks: [{ accepted: ['kitchen', 'the kitchen'] }] },
  },
  wb_fill_sleep: {
    id: 'wb_fill_sleep',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'Fill in the blank. We sleep in the ____.',
    skill_tag: 'places_and_uses',
    answer: { blanks: [{ accepted: ['bedroom', 'bed room', 'the bedroom'] }] },
  },
  wb_neighbour: {
    id: 'wb_neighbour',
    kind: 'free_text',
    tier: 2,
    prompt: 'Write the name of one person who lives near your home.',
    skill_tag: 'people_in_environment',
    rubric: {
      criteria: ['Names a real person who lives near the child (a neighbour).'],
      exemplar: 'Mama Tolu',
    },
    explanation: 'Any correct answer: a neighbour is someone who lives near your home.',
  },
  // ---- Workbook, Tier 3 ----
  wb_two_places: {
    id: 'wb_two_places',
    kind: 'free_text',
    tier: 3,
    prompt: 'Name two places in your school and say what we do in each one.',
    skill_tag: 'places_and_uses',
    rubric: {
      criteria: [
        'Names two different places in the school.',
        'Says what we do in each place, correctly.',
      ],
      exemplar: 'Classroom: we learn. Playground: we play.',
    },
  },
  wb_keep_clean: {
    id: 'wb_keep_clean',
    kind: 'free_text',
    tier: 3,
    prompt: 'Keeping clean. Write one way you can keep your classroom clean.',
    skill_tag: 'caring_for_environment',
    rubric: {
      criteria: ['Gives one sensible way to keep the classroom clean.'],
      exemplar: 'I put rubbish in the bin.',
    },
  },
  // ---- Application task (from Tell It Back & My Notebook) ----
  wb_application: {
    id: 'wb_application',
    kind: 'draw',
    tier: 3,
    prompt:
      'Tell a friend: “In my home there is a ____ and a ____.” (Name two rooms.) Then, in my notebook: I draw my favourite place in my school or home, and I write its name under it.',
    skill_tag: 'places_and_uses',
    self_check: [
      'I told a friend two rooms in my home.',
      'I drew my favourite place.',
      'I wrote its name under my drawing.',
    ],
  },
  // ---- Quick-Answer Drill (60 seconds) ----
  dr_learn: {
    id: 'dr_learn',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'We learn in the ____.',
    skill_tag: 'places_and_uses',
    answer: { blanks: [{ accepted: ['classroom', 'the classroom', 'school', 'the school'] }] },
  },
  dr_cook: {
    id: 'dr_cook',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'We cook in the ____.',
    skill_tag: 'places_and_uses',
    answer: { blanks: [{ accepted: ['kitchen', 'the kitchen'] }] },
  },
  dr_teacher: {
    id: 'dr_teacher',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'Our teacher works at ____.',
    skill_tag: 'people_in_environment',
    answer: {
      blanks: [{ accepted: ['school', 'the school', 'staff room', 'the staff room'] }],
    },
  },
  dr_rubbish: {
    id: 'dr_rubbish',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'Rubbish goes in the ____.',
    skill_tag: 'caring_for_environment',
    answer: { blanks: [{ accepted: ['bin', 'the bin', 'dustbin', 'the dustbin'] }] },
  },
  dr_family: {
    id: 'dr_family',
    kind: 'free_text',
    tier: 1,
    prompt: 'Name one person in your family.',
    skill_tag: 'people_in_environment',
    rubric: {
      criteria: ['Names a member of the child’s own family (any family member is correct).'],
      exemplar: 'Mummy',
    },
  },
  // ---- Quick-Fire! (Answer Fast) ----
  qf_learn: {
    id: 'qf_learn',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'Where do we learn in school? ____',
    skill_tag: 'places_and_uses',
    answer: { blanks: [{ accepted: ['classroom', 'the classroom', 'in the classroom'] }] },
  },
  qf_cook: {
    id: 'qf_cook',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'Where is food cooked at home? ____',
    skill_tag: 'places_and_uses',
    answer: { blanks: [{ accepted: ['kitchen', 'the kitchen', 'in the kitchen'] }] },
  },
  qf_teacher: {
    id: 'qf_teacher',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'Who teaches you at school? ____',
    skill_tag: 'people_in_environment',
    answer: { blanks: [{ accepted: ['teacher', 'the teacher', 'my teacher', 'teachers'] }] },
  },
  qf_clean: {
    id: 'qf_clean',
    kind: 'free_text',
    tier: 1,
    prompt: 'Name one way to keep your environment clean.',
    skill_tag: 'caring_for_environment',
    rubric: {
      criteria: [
        'Names one sensible way: rubbish in the bin, keeping the classroom or bedroom tidy, not drawing on walls, or washing hands after using the toilet.',
      ],
      exemplar: 'Put rubbish in the bin.',
    },
  },
  qf_gutter: {
    id: 'qf_gutter',
    kind: 'mcq',
    tier: 1,
    prompt: 'Should you play near a deep gutter? Yes or no?',
    skill_tag: 'staying_safe',
    options: ['Yes', 'No'],
    answer: { correct_index: 1 },
    explanation: 'No. A deep gutter is not safe to play near.',
  },
  // ---- Mastery check (Have I Got It?) ----
  mc_places: {
    id: 'mc_places',
    kind: 'sort',
    tier: 2,
    prompt: 'I can name places at school and at home. Put each place where it belongs.',
    skill_tag: 'places_and_uses',
    hint: 'Think about where you find each place.',
    items: ['classroom', 'playground', 'staff room', 'kitchen', 'bedroom', 'living room'],
    categories: ['At school', 'At home'],
    answer: {
      mapping: {
        classroom: 'At school',
        playground: 'At school',
        'staff room': 'At school',
        kitchen: 'At home',
        bedroom: 'At home',
        'living room': 'At home',
      },
    },
  },
  mc_people: {
    id: 'mc_people',
    kind: 'match',
    tier: 2,
    prompt: 'I can name the people in my environment. Match where we are to the people we meet.',
    skill_tag: 'people_in_environment',
    hint: 'Who do you see at home? At school? Near your home?',
    answer: {
      pairs: [
        { left: 'At home', right: 'family' },
        { left: 'At school', right: 'teachers and friends' },
        { left: 'Near our home', right: 'neighbours' },
      ],
    },
  },
  mc_safe_clean: {
    id: 'mc_safe_clean',
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
    answer: {
      correct: [
        "Hold a grown-up's hand near the road",
        'Put rubbish in the bin',
        'Wash your hands after using the toilet',
      ],
    },
  },
  // ---- Practice variants ("more practice" pool) ----
  va_play: {
    id: 'va_play',
    kind: 'mcq',
    tier: 1,
    prompt: 'Where do we play at school?',
    skill_tag: 'places_and_uses',
    options: ['classroom', 'playground', 'staff room'],
    answer: { correct_index: 1 },
  },
  va_sit: {
    id: 'va_sit',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'The family sits together in the ____.',
    skill_tag: 'places_and_uses',
    answer: { blanks: [{ accepted: ['living room', 'the living room'] }] },
  },
  va_match: {
    id: 'va_match',
    kind: 'match',
    tier: 2,
    prompt: 'Match the place to what happens there.',
    skill_tag: 'places_and_uses',
    answer: {
      pairs: [
        { left: 'Toilet', right: 'We wash' },
        { left: 'Staff room', right: 'Teachers rest' },
        { left: 'Bedroom', right: 'We sleep' },
      ],
    },
  },
  vb_safe: {
    id: 'vb_safe',
    kind: 'mcq',
    tier: 1,
    prompt: 'Which one is safe?',
    skill_tag: 'staying_safe',
    options: [
      'Touching hot things in the kitchen',
      "Holding a grown-up's hand near the road",
      'Playing near a deep gutter',
    ],
    answer: { correct_index: 1 },
  },
  vb_neighbours: {
    id: 'vb_neighbours',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'The people who live near our home are our ____.',
    skill_tag: 'people_in_environment',
    answer: { blanks: [{ accepted: ['neighbours', 'neighbors', 'neighbour'] }] },
  },
  vb_clean: {
    id: 'vb_clean',
    kind: 'circle',
    tier: 2,
    prompt: 'Circle the ways to keep our environment clean.',
    skill_tag: 'caring_for_environment',
    options: [
      'Put rubbish in the bin',
      'Draw on the walls',
      'Keep your bedroom tidy',
      'Throw rubbish on the ground',
    ],
    answer: { correct: ['Put rubbish in the bin', 'Keep your bedroom tidy'] },
  },
};

export const goldenUnit2: LessonUnit = {
  schema_version: 1,
  kind: 'lesson',
  header: {
    subject_slug: 'basic-science',
    level_code: 'P1',
    term: 1,
    chapter: { number: 1, title: 'Our World Around Us' },
    unit_no: 2,
    week_no: 2,
    title: 'Exploring Our Environment (Part 2)',
    objective:
      'Explore the school environment (classroom, playground, toilet, staff room) and the home environment (bedroom, kitchen, living room, bathroom, compound); identify the people in our environment; understand safety; take care of our environment by keeping it clean.',
    stage: 'absorb',
    stage_to: 'connect',
    theme: { slug: 'my-school-and-home', title: 'My School and My Home', lens: 'Observation' },
  },
  sections: [
    {
      id: 'come_and_explore',
      type: 'story_opener',
      layer: 'ENRICH',
      heading: 'Come and Explore! (Our Story)',
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
      tutor_script: {
        nodes: [
          node(
            'n_intro',
            'Hello! Zari and Zuri are going to explore today. Let us listen to their story together.',
            { next: 'n_ask' },
          ),
          node('n_ask', 'Where did Zari and Zuri go to explore first?', {
            expect: { accepted: ['school', 'their school', 'the school', 'to school'] },
            on_correct: ['Yes! They explored their school. Well done!'],
            on_incorrect: [
              'Not quite. They peeped into the classroom and ran across the playground. Where are those places?',
            ],
            hint: ['Think about where there is a classroom and a playground.'],
          }),
          node('n_next', 'Their homes have many places too. Are you ready to explore with them?'),
        ],
      },
    },
    {
      id: 'remember_senses',
      type: 'remember',
      layer: 'ENRICH',
      heading: 'Remember?',
      blocks: [
        para(
          'Last week we learned that our environment is everything around us, and we used our five senses.',
        ),
        para('**Quick — name the five senses!** (see, hear, smell, touch, taste)'),
        para('Today we explore the PLACES and the PEOPLE in our environment.'),
      ],
      tutor_script: {
        nodes: [
          node('n_recall', 'Last week we used our five senses. Can you tell me one of them?', {
            expect: {
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
            },
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
      id: 'places_in_school',
      type: 'concept',
      layer: 'CORE',
      heading: 'Places in Our School',
      blocks: [
        para('Our school has many places. In each place we do something different:'),
        bullets(
          'The **classroom** — where we learn.',
          'The **playground** — where we play.',
          'The **toilet** — where we wash and keep clean.',
          'The **staff room** — where our teachers work and rest.',
        ),
      ],
      tutor_script: {
        nodes: [
          node('n_learn', 'Our school has many places. Where do we learn?', {
            expect: { question_id: 'qf_learn' },
            on_correct: ['Yes! We learn in the classroom.'],
            on_incorrect: ['We learn in the classroom. Say it with me: classroom.'],
            hint: ['It is the place with desks and a board.'],
          }),
          node('n_play', 'And where do we play?', {
            expect: { accepted: ['playground', 'the playground', 'at the playground'] },
            on_correct: ['Yes, we play on the playground!'],
            on_incorrect: ['We play on the playground.'],
            hint: ['It is the open place outside where we run and play.'],
          }),
        ],
      },
    },
    {
      id: 'places_in_home',
      type: 'concept',
      layer: 'CORE',
      heading: 'Places in Our Home',
      blocks: [
        para('Our home has many places too:'),
        bullets(
          'The **bedroom** — where we sleep.',
          'The **kitchen** — where food is cooked.',
          'The **living room** — where the family sits together.',
          'The **bathroom** — where we bath and keep clean.',
          'The **compound** — the open space around the house.',
        ),
      ],
    },
    {
      id: 'people_in_environment',
      type: 'concept',
      layer: 'CORE',
      heading: 'People in Our Environment',
      blocks: [
        para('We are not alone. There are people all around us:'),
        bullets(
          'At home: our **family** — mummy, daddy, brothers and sisters.',
          'At school: our **teachers** and our **friends**.',
          'Near our home: our **neighbours**.',
        ),
        para('All these people are part of our environment.'),
      ],
    },
    {
      id: 'staying_safe',
      type: 'concept',
      layer: 'CORE',
      heading: 'Staying Safe in Our Environment',
      blocks: [
        para('We must always stay safe:'),
        bullets(
          'Do not touch fire or hot things in the kitchen.',
          'Do not play near dirty water or deep gutters.',
          "Hold a grown-up's hand near the road.",
          'Tell a grown-up at once if something is not safe.',
        ),
        // Folded in from the template's ENRICH-tagged "Keeping Our Environment Clean" (see file header).
        para('**Keeping Our Environment Clean**'),
        para('A good child keeps their environment clean and safe:'),
        bullets(
          'Put rubbish in the bin, not on the ground.',
          'Keep your classroom and your bedroom tidy.',
          'Do not draw on the walls.',
          'Wash your hands after using the toilet.',
        ),
        para('When we keep our environment clean, everyone stays **healthy and happy.**'),
      ],
      tutor_script: {
        nodes: [
          node('n_gutter', 'Here is a safety question. Is it safe to play near a deep gutter?', {
            expect: { question_id: 'qf_gutter' },
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
      id: 'lets_look_together',
      type: 'worked_examples',
      layer: 'CORE',
      heading: "Let's Look Together (Examples)",
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
    },
    {
      id: 'our_places_walk',
      type: 'do_and_discover',
      layer: 'ENRICH',
      heading: 'Do & Discover: Our Places Walk',
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
    },
    {
      id: 'practice_time',
      type: 'practice',
      layer: 'CORE',
      heading: 'Practice Time (Workbook Tiers 1 to 3)',
      blocks: [
        callout(
          'info',
          'Exercises move from supported (Tier 1) to independent (Tier 3). You can check your answers at the back of your workbook.',
        ),
        ask('wb_match_places'),
        ask('wb_circle_people'),
        ask('wb_fill_cook'),
        ask('wb_fill_sleep'),
        ask('wb_neighbour'),
        ask('wb_two_places'),
        ask('wb_keep_clean'),
      ],
    },
    {
      id: 'think_deeper',
      type: 'think_deeper',
      layer: 'CORE+',
      heading: 'Think Deeper',
      blocks: [
        bullets(
          'Why do we cook food in the kitchen and not in the bedroom?',
          'Which is safe: playing on the playground, or playing near a deep gutter?',
          'Same or different: how is your classroom different from your bedroom?',
          'What would happen if nobody kept the classroom clean?',
        ),
      ],
    },
    {
      id: 'quick_fire',
      type: 'quick_fire',
      layer: 'CORE',
      heading: 'Quick-Fire! (Answer Fast)',
      blocks: [
        ask('qf_learn'),
        ask('qf_cook'),
        ask('qf_teacher'),
        ask('qf_clean'),
        ask('qf_gutter'),
      ],
    },
    {
      id: 'have_i_got_it',
      type: 'mastery_check',
      layer: 'CORE',
      heading: 'Have I Got It? (Mastery Check)',
      blocks: [
        para('You have mastered this unit when you can:'),
        ask('mc_places'),
        ask('mc_people'),
        ask('mc_safe_clean'),
        callout(
          'not_yet',
          '**Not yet?** Take another short places-walk and name each place aloud, then try again. We move on when you are ready.',
        ),
      ],
    },
  ],
  questions,
  session_plan: [
    {
      period: 1,
      sections: [
        'come_and_explore',
        'remember_senses',
        'places_in_school',
        'places_in_home',
        'our_places_walk',
        'quick_fire',
      ],
      minutes: [
        { segment: 'start', minutes: 10 },
        { segment: 'teach', minutes: 15 },
        { segment: 'move_and_do', minutes: 15 },
        { segment: 'practice', minutes: 10 },
        { segment: 'close', minutes: 10 },
      ],
    },
    {
      period: 2,
      sections: [
        'people_in_environment',
        'staying_safe',
        'lets_look_together',
        'practice_time',
        'think_deeper',
        'have_i_got_it',
      ],
      minutes: [
        { segment: 'start', minutes: 10 },
        { segment: 'teach', minutes: 20 },
        { segment: 'move_and_do', minutes: 10 },
        { segment: 'practice', minutes: 10 },
        { segment: 'close', minutes: 10 },
      ],
    },
  ],
  workbook: {
    intro:
      'Exercises move from supported (Tier 1) to independent (Tier 3). Answers are at the back for self-checking. Real print pages will carry pictures where words are shown in brackets.',
    tiers: [
      {
        tier: 1,
        title: "Let's Start Together",
        question_ids: ['wb_match_places', 'wb_circle_people'],
      },
      {
        tier: 2,
        title: 'Now You Try',
        question_ids: ['wb_fill_cook', 'wb_fill_sleep', 'wb_neighbour'],
      },
      {
        tier: 3,
        title: 'Stretch Yourself',
        question_ids: ['wb_two_places', 'wb_keep_clean'],
      },
    ],
    quick_answer_drill: {
      seconds: 60,
      question_ids: ['dr_learn', 'dr_cook', 'dr_teacher', 'dr_rubbish', 'dr_family'],
    },
    take_it_home:
      'This evening, walk through your home with a grown-up. Name every room, and help to tidy one of them.',
    application_task_id: 'wb_application',
    answers_note:
      '1. Kitchen–Cook, Bedroom–Sleep, Playground–Play, Classroom–Learn, Bathroom–Bath. 2. teacher, friend, classmate (not astronaut). 3. kitchen. 4. bedroom. 6–7. any correct answers. Quick-Answer: classroom; kitchen; school; bin; any family member.',
    not_yet:
      'Take another short places-walk and name each place aloud, then try again. We move on when you are ready.',
    practice_variants: [
      { id: 'variant_places', question_ids: ['va_play', 'va_sit', 'va_match'] },
      { id: 'variant_safe_clean', question_ids: ['vb_safe', 'vb_neighbours', 'vb_clean'] },
    ],
  },
  teacher_manual: {
    script: [
      {
        section_id: 'come_and_explore',
        say: 'Read the story slowly and point to the picture. Pause after "Come, let us explore them all!"',
        ask: 'Where did Zari and Zuri go to explore first?',
        watch_for: 'Children who name only one place. Invite them to name another from the story.',
      },
      {
        section_id: 'remember_senses',
        say: 'Remind the class that the environment is everything around us. Touch your eyes, ears, nose, hand and tongue as you name each sense.',
        ask: 'Can you name the five senses?',
        watch_for:
          'Whether children recall all five. Give a clue with the action if a child is stuck.',
      },
      {
        section_id: 'places_in_school',
        say: 'Read each place and point to it if you can see it from where you are. Say: "classroom, where we learn."',
        ask: 'What do we do on the playground? What do we do in the toilet?',
        watch_for:
          'Children mixing up the toilet at school (wash and keep clean) with the bathroom at home.',
      },
      {
        section_id: 'places_in_home',
        say: 'Ask children to picture their own home as you read each room. Let two or three children describe their kitchen.',
        ask: 'Which room do you like best, and why?',
        watch_for:
          'Children whose homes have no separate living room; accept their own words for the family sitting place.',
      },
      {
        section_id: 'people_in_environment',
        say: 'Draw three circles on the board: home, school, near our home. Write one group of people in each.',
        ask: 'Who lives in your house? Who lives beside it?',
        watch_for:
          'Children who name only the immediate family; remind them that neighbours and friends are part of the environment.',
      },
      {
        section_id: 'staying_safe',
        say: 'Read the safety rules calmly and do the action for each (hold a hand, point to the bin). Keep it warm, never scary.',
        ask: 'What should you do if something is not safe?',
        watch_for: 'Anxiety. Stress that telling a grown-up is the brave and sensible thing to do.',
      },
      {
        section_id: 'lets_look_together',
        say: 'Do the three examples together, quickly, with the whole class answering aloud.',
        ask: 'Can you point to one safe thing and one thing that is not safe?',
        watch_for:
          'Children who point to something safe both times; ask them to look again for a danger.',
      },
      {
        section_id: 'our_places_walk',
        say: 'Lead the walk. Stop at each place and let a different child name it, tell what we do there, and greet a person.',
        ask: 'What is this place called? What do we do here?',
        watch_for: 'Quiet children. Give each child one place to name.',
      },
      {
        section_id: 'practice_time',
        say: 'Hand out the workbook. Tier 1 together, Tier 2 in pairs, Tier 3 alone.',
        ask: 'How did you know which place goes with which job?',
        watch_for: 'Children who only manage Tier 1. That is fine; note it for the mastery check.',
      },
      {
        section_id: 'think_deeper',
        say: 'Ask one prompt at a time and wait. Accept any sensible reason.',
        ask: 'Why do we cook food in the kitchen and not in the bedroom?',
        watch_for:
          'Reasons about safety and cleanliness. Praise the thinking, not only the answer.',
      },
      {
        section_id: 'quick_fire',
        say: 'Fire the five questions fast. Children answer aloud, together or one by one.',
        ask: 'Where do we learn in school? Where is food cooked at home?',
        watch_for: 'Hesitation. Repeat the question once, then move on and come back.',
      },
      {
        section_id: 'have_i_got_it',
        say: 'Give each child the three mastery questions on their own. Do not help with the answers.',
        ask: 'Can you put each place where it belongs?',
        watch_for: 'Which of the three "I can" statements each child cannot yet do.',
      },
    ],
    theme_map: {
      lenses: [
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
        {
          subject: 'Social Studies',
          lens: 'Community',
          what_child_does: 'Finds out who lives and works around us.',
        },
        {
          subject: 'Mathematics',
          lens: 'Value',
          what_child_does: 'Counts the rooms in a home and the people in a family.',
        },
        {
          subject: 'Civic Education',
          lens: 'Behaviour',
          what_child_does: 'Keeps the places we share clean and safe.',
        },
      ],
      connection_moment:
        'Today we looked at our school and our home as scientists who observe, as speakers who name things, and as helpers who keep our places clean and safe.',
    },
    timing:
      'Two 60-minute periods. Period 1: story and recall (10), places in school and home (15), Our Places Walk (15), oral practice (10), Quick-Fire (10). Period 2: recap (10), people and safety (20), examples (10), workbook practice (10), Think Deeper and the mastery check (10).',
    materials: [
      'Chalk or marker and a board, to list places and people.',
      "Crayons or coloured pencils and each child's notebook, for the My Notebook drawing.",
      'A bin or basket, to show that rubbish goes in the bin.',
      'Picture cards of school and home places (optional; hand-drawn is fine).',
    ],
    mastery_guidance: {
      got_it: [
        'Names at least three places in school and three places at home.',
        'Names the people in the environment: family, teacher, friend, neighbour.',
        'Says one way to stay safe and one way to keep the environment clean.',
      ],
      not_yet:
        'Take another short places-walk and name each place aloud, then try again. Move on only when the child is ready; mastery sets the pace, not the calendar.',
    },
    helper_script: [
      {
        section_id: 'come_and_explore',
        steps: [
          'Read the story aloud, one paragraph at a time.',
          'Point to the picture and ask the child what they can see.',
          'Ask where Zari and Zuri went first. Wait for the answer; do not answer for the child.',
        ],
      },
      {
        section_id: 'places_in_school',
        steps: [
          'Read each place aloud and point to the picture or the real place.',
          'Ask the child to say the place and what we do there.',
          'Praise every try. Say the right word gently if the child is unsure.',
        ],
      },
      {
        section_id: 'our_places_walk',
        steps: [
          'Walk slowly with the child through the school or the home.',
          'At each place, ask: What is this place? What do we do here?',
          'Help the child greet one person politely.',
        ],
      },
      {
        section_id: 'have_i_got_it',
        steps: [
          'Read each mastery question aloud and let the child tap the answer.',
          'Do not give hints or answers during the check.',
          'If the child is not yet ready, do a short places-walk and try again another day.',
        ],
      },
    ],
  },
};
