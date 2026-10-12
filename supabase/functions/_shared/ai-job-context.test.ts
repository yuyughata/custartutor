import { describe, expect, it } from 'vitest';
import { createJobEngine, StepError } from '../../../packages/authoring-core/src';
import { AiJobHttpError } from './ai-job-errors.ts';
import { PRIOR_UNITS_LIMIT, createJobInputResolver, slugOf } from './ai-job-context.ts';
import type { JobInputResolver } from './ai-job-context.ts';
import { FakeDb } from './ai-job-fake-db.ts';
import type { Row } from './ai-job-fake-db.ts';
import { ED, IDS, SA, core, seedCurriculum } from './ai-job-test-kit.ts';

// The resolver turns ids into engine input by reading with the caller's client. These tests feed what it builds
// to the REAL engine's parseInput, so the two cannot drift apart.

const engine = createJobEngine();

function setup(mutate?: (tables: Record<string, Row[]>) => void): {
  tables: Record<string, Row[]>;
  db: FakeDb;
  resolver: JobInputResolver;
} {
  const tables = seedCurriculum();
  mutate?.(tables);
  const db = new FakeDb(tables);
  return { tables, db, resolver: createJobInputResolver({ db, userId: ED, core }) };
}

async function refusal(promise: Promise<unknown>): Promise<AiJobHttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AiJobHttpError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const definition = (term: string) => ({ type: 'definition', term, meaning: 'x' });
const version = (
  unit: number,
  content: unknown,
  no = 1,
  id = IDS.version(unit * 10 + no),
): Row => ({
  id,
  unit_id: IDS.unit(unit),
  version: no,
  status: 'approved',
  content,
});

const GENERATE = (n: number) => ({ unit_id: IDS.unit(n) });

