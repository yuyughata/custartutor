import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { colourChartProject, goldenUnit2, marketDayMathsUnit } from './fixtures';
import { lintUnit } from './lint';
import { Question } from './question';
import { Section } from './sections';
import { TutorScript } from './tutor-script';
import { clone, getAt, pushAt, rawClone, removeAt, setAt } from './test-utils';
import {
  AssessmentUnit,
  LessonUnit,
  MiniProjectUnit,
  RevisionUnit,
  TermProjectUnit,
  UnitContent,
  questionsOf,
  sectionsOf,
} from './unit';
import type {
  AssessmentUnit as AssessmentUnitType,
  RevisionUnit as RevisionUnitType,
} from './unit';

/** Issue paths from a failed parse, as dotted strings. */
function failurePaths(
  schema: {
    safeParse(input: unknown): { success: boolean; error?: { issues: { path: PropertyKey[] }[] } };
  },
  input: unknown,
): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => issue.path.map(String).join('.'));
}

function revisionUnit(): RevisionUnitType {
  const questions = {
    q_cook: goldenUnit2.questions.qf_cook,
    q_gutter: goldenUnit2.questions.qf_gutter,
  };
  if (!questions.q_cook || !questions.q_gutter) throw new Error('fixture');
  return {
    schema_version: 1,
    kind: 'revision',
    header: {
      subject_slug: 'basic-science',
      level_code: 'P1',
      term: 1,
      week_no: 11,
      title: 'Revision',
      objective: 'Review of all topics: Environment, roads, colours, shapes, living things',
      stage: 'absorb',
    },
    sections: [
      {
        id: 'review_places',
        type: 'revision_topic',
        layer: 'CORE',
        heading: 'Places',
        blocks: [
          { type: 'paragraph', text: 'Let us remember our places.' },
          { type: 'question', question_id: 'q_cook' },
          { type: 'question', question_id: 'q_gutter' },
        ],
      },
    ],
    questions: {
      q_cook: { ...questions.q_cook, id: 'q_cook' },
      q_gutter: { ...questions.q_gutter, id: 'q_gutter' },
    },
    scoring: { total_marks: 10, pass_mark: 5 },
  };
}

function assessmentUnit(): AssessmentUnitType {
  const revision = revisionUnit();
  return {
    ...revision,
    kind: 'assessment',
    header: { ...revision.header, title: 'End of Term Assessment', week_no: 12 },
    sections: [
      { ...revision.sections[0]!, id: 'part_one', type: 'assessment_part', heading: 'Part One' },
    ],
  };
}

