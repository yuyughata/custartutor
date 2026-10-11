import type { MiniProjectUnit } from '../unit';
import { ask, callout, node, para } from './helpers';

/**
 * Mini-project fixture: P1 Basic Science, Term 1, Week 4 "Colour Identification" (scheme of work). The
 * objective is the scheme's week-4 breakdown, joined in order. Steps, materials, rubric and prompts are
 * authored for this fixture. Materials are local and low cost.
 */
export const colourChartProject: MiniProjectUnit = {
  schema_version: 1,
  kind: 'mini_project',
  header: {
    subject_slug: 'basic-science',
    level_code: 'P1',
    term: 1,
    chapter: { number: 1, title: 'Our World Around Us' },
    unit_no: 4,
    week_no: 4,
    title: 'Our Colour Chart',
    objective:
      'Identifying primary colours: red, blue, yellow; identifying secondary colours: green, orange, purple; identifying other common colours: black, white, brown, pink, grey; colours in our environment: colour of sky, grass, sun, etc.; sorting and grouping objects by colour; mixing colours (practical activity with paints/crayons).',
    stage: 'absorb',
    stage_to: 'connect',
  },
  brief:
    'Make a colour chart of the world around you. Find things of each colour, sort them into boxes, and mix two colours to make a new one.',
  steps: [
    {
      n: 1,
      text: 'Take a big sheet of paper. Draw 12 boxes on it, 3 boxes across and 4 boxes down.',
    },
    {
      n: 2,
      text: 'Write a colour name at the top of each box: red, blue, yellow, green, orange, purple, black, white, brown, pink, grey. Leave the last box for "My mix".',
    },
    {
      n: 3,
      text: 'Go on a colour hunt at school or at home with a grown-up. Find small safe things of each colour: leaves, fallen petals, cloth scraps, bottle caps, old paper.',
    },
    {
      n: 4,
      text: 'Stick or draw each thing in the box with its colour. Look at the colour of the sky, the grass and the sun, and colour a small picture of each.',
    },
    {
      n: 5,
      text: 'Mix colours with crayons or paints. Yellow and blue make green. Red and yellow make orange. Red and blue make purple. Colour your best mix in the "My mix" box.',
    },
    {
      n: 6,
      text: 'Show your chart to a grown-up. Point to each box and say the colour out loud.',
    },
  ],
  materials: [
    'A big sheet of paper, or a flattened cardboard box.',
    'Crayons or coloured pencils (or paints and a brush).',
    'Starch paste, gum or tape to stick things down.',
    'Small safe things from home or school: leaves, fallen petals, cloth scraps, bottle caps, old magazine pictures.',
    'A cup of water and an old rag, if using paints.',
  ],
  rubric: [
    {
      criterion: 'Names colours',
      levels: [
        { level: 1, descriptor: 'Names one to three colours, with help.' },
        { level: 2, descriptor: 'Names the three primary colours: red, blue and yellow.' },
        { level: 3, descriptor: 'Names the primary and secondary colours.' },
        { level: 4, descriptor: 'Names primary, secondary and other common colours without help.' },
      ],
    },
    {
      criterion: 'Sorts by colour',
      levels: [
        { level: 1, descriptor: 'Puts some things in the right box, with help.' },
        { level: 2, descriptor: 'Puts most things in the right box.' },
        { level: 3, descriptor: 'Puts every thing in the right box.' },
        { level: 4, descriptor: 'Sorts every thing and can say why it belongs in its box.' },
      ],
    },
    {
      criterion: 'Mixes colours',
      levels: [
        { level: 1, descriptor: 'Tries mixing two colours, with help.' },
        { level: 2, descriptor: 'Mixes two colours and says the new colour.' },
        { level: 3, descriptor: 'Mixes two different pairs and names both new colours.' },
        { level: 4, descriptor: 'Says which two colours make green, orange and purple.' },
      ],
    },
    {
      criterion: 'Care and tidiness',
      levels: [
        { level: 1, descriptor: 'Needs reminders to tidy up.' },
        { level: 2, descriptor: 'Tidies up when asked.' },
        { level: 3, descriptor: 'Keeps the work area tidy and puts rubbish in the bin.' },
      ],
    },
  ],
  evidence_options: ['photo', 'drawing', 'audio', 'text'],
  reflection_prompts: [
    'Which colour did you find the most things of?',
    'Which two colours did you mix, and what new colour did you make?',
    'What colour is the sky? The grass? The sun?',
  ],
  tutor_script: {
    nodes: [
      node(
        'n_start',
        'Let us make a colour chart! First, can you name a colour you can see right now?',
        {
          expect: {
            accepted: [
              'red',
              'blue',
              'yellow',
              'green',
              'orange',
              'purple',
              'black',
              'white',
              'brown',
              'pink',
              'grey',
              'gray',
            ],
          },
          on_correct: ['Yes, that is a colour! Good looking.'],
          on_incorrect: ['Look around you. Can you see something red, or blue, or green?'],
          hint: ['Look at the sky, the grass or your clothes.'],
          next: 'n_mix',
        },
      ),
      node('n_mix', 'What colour do you make when you mix blue and yellow?', {
        expect: { question_id: 'colour_mix_green' },
        on_correct: ['Yes! Blue and yellow make green.'],
        on_incorrect: ['Try mixing blue and yellow crayons on paper. What do you see?'],
        hint: ['Think about the colour of grass.'],
      }),
    ],
  },
  sections: [
    {
      id: 'colour_check',
      type: 'project_part',
      layer: 'CORE',
      heading: 'Check Your Colours',
      blocks: [
        para('Before you finish your chart, check what you know about mixing.'),
        ask('colour_mix_green'),
        callout('tip', 'You can mix the colours on a piece of scrap paper first.'),
      ],
    },
  ],
  questions: {
    colour_mix_green: {
      id: 'colour_mix_green',
      kind: 'mcq',
      tier: 1,
      prompt: 'What colour do you make when you mix blue and yellow?',
      skill_tag: 'mixing_colours',
      options: ['green', 'orange', 'purple'],
      answer: { correct_index: 0 },
      explanation: 'Blue and yellow make green.',
    },
  },
};