describe('chapter_plan', () => {
  it('builds an input the real engine accepts: the weeks in order, the active cast with its defaults filled', async () => {
    const { resolver } = setup();
    const resolved = await resolver.resolve('chapter_plan', { scheme_id: IDS.scheme });
    expect(resolved.schemeId).toBe(IDS.scheme);
    expect(resolved.unitId).toBeNull();

    const parsed = engine.parseInput('chapter_plan', resolved.input);
    expect(parsed.scheme_id).toBe(IDS.scheme);
    expect(parsed.scheme.subject_slug).toBe('basic-science');
    expect(parsed.scheme.level_code).toBe('P1');
    expect(parsed.scheme.term).toBe(1);
    expect(parsed.scheme.weeks.map((week) => week.week_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parsed.scheme.weeks[0]).toMatchObject({
      topic: 'Topic 1',
      subtopics: ['Sub 1a', 'Sub 1b'],
    });
    expect(parsed.subject_name).toBe('Basic Science');
    // the inactive character is never offered to the model; the others come sorted by slug
    expect(parsed.cast.map((member) => member.slug)).toEqual(['zari', 'zuri']);
    expect(parsed.cast[0]?.traits).toMatchObject({ age_years: 7, gender: 'female' });
    expect(parsed.cast[1]?.traits).toBeDefined();
  });

  it('tolerates a week without a topic and without subtopics', async () => {
    const { resolver } = setup((tables) => {
      const weeks = tables['scheme_weeks'] as Row[];
      weeks[2] = { ...weeks[2], topic: null, subtopics: null, kind: 'revision' };
    });
    const resolved = await resolver.resolve('chapter_plan', { scheme_id: IDS.scheme });
    const week = (resolved.input as { scheme: { weeks: Row[] } }).scheme.weeks[2];
    expect(week).toMatchObject({ week_no: 3, kind: 'revision', topic: '', subtopics: [] });
  });

  it('refuses a scheme that is not approved, and one the caller cannot see', async () => {
    const { resolver } = setup((tables) => {
      (tables['schemes'] as Row[])[0]!['status'] = 'draft';
    });
    const draft = await refusal(resolver.resolve('chapter_plan', { scheme_id: IDS.scheme }));
    expect(draft.code).toBe('conflict');
    const missing = await refusal(resolver.resolve('chapter_plan', { scheme_id: IDS.unit(99) }));
    expect(missing.code).toBe('not_found');
  });

  it('names the character whose facts do not fit the cast bible', async () => {
    const { resolver } = setup((tables) => {
      (tables['characters'] as Row[])[1]!['traits'] = { age_years: 'seven' };
    });
    const error = await refusal(resolver.resolve('chapter_plan', { scheme_id: IDS.scheme }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('"zuri"');
    expect(error.message).toContain('age_years');
  });

  it('ignores the bad facts of a retired character', async () => {
    const { resolver } = setup((tables) => {
      (tables['characters'] as Row[])[2]!['traits'] = { age_years: 'ancient' };
    });
    const resolved = await resolver.resolve('chapter_plan', { scheme_id: IDS.scheme });
    expect((resolved.input as { cast: Row[] }).cast.map((member) => member['slug'])).toEqual([
      'zari',
      'zuri',
    ]);
  });
});

describe('unit_generate', () => {
  it('builds an input the real engine accepts', async () => {
    const { resolver } = setup();
    const resolved = await resolver.resolve('unit_generate', {
      unit_id: IDS.unit(3),
      notes: 'Use a market scene.',
    });
    expect(resolved.unitId).toBe(IDS.unit(3));
    expect(resolved.schemeId).toBe(IDS.scheme);

    const parsed = engine.parseInput('unit_generate', resolved.input);
    expect(parsed.unit).toMatchObject({
      id: IDS.unit(3),
      kind: 'lesson',
      unit_no: 3,
      week_no: 3,
      title: 'Unit 3',
      objective: 'Objective 3',
      stage: 'absorb',
      periods: 2,
    });
    expect(parsed.chapter).toEqual({ number: 1, title: 'Our World' });
    expect(parsed.subject).toEqual({ slug: 'basic-science', name: 'Basic Science' });
    expect(parsed.level_code).toBe('P1');
    expect(parsed.term).toBe(1);
    expect(parsed.scheme_week).toEqual({ topic: 'Topic 3', subtopics: ['Sub 3a', 'Sub 3b'] });
    expect(parsed.notes).toBe('Use a market scene.');
    expect(parsed.cast.map((member) => member.slug)).toEqual(['zari', 'zuri']);
  });

  it('gives the theme of the chapter with the slug of its title and the lens of this unit', async () => {
    const { resolver } = setup();
    const parsed = engine.parseInput(
      'unit_generate',
      (await resolver.resolve('unit_generate', GENERATE(2))).input,
    );
    expect(parsed.theme).toEqual({ slug: 'market-day', title: 'Market Day', lens: 'Counting' });
  });

  it('leaves the theme out when the chapter has none, or the unit has no lens in it', async () => {
    const { resolver } = setup();
    // unit 6 is in chapter 2, which has no theme
    const chapterTwo = engine.parseInput(
      'unit_generate',
      (await resolver.resolve('unit_generate', GENERATE(6))).input,
    );
    expect(chapterTwo.theme).toBeUndefined();

    const noLens = setup((tables) => {
      tables['theme_units'] = (tables['theme_units'] as Row[]).filter(
        (link) => link['unit_id'] !== IDS.unit(2),
      );
    });
    const resolved = await noLens.resolver.resolve('unit_generate', GENERATE(2));
    expect(resolved.input).not.toHaveProperty('theme');
    const blankLens = setup((tables) => {
      (tables['theme_units'] as Row[])[1]!['lens'] = '   ';
    });
    expect(
      (await blankLens.resolver.resolve('unit_generate', GENERATE(2))).input,
    ).not.toHaveProperty('theme');
  });

  it('falls back from a blank objective to the scheme week topic, then to the title', async () => {
    const blank = setup((tables) => {
      (tables['units'] as Row[])[0]!['objective'] = '  ';
    });
    const first = await blank.resolver.resolve('unit_generate', GENERATE(1));
    expect(engine.parseInput('unit_generate', first.input).unit.objective).toBe('Topic 1');

    const noWeek = setup((tables) => {
      const unit = (tables['units'] as Row[])[0]!;
      unit['objective'] = null;
      unit['week_no'] = null;
    });
    const second = await noWeek.resolver.resolve('unit_generate', GENERATE(1));
    const parsed = engine.parseInput('unit_generate', second.input);
    expect(parsed.unit.objective).toBe('Unit 1');
    expect(parsed.unit.week_no).toBeNull();
    expect(parsed.scheme_week).toBeNull();
  });

  it('gives the earlier units for spiral review: nearest last, at most six, with their key terms', async () => {
    const { resolver } = setup((tables) => {
      (tables['unit_versions'] as Row[]).push(
        version(6, {
          sections: [
            {
              id: 'a',
              type: 'concept',
              blocks: [
                definition('  Soil '),
                definition('Soil'),
                definition('Rock'),
                { type: 'text' },
              ],
            },
            {
              id: 'b',
              type: 'concept',
              blocks: [definition('Sand'), { type: 'definition', term: 7 }],
            },
          ],
        }),
      );
    });
    const resolved = await resolver.resolve('unit_generate', GENERATE(8));
    const parsed = engine.parseInput('unit_generate', resolved.input);
    expect(parsed.prior_units).toHaveLength(PRIOR_UNITS_LIMIT);
    expect(parsed.prior_units.map((prior) => prior.unit_no)).toEqual([2, 3, 4, 5, 6, 7]);
    const six = parsed.prior_units.find((prior) => prior.unit_no === 6);
    expect(six?.key_terms).toEqual(['Soil', 'Rock', 'Sand']);
    expect(six?.objective).toBe('Objective 6');
    expect(parsed.prior_units.find((prior) => prior.unit_no === 2)?.key_terms).toEqual([]);
  });

  it('keeps at most 12 key terms per earlier unit and reads the latest version only', async () => {
    const many = Array.from({ length: 20 }, (_, index) => definition(`Term ${index}`));
    const { resolver } = setup((tables) => {
      (tables['unit_versions'] as Row[]).push(
        version(1, { sections: [{ id: 'a', type: 'concept', blocks: [definition('Old')] }] }, 1),
        version(1, { sections: [{ id: 'a', type: 'concept', blocks: many }] }, 2),
      );
    });
    const parsed = engine.parseInput(
      'unit_generate',
      (await resolver.resolve('unit_generate', GENERATE(2))).input,
    );
    const keyTerms = parsed.prior_units[0]?.key_terms ?? [];
    expect(keyTerms).toHaveLength(12);
    expect(keyTerms[0]).toBe('Term 0');
    expect(keyTerms).not.toContain('Old');
  });

  it('lists the enrichment sections the previous unit used, in order, and ignores other section types', async () => {
    const { resolver } = setup((tables) => {
      (tables['unit_versions'] as Row[]).push(
        version(4, {
          sections: [
            { id: 's1', type: 'story_opener', blocks: [] },
            { id: 's2', type: 'concept', blocks: [] },
            { id: 's3', type: 'remember', blocks: [] },
            { id: 's4', type: 'mastery_check', blocks: [] },
            { id: 's5', type: 'do_and_discover', blocks: [] },
          ],
        }),
        // an older unit's enrichment does not count: only the unit just before this one
        version(2, { sections: [{ id: 'x', type: 'character_values', blocks: [] }] }),
      );
    });
    const parsed = engine.parseInput(
      'unit_generate',
      (await resolver.resolve('unit_generate', GENERATE(5))).input,
    );
    expect(parsed.previous_enrichment).toEqual(['story_opener', 'remember', 'do_and_discover']);
  });

  it('has no spiral review for the first unit, and an empty rotation', async () => {
    const { resolver } = setup();
    const parsed = engine.parseInput(
      'unit_generate',
      (await resolver.resolve('unit_generate', GENERATE(1))).input,
    );
    expect(parsed.prior_units).toEqual([]);
    expect(parsed.previous_enrichment).toEqual([]);
  });

  it('counts the units of earlier terms as earlier, and skips removed and archived units', async () => {
    const { resolver } = setup((tables) => {
      const chapterTwoTerm = 'b3000000-0000-4000-8000-000000000009';
      (tables['chapters'] as Row[]).push({
        id: chapterTwoTerm,
        scheme_id: IDS.scheme2,
        number: 1,
        title: 'Term two',
        theme_id: null,
      });
      (tables['units'] as Row[]).push({
        id: IDS.unit(20),
        chapter_id: chapterTwoTerm,
        unit_no: 1,
        week_no: 1,
        kind: 'lesson',
        title: 'Term 2 unit',
        objective: 'Later',
        stage: 'absorb',
        periods: 2,
        status: 'draft',
        deleted_at: null,
      });
      (tables['units'] as Row[])[3]!['deleted_at'] = '2026-10-01T00:00:00Z';
      (tables['units'] as Row[])[4]!['status'] = 'archived';
      (tables['scheme_weeks'] as Row[]).push({
        scheme_id: IDS.scheme2,
        week_no: 1,
        kind: 'teaching',
        topic: 'T2',
        subtopics: [],
      });
    });
    const parsed = engine.parseInput(
      'unit_generate',
      (await resolver.resolve('unit_generate', GENERATE(20))).input,
    );
    expect(parsed.term).toBe(2);
    expect(parsed.prior_units.map((prior) => prior.unit_no)).toEqual([1, 2, 3, 6, 7, 8]);
  });

  it('refuses a unit that is gone, archived or unknown', async () => {
    const removed = setup((tables) => {
      (tables['units'] as Row[])[0]!['deleted_at'] = '2026-10-01T00:00:00Z';
    });
    expect((await refusal(removed.resolver.resolve('unit_generate', GENERATE(1)))).code).toBe(
      'conflict',
    );
    const archived = setup((tables) => {
      (tables['units'] as Row[])[0]!['status'] = 'archived';
    });
    expect((await refusal(archived.resolver.resolve('unit_generate', GENERATE(1)))).code).toBe(
      'conflict',
    );
    const { resolver } = setup();
    expect((await refusal(resolver.resolve('unit_generate', GENERATE(77)))).code).toBe('not_found');
  });

  it('omits notes when none were given', async () => {
    const { resolver } = setup();
    const resolved = await resolver.resolve('unit_generate', GENERATE(1));
    expect(resolved.input).not.toHaveProperty('notes');
  });

  it('turns a database error into a protocol error without leaking it', async () => {
    const { db, resolver } = setup();
    db.tableErrors.set('units', {
      code: 'XX000',
      message: 'relation "secret_table" exploded sk-ant-abc123',
    });
    const error = await refusal(resolver.resolve('unit_generate', GENERATE(1)));
    expect(error.code).toBe('internal');
    expect(error.message).not.toContain('secret_table');
    expect(error.message).not.toContain('sk-ant');
  });

  it('reports a row it cannot make sense of as internal', async () => {
    const { resolver } = setup((tables) => {
      (tables['units'] as Row[])[0]!['chapter_id'] = 12;
    });
    expect((await refusal(resolver.resolve('unit_generate', GENERATE(1)))).code).toBe('internal');
  });
});

describe('unit_revise', () => {
  const content = {
    schema_version: 1,
    kind: 'lesson',
    header: { title: 'Unit 3' },
    sections: [
      { id: 'intro', type: 'story_opener', blocks: [] },
      { id: 'body', type: 'concept', blocks: [definition('Soil')] },
    ],
  };
  const withVersions = (tables: Record<string, Row[]>) => {
    (tables['unit_versions'] as Row[]).push(
      version(3, { ...content, old: true }, 1),
      version(3, content, 2),
    );
  };

  it('builds an input the real engine accepts, from the latest version', async () => {
    const { resolver } = setup(withVersions);
    const resolved = await resolver.resolve('unit_revise', {
      unit_version_id: IDS.version(32),
      instruction: 'Make it simpler.',
      section_ids: ['body'],
    });
    expect(resolved.unitId).toBe(IDS.unit(3));
    expect(resolved.schemeId).toBe(IDS.scheme);
    const parsed = engine.parseInput('unit_revise', resolved.input);
    expect(parsed).toMatchObject({
      unit_id: IDS.unit(3),
      base_version_id: IDS.version(32),
      base_version_no: 2,
      instruction: 'Make it simpler.',
      section_ids: ['body'],
    });
    expect(parsed.base_content).toEqual(content);
    expect(parsed.previous_enrichment).toEqual([]);
    expect(parsed.cast.map((member) => member.slug)).toEqual(['zari', 'zuri']);
  });

  it('omits section_ids when the model decides', async () => {
    const { resolver } = setup(withVersions);
    const resolved = await resolver.resolve('unit_revise', {
      unit_version_id: IDS.version(32),
      instruction: 'Shorter.',
    });
    expect(resolved.input).not.toHaveProperty('section_ids');
  });

  it('refuses to revise a version that is not the latest', async () => {
    const { resolver } = setup(withVersions);
    const error = await refusal(
      resolver.resolve('unit_revise', {
        unit_version_id: IDS.version(31),
        instruction: 'Shorter.',
      }),
    );
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('newer version');
  });

  it('refuses a section id the version does not have, and a version that does not exist', async () => {
    const { resolver } = setup(withVersions);
    const unknownSection = await refusal(
      resolver.resolve('unit_revise', {
        unit_version_id: IDS.version(32),
        instruction: 'x',
        section_ids: ['body', 'ghost'],
      }),
    );
    expect(unknownSection.code).toBe('invalid_request');
    expect(unknownSection.message).toContain('"ghost"');
    const missing = await refusal(
      resolver.resolve('unit_revise', { unit_version_id: IDS.version(99), instruction: 'x' }),
    );
    expect(missing.code).toBe('not_found');
  });

  it('uses the rotation of the unit before it', async () => {
    const { resolver } = setup((tables) => {
      withVersions(tables);
      (tables['unit_versions'] as Row[]).push(
        version(2, {
          sections: [
            { id: 'q', type: 'tell_it_back', blocks: [] },
            { id: 'r', type: 'concept', blocks: [] },
          ],
        }),
      );
    });
    const resolved = await resolver.resolve('unit_revise', {
      unit_version_id: IDS.version(32),
      instruction: 'x',
    });
    expect(engine.parseInput('unit_revise', resolved.input).previous_enrichment).toEqual([
      'tell_it_back',
    ]);
  });
});

describe('scheme_ingest', () => {
  const text = { type: 'text' as const, text: 'Week 1: Plants', filename: 'scheme.txt' };

  it('builds an input the real engine accepts for pasted text, without touching storage', async () => {
    const { db, resolver } = setup();
    const resolved = await resolver.resolve('scheme_ingest', {
      subject_id: IDS.subject,
      level_code: 'P2',
      term: 3,
      source: text,
    });
    expect(resolved.unitId).toBeNull();
    expect(resolved.schemeId).toBeNull();
    expect(engine.parseInput('scheme_ingest', resolved.input)).toEqual({
      subject_slug: 'basic-science',
      subject_name: 'Basic Science',
      level_code: 'P2',
      term: 3,
      source: text,
    });
    expect(db.storageCalls).toEqual([]);
  });

  it('may redo a draft scheme, and refuses to touch one that is approved', async () => {
    const draft = setup((tables) => {
      (tables['schemes'] as Row[])[0]!['status'] = 'draft';
    });
    await expect(
      draft.resolver.resolve('scheme_ingest', {
        subject_id: IDS.subject,
        level_code: 'P1',
        term: 1,
        source: text,
      }),
    ).resolves.toBeDefined();

    const { resolver } = setup();
    const error = await refusal(
      resolver.resolve('scheme_ingest', {
        subject_id: IDS.subject,
        level_code: 'P1',
        term: 1,
        source: text,
      }),
    );
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('approved');
  });

  it('refuses an unknown subject', async () => {
    const { resolver } = setup();
    const error = await refusal(
      resolver.resolve('scheme_ingest', {
        subject_id: IDS.unit(77),
        level_code: 'P1',
        term: 1,
        source: text,
      }),
    );
    expect(error.code).toBe('not_found');
  });

  describe('uploaded PDFs', () => {
    const pdf = (path: string) => ({ type: 'pdf' as const, path, filename: 'scheme.pdf' });
    const params = (path: string) => ({
      subject_id: IDS.subject,
      level_code: 'P2',
      term: 3,
      source: pdf(path),
    });

    it('accepts a file the caller uploaded under their own id', async () => {
      const { db, resolver } = setup();
      db.objects.set(`scheme-uploads/${ED}/term3.pdf`, {
        bytes: new Uint8Array([1]),
        type: 'application/pdf',
      });
      const resolved = await resolver.resolve('scheme_ingest', params(`${ED}/term3.pdf`));
      expect((resolved.input as { source: unknown }).source).toEqual(pdf(`${ED}/term3.pdf`));
      expect(db.storageCalls).toEqual([`list:scheme-uploads/${ED}`]);
    });

    it('answers not found when the file is not there', async () => {
      const { resolver } = setup();
      expect(
        (await refusal(resolver.resolve('scheme_ingest', params(`${ED}/missing.pdf`)))).code,
      ).toBe('not_found');
    });

    it('refuses paths that are not the caller’s own, before listing anything', async () => {
      const { db, resolver } = setup();
      const paths = [
        `${SA}/term3.pdf`,
        'term3.pdf',
        `${ED}//term3.pdf`,
        `${ED}/../${SA}/term3.pdf`,
        `${ED}/./term3.pdf`,
        `${ED}/${'a'.repeat(300)}.pdf`,
      ];
      for (const path of paths) {
        const error = await refusal(resolver.resolve('scheme_ingest', params(path)));
        expect(error.code, path).toBe('invalid_request');
      }
      expect(db.storageCalls).toEqual([]);
    });

    it('reports a storage failure as internal without the storage message', async () => {
      const { db, resolver } = setup();
      db.storage.from = () => ({
        list: () =>
          Promise.resolve({ data: null, error: { message: 'bucket secret details sk-ant-xyz' } }),
        download: () => Promise.resolve({ data: null, error: { message: 'x' } }),
      });
      const error = await refusal(resolver.resolve('scheme_ingest', params(`${ED}/term3.pdf`)));
      expect(error.code).toBe('internal');
      expect(error.message).not.toContain('secret');
    });
  });
});

describe('slugOf', () => {
  it('makes a slug that starts with a letter', () => {
    expect(slugOf('Market Day')).toBe('market-day');
    expect(slugOf('  Our  World!  ')).toBe('our-world');
    expect(slugOf('Café time')).toBe('cafe-time');
    expect(slugOf('1st Term Fun')).toBe('theme-1st-term-fun');
    expect(slugOf('???')).toBe('theme');
  });
});

describe('the real engine and the resolver agree on bad input', () => {
  it('fails parseInput with a StepError, not a crash, when the resolver is bypassed', () => {
    expect(() => engine.parseInput('unit_generate', { unit: {} })).toThrow(StepError);
  });
});