describe('UnitContent: lesson', () => {
  it('parses the golden unit and the Market Day unit', () => {
    expect(LessonUnit.safeParse(goldenUnit2).success).toBe(true);
    expect(LessonUnit.safeParse(marketDayMathsUnit).success).toBe(true);
    expect(UnitContent.parse(goldenUnit2).kind).toBe('lesson');
  });

  it.each([
    ['header', 'header'],
    ['sections', 'sections'],
    ['questions', 'questions'],
    ['session_plan', 'session_plan'],
    ['workbook', 'workbook'],
    ['teacher_manual', 'teacher_manual'],
  ])('fails without %s', (key) => {
    const raw = rawClone(goldenUnit2);
    removeAt(raw, [key]);
    expect(failurePaths(UnitContent, raw)).toContain(key);
  });

  it('fails when the header is invalid', () => {
    const cases: [(string | number)[], unknown][] = [
      [['header', 'term'], 4],
      [['header', 'level_code'], 'P7'],
      [['header', 'week_no'], 0],
      [['header', 'unit_no'], 1.5],
      [['header', 'stage'], 'master'],
      [['header', 'subject_slug'], 'Basic Science'],
      [['header', 'chapter', 'number'], 0],
      [['header', 'theme', 'slug'], 'Not A Slug'],
    ];
    for (const [path, value] of cases) {
      const raw = rawClone(goldenUnit2);
      setAt(raw, path, value);
      expect(failurePaths(UnitContent, raw), path.join('.')).toContain(path.join('.'));
    }
  });

  it('rejects a stage_to that is earlier than the stage', () => {
    const raw = rawClone(goldenUnit2);
    setAt(raw, ['header', 'stage'], 'connect');
    setAt(raw, ['header', 'stage_to'], 'absorb');
    expect(failurePaths(UnitContent, raw)).toContain('header.stage_to');
    setAt(raw, ['header', 'stage_to'], 'connect');
    expect(failurePaths(UnitContent, raw)).toEqual([]);
  });

  it('rejects the wrong schema_version', () => {
    expect(failurePaths(UnitContent, { ...clone(goldenUnit2), schema_version: 2 })).toContain(
      'schema_version',
    );
  });

  it('rejects a section with a bad id, type or layer, or no blocks', () => {
    const cases: [(string | number)[], unknown][] = [
      [['sections', 0, 'id'], 'Bad Id'],
      [['sections', 0, 'type'], 'chapter_intro'],
      [['sections', 0, 'layer'], 'EXTRA'],
      [['sections', 0, 'blocks'], []],
      [['sections', 0, 'heading'], ''],
    ];
    for (const [path, value] of cases) {
      const raw = rawClone(goldenUnit2);
      setAt(raw, path, value);
      expect(failurePaths(UnitContent, raw)).toContain(path.join('.'));
    }
  });

  it('rejects duplicate section ids', () => {
    const raw = rawClone(goldenUnit2);
    setAt(raw, ['sections', 1, 'id'], 'come_and_explore');
    expect(failurePaths(UnitContent, raw)).toContain('sections.1.id');
  });

  it('rejects every kind of dangling reference', () => {
    const raw = rawClone(goldenUnit2);
    pushAt(raw, ['sections', 0, 'blocks'], { type: 'question', question_id: 'q_ghost' });
    pushAt(raw, ['workbook', 'tiers', 0, 'question_ids'], 'q_ghost');
    pushAt(raw, ['workbook', 'quick_answer_drill', 'question_ids'], 'q_ghost');
    setAt(raw, ['workbook', 'application_task_id'], 'q_ghost');
    pushAt(raw, ['workbook', 'practice_variants', 0, 'question_ids'], 'q_ghost');
    pushAt(raw, ['session_plan', 0, 'sections'], 'section_ghost');
    pushAt(raw, ['teacher_manual', 'script'], {
      section_id: 'section_ghost',
      say: 'a',
      ask: 'b',
      watch_for: 'c',
    });
    pushAt(raw, ['teacher_manual', 'helper_script'], { section_id: 'section_ghost', steps: ['a'] });
    setAt(raw, ['sections', 0, 'tutor_script', 'nodes', 1, 'expect'], { question_id: 'q_ghost' });
    const paths = failurePaths(UnitContent, raw);
    expect(paths).toEqual(
      expect.arrayContaining([
        'sections.0.blocks.4.question_id',
        'workbook.tiers.0.question_ids.2',
        'workbook.quick_answer_drill.question_ids.5',
        'workbook.application_task_id',
        'workbook.practice_variants.0.question_ids.3',
        'session_plan.0.sections.6',
        `teacher_manual.script.${goldenUnit2.teacher_manual.script.length}.section_id`,
        `teacher_manual.helper_script.${goldenUnit2.teacher_manual.helper_script.length}.section_id`,
        'sections.0.tutor_script.nodes.1.expect.question_id',
      ]),
    );
  });

  it('requires the questions map key to equal the question id', () => {
    const raw = rawClone(goldenUnit2);
    setAt(raw, ['questions', 'qf_cook', 'id'], 'qf_other');
    expect(failurePaths(UnitContent, raw)).toContain('questions.qf_cook.id');
  });

  it('allows the workbook to have fewer than three tiers at parse time (lint enforces three)', () => {
    const unit = clone(goldenUnit2);
    unit.workbook.tiers = unit.workbook.tiers.slice(0, 1);
    expect(LessonUnit.safeParse(unit).success).toBe(true);
    expect(lintUnit(unit).errors.map((e) => e.code)).toContain('workbook_tiers');
  });

  it('rejects a workbook with four tiers or a tier number repeated out of range', () => {
    const raw = rawClone(goldenUnit2);
    pushAt(raw, ['workbook', 'tiers'], { tier: 3, title: 'Extra', question_ids: ['qf_cook'] });
    expect(failurePaths(UnitContent, raw)).toContain('workbook.tiers');
    const outOfRange = rawClone(goldenUnit2);
    setAt(outOfRange, ['workbook', 'tiers', 0, 'tier'], 5);
    expect(failurePaths(UnitContent, outOfRange)).toContain('workbook.tiers.0.tier');
  });

  it('rejects a bad session segment', () => {
    const raw = rawClone(goldenUnit2);
    setAt(raw, ['session_plan', 0, 'minutes', 0, 'segment'], 'nap');
    expect(failurePaths(UnitContent, raw)).toContain('session_plan.0.minutes.0.segment');
  });

  it('parses a section tree with a section-level audio ref and language', () => {
    const unit = clone(goldenUnit2);
    const first = unit.sections[0];
    if (first) {
      first.lang = 'en-NG';
      first.audio_refs = ['aud_story_opener_01'];
    }
    expect(LessonUnit.parse(unit).sections[0]).toMatchObject({
      lang: 'en-NG',
      audio_refs: ['aud_story_opener_01'],
    });
  });
});

