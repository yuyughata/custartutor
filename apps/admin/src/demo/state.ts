// The in-memory database behind demo mode, and its seed. Plain data, no I/O. The seed mirrors the dev project:
// the twelve subjects, six levels, the Basic Science P1 Term 1 scheme (APPROVED, with its two chapters of four
// units each), the golden Unit 2 as an APPROVED version, and the cast with only the facts the owner supplied.
// Nothing here is model output: every AI draft in demo mode comes from the stand-in model through the job API.
import type { AiSettings, CastTraits, JobKind, Json, UsageRecord } from '@custar/authoring-core';
import { DEFAULT_AI_SETTINGS } from '@custar/authoring-core';
import {
  groupIntoChapters,
  lintUnit,
  type LevelCode,
  type SchemeWeek,
  type Stage,
  type Theme,
  type UnitKind,
} from '@custar/content-schema';
import { goldenUnit2, p1BasicScienceTerm1 } from '@custar/content-schema/fixtures';
import type {
  CharacterRecord,
  ContentStatus,
  Level,
  PublishedInfo,
  SchemeStatus,
  Subject,
  TermNumber,
  UnitVersionFull,
} from '../api/types';

export const DEMO_MODEL_ID = 'demo-fixture-model';

export interface DemoScheme {
  id: string;
  subject_id: string;
  level_code: LevelCode;
  term: TermNumber;
  status: SchemeStatus;
  source_note: string | null;
  created_at: string;
  weeks: SchemeWeek[];
}

export interface DemoChapter {
  id: string;
  scheme_id: string;
  number: number;
  title: string;
  status: ContentStatus;
  theme?: Theme;
}

export interface DemoUnit {
  id: string;
  chapter_id: string;
  unit_no: number;
  week_no: number | null;
  kind: UnitKind;
  title: string;
  objective: string | null;
  stage: Stage;
  periods: number;
  status: ContentStatus;
}

export interface DemoPublished extends PublishedInfo {
  unit_version_id: string;
}

export interface DemoUsage {
  at: string;
  job_id: string;
  kind: JobKind;
  record: UsageRecord;
}

export interface DemoState {
  subjects: Subject[];
  levels: Level[];
  schemes: DemoScheme[];
  chapters: DemoChapter[];
  units: DemoUnit[];
  versions: UnitVersionFull[];
  published: DemoPublished[];
  characters: CharacterRecord[];
  settings: AiSettings;
  usage: DemoUsage[];
}

/** A v4-shaped uuid with a recognisable prefix, so demo ids are stable between reloads and easy to spot. */
export function seedId(n: number): string {
  return `de0d0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const SUBJECTS: [string, string, number][] = [
  ['english-studies', 'English Studies', 10],
  ['mathematics', 'Mathematics', 20],
  ['basic-science', 'Basic Science', 30],
  ['social-studies', 'Social Studies', 40],
  ['civic-education', 'Civic Education', 50],
  ['cultural-creative-arts', 'Cultural and Creative Arts', 60],
  ['nigerian-language', 'Nigerian Language', 70],
  ['physical-health-education', 'Physical and Health Education', 80],
  ['religion-studies', 'Religion Studies', 110],
  ['ict', 'ICT', 120],
  ['pre-vocational-studies', 'Pre-vocational Studies', 130],
  ['french', 'French', 140],
];

const LEVELS: LevelCode[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

export const DEMO_SUBJECT_BASIC_SCIENCE = seedId(3);
export const DEMO_SCHEME_P1_T1 = seedId(100);
export const DEMO_UNIT_2 = seedId(202);
export const DEMO_VERSION_GOLDEN = seedId(302);

const CHAPTER_TITLES = ['Our World Around Us', 'Shapes and Living Things'];

function derivedGuidance(name: string, age: string, text: string): string {
  return `Derived from ${name}'s age (${age}), not stated by the owner. ${text}`;
}

