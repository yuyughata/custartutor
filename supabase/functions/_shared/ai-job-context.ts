// The `JobInputResolver` of the `ai-job` edge function: turns the ids a client sends (a unit, a scheme, a version)
// into the full input the step engine needs, by READING THE DATABASE WITH THE CALLER'S CLIENT. Row level security
// therefore applies to every read: the function never sees anything the person could not see in the admin app.
//
// Pure (the client is injected), so it is unit tested with an in-memory fake. Mirrors the demo backend of the admin
// app (apps/admin/src/demo/jobHooks.ts) so a unit drafted in demo mode and on the server gets the same context.

import { AiJobHttpError } from './ai-job-errors.ts';
import { mapDbError } from './ai-job-errors.ts';
import type {
  AuthoringCore,
  DbClient,
  DbResult,
  JobKind,
  JobParamsMap,
  Json,
  SchemeSource,
} from './ai-job-types.ts';

export const SCHEME_UPLOADS_BUCKET = 'scheme-uploads';
/** How many earlier units the generator gets for spiral review. */
export const PRIOR_UNITS_LIMIT = 6;
const MAX_TERMS_PER_UNIT = 12;

/** The enrichment menu of the unit template (packages/content-schema `ENRICHMENT_MENU`; a test keeps them equal). */
export const ENRICHMENT_MENU = [
  'story_opener',
  'across_subjects',
  'window_to_world',
  'do_and_discover',
  'tell_it_back',
  'remember',
  'character_values',
] as const;

type Row = Record<string, unknown>;

export interface ResolvedJob {
  /** The engine input (not yet parsed by the engine). */
  input: unknown;
  unitId: string | null;
  schemeId: string | null;
}

export interface JobInputResolver {
  resolve<K extends JobKind>(kind: K, params: JobParamsMap[K]): Promise<ResolvedJob>;
}

