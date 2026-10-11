import type { Question } from '../question';
import type { LessonUnit } from '../unit';
import { ask, bullets, callout, example, illustration, node, para, steps } from './helpers';

/**
 * ILLUSTRATIVE fixture, NOT drawn from a verified NERDC scheme of work.
 *
 * A hand-built P1 Mathematics lesson on the brief's "Market Day" theme (brief section 8: Mathematics lens
 * "Value": count goods, read prices in naira and kobo, add two purchases, work out change). It exists to
 * prove the schema is not overfitted to the Basic Science golden unit (plan section 4, freeze test): it
 * exercises numeric `fill_blank` answers (units such as the naira sign, fractions), tables, dialogue,
 * definitions and the `window_to_world` section. The objective wording below is ours, not NERDC's.
 * Numbers are kept small (money up to 10 naira).
 */

const naira = ['₦', 'naira'];

const questions: Record<string, Question> = {
  // ---- Workbook tier 1: count and read ----
  m_count_mangoes: {
    id: 'm_count_mangoes',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'Count the mangoes on the tray. How many mangoes are there? ____',
    skill_tag: 'counting_goods',
    hint: 'Touch each mango once and say the numbers in order.',
    answer: { blanks: [{ accepted: ['7', 'seven'], numeric: true }] },
  },
  m_read_price: {
    id: 'm_read_price',
    kind: 'mcq',
    tier: 1,
    prompt: 'Look at the price board. What is the price of one mango?',
    skill_tag: 'reading_prices',
    options: ['₦2', '₦3', '₦5'],
    answer: { correct_index: 1 },
  },
  m_kobo: {
    id: 'm_kobo',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'How many kobo make ₦1? ____',
    skill_tag: 'reading_prices',
    answer: { blanks: [{ accepted: ['100'], numeric: true }] },
    explanation: '100 kobo make ₦1.',
  },
  m_share_half: {
    id: 'm_share_half',
    kind: 'fill_blank',
    tier: 1,
    prompt:
      'Two friends share one loaf of bread fairly. What part of the loaf does each friend get? ____',
    skill_tag: 'reading_prices',
    hint: 'Each friend gets the same amount.',
    answer: { blanks: [{ accepted: ['1/2', '0.5', 'half'], numeric: true }] },
    explanation: 'Each friend gets one half, which we can write as 1/2 or 0.5.',
  },
  // ---- Workbook tier 2: add two purchases ----
  m_add_mango_orange: {
    id: 'm_add_mango_orange',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'A mango costs ₦3. An orange costs ₦2. Together they cost ₦____.',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['5'], numeric: true, units: naira }] },
  },
  m_add_banana_bread: {
    id: 'm_add_banana_bread',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'Zuri buys a banana for ₦1 and a loaf of bread for ₦7. She pays ₦____ in all.',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['8'], numeric: true, units: naira }] },
  },
  // ---- Workbook tier 3: find change ----
  m_change_bread: {
    id: 'm_change_bread',
    kind: 'fill_blank',
    tier: 3,
    prompt: 'Zuri pays ₦10 for a loaf of bread that costs ₦7. Her change is ₦____.',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['3'], numeric: true, units: naira }] },
  },
  m_change_mango: {
    id: 'm_change_mango',
    kind: 'fill_blank',
    tier: 3,
    prompt: 'Zari pays ₦5 for a mango that costs ₦3. Her change is ₦____.',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['2'], numeric: true, units: naira }] },
  },
  // ---- Application task ----
  m_application: {
    id: 'm_application',
    kind: 'free_text',
    tier: 3,
    prompt:
      'With a grown-up, look at two things in a shop or market. Say each price. Add the two prices. If you paid with a ₦10 coin, what would your change be? Write or tell what you found.',
    skill_tag: 'finding_change',
    rubric: {
      criteria: [
        'Names two goods and their prices.',
        'Adds the two prices correctly.',
        'Works out the change from ₦10 correctly (or says why ₦10 is not enough).',
      ],
    },
  },
  // ---- Quick-answer drill ----
  md_1: {
    id: 'md_1',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦1 + ₦1 = ₦____',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['2'], numeric: true, units: naira }] },
  },
  md_2: {
    id: 'md_2',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦2 + ₦3 = ₦____',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['5'], numeric: true, units: naira }] },
  },
  md_3: {
    id: 'md_3',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦4 + ₦4 = ₦____',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['8'], numeric: true, units: naira }] },
  },
  md_4: {
    id: 'md_4',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦10 − ₦5 = ₦____',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['5'], numeric: true, units: naira }] },
  },
  md_5: {
    id: 'md_5',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦10 − ₦7 = ₦____',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['3'], numeric: true, units: naira }] },
  },
  // ---- Quick-fire ----
  mq_1: {
    id: 'mq_1',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦3 + ₦3 = ₦____',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['6'], numeric: true, units: naira }] },
  },
  mq_2: {
    id: 'mq_2',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦9 − ₦4 = ₦____',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['5'], numeric: true, units: naira }] },
  },
  mq_3: {
    id: 'mq_3',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'How many kobo make ₦1? ____',
    skill_tag: 'reading_prices',
    answer: { blanks: [{ accepted: ['100'], numeric: true }] },
  },
  mq_4: {
    id: 'mq_4',
    kind: 'fill_blank',
    tier: 1,
    prompt: 'Half of ₦8 is ₦____.',
    skill_tag: 'reading_prices',
    answer: { blanks: [{ accepted: ['4'], numeric: true, units: naira }] },
  },
  mq_5: {
    id: 'mq_5',
    kind: 'fill_blank',
    tier: 1,
    prompt: '₦10 − ₦6 = ₦____',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['4'], numeric: true, units: naira }] },
  },
  // ---- Mastery check ----
  mm_count: {
    id: 'mm_count',
    kind: 'fill_blank',
    tier: 2,
    prompt:
      'Zuri puts 4 oranges in a basket. Then she puts in 3 more. How many oranges are in the basket? ____',
    skill_tag: 'counting_goods',
    answer: { blanks: [{ accepted: ['7', 'seven'], numeric: true }] },
  },
  mm_add: {
    id: 'mm_add',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'A mango costs ₦3 and a loaf of bread costs ₦7. Together they cost ₦____.',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['10'], numeric: true, units: naira }] },
  },
  mm_change: {
    id: 'mm_change',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'Zari pays ₦10 for groundnuts that cost ₦4. Her change is ₦____.',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['6'], numeric: true, units: naira }] },
  },
  // ---- Practice variants ----
  va_1: {
    id: 'va_1',
    kind: 'fill_blank',
    tier: 2,
    prompt: '₦2 + ₦6 = ₦____',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['8'], numeric: true, units: naira }] },
  },
  va_2: {
    id: 'va_2',
    kind: 'fill_blank',
    tier: 2,
    prompt: 'A banana costs ₦1 and a mango costs ₦3. Together they cost ₦____.',
    skill_tag: 'adding_purchases',
    answer: { blanks: [{ accepted: ['4'], numeric: true, units: naira }] },
  },
  va_3: {
    id: 'va_3',
    kind: 'mcq',
    tier: 2,
    prompt: 'Which two goods cost ₦6 together? Mango ₦3, orange ₦2, groundnuts ₦4, banana ₦1.',
    skill_tag: 'adding_purchases',
    options: ['mango and orange', 'orange and groundnuts', 'banana and mango'],
    answer: { correct_index: 1 },
  },
  vc_1: {
    id: 'vc_1',
    kind: 'fill_blank',
    tier: 3,
    prompt: 'Pay ₦5 for something that costs ₦2. Change: ₦____.',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['3'], numeric: true, units: naira }] },
  },
  vc_2: {
    id: 'vc_2',
    kind: 'fill_blank',
    tier: 3,
    prompt: 'Pay ₦10 for something that costs ₦9. Change: ₦____.',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['1'], numeric: true, units: naira }] },
  },
  vc_3: {
    id: 'vc_3',
    kind: 'fill_blank',
    tier: 3,
    prompt: 'Pay ₦6 for something that costs ₦4. Change: ₦____.',
    skill_tag: 'finding_change',
    answer: { blanks: [{ accepted: ['2'], numeric: true, units: naira }] },
  },
};

