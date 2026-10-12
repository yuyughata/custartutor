import { parseUnit } from '@custar/content-schema';
import type { UnitContent } from '@custar/content-schema';
import {
  colourChartProject,
  goldenUnit2,
  marketDayMathsUnit,
} from '@custar/content-schema/fixtures';
import { FakeSyncApi } from './fake-sync-api';
import type { FakeSyncApiOptions } from './fake-sync-api';
import { buildPackFiles } from './pack-builder';
import type { BuiltPack } from './pack-builder';
import { encodeUtf8 } from '../utf8';

/** Stable ids so a demo (or a test) can refer to the seeded data. */
export const DEMO_IDS = {
  household: '0d0c0000-0000-4000-8000-000000000001',
  childAda: '0d0c0000-0000-4000-8000-0000000000a1',
  childTobi: '0d0c0000-0000-4000-8000-0000000000a2',
  subjectScience: '0d0c0000-0000-4000-8000-0000000000b1',
  subjectMaths: '0d0c0000-0000-4000-8000-0000000000b2',
  unitEnvironment: '0d0c0000-0000-4000-8000-0000000000c1',
  unitColours: '0d0c0000-0000-4000-8000-0000000000c2',
  unitMarket: '0d0c0000-0000-4000-8000-0000000000c3',
} as const;

/** The grown-up PIN of the demo household. */
export const DEMO_PIN = '2468';

export interface DemoServer {
  api: FakeSyncApi;
  ids: typeof DEMO_IDS;
  pin: string;
  /** The built packs by unit id, as published (version 1). */
  packs: Map<string, BuiltPack>;
}

/** A tiny SVG picture used as the demo pack's shared media blob. */
const DEMO_PICTURE = encodeUtf8(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0f766e"/></svg>',
);

interface DemoUnit {
  id: string;
  subjectId: string;
  content: UnitContent;
}

/**
 * A ready-made server for the app's demo mode and for end-to-end tests: one household with two children,
 * two subjects and three published units (the golden Basic Science lesson, the Market Day Maths lesson and the
 * colour-chart mini project), each with a REAL pack (learner pack plus grown-up pack, media blob) built from
 * the content-schema fixtures by `buildPackFiles` exactly as the publish job will.
 * The household PIN is `DEMO_PIN`.
 */
export async function createDemoServer(options: FakeSyncApiOptions = {}): Promise<DemoServer> {
  const api = new FakeSyncApi(options);
  api.setHousehold({ id: DEMO_IDS.household, name: 'The Demo Family' });
  api.seedPin(DEMO_PIN);

  api.addSubject({
    id: DEMO_IDS.subjectScience,
    slug: 'basic-science',
    name: 'Basic Science',
    kind: 'core',
    curriculum_source: 'nerdc',
    icon: 'flask',
    colour: '#0f766e',
    sort: 3,
  });
  api.addSubject({
    id: DEMO_IDS.subjectMaths,
    slug: 'mathematics',
    name: 'Mathematics',
    kind: 'core',
    curriculum_source: 'nerdc',
    icon: 'calculator',
    colour: '#b45309',
    sort: 2,
  });

  api.addChild({
    id: DEMO_IDS.childAda,
    household_id: DEMO_IDS.household,
    display_alias: 'Ada',
    avatar: 'owl',
    level_code: 'P1',
    reading_mode: 'reader',
    daily_limit_min: 60,
  });
  api.addChild({
    id: DEMO_IDS.childTobi,
    household_id: DEMO_IDS.household,
    display_alias: 'Tobi',
    avatar: 'lion',
    level_code: 'P1',
    reading_mode: 'pre_reader',
    daily_limit_min: null,
  });

  const demoUnits: DemoUnit[] = [
    {
      id: DEMO_IDS.unitEnvironment,
      subjectId: DEMO_IDS.subjectScience,
      content: parseUnit(goldenUnit2),
    },
    {
      id: DEMO_IDS.unitColours,
      subjectId: DEMO_IDS.subjectScience,
      content: parseUnit(colourChartProject),
    },
    {
      id: DEMO_IDS.unitMarket,
      subjectId: DEMO_IDS.subjectMaths,
      content: parseUnit(marketDayMathsUnit),
    },
  ];

  const packs = new Map<string, BuiltPack>();
  for (const demo of demoUnits) {
    const { header } = demo.content;
    api.addUnit({
      id: demo.id,
      subject_id: demo.subjectId,
      chapter_number: header.chapter?.number ?? 1,
      chapter_title: header.chapter?.title ?? 'Projects',
      unit_no: header.unit_no ?? 1,
      week_no: header.week_no ?? null,
      kind: demo.content.kind,
      title: header.title,
      objective: header.objective,
      stage: header.stage,
      level_code: header.level_code,
      term: header.term,
    });
    const pack = await buildPackFiles(demo.content, {
      unitId: demo.id,
      versionNo: 1,
      media: [{ assetId: 'demo_picture', bytes: DEMO_PICTURE, ext: 'svg' }],
    });
    api.publishPack(pack);
    packs.set(demo.id, pack);
  }

  return { api, ids: DEMO_IDS, pin: DEMO_PIN, packs };
}
