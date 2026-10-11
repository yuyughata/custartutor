import type { Scheme, SchemeWeek, WeekKind } from '../scheme';

/**
 * The NERDC Primary 1 Basic Science scheme of work, three terms of 13 weeks, transcribed from
 * docs/reference/P1_Basic_Science_Scheme_of_Work.pdf (pages 623-629 of the source compendium). Topics and
 * subtopics are copied exactly as printed (including the capitals of exam weeks and the en dashes).
 *
 * `kind` is our classification of each week: only `teaching` weeks become units. The PDF carries a
 * third-party watermark, so the PDF itself stays in docs/reference (private repo only).
 */

function week(week_no: number, kind: WeekKind, topic: string, subtopics: string[]): SchemeWeek {
  return { week_no, kind, topic, subtopics };
}

/** The weeks shared by every term: 5 mid-term exam, 6 break, 11 revision, 12 exam, 13 closing. */
function midTerm(): SchemeWeek[] {
  return [
    week(5, 'mid_term_exam', 'MID-TERM EXAMINATION', ['Assessment of Weeks 1–4']),
    week(6, 'break', 'MID-TERM BREAK', ['Holiday/Rest']),
  ];
}

function closing(revisionSubtopic: string): SchemeWeek[] {
  return [
    week(11, 'revision', 'REVISION', [revisionSubtopic]),
    week(12, 'exam', 'EXAMINATION', ['End of Term Assessment']),
    week(13, 'closing', 'CLOSING/VACATION', ['Term ends']),
  ];
}

export const p1BasicScienceTerm1: Scheme = {
  subject_slug: 'basic-science',
  level_code: 'P1',
  term: 1,
  weeks: [
    week(1, 'teaching', 'Exploring Our Environment (Part 1)', [
      'Understanding what an environment is',
      'Identifying our immediate surroundings (home, school, classroom)',
      'Naming things we see in our environment',
      'Describing our environment using our senses (what we see, hear, smell, touch, taste)',
      'Taking a nature walk around the school compound',
    ]),
    week(2, 'teaching', 'Exploring Our Environment (Part 2)', [
      'Exploring the school environment: classrooms, playground, toilets, staff room',
      'Exploring the home environment: bedroom, kitchen, living room, bathroom, compound',
      'Identifying people in our environment: family, teachers, friends, neighbours',
      'Understanding safety in our environment',
      'Taking care of our environment (keeping it clean)',
    ]),
    week(3, 'teaching', 'Exploring Other Parts of the Surrounding: Roads', [
      'Identifying roads in our community',
      'Types of roads: tarred roads, untarred roads, pathways',
      'Uses of roads: for vehicles, walking, bicycles',
      'Road safety: crossing the road safely, traffic lights (red, yellow, green)',
      'People who work on roads: drivers, road safety officials, road construction workers',
    ]),
    week(4, 'teaching', 'Colour Identification', [
      'Identifying primary colours: red, blue, yellow',
      'Identifying secondary colours: green, orange, purple',
      'Identifying other common colours: black, white, brown, pink, grey',
      'Colours in our environment: colour of sky, grass, sun, etc.',
      'Sorting and grouping objects by colour',
      'Mixing colours (practical activity with paints/crayons)',
    ]),
    ...midTerm(),
    week(7, 'teaching', 'Shapes (Part 1)', [
      'Identifying basic shapes: circle, square, triangle, rectangle',
      'Properties of shapes: sides and corners',
      'Finding shapes in our environment (windows, doors, wheels, balls)',
      'Drawing and tracing basic shapes',
      'Sorting objects by their shapes',
    ]),
    week(8, 'teaching', 'Shapes (Part 2)', [
      'Identifying more shapes: oval, diamond, star, heart',
      'Comparing shapes: big and small, same and different',
      'Creating patterns with shapes',
      'Using shapes to make pictures and designs',
      'Three-dimensional shapes: ball (sphere), box (cube), tin (cylinder)',
    ]),
    week(9, 'teaching', 'Living Things (Part 1)', [
      'Understanding what living things are',
      'Characteristics of living things: they move, eat, grow, breathe, reproduce',
      'Examples of living things: humans, animals, plants',
      'Identifying living things in our environment',
      'Differences between different living things',
    ]),
    week(10, 'teaching', 'Living Things (Part 2)', [
      'Animals as living things: pets (dog, cat, rabbit), farm animals (goat, cow, chicken), wild animals (lion, elephant, monkey)',
      'Plants as living things: trees, flowers, grasses, vegetables',
      'Parts of plants: roots, stem, leaves, flowers, fruits',
      'What living things need to survive: food, water, air, shelter',
      'Taking care of living things (plants and animals)',
    ]),
    ...closing('Review of all topics: Environment, roads, colours, shapes, living things'),
  ],
};