export const marketDayMathsUnit: LessonUnit = {
  schema_version: 1,
  kind: 'lesson',
  header: {
    subject_slug: 'mathematics',
    level_code: 'P1',
    term: 2,
    chapter: { number: 2, title: 'Money and Shopping' },
    unit_no: 6,
    week_no: 9,
    title: 'Market Day: Prices and Change',
    objective:
      'Count goods, read prices in naira and kobo, add two purchases, and find change (using coins up to 10 naira).',
    stage: 'connect',
    theme: { slug: 'market-day', title: 'Market Day', lens: 'Value' },
  },
  sections: [
    {
      id: 'market_story',
      type: 'story_opener',
      layer: 'ENRICH',
      heading: 'Come to the Market!',
      blocks: [
        para('Saturday is market day. Zari and Zuri go to the market with Mama.'),
        {
          type: 'dialogue',
          lines: [
            { character: 'Zuri', text: 'Look at all the oranges! How many are there?' },
            { character: 'Trader', text: 'Count them and see! Each orange costs ₦2.' },
            { character: 'Zari', text: 'We have ₦10. What can we buy?' },
          ],
        },
        illustration(
          'A busy Nigerian market. A trader stands behind a table of oranges, mangoes and bread. Zari and Zuri hold their coins.',
          'Zari and Zuri at a market stall with a trader. The table has oranges, mangoes and loaves of bread.',
        ),
      ],
      tutor_script: {
        nodes: [
          node('n_intro', 'Zari and Zuri are at the market. The oranges cost ₦2 each.', {
            next: 'n_price',
          }),
          node('n_price', 'How much does one orange cost?', {
            expect: { accepted: ['2', '₦2', '2 naira', 'two naira'] },
            on_correct: ['Yes! One orange costs ₦2.'],
            on_incorrect: ['Listen again. The trader said each orange costs ₦2.'],
            hint: ['It is the number after the naira sign.'],
          }),
        ],
      },
    },
    {
      id: 'counting_goods',
      type: 'concept',
      layer: 'CORE',
      heading: 'Counting Goods',
      blocks: [
        para('At the market, traders sell many things. We count them to know how many there are.'),
        {
          type: 'definition',
          term: 'goods',
          meaning: 'Things that people sell, like fruit and bread.',
        },
        bullets(
          'Touch each good once.',
          'Say the numbers in order: 1, 2, 3.',
          'The last number tells how many.',
        ),
      ],
      tutor_script: {
        nodes: [
          node(
            'n_count',
            'Zuri puts 4 oranges in a basket. Then she puts in 3 more. How many now?',
            {
              expect: { question_id: 'mm_count' },
              on_correct: ['Yes, 7 oranges. You counted well!'],
              on_incorrect: ['Count again. Start with 4, then count on: 5, 6, 7.'],
              hint: ['Hold up 4 fingers, then add 3 more.'],
            },
          ),
        ],
      },
    },
    {
      id: 'reading_prices',
      type: 'concept',
      layer: 'CORE',
      heading: 'Reading Prices',
      blocks: [
        para('Every good has a price. The price is the money we pay for it.'),
        { type: 'definition', term: 'price', meaning: 'The money we pay for something.' },
        para('In Nigeria we pay in naira (₦) and kobo (k). 100 kobo make ₦1.'),
        {
          type: 'table',
          headers: ['Goods', 'Price'],
          rows: [
            ['Banana', '₦1'],
            ['Orange', '₦2'],
            ['Mango', '₦3'],
            ['Groundnuts', '₦4'],
            ['Bread', '₦7'],
          ],
        },
        para('Today we use whole naira coins up to ₦10.'),
      ],
    },
    {
      id: 'adding_purchases',
      type: 'concept',
      layer: 'CORE',
      heading: 'Adding Two Purchases',
      blocks: [
        para('Sometimes we buy two things. We add the two prices to find the total.'),
        { type: 'definition', term: 'total', meaning: 'All the money for everything we buy.' },
        para('A banana costs ₦1. Groundnuts cost ₦4. We add: 1 + 4 = 5. The total is ₦5.'),
      ],
    },
    {
      id: 'finding_change',
      type: 'concept',
      layer: 'CORE',
      heading: 'Finding Change',
      blocks: [
        para(
          'We often pay with a coin that is more than the price. The trader gives some money back.',
        ),
        { type: 'definition', term: 'change', meaning: 'The money the trader gives back to us.' },
        para('To find the change, take the price away from the money we gave.'),
        para('**Money given − price = change**'),
      ],
    },
    {
      id: 'market_examples',
      type: 'worked_examples',
      layer: 'CORE',
      heading: "Let's Shop Together (Examples)",
      blocks: [
        example(
          'Example 1 — Counting',
          'There are 6 oranges on the tray. We count: 1, 2, 3, 4, 5, 6. There are 6 oranges.',
        ),
        example(
          'Example 2 — Adding',
          'A mango costs ₦3. An orange costs ₦2. We add: 3 + 2 = 5. We pay ₦5.',
        ),
        example(
          'Example 3 — Change',
          'Zuri pays ₦10 for bread that costs ₦7. We take away: 10 − 7 = 3. The trader gives ₦3 change.',
        ),
      ],
    },
    {
      id: 'market_play',
      type: 'do_and_discover',
      layer: 'ENRICH',
      heading: 'Do & Discover: Play Market',
      blocks: [
        para('Set up a pretend market in your classroom or at home.'),
        steps(
          [
            'SET UP',
            'Put fruit, bottle caps or pictures on a table. Write a price on a card for each one.',
          ],
          ['BUY', 'One child is the trader. The other buys two things and adds the prices.'],
          [
            'GIVE CHANGE',
            'Pay with a paper ₦10 coin. The trader works out the change and gives it back.',
          ],
        ),
        para('Swap places. Then the buyer becomes the trader.'),
      ],
    },
    {
      id: 'market_window',
      type: 'window_to_world',
      layer: 'ENRICH',
      heading: 'Window to the World',
      blocks: [
        para(
          'In Nigeria we pay with naira and kobo. People in other countries use different money.',
        ),
        bullets(
          { lead: 'Ghana', text: 'People pay with cedis and pesewas.' },
          { lead: 'Kenya', text: 'People pay with shillings and cents.' },
          { lead: 'Every country', text: 'Prices are numbers we add and take away.' },
        ),
        illustration(
          'Coins and notes from Nigeria, Ghana and Kenya laid out side by side on a table.',
          'Coins and notes from three different countries on a table.',
        ),
      ],
    },
    {
      id: 'market_practice',
      type: 'practice',
      layer: 'CORE',
      heading: 'Practice Time (Workbook Tiers 1 to 3)',
      blocks: [
        illustration('A tray holding seven mangoes in a row.', 'A tray with seven mangoes on it.'),
        ask('m_count_mangoes'),
        ask('m_read_price'),
        ask('m_kobo'),
        ask('m_share_half'),
        ask('m_add_mango_orange'),
        ask('m_add_banana_bread'),
        ask('m_change_bread'),
        ask('m_change_mango'),
      ],
    },
    {
      id: 'market_think',
      type: 'think_deeper',
      layer: 'CORE+',
      heading: 'Think Deeper',
      blocks: [
        bullets(
          'Same or different: five ₦1 coins and one ₦5 coin?',
          'Why do you think the trader gives you change?',
          'What would happen if the trader did not give you change?',
        ),
      ],
    },
    {
      id: 'market_quick_fire',
      type: 'quick_fire',
      layer: 'CORE',
      heading: 'Quick-Fire! (Answer Fast)',
      blocks: [ask('mq_1'), ask('mq_2'), ask('mq_3'), ask('mq_4'), ask('mq_5')],
    },
    {
      id: 'market_mastery',
      type: 'mastery_check',
      layer: 'CORE',
      heading: 'Have I Got It? (Mastery Check)',
      blocks: [
        para('You have mastered this unit when you can:'),
        ask('mm_count'),
        ask('mm_add'),
        ask('mm_change'),
        callout(
          'not_yet',
          '**Not yet?** Play Market again with a friend and shop for two things. Then try again. We move on when you are ready.',
        ),
      ],
    },
  ],
  questions,
  session_plan: [
    {
      period: 1,
      sections: [
        'market_story',
        'counting_goods',
        'reading_prices',
        'adding_purchases',
        'market_play',
        'market_quick_fire',
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
        'finding_change',
        'market_examples',
        'market_window',
        'market_practice',
        'market_think',
        'market_mastery',
      ],
      minutes: [
        { segment: 'start', minutes: 10 },
        { segment: 'teach', minutes: 15 },
        { segment: 'move_and_do', minutes: 10 },
        { segment: 'practice', minutes: 15 },
        { segment: 'close', minutes: 10 },
      ],
    },
  ],
  workbook: {
    intro:
      'Exercises move from supported (Tier 1) to independent (Tier 3). Answers are at the back for self-checking.',
    tiers: [
      {
        tier: 1,
        title: "Let's Start Together",
        question_ids: ['m_count_mangoes', 'm_read_price', 'm_kobo', 'm_share_half'],
      },
      { tier: 2, title: 'Now You Try', question_ids: ['m_add_mango_orange', 'm_add_banana_bread'] },
      { tier: 3, title: 'Stretch Yourself', question_ids: ['m_change_bread', 'm_change_mango'] },
    ],
    quick_answer_drill: {
      seconds: 60,
      question_ids: ['md_1', 'md_2', 'md_3', 'md_4', 'md_5'],
    },
    take_it_home:
      'This week, go to a shop or market with a grown-up. Pick two things, add their prices, and work out the change from ₦10.',
    application_task_id: 'm_application',
    answers_note:
      '1. 7; ₦3; 100 kobo; one half (1/2 or 0.5). 2. ₦5; ₦8. 3. ₦3; ₦2. Quick-Answer: 2; 5; 8; 5; 3.',
    not_yet: 'Play Market again with a friend and shop for two things. Then try again.',
    practice_variants: [
      { id: 'variant_adding', question_ids: ['va_1', 'va_2', 'va_3'] },
      { id: 'variant_change', question_ids: ['vc_1', 'vc_2', 'vc_3'] },
    ],
  },
  teacher_manual: {
    script: [
      {
        section_id: 'market_story',
        say: 'Read the dialogue with three voices: Zuri, the trader and Zari. Show the picture.',
        ask: 'How much does one orange cost?',
        watch_for: 'Children who say how many oranges instead of the price.',
      },
      {
        section_id: 'counting_goods',
        say: 'Count real objects aloud, touching each one once. Let children count with you.',
        ask: 'How many are there? How do you know?',
        watch_for: 'Children who count one object twice or skip one. Slow down and touch each one.',
      },
      {
        section_id: 'reading_prices',
        say: 'Point to the naira sign and say "naira". Read each price on the board.',
        ask: 'What is the price of a mango?',
        watch_for: 'Confusion between the price and the number of goods.',
      },
      {
        section_id: 'adding_purchases',
        say: 'Use two cards with prices. Put them side by side and add them with coins.',
        ask: 'What is the total for a banana and groundnuts?',
        watch_for: 'Children who give only one of the two prices.',
      },
      {
        section_id: 'finding_change',
        say: 'Hand a child a paper ₦10 coin. Take one price away with real coins and let the child count the change.',
        ask: 'Why does the trader give money back?',
        watch_for: 'Children who add instead of taking away.',
      },
      {
        section_id: 'market_examples',
        say: 'Do the three examples at the board, then let children do them with coins.',
        ask: 'Which sum do we use to find the change?',
        watch_for: 'Mixing up adding (total) and taking away (change).',
      },
      {
        section_id: 'market_play',
        say: 'Set up two or three market tables. Walk around and listen to the prices and the change.',
        ask: 'What did you buy? How much did you pay?',
        watch_for: 'Children who give wrong change. Let their partner check with coins.',
      },
      {
        section_id: 'market_window',
        say: 'Show the picture of coins. Say the names of the money in each country.',
        ask: 'Is the idea of adding prices the same in every country?',
        watch_for: 'Curiosity. Welcome every question about other places.',
      },
      {
        section_id: 'market_think',
        say: 'Ask one prompt at a time and wait for answers.',
        ask: 'Why do you think the trader gives you change?',
        watch_for: 'Reasons about fairness. Praise the reasoning.',
      },
      {
        section_id: 'market_mastery',
        say: 'Give each child the three questions alone, with coins on the desk.',
        ask: 'Can you find the change from ₦10 for groundnuts at ₦4?',
        watch_for: 'Which of counting, adding and change each child still finds hard.',
      },
    ],
    theme_map: {
      lenses: [
        {
          subject: 'Mathematics',
          lens: 'Value',
          what_child_does:
            'Counts goods, reads prices in naira and kobo, adds two purchases and works out change.',
        },
        {
          subject: 'English Studies',
          lens: 'Language',
          what_child_does:
            'Names and describes the goods; acts a buyer and seller dialogue; retells the trip.',
        },
        {
          subject: 'Social Studies',
          lens: 'Community',
          what_child_does:
            'Finds out who works at the market and why people trade; needs versus wants.',
        },
        {
          subject: 'Basic Science',
          lens: 'Observation',
          what_child_does:
            'Finds where goods come from; sorts them as fruit, vegetable or grain; why some spoil.',
        },
        {
          subject: 'Civic Education',
          lens: 'Behaviour',
          what_child_does: 'Practises honest measuring, fairness and not cheating.',
        },
      ],
      connection_moment:
        'Today we looked at the market as mathematicians who count and add money, as writers who name and describe goods, as scientists who ask where goods come from, and as fair and honest buyers and sellers.',
    },
    timing:
      'Two 60-minute periods. Period 1: story (10), counting, prices and adding (15), Play Market (15), practice (10), Quick-Fire (10). Period 2: recap (10), finding change and examples (15), Window to the World (10), workbook practice (15), Think Deeper and the mastery check (10).',
    materials: [
      'Paper or cardboard coins marked ₦1, ₦2, ₦5 and ₦10 (children can make them).',
      'Real or picture fruit (oranges, mangoes, bananas) and bottle caps for counting.',
      'Price cards written with a marker.',
      'A small basket or tray for the pretend market.',
    ],
    mastery_guidance: {
      got_it: [
        'Counts a set of up to 10 goods correctly.',
        'Adds two prices that total 10 naira or less.',
        'Finds the change from a ₦10 coin when the price is under ₦10.',
      ],
      not_yet:
        'Play Market again with real or paper coins, taking one step at a time: count, add, then give change. Try the check again when the child is ready.',
    },
    helper_script: [
      {
        section_id: 'market_story',
        steps: [
          'Read the story aloud and show the picture.',
          'Ask: How much does one orange cost? Wait for the answer.',
        ],
      },
      {
        section_id: 'market_play',
        steps: [
          'Set out the goods and price cards with the child.',
          'Be the trader first. Let the child buy two things and add the prices.',
          'Swap roles so the child gives the change.',
        ],
      },
      {
        section_id: 'market_mastery',
        steps: [
          'Read each question aloud and let the child use coins to work it out.',
          'Do not give the answer. If the child is stuck, say that it is fine to try again another day.',
        ],
      },
    ],
  },
};