describe('UnitContent: projects', () => {
  it('parses the mini-project fixture', () => {
    expect(MiniProjectUnit.parse(colourChartProject)).toEqual(colourChartProject);
    expect(UnitContent.parse(colourChartProject).kind).toBe('mini_project');
  });

  it('parses a term project that reuses the project shape', () => {
    const termProject = { ...clone(colourChartProject), kind: 'term_project' as const };
    expect(TermProjectUnit.safeParse(termProject).success).toBe(true);
    expect(UnitContent.parse(termProject).kind).toBe('term_project');
    expect(MiniProjectUnit.safeParse(termProject).success).toBe(false);
  });

  it('parses a minimal project with no sections, questions or tutor script', () => {
    const minimal = clone(colourChartProject);
    delete minimal.sections;
    delete minimal.questions;
    delete minimal.tutor_script;
    delete minimal.header.chapter;
    delete minimal.header.week_no;
    delete minimal.header.unit_no;
    expect(MiniProjectUnit.safeParse(minimal).success).toBe(true);
    expect(sectionsOf(minimal)).toEqual([]);
    expect(questionsOf(minimal)).toEqual({});
  });

  it.each([
    ['steps', []],
    ['materials', []],
    ['rubric', []],
    ['evidence_options', []],
    ['reflection_prompts', []],
    ['brief', ''],
  ])('rejects %s = %j', (key, value) => {
    const raw = rawClone(colourChartProject);
    setAt(raw, [key], value);
    expect(failurePaths(UnitContent, raw)).toContain(key);
  });

  it('rejects an evidence option that is not photo, drawing, audio or text', () => {
    const raw = rawClone(colourChartProject);
    setAt(raw, ['evidence_options'], ['video']);
    expect(failurePaths(UnitContent, raw)).toContain('evidence_options.0');
  });

  it('requires steps numbered 1, 2, 3 in order', () => {
    const raw = rawClone(colourChartProject);
    setAt(raw, ['steps', 1, 'n'], 5);
    expect(failurePaths(UnitContent, raw)).toContain('steps.1.n');
  });

  it('rejects repeated evidence options and a rubric row with one level', () => {
    const raw = rawClone(colourChartProject);
    setAt(raw, ['evidence_options'], ['photo', 'photo']);
    expect(failurePaths(UnitContent, raw)).toContain('evidence_options');
    const rubric = rawClone(colourChartProject);
    setAt(rubric, ['rubric', 0, 'levels'], [{ level: 1, descriptor: 'Only one' }]);
    expect(failurePaths(UnitContent, rubric)).toContain('rubric.0.levels');
  });

  it('resolves references inside optional sections and the tutor script', () => {
    const raw = rawClone(colourChartProject);
    pushAt(raw, ['sections', 0, 'blocks'], { type: 'question', question_id: 'q_ghost' });
    setAt(raw, ['tutor_script', 'nodes', 1, 'expect'], { question_id: 'q_ghost_two' });
    const paths = failurePaths(UnitContent, raw);
    expect(paths).toContain('sections.0.blocks.3.question_id');
    expect(paths).toContain('tutor_script.nodes.1.expect.question_id');
    expect(getAt(raw, ['questions', 'colour_mix_green'])).toBeDefined();
  });
});