export interface ResolverOptions {
  /** The caller's client. */
  db: DbClient;
  /** The caller's user id (the `sub` claim): uploads are only readable under it. */
  userId: string;
  core: Pick<AuthoringCore, 'CastTraits'>;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export function createJobInputResolver(options: ResolverOptions): JobInputResolver {
  const { db, userId, core } = options;
  const log = options.log ?? (() => {});

  // --- small helpers ----------------------------------------------------------------------------

  const unwrap = <T>(result: DbResult<T>): T | null => {
    if (result.error) throw mapDbError(result.error, log);
    return result.data;
  };
  const rows = async (query: PromiseLike<DbResult<Row[]>>): Promise<Row[]> =>
    unwrap(await query) ?? [];
  const row = async (query: PromiseLike<DbResult<Row>>): Promise<Row | null> => unwrap(await query);

  const notFound = (what: string): AiJobHttpError =>
    new AiJobHttpError('not_found', `That ${what} does not exist, or you cannot see it.`);
  const unexpected = (what: string): AiJobHttpError => {
    log('unexpected_row', { what });
    return new AiJobHttpError('internal', 'The server read data it did not expect. Try again.');
  };

  const text = (value: unknown, what: string): string => {
    if (typeof value !== 'string') throw unexpected(what);
    return value;
  };
  const int = (value: unknown, what: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw unexpected(what);
    return value;
  };
  const nonBlank = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;
  const isRecord = (value: unknown): value is Row =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  // --- reads shared by several kinds --------------------------------------------------------------

  async function subjectById(id: string): Promise<{ id: string; slug: string; name: string }> {
    const subject = await row(
      db.from('subjects').select('id,slug,name').eq('id', id).maybeSingle(),
    );
    if (!subject) throw notFound('subject');
    return {
      id: text(subject['id'], 'subject.id'),
      slug: text(subject['slug'], 'subject.slug'),
      name: text(subject['name'], 'subject.name'),
    };
  }

  async function cast(): Promise<unknown[]> {
    const characters = await rows(
      db
        .from('characters')
        .select('slug,name,traits,voice')
        .eq('active', true)
        .order('slug', { ascending: true }),
    );
    return characters.map((character) => {
      const slug = text(character['slug'], 'character.slug');
      const traits = core.CastTraits.safeParse(character['traits'] ?? {});
      if (!traits.success) {
        const problems = traits.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new AiJobHttpError(
          'invalid_request',
          `The character "${slug}" has facts that do not fit the cast bible (${problems}). Fix them in the characters editor first.`,
        );
      }
      return {
        slug,
        name: text(character['name'], 'character.name'),
        traits: traits.data,
        voice: isRecord(character['voice']) ? character['voice'] : {},
      };
    });
  }

  interface UnitContext {
    unit: Row;
    chapter: Row;
    scheme: Row;
    subject: { id: string; slug: string; name: string };
  }

  async function unitContext(unitId: string): Promise<UnitContext> {
    const unit = await row(
      db
        .from('units')
        .select(
          'id,chapter_id,unit_no,week_no,kind,title,objective,stage,periods,status,deleted_at',
        )
        .eq('id', unitId)
        .maybeSingle(),
    );
    if (!unit) throw notFound('unit');
    if (unit['deleted_at'] !== null && unit['deleted_at'] !== undefined) {
      throw new AiJobHttpError('conflict', 'This unit has been removed from the plan.');
    }
    if (unit['status'] === 'archived') {
      throw new AiJobHttpError('conflict', 'This unit is archived and takes no new version.');
    }
    const chapter = await row(
      db
        .from('chapters')
        .select('id,scheme_id,number,title,theme_id')
        .eq('id', text(unit['chapter_id'], 'unit.chapter_id'))
        .maybeSingle(),
    );
    if (!chapter) throw notFound('chapter');
    const scheme = await row(
      db
        .from('schemes')
        .select('id,subject_id,level_code,term,status')
        .eq('id', text(chapter['scheme_id'], 'chapter.scheme_id'))
        .maybeSingle(),
    );
    if (!scheme) throw notFound('scheme');
    const subject = await subjectById(text(scheme['subject_id'], 'scheme.subject_id'));
    return { unit, chapter, scheme, subject };
  }

  /** Every live unit of the subject and level, oldest first: by term, then by unit number. */
  async function unitsInOrder(subjectId: string, levelCode: string): Promise<Row[]> {
    const schemes = await rows(
      db.from('schemes').select('id,term').eq('subject_id', subjectId).eq('level_code', levelCode),
    );
    if (schemes.length === 0) return [];
    const termOf = new Map<string, number>(
      schemes.map((scheme) => [
        text(scheme['id'], 'scheme.id'),
        int(scheme['term'], 'scheme.term'),
      ]),
    );
    const chapters = await rows(
      db
        .from('chapters')
        .select('id,scheme_id')
        .in('scheme_id', [...termOf.keys()]),
    );
    if (chapters.length === 0) return [];
    const chapterTerm = new Map<string, number>(
      chapters.map((chapter) => [
        text(chapter['id'], 'chapter.id'),
        termOf.get(text(chapter['scheme_id'], 'chapter.scheme_id')) ?? 0,
      ]),
    );
    const units = await rows(
      db
        .from('units')
        .select('id,chapter_id,unit_no,title,objective,status,deleted_at')
        .in('chapter_id', [...chapterTerm.keys()]),
    );
    return units
      .filter((unit) => (unit['deleted_at'] ?? null) === null && unit['status'] !== 'archived')
      .map((unit) => ({
        unit: unit as Row,
        term: chapterTerm.get(text(unit['chapter_id'], 'unit.chapter_id')) ?? 0,
        unitNo: int(unit['unit_no'], 'unit.unit_no'),
      }))
      .sort((a, b) => a.term - b.term || a.unitNo - b.unitNo)
      .map(({ unit }) => unit);
  }

  /** The content of the latest version of a unit (any status), or null when it has none. */
  async function latestContent(unitId: string): Promise<Json | null> {
    const versions = await rows(
      db
        .from('unit_versions')
        .select('content')
        .eq('unit_id', unitId)
        .order('version', { ascending: false })
        .limit(1),
    );
    const first = versions[0];
    return first ? ((first['content'] ?? null) as Json) : null;
  }

  const sectionsOf = (content: Json | null): Row[] =>
    isRecord(content) && Array.isArray(content['sections'])
      ? (content['sections'] as unknown[]).filter(isRecord)
      : [];

  /** Terms defined in the unit (definition blocks), best effort, for the "Remember?" section of later units. */
  const keyTerms = (content: Json | null): string[] => {
    const terms: string[] = [];
    for (const section of sectionsOf(content)) {
      if (!Array.isArray(section['blocks'])) continue;
      for (const block of section['blocks'] as unknown[]) {
        if (
          isRecord(block) &&
          block['type'] === 'definition' &&
          typeof block['term'] === 'string'
        ) {
          const term = block['term'].trim();
          if (term !== '' && !terms.includes(term)) terms.push(term);
        }
      }
    }
    return terms.slice(0, MAX_TERMS_PER_UNIT);
  };

  /** The enrichment section types the unit uses (for the rotation rule), in order of appearance. */
  const enrichmentTypes = (content: Json | null): string[] => {
    const used: string[] = [];
    for (const section of sectionsOf(content)) {
      const type = section['type'];
      if (typeof type === 'string' && (ENRICHMENT_MENU as readonly string[]).includes(type))
        used.push(type);
    }
    return used;
  };

  /** The unit before this one in the subject and level (nearest earlier unit), and all the earlier ones. */
  async function earlierUnits(context: UnitContext): Promise<Row[]> {
    const ordered = await unitsInOrder(
      context.subject.id,
      text(context.scheme['level_code'], 'scheme.level_code'),
    );
    const index = ordered.findIndex((unit) => unit['id'] === context.unit['id']);
    return index > 0 ? ordered.slice(0, index) : [];
  }

  async function previousEnrichment(earlier: Row[]): Promise<string[]> {
    const previous = earlier[earlier.length - 1];
    if (!previous) return [];
    return enrichmentTypes(await latestContent(text(previous['id'], 'unit.id')));
  }

  async function theme(
    chapter: Row,
    unitId: string,
  ): Promise<{ slug: string; title: string; lens: string } | null> {
    const themeId = chapter['theme_id'];
    if (typeof themeId !== 'string') return null;
    const found = await row(db.from('themes').select('id,title').eq('id', themeId).maybeSingle());
    if (!found) return null;
    const link = await row(
      db
        .from('theme_units')
        .select('lens')
        .eq('theme_id', themeId)
        .eq('unit_id', unitId)
        .maybeSingle(),
    );
    const title = nonBlank(found['title']);
    const lens = link ? nonBlank(link['lens']) : null;
    return title !== null && lens !== null ? { slug: slugOf(title), title, lens } : null;
  }

  // --- the four kinds -----------------------------------------------------------------------------

  async function schemeIngest(params: JobParamsMap['scheme_ingest']): Promise<ResolvedJob> {
    const subject = await subjectById(params.subject_id);
    const existing = await row(
      db
        .from('schemes')
        .select('id,status')
        .eq('subject_id', subject.id)
        .eq('level_code', params.level_code)
        .eq('term', params.term)
        .maybeSingle(),
    );
    if (existing && existing['status'] !== 'draft') {
      throw new AiJobHttpError(
        'conflict',
        `There is already an ${String(existing['status'])} scheme for this subject, level and term. A scheme that is not a draft is never rewritten.`,
      );
    }
    if (params.source.type === 'pdf') await assertUploadExists(params.source);
    return {
      input: {
        subject_slug: subject.slug,
        subject_name: subject.name,
        level_code: params.level_code,
        term: params.term,
        source: params.source,
      },
      unitId: null,
      schemeId: null,
    };
  }

  /** The uploaded file must sit under the caller's own prefix and exist (the bucket policy enforces the prefix too). */
  async function assertUploadExists(source: SchemeSource): Promise<void> {
    const path = source.path ?? '';
    const parts = path.split('/');
    if (
      parts.length < 2 ||
      parts[0] !== userId ||
      parts.some((part) => part === '' || part === '.' || part === '..') ||
      path.length > 300
    ) {
      throw new AiJobHttpError(
        'invalid_request',
        'The uploaded file must be one you uploaded yourself.',
      );
    }
    const file = parts[parts.length - 1] as string;
    const directory = parts.slice(0, -1).join('/');
    const listed = await db.storage
      .from(SCHEME_UPLOADS_BUCKET)
      .list(directory, { limit: 20, search: file });
    if (listed.error) {
      log('storage_error', { message: listed.error.message ?? null });
      throw new AiJobHttpError('internal', 'The uploaded file could not be checked. Try again.');
    }
    if (!(listed.data ?? []).some((object) => object.name === file)) {
      throw new AiJobHttpError('not_found', 'The uploaded file was not found. Upload it again.');
    }
  }

  async function chapterPlan(params: JobParamsMap['chapter_plan']): Promise<ResolvedJob> {
    const scheme = await row(
      db
        .from('schemes')
        .select('id,subject_id,level_code,term,status')
        .eq('id', params.scheme_id)
        .maybeSingle(),
    );
    if (!scheme) throw notFound('scheme');
    if (scheme['status'] !== 'approved') {
      throw new AiJobHttpError(
        'conflict',
        'The scheme must be approved before a chapter plan can be drafted.',
      );
    }
    const subject = await subjectById(text(scheme['subject_id'], 'scheme.subject_id'));
    const weeks = await rows(
      db
        .from('scheme_weeks')
        .select('week_no,kind,topic,subtopics')
        .eq('scheme_id', params.scheme_id)
        .order('week_no', { ascending: true }),
    );
    return {
      input: {
        scheme_id: params.scheme_id,
        scheme: {
          subject_slug: subject.slug,
          level_code: scheme['level_code'],
          term: scheme['term'],
          weeks: weeks.map((week) => ({
            week_no: week['week_no'],
            kind: week['kind'],
            topic: week['topic'] ?? '',
            subtopics: Array.isArray(week['subtopics']) ? week['subtopics'] : [],
          })),
        },
        subject_name: subject.name,
        cast: await cast(),
      },
      unitId: null,
      schemeId: params.scheme_id,
    };
  }

  async function unitGenerate(params: JobParamsMap['unit_generate']): Promise<ResolvedJob> {
    const context = await unitContext(params.unit_id);
    const { unit, chapter, scheme, subject } = context;
    const unitId = text(unit['id'], 'unit.id');
    const weekNo =
      unit['week_no'] === null || unit['week_no'] === undefined
        ? null
        : int(unit['week_no'], 'unit.week_no');
    let week: Row | null = null;
    if (weekNo !== null) {
      week = await row(
        db
          .from('scheme_weeks')
          .select('week_no,topic,subtopics')
          .eq('scheme_id', text(scheme['id'], 'scheme.id'))
          .eq('week_no', weekNo)
          .maybeSingle(),
      );
    }
    const earlier = await earlierUnits(context);
    const prior = await Promise.all(
      earlier.slice(-PRIOR_UNITS_LIMIT).map(async (earlierUnit) => ({
        unit_no: int(earlierUnit['unit_no'], 'unit.unit_no'),
        title: text(earlierUnit['title'], 'unit.title'),
        objective: typeof earlierUnit['objective'] === 'string' ? earlierUnit['objective'] : null,
        key_terms: keyTerms(await latestContent(text(earlierUnit['id'], 'unit.id'))),
      })),
    );
    const chapterTheme = await theme(chapter, unitId);
    const weekTopic = week ? nonBlank(week['topic']) : null;
    return {
      input: {
        unit: {
          id: unitId,
          kind: unit['kind'],
          unit_no: unit['unit_no'],
          week_no: weekNo,
          title: unit['title'],
          objective: nonBlank(unit['objective']) ?? weekTopic ?? unit['title'],
          stage: unit['stage'],
          periods: unit['periods'],
        },
        chapter: { number: chapter['number'], title: chapter['title'] },
        subject: { slug: subject.slug, name: subject.name },
        level_code: scheme['level_code'],
        term: scheme['term'],
        ...(chapterTheme ? { theme: chapterTheme } : {}),
        scheme_week: week
          ? {
              topic: week['topic'] ?? '',
              subtopics: Array.isArray(week['subtopics']) ? week['subtopics'] : [],
            }
          : null,
        prior_units: prior,
        previous_enrichment: await previousEnrichment(earlier),
        cast: await cast(),
        ...(params.notes ? { notes: params.notes } : {}),
      },
      unitId,
      schemeId: text(scheme['id'], 'scheme.id'),
    };
  }

  async function unitRevise(params: JobParamsMap['unit_revise']): Promise<ResolvedJob> {
    const version = await row(
      db
        .from('unit_versions')
        .select('id,unit_id,version,content,status')
        .eq('id', params.unit_version_id)
        .maybeSingle(),
    );
    if (!version) throw notFound('version');
    const unitId = text(version['unit_id'], 'version.unit_id');
    const latest = await rows(
      db
        .from('unit_versions')
        .select('id,version')
        .eq('unit_id', unitId)
        .order('version', { ascending: false })
        .limit(1),
    );
    if (latest[0] && latest[0]['id'] !== version['id']) {
      throw new AiJobHttpError(
        'conflict',
        'A newer version of this unit exists. Reload the page and revise the latest version.',
      );
    }
    const content = (version['content'] ?? null) as Json | null;
    if (params.section_ids) {
      const known = new Set(sectionsOf(content).map((section) => section['id']));
      const unknown = params.section_ids.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new AiJobHttpError(
          'invalid_request',
          `This version has no section "${unknown[0] as string}".`,
        );
      }
    }
    const context = await unitContext(unitId);
    const earlier = await earlierUnits(context);
    return {
      input: {
        unit_id: unitId,
        base_version_id: text(version['id'], 'version.id'),
        base_version_no: int(version['version'], 'version.version'),
        base_content: content,
        instruction: params.instruction,
        ...(params.section_ids ? { section_ids: params.section_ids } : {}),
        previous_enrichment: await previousEnrichment(earlier),
        cast: await cast(),
      },
      unitId,
      schemeId: text(context.scheme['id'], 'scheme.id'),
    };
  }

  return {
    async resolve<K extends JobKind>(kind: K, params: JobParamsMap[K]): Promise<ResolvedJob> {
      switch (kind) {
        case 'scheme_ingest':
          return schemeIngest(params as JobParamsMap['scheme_ingest']);
        case 'chapter_plan':
          return chapterPlan(params as JobParamsMap['chapter_plan']);
        case 'unit_generate':
          return unitGenerate(params as JobParamsMap['unit_generate']);
        case 'unit_revise':
          return unitRevise(params as JobParamsMap['unit_revise']);
        default:
          throw new AiJobHttpError('invalid_request', 'Unknown job kind.');
      }
    },
  };
}

/** `Market Day` -> `market-day`: a slug that fits the content-schema `Slug` (starts with a letter). */
export function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return 'theme';
  return /^[a-z]/.test(slug) ? slug : `theme-${slug}`;
}