export const p1BasicScienceTerm2: Scheme = {
  subject_slug: 'basic-science',
  level_code: 'P1',
  term: 2,
  weeks: [
    week(1, 'teaching', 'Non-Living Things (Part 1)', [
      'Understanding what non-living things are',
      'Characteristics of non-living things: they do not move on their own, do not eat, do not grow, do not breathe',
      'Examples of non-living things: stones, water, air, chairs, tables, books',
      'Identifying non-living things in our environment',
      'Differences between living and non-living things',
    ]),
    week(2, 'teaching', 'Non-Living Things (Part 2)', [
      'Natural non-living things: rocks, water, soil, air, sand, mountains',
      'Man-made non-living things: cars, houses, chairs, tables, toys, clothes',
      'Uses of non-living things in our daily life',
      'Sorting and classifying non-living things',
      'How non-living things help living things (water for drinking, air for breathing, shelter from houses)',
    ]),
    week(3, 'teaching', 'Exploring Other Parts of the Surroundings: Air', [
      'Understanding what air is',
      'Air is all around us (we cannot see it but we can feel it)',
      'Feeling air: blowing, waving, fanning',
      'Uses of air: breathing, drying clothes, flying kites, inflating balloons',
      'Moving air is called wind',
      'Clean air and dirty air (pollution – introduction)',
    ]),
    week(4, 'teaching', 'Exploring Other Parts of the Surroundings: Soil', [
      'Understanding what soil is',
      'Where we find soil: ground, gardens, farms, pots',
      'Types of soil: sandy soil, clay soil, loamy soil (basic observation)',
      'Colours of soil: black, brown, red, yellow',
      'Uses of soil: growing plants, making pots, building houses (mud)',
      'Taking care of soil (not littering, planting trees)',
    ]),
    ...midTerm(),
    week(7, 'teaching', 'Exploring Other Parts of the Surroundings: Water', [
      'Understanding what water is',
      'Sources of water: rain, river, stream, well, borehole, tap',
      'Forms of water: liquid (drinking water), solid (ice), gas (steam from boiling water)',
      'Uses of water: drinking, cooking, bathing, washing, cleaning, watering plants',
      'Clean water and dirty water',
    ]),
    week(8, 'teaching', 'Water (Continued) & Water Safety', [
      'Importance of clean water for health',
      'Ways to keep water clean: covering water containers, not throwing dirt in water',
      'Water safety: not playing near deep water, not drinking dirty water',
      'Saving water: turning off taps, not wasting water',
      'Water cycle (very simple introduction): rain falls, water flows to rivers, sun dries water, rain falls again',
    ]),
    week(9, 'teaching', 'Energy (Part 1)', [
      'Understanding what energy is (the ability to do work or make things happen)',
      'Energy makes things work, move, or change',
      'Sources of energy: sun, food, batteries, electricity',
      'Energy from the sun: gives light, gives heat, helps plants grow, dries clothes',
      'Energy from food: helps us run, jump, play, think',
    ]),
    week(10, 'teaching', 'Energy (Part 2)', [
      'Energy from batteries: makes toys work, torches give light, clocks work',
      'Energy from electricity: lights our homes, powers television, charges phones, runs fans',
      'Safety with electricity: not touching sockets, not playing with wires, telling adults about electrical problems',
      'Saving energy: switching off lights when not in use, not wasting food',
      'Renewable energy (simple awareness): sun, wind, water',
    ]),
    ...closing('Review of all topics: Non-living things, air, soil, water, energy'),
  ],
};