describe('UnitContent: revision and assessment', () => {
  it('parses a revision unit and an assessment unit', () => {
    expect(RevisionUnit.parse(revisionUnit())).toEqual(revisionUnit());
    expect(AssessmentUnit.parse(assessmentUnit())).toEqual(assessmentUnit());
    expect(UnitContent.parse(revisionUnit()).kind).toBe('revision');
    expect(UnitContent.parse(assessmentUnit()).kind).toBe('assessment');
  });

  it('they lint without errors', () => {
    expect(lintUnit(revisionUnit()).errors).toEqual([]);
    expect(lintUnit(assessmentUnit()).errors).toEqual([]);
  });

  it('require sections, questions and scoring', () => {
    for (const key of ['sections', 'questions', 'scoring']) {
      const raw = rawClone(revisionUnit());
      removeAt(raw, [key]);
      expect(failurePaths(UnitContent, raw)).toContain(key);
    }
  });

  it('reject a pass mark above the total and a zero total', () => {
    const raw = rawClone(revisionUnit());
    setAt(raw, ['scoring', 'pass_mark'], 11);
    expect(failurePaths(UnitContent, raw)).toContain('scoring.pass_mark');
    setAt(raw, ['scoring', 'pass_mark'], 5);
    setAt(raw, ['scoring', 'total_marks'], 0);
    expect(failurePaths(UnitContent, raw)).toContain('scoring.total_marks');
  });

  it('resolve question references', () => {
    const raw = rawClone(assessmentUnit());
    pushAt(raw, ['sections', 0, 'blocks'], { type: 'question', question_id: 'q_ghost' });
    expect(failurePaths(UnitContent, raw)).toContain('sections.0.blocks.3.question_id');
  });

  it('are not lessons: a lesson field set alone does not make a revision', () => {
    const raw = rawClone(revisionUnit());
    setAt(raw, ['kind'], 'lesson');
    expect(failurePaths(UnitContent, raw)).toEqual(
      expect.arrayContaining(['header.chapter', 'session_plan']),
    );
  });
});

describe('UnitContent: the discriminator', () => {
  it('rejects a missing or unknown kind', () => {
    const missing = rawClone(goldenUnit2);
    removeAt(missing, ['kind']);
    expect(failurePaths(UnitContent, missing)).toEqual(['kind']);
    expect(failurePaths(UnitContent, { ...clone(goldenUnit2), kind: 'worksheet' })).toEqual([
      'kind',
    ]);
    expect(UnitContent.safeParse(null).success).toBe(false);
    expect(UnitContent.safeParse('lesson').success).toBe(false);
  });
});

describe('JSON Schema export', () => {
  it('converts the unit, section, question and tutor-script schemas (no transforms, for structured outputs)', () => {
    for (const schema of [UnitContent, Section, Question, TutorScript]) {
      for (const io of ['input', 'output'] as const) {
        const jsonSchema = z.toJSONSchema(schema, { io });
        expect(typeof jsonSchema).toBe('object');
      }
    }
  });
});
