// The demo model: a FIXTURE-BACKED LlmClient for the admin app's demo mode and for tests. It is not a toy and it
// is not Claude. For every step the real engine asks for, it answers with content taken from the repo's
// fixtures: the P1 Basic Science scheme for ingestion, chapter and unit titles from the scheme topics, section
// bodies from the golden Unit 2 re-keyed to the requested section ids and types, workbook and manual parts from
// the golden unit, a project from the colour-chart mini project. The engine's own validation, assembly, parse and
// lint run on top, so the whole pipeline produces a unit that passes parseUnit and lintUnit.
//
// Every string of authored content it emits is a fixture's string. It reports the model id DEMO_MODEL_ID, never a
// Claude id, and its review flags say so, so a demo draft cannot be mistaken for real output.
import {
  goldenUnit2,
  marketDayMathsUnit,
  colourChartProject,
  p1BasicScienceSchemes,
} from '@custar/content-schema/fixtures';
import type { AnyBlock, Question, Section, TutorScript } from '@custar/content-schema';
import {
  LlmError,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from '../contract';
import { STAGE_BY_LEVEL } from '../engine/levels';
import { blockToAuthor, questionToAuthor, tutorToAuthor } from '../engine/mapping';
import { parseContextBlocks, parseDataBlocks } from '../prompts/fence';
import type {
  AuthorBlock,
  AuthorQuestion,
  AuthorSectionBody,
  AuthorTutorLine,
  ChapterTitlesOutput,
  ManualOutput,
  OutlineOutput,
  PatchOutput,
  ProjectDraftOutput,
  RepairOutput,
  ReviewOutput,
  SchemeExtractOutput,
  TestDraftOutput,
  WorkbookOutput,
} from '../prompts/schemas';

/** The model id the demo reports. Never a Claude id. */
export const DEMO_MODEL_ID = 'demo-fixture-model';

const DEMO_NOTICE =
  'DEMO MODEL: this draft was assembled from built-in fixture content (the template unit), not written by Claude for this unit. Nothing here has been reviewed by a model.';

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Fixture access
// ---------------------------------------------------------------------------------------------

const GOLDEN_SECTION = new Map<string, Section>(goldenUnit2.sections.map((s) => [s.id, s]));
const GOLDEN_QUESTIONS = goldenUnit2.questions;
const MARKET_SECTION = new Map<string, Section>(marketDayMathsUnit.sections.map((s) => [s.id, s]));

const GOLDEN_CONCEPTS = [
  'places_in_school',
  'places_in_home',
  'people_in_environment',
  'staying_safe',
];
const GOLDEN_BY_TYPE: Record<string, string> = {
  story_opener: 'come_and_explore',
  remember: 'remember_senses',
  worked_examples: 'lets_look_together',
  do_and_discover: 'our_places_walk',
  character_values: 'keeping_clean',
  tell_it_back: 'tell_it_back',
  practice: 'practice_time',
  think_deeper: 'think_deeper',
  quick_fire: 'quick_fire',
  mastery_check: 'have_i_got_it',
};

function goldenIdFor(sectionId: string, type: string): string | null {
  if (type === 'concept') {
    const n = Number(/(\d+)$/.exec(sectionId)?.[1] ?? '1');
    return GOLDEN_CONCEPTS[(Math.max(1, n) - 1) % GOLDEN_CONCEPTS.length] ?? null;
  }
  return GOLDEN_BY_TYPE[type] ?? null;
}

function acceptedOf(question: Question | undefined): string[] {
  if (!question) return [];
  if (question.kind === 'fill_blank') return [...(question.answer.blanks[0]?.accepted ?? [])];
  if (question.kind === 'mcq')
    return [question.options[question.answer.correct_index] ?? ''].filter((x) => x !== '');
  return [];
}

/** A golden section as an authoring body. Questions the section owns keep their ids as refs. */
function bodyFromSection(
  section: Section,
  questions: Readonly<Record<string, Question>>,
): AuthorSectionBody {
  const placed = section.blocks.flatMap((b) => (b.type === 'question' ? [b.question_id] : []));
  const owned = [...new Set(placed)];
  const authoredQuestions = owned.flatMap((id) => {
    const q = questions[id];
    const authored = q ? questionToAuthor(q) : null;
    return authored ? [authored] : [];
  });
  const ownedIds = new Set(authoredQuestions.map((q) => q.ref));
  const tutor: AuthorTutorLine[] = tutorToAuthor(
    section.tutor_script as TutorScript | undefined,
  ).map((line) => {
    if (line.question_ref === '' || ownedIds.has(line.question_ref)) return line;
    // the template's tutor graded a question owned by another section: list its accepted answers instead
    return { ...line, question_ref: '', accepted: acceptedOf(questions[line.question_ref]) };
  });
  return {
    blocks: section.blocks.map((block: AnyBlock) => blockToAuthor(block)),
    questions: authoredQuestions,
    tutor_script: tutor,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------------------------

function userText(messages: readonly LlmMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') parts.push(message.content);
    else for (const part of message.content) if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}

function asRec(value: unknown): Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------------------------
// Per-step answers
// ---------------------------------------------------------------------------------------------

function extractAnswer(ctx: Rec): SchemeExtractOutput {
  const term = Number(ctx['term'] ?? 1);
  const scheme =
    p1BasicScienceSchemes[Math.max(0, Math.min(2, term - 1))] ?? p1BasicScienceSchemes[0]!;
  return {
    document_says: { subject: '', class_level: '', term: '' },
    weeks: scheme.weeks.map((week) => ({
      week_no: week.week_no,
      kind: week.kind,
      topic: week.topic,
      subtopics: [...week.subtopics],
    })),
    notes: [
      'DEMO MODEL: these weeks come from the built-in Primary 1 Basic Science fixture, not from your document.',
    ],
  };
}

function baseTopic(topic: string): string {
  return topic
    .replace(/\s*\(Part \d+\)/i, '')
    .replace(/:.*$/, '')
    .trim();
}

function titlesAnswer(job: Rec, data: Rec): ChapterTitlesOutput {
  const level = (str(job['level_code']) || 'P1') as keyof typeof STAGE_BY_LEVEL;
  const stage = STAGE_BY_LEVEL[level] ?? STAGE_BY_LEVEL.P1;
  const chapters = asArray(data['chapters']).map((raw) => {
    const chapter = asRec(raw);
    const weeks = asArray(chapter['weeks']).map(asRec);
    const bases = [...new Set(weeks.map((w) => baseTopic(str(w['topic']))))];
    const first = str(weeks[0]?.['topic']);
    const isGoldenChapter = first === 'Exploring Our Environment (Part 1)';
    const title = isGoldenChapter
      ? goldenUnit2.header.chapter.title
      : `${bases[0] ?? 'Chapter'}${bases.length > 1 ? ' and More' : ''}`;
    const theme = isGoldenChapter ? goldenUnit2.header.theme : undefined;
    return {
      chapter_no: Number(chapter['chapter_no']),
      title,
      theme_slug: theme?.slug ?? '',
      theme_title: theme?.title ?? '',
      theme_lens: theme?.lens ?? '',
      units: weeks.map((week) => {
        const subtopics = asArray(week['subtopics']).map(str);
        const topic = str(week['topic']);
        const isGoldenUnit = topic === 'Exploring Our Environment (Part 2)';
        return {
          week_no: Number(week['week_no']),
          title: topic,
          objective: isGoldenUnit ? goldenUnit2.header.objective : [topic, ...subtopics].join('; '),
          stage: stage.stage,
          stage_to: stage.stage_to ?? ('none' as const),
        };
      }),
    };
  });
  return { chapters };
}

const TEMPLATE_FIVE = [
  'story_opener',
  'remember',
  'do_and_discover',
  'character_values',
  'tell_it_back',
] as const;
const CANONICAL = [
  'story_opener',
  'remember',
  'concept',
  'worked_examples',
  'across_subjects',
  'window_to_world',
  'do_and_discover',
  'character_values',
  'tell_it_back',
  'practice',
  'think_deeper',
  'quick_fire',
  'mastery_check',
];

function pickEnrichment(previous: readonly string[], hasPriors: boolean): string[] {
  const without = (list: readonly string[]) =>
    hasPriors ? [...list] : list.filter((t) => t !== 'remember');
  const candidates = [
    hasPriors
      ? [...TEMPLATE_FIVE]
      : ['story_opener', 'window_to_world', 'do_and_discover', 'character_values', 'tell_it_back'],
    without(['story_opener', 'remember', 'window_to_world', 'do_and_discover', 'tell_it_back']),
    ['story_opener', 'window_to_world', 'do_and_discover', 'across_subjects', 'character_values'],
    ['story_opener', 'do_and_discover', 'tell_it_back'],
  ];
  const prev = new Set(previous);
  const same = (list: readonly string[]) =>
    list.length === prev.size && list.every((t) => prev.has(t));
  return candidates.find((list) => !same(list)) ?? candidates[0]!;
}

function outlineAnswer(facts: Rec, data: Rec): OutlineOutput {
  const hasPriors = facts['has_earlier_units'] === true;
  const enrichment = pickEnrichment(asArray(facts['previous_enrichment']).map(str), hasPriors);
  const week = asRec(asRec(data['unit_text'])['scheme_week']);
  const subtopicCount = asArray(week['subtopics']).length;
  const conceptCount = subtopicCount > 0 ? Math.max(1, Math.min(4, subtopicCount)) : 4;
  const concepts = Array.from({ length: conceptCount }, (_, k) => ({
    heading: GOLDEN_SECTION.get(GOLDEN_CONCEPTS[k]!)!.heading,
    plan: '',
    covers:
      subtopicCount === 0
        ? []
        : Array.from({ length: subtopicCount }, (_, i) => i + 1).filter(
            (n) => Math.min(n - 1, conceptCount - 1) === k,
          ),
  }));
  const headingOf = (type: string): string => {
    const golden = GOLDEN_SECTION.get(GOLDEN_BY_TYPE[type] ?? '');
    if (golden) return golden.heading;
    return MARKET_SECTION.get('market_window')?.heading ?? '';
  };
  const plan = (type: string) => ({ heading: headingOf(type), plan: '' });

  const ids = CANONICAL.flatMap((type) => {
    if (type === 'concept') return concepts.map((_, k) => `concept_${k + 1}`);
    if (
      ['worked_examples', 'practice', 'think_deeper', 'quick_fire', 'mastery_check'].includes(type)
    )
      return [type];
    return enrichment.includes(type) ? [type] : [];
  });
  const periodCount = Math.max(1, Math.min(Number(facts['periods'] ?? 2), ids.length));
  const first = new Set([
    'story_opener',
    'remember',
    'concept_1',
    'concept_2',
    'do_and_discover',
    'quick_fire',
  ]);
  let groups: string[][];
  if (periodCount === 2) {
    groups = [ids.filter((id) => first.has(id)), ids.filter((id) => !first.has(id))];
  } else {
    const size = Math.ceil(ids.length / periodCount);
    groups = Array.from({ length: periodCount }, (_, i) => ids.slice(i * size, (i + 1) * size));
  }
  const periods = groups.map((sections, index) => {
    const source = goldenUnit2.session_plan[index] ?? goldenUnit2.session_plan[0]!;
    const minutes = Object.fromEntries(source.minutes.map((m) => [m.segment, m.minutes]));
    return {
      sections,
      start: minutes['start'] ?? 10,
      teach: minutes['teach'] ?? 15,
      move_and_do: minutes['move_and_do'] ?? 15,
      practice: minutes['practice'] ?? 10,
      close: minutes['close'] ?? 10,
    };
  });
  return {
    enrichment: enrichment.map((type) => ({
      type: type as OutlineOutput['enrichment'][number]['type'],
      heading: type === 'across_subjects' ? 'Across Subjects' : headingOf(type),
      plan: '',
    })),
    concepts,
    worked_examples: plan('worked_examples'),
    practice: plan('practice'),
    think_deeper: plan('think_deeper'),
    quick_fire: plan('quick_fire'),
    mastery_check: plan('mastery_check'),
    periods,
  };
}

function sectionAnswer(sectionCtx: Rec): AuthorSectionBody {
  const id = str(sectionCtx['id']);
  const type = str(sectionCtx['type']);
  if (type === 'window_to_world') {
    return bodyFromSection(MARKET_SECTION.get('market_window')!, marketDayMathsUnit.questions);
  }
  if (type === 'across_subjects') {
    const map = goldenUnit2.teacher_manual.theme_map;
    const blocks: AuthorBlock[] = [
      blockToAuthor({
        type: 'bullets',
        items: (map?.lenses ?? []).map((lens) => ({
          lead: lens.subject,
          text: lens.what_child_does,
        })),
      }),
      blockToAuthor({ type: 'paragraph', text: map?.connection_moment ?? '' }),
    ];
    return { blocks, questions: [], tutor_script: [] };
  }
  const goldenId = goldenIdFor(id, type);
  const golden = goldenId ? GOLDEN_SECTION.get(goldenId) : undefined;
  if (!golden) {
    // revision_topic, assessment_part and anything unknown: the mastery check's questions
    return bodyFromSection(GOLDEN_SECTION.get('have_i_got_it')!, GOLDEN_QUESTIONS);
  }
  return bodyFromSection(golden, GOLDEN_QUESTIONS);
}

function workbookAnswer(): WorkbookOutput {
  const wb = goldenUnit2.workbook;
  const author = (id: string): AuthorQuestion => questionToAuthor(GOLDEN_QUESTIONS[id]!)!;
  const drill = wb.quick_answer_drill.question_ids
    .filter((id) => GOLDEN_QUESTIONS[id]?.kind === 'fill_blank')
    .map(author);
  return {
    tier1_title: wb.tiers[0]!.title,
    tier2_title: wb.tiers[1]!.title,
    tier3_title: wb.tiers[2]!.title,
    drill,
    drill_seconds: wb.quick_answer_drill.seconds,
    take_it_home: wb.take_it_home,
    application: author(wb.application_task_id),
    not_yet: wb.not_yet ?? '',
    variants: wb.practice_variants.map((variant) => ({
      questions: variant.question_ids.map(author),
    })),
  };
}

function manualAnswer(facts: Rec): ManualOutput {
  const manual = goldenUnit2.teacher_manual;
  const sectionIds = asArray(facts['section_ids']).map(str);
  // map each requested id back to a template section id by its type: concept_k, otherwise the type name
  const goldenFor = (id: string): string => {
    if (/^concept_\d+$/.test(id)) return goldenIdFor(id, 'concept') ?? 'places_in_school';
    if (id === 'across_subjects') return 'lets_look_together';
    return GOLDEN_BY_TYPE[id] ?? id;
  };
  const scriptOf = (goldenId: string) =>
    manual.script.find((entry) => entry.section_id === goldenId);
  const script = sectionIds.flatMap((id) => {
    if (id === 'window_to_world') {
      const entry = marketDayMathsUnit.teacher_manual.script.find(
        (e) => e.section_id === 'market_window',
      );
      return entry
        ? [{ section_id: id, say: entry.say, ask: entry.ask, watch_for: entry.watch_for }]
        : [];
    }
    const entry = scriptOf(goldenFor(id));
    return entry
      ? [{ section_id: id, say: entry.say, ask: entry.ask, watch_for: entry.watch_for }]
      : [];
  });
  const helper = sectionIds.flatMap((id) => {
    const entry = manual.helper_script.find((e) => e.section_id === goldenFor(id));
    return entry ? [{ section_id: id, steps: [...entry.steps] }] : [];
  });
  return {
    script,
    theme_lenses: (manual.theme_map?.lenses ?? []).map((lens) => ({ ...lens })),
    connection_moment: manual.theme_map?.connection_moment ?? '',
    materials: [...manual.materials],
    got_it: [...manual.mastery_guidance.got_it],
    not_yet_guidance: manual.mastery_guidance.not_yet,
    helper_script: helper,
  };
}

function reviewAnswer(): ReviewOutput {
  return { flags: [{ code: 'other', severity: 'note', section_id: '', message: DEMO_NOTICE }] };
}

function repairAnswer(data: Rec): RepairOutput {
  return {
    sections: asArray(data['sections_to_repair']).map((raw) => {
      const section = asRec(raw);
      const authoring = asRec(section['authoring']);
      return {
        id: str(section['id']),
        blocks: asArray(authoring['blocks']) as AuthorBlock[],
        questions: asArray(authoring['questions']) as AuthorQuestion[],
        tutor_script: asArray(authoring['tutor_script']) as AuthorTutorLine[],
      };
    }),
  };
}

function projectAnswer(): ProjectDraftOutput {
  const project = colourChartProject;
  const tutor = tutorToAuthor(project.tutor_script).map((line) =>
    line.question_ref === ''
      ? line
      : { ...line, question_ref: '', accepted: acceptedOf(project.questions?.[line.question_ref]) },
  );
  return {
    brief: project.brief,
    steps: project.steps.map((step) => step.text),
    materials: [...project.materials],
    rubric: project.rubric.map((row) => ({
      criterion: row.criterion,
      levels: row.levels.map((l) => l.descriptor),
    })),
    evidence_options: [...project.evidence_options],
    reflection_prompts: [...project.reflection_prompts],
    tutor_script: tutor,
  };
}

function testAnswer(): TestDraftOutput {
  return {
    parts: ['quick_fire', 'have_i_got_it'].map((id) => {
      const section = GOLDEN_SECTION.get(id)!;
      const body = bodyFromSection(section, GOLDEN_QUESTIONS);
      return { heading: section.heading, blocks: body.blocks, questions: body.questions };
    }),
  };
}

function patchAnswer(facts: Rec, data: Rec): PatchOutput {
  const empty: PatchOutput = {
    summary: '',
    sections: [],
    questions: [],
    workbook: { tier1_title: '', tier2_title: '', tier3_title: '', take_it_home: '', not_yet: '' },
    manual: { script: [], helper_script: [], materials: [], got_it: [], not_yet_guidance: '' },
  };
  const index = asArray(facts['sections']).map(asRec);
  const restricted = asArray(facts['restricted_to']).map(str);
  const target =
    restricted[0] ??
    str(index.find((s) => s['type'] === 'story_opener')?.['id'] ?? index[0]?.['id']);
  const base = asRec(data['base_unit']);
  const section = asArray(base['sections'])
    .map(asRec)
    .find((s) => s['id'] === target);
  if (!section) return { ...empty, summary: 'DEMO MODEL: there was nothing to change.' };
  const blocks = asArray(section['blocks']) as AuthorBlock[];
  let next = blocks.filter((b) => b.type !== 'illustration');
  if (next.length === blocks.length || next.length === 0)
    next = blocks.slice(0, Math.max(1, blocks.length - 1));
  if (next.length === blocks.length)
    return { ...empty, summary: 'DEMO MODEL: the fixture revision found nothing to shorten.' };
  return {
    ...empty,
    summary: `DEMO MODEL: shortened section ${target} by dropping its last block (the fixture revision does not read your instruction).`,
    sections: [{ id: target, type: '', heading: '', blocks: next, tutor_script: [] }],
  };
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

function answerFor(request: LlmRequest<unknown>): unknown {
  const text = userText(request.messages);
  const ctx = parseContextBlocks(text);
  const data = parseDataBlocks(text);
  switch (request.schemaName) {
    case 'scheme_extract':
      return extractAnswer(asRec(ctx['job']));
    case 'chapter_titles':
      return titlesAnswer(asRec(ctx['job']), data);
    case 'unit_outline':
      return outlineAnswer(asRec(ctx['unit_facts']), data);
    case 'unit_section':
      return sectionAnswer(asRec(ctx['section']));
    case 'unit_workbook':
      return workbookAnswer();
    case 'unit_manual':
      return manualAnswer(asRec(ctx['manual_facts']));
    case 'unit_review':
      return reviewAnswer();
    case 'unit_repair':
      return repairAnswer(data);
    case 'unit_project':
      return projectAnswer();
    case 'unit_test':
      return testAnswer();
    case 'unit_patch':
      return patchAnswer(asRec(ctx['patch_facts']), data);
    default:
      throw new LlmError(
        'refusal',
        `The demo model does not know the step "${request.schemaName}".`,
        { retryable: false },
      );
  }
}

/** A fixture-backed model. Deterministic: the same request always gets the same reply. */
export function createDemoLlm(): LlmClient {
  const seenSystems = new Set<string>();
  return {
    generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      let value: unknown;
      try {
        value = answerFor(request as LlmRequest<unknown>);
      } catch (error) {
        return Promise.reject(error);
      }
      const parsed = request.schema.safeParse(value);
      if (!parsed.success) {
        return Promise.reject(
          new LlmError(
            'schema',
            `The demo model's fixture reply does not fit "${request.schemaName}": ${parsed.error.message}`,
            {
              raw: JSON.stringify(value),
            },
          ),
        );
      }
      const systemText = request.system.map((block) => block.text).join('\n');
      const systemTokens = estimateTokens(systemText.length);
      const cached = request.system.some((block) => block.cache === true);
      const messageChars = userText(request.messages).length;
      const firstSight = cached && !seenSystems.has(systemText);
      if (cached) seenSystems.add(systemText);
      const usage: LlmUsage = {
        input_tokens: estimateTokens(cached ? messageChars : messageChars + systemText.length),
        output_tokens: estimateTokens(JSON.stringify(value).length),
        cache_read_tokens: cached && !firstSight ? systemTokens : 0,
        cache_creation_tokens: firstSight ? systemTokens : 0,
      };
      return Promise.resolve({
        value: parsed.data,
        usage,
        model: DEMO_MODEL_ID,
        stopReason: 'end_turn',
      });
    },
  };
}