export function seedCharacters(): CharacterRecord[] {
  const base: CastTraits = { personality: [] };
  return [
    {
      id: seedId(401),
      slug: 'zari',
      name: 'Zari',
      traits: {
        ...base,
        age_years: 7,
        gender: 'female',
        pronouns: 'she/her',
        derived_guidance: derivedGuidance(
          'Zari',
          '7',
          'Speaks in short, clear sentences; can read simple words, count and follow two-step instructions.',
        ),
      },
      voice: {},
      active: true,
    },
    {
      id: seedId(402),
      slug: 'zuri',
      name: 'Zuri',
      traits: {
        ...base,
        age_years: 4,
        age_note: 'almost 5',
        gender: 'male',
        pronouns: 'he/him',
        derived_guidance: derivedGuidance(
          'Zuri',
          'almost 5',
          'Uses very simple words, asks "why?", learns through play and repetition, and needs one step at a time.',
        ),
      },
      voice: {},
      active: true,
    },
  ];
}

export function createDemoState(now: Date = new Date()): DemoState {
  const iso = now.toISOString();
  const subjects: Subject[] = SUBJECTS.map(([slug, name, sort], index) => ({
    id: seedId(index + 1),
    slug,
    name,
    sort,
  }));
  const levels: Level[] = LEVELS.map((code, index) => ({
    code,
    name: `Primary ${index + 1}`,
    sort: index + 1,
  }));

  const scheme: DemoScheme = {
    id: DEMO_SCHEME_P1_T1,
    subject_id: DEMO_SUBJECT_BASIC_SCIENCE,
    level_code: 'P1',
    term: 1,
    status: 'approved',
    source_note: 'NERDC Primary 1 Basic Science scheme of work, Term 1 (sample data for demo mode).',
    created_at: iso,
    weeks: p1BasicScienceTerm1.weeks.map((week) => ({ ...week, subtopics: [...week.subtopics] })),
  };

  const grouping = groupIntoChapters(p1BasicScienceTerm1);
  const chapters: DemoChapter[] = [];
  const units: DemoUnit[] = [];
  let unitNo = 0;
  grouping.chapters.forEach((proposal, chapterIndex) => {
    const chapter: DemoChapter = {
      id: seedId(150 + chapterIndex + 1),
      scheme_id: scheme.id,
      number: proposal.chapter_no,
      title: CHAPTER_TITLES[chapterIndex] ?? `Chapter ${proposal.chapter_no}`,
      status: 'draft',
    };
    chapters.push(chapter);
    for (const weekNo of proposal.week_nos) {
      unitNo += 1;
      const week = scheme.weeks.find((candidate) => candidate.week_no === weekNo) as SchemeWeek;
      units.push({
        id: seedId(200 + unitNo),
        chapter_id: chapter.id,
        unit_no: unitNo,
        week_no: weekNo,
        kind: 'lesson',
        title: week.topic,
        objective:
          unitNo === 2
            ? goldenUnit2.header.objective
            : `Learn about ${week.topic}: ${week.subtopics.slice(0, 3).join('; ')}.`,
        stage: 'absorb',
        periods: 1,
        status: 'draft',
      });
    }
  });

  const report = lintUnit(goldenUnit2);
  const toFlag = (issue: { code: string; message: string; path?: string }, severity: 'note' | 'concern') => ({
    code: issue.code,
    message: issue.message,
    severity,
    ...(issue.path ? { path: issue.path } : {}),
  });
  const golden: UnitVersionFull = {
    id: DEMO_VERSION_GOLDEN,
    unit_id: DEMO_UNIT_2,
    version: 1,
    schema_version: goldenUnit2.schema_version,
    status: 'approved',
    generated_by: 'human',
    model: null,
    prompt_version: null,
    lint_report: {
      errors: report.errors.map((issue) => toFlag(issue, 'concern')),
      warnings: report.warnings.map((issue) => toFlag(issue, 'note')),
      ok: report.ok,
      review: [],
      summary: 'The golden unit, transcribed by hand from the template. Not model output.',
    },
    base_version_id: null,
    created_by: null,
    created_at: iso,
    content: JSON.parse(JSON.stringify(goldenUnit2)) as Json,
  };

  return {
    subjects,
    levels,
    schemes: [scheme],
    chapters,
    units,
    versions: [golden],
    published: [],
    characters: seedCharacters(),
    settings: structuredClone(DEFAULT_AI_SETTINGS),
    usage: [],
  };
}