export const p1BasicScienceTerm3: Scheme = {
  subject_slug: 'basic-science',
  level_code: 'P1',
  term: 3,
  weeks: [
    week(1, 'teaching', 'Technology (Part 1: Understanding Technology)', [
      'What is technology? (using tools and machines to make work easier)',
      'Technology in our homes: television, radio, telephone, electric iron, refrigerator, fan',
      'How technology helps us: makes work easier, saves time, makes life comfortable',
      'Simple technology vs. complex technology',
      'Technology for communication: telephone, mobile phone, radio, television',
    ]),
    week(2, 'teaching', 'Technology (Part 2: Technology Around Us)', [
      'Technology in schools: computers, projectors, fans, lights, bells',
      'Technology for transportation: cars, buses, motorcycles, bicycles, trains, airplanes',
      'Technology in hospitals: thermometer, stethoscope, X-ray machines',
      'Technology for farming: hoes, cutlasses, tractors, watering cans',
      'How technology has changed over time (old vs. new): old phones vs. smartphones, letter writing vs. email (basic awareness)',
    ]),
    week(3, 'teaching', 'Measuring Things (Part 1: Length and Size)', [
      'Understanding measurement (finding out how long, how big, how heavy something is)',
      'Measuring length: long and short, tall and short',
      'Comparing lengths: longer, shorter, longest, shortest, same length',
      'Non-standard units for measuring length: hand span, foot length, pencil, stick',
      'Measuring activities: measuring desks, books, classrooms using non-standard units',
    ]),
    week(4, 'teaching', 'Measuring Things (Part 2: Weight and Capacity)', [
      'Measuring weight: heavy and light',
      'Comparing weights: heavier, lighter, heaviest, lightest, same weight',
      'Using hands to feel weight differences',
      'Introduction to simple balance scales',
      'Measuring capacity: full, half-full, empty',
      'Comparing capacity: holds more, holds less',
    ]),
    ...midTerm(),
    week(7, 'teaching', 'Measuring Things (Part 3: Time and Temperature)', [
      'Measuring time: day and night, morning, afternoon, evening',
      'Understanding fast and slow, quick and long',
      'Days of the week, months (awareness)',
      "Introduction to clock: telling time (o'clock only)",
      'Measuring temperature: hot and cold, warm and cool',
      'Using our body to feel temperature differences',
    ]),
    week(8, 'teaching', 'Simple Machines (Part 1: Introduction)', [
      'What are simple machines? (tools that make work easier)',
      'Why we use simple machines: to lift, move, cut, hold things',
      'Identifying simple machines in our environment',
      'Types of simple machines we will learn: lever, wheel and axle, inclined plane, pulley, wedge, screw',
      'Simple machines at home and school',
    ]),
    week(9, 'teaching', 'Simple Machines (Part 2: Types)', [
      'Lever: seesaw, bottle opener, scissors, broom',
      'Wheel and axle: bicycle, car wheels, door knob, wheelbarrow',
      'Inclined plane: ramp, slope, slide, staircase',
      'How each simple machine helps make work easier',
      'Practical demonstrations with real objects',
    ]),
    week(10, 'teaching', 'Simple Machines (Part 3: More Types and Uses)', [
      'Wedge: knife, axe, needle, door stopper',
      'Pulley: flag pole, well bucket, curtain rod, crane (simple observation)',
      'Screw: bottle cap, jar lid, wood screw, light bulb',
      'Finding simple machines in our classroom and home',
      'How simple machines work together (compound machines – bicycle has wheels and levers)',
      'Making simple machines: creating a simple lever with ruler and eraser',
    ]),
    ...closing('Review of all topics: Technology, measuring things, simple machines'),
  ],
};

/** The three terms, in order. */
export const p1BasicScienceSchemes: Scheme[] = [
  p1BasicScienceTerm1,
  p1BasicScienceTerm2,
  p1BasicScienceTerm3,
];
