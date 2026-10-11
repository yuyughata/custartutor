import {
  colourChartProject,
  goldenUnit2,
  marketDayMathsUnit,
} from '@custar/content-schema/fixtures';
import type { UnitContent } from '@custar/content-schema';

export interface FixtureEntry {
  slug: string;
  title: string;
  description: string;
  unit: UnitContent;
}

export const FIXTURES: FixtureEntry[] = [
  {
    slug: 'golden-unit-2',
    title: 'P1 Basic Science · T1 · Unit 2: Exploring Our Environment (Part 2)',
    description: 'The golden unit transcribed from the template (lesson).',
    unit: goldenUnit2,
  },
  {
    slug: 'maths-market-day',
    title: 'P1 Mathematics · Market Day: counting goods and adding prices',
    description: 'Illustrative Maths lesson on the brief’s Market Day theme.',
    unit: marketDayMathsUnit,
  },
  {
    slug: 'colour-chart-project',
    title: 'P1 Basic Science · Our Colour Chart',
    description: 'A mini project fixture.',
    unit: colourChartProject,
  },
];
