import { describe, expect, it } from 'vitest';
import { goldenUnit2, marketDayMathsUnit } from './fixtures';
import { averageSentenceLength, lintUnit, lintVersionIds, reasoningRungOf } from './lint';
import type { LintReport } from './lint';
import { ALWAYS_PRESENT_TYPES, ENRICHMENT_MENU, LAYER_FOR_TYPE } from './sections';
import type { Section } from './sections';
import { clone } from './test-utils';
import type { LessonUnit } from './unit';

function codes(report: LintReport): string[] {
  return report.errors.map((issue) => issue.code);
}

function warningCodes(report: LintReport): string[] {
  return report.warnings.map((issue) => issue.code);
}

function sectionOfType(unit: LessonUnit, type: Section['type']): Section {
  const section = unit.sections.find((s) => s.type === type);
  if (!section) throw new Error(`no ${type} section`);
  return section;
}

function extraSection(id: string, type: Section['type']): Section {
  return {
    id,
    type,
    layer: LAYER_FOR_TYPE[type],
    heading: 'Extra',
    blocks: [{ type: 'paragraph', text: 'A short line.' }],
  };
}

describe('section constants', () => {
  it('encode brief section 7', () => {
    expect([...ALWAYS_PRESENT_TYPES].sort()).toEqual(
      [
        'concept',
        'mastery_check',
        'practice',
        'quick_fire',
        'think_deeper',
        'worked_examples',
      ].sort(),
    );
    expect([...ENRICHMENT_MENU].sort()).toEqual(
      [
        'across_subjects',
        'character_values',
        'do_and_discover',
        'remember',
        'story_opener',
        'tell_it_back',
        'window_to_world',
      ].sort(),
    );
    expect(LAYER_FOR_TYPE.think_deeper).toBe('CORE+');
    for (const type of ENRICHMENT_MENU) expect(LAYER_FOR_TYPE[type]).toBe('ENRICH');
    for (const type of ALWAYS_PRESENT_TYPES.filter((t) => t !== 'think_deeper')) {
      expect(LAYER_FOR_TYPE[type]).toBe('CORE');
    }
  });
});

describe('lintUnit: the golden unit is the baseline', () => {
  it('has no errors', () => {
    const report = lintUnit(goldenUnit2);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('lintUnit errors', () => {
  it.each(ALWAYS_PRESENT_TYPES)('fails when the %s section is missing', (type) => {
    const unit = clone(goldenUnit2);
    unit.sections = unit.sections.filter((s) => s.type !== type);
    const report = lintUnit(unit);
    expect(report.ok).toBe(false);
    expect(
      report.errors.some((e) => e.code === 'missing_section' && e.message.includes(`"${type}"`)),
    ).toBe(true);
  });

  it('fails with fewer than two enrichment sections', () => {
    const unit = clone(goldenUnit2);
    unit.sections = unit.sections.filter(
      (s) => s.type !== 'remember' && s.type !== 'do_and_discover',
    );
    expect(codes(lintUnit(unit))).toContain('enrichment_count');
  });

  it('fails with more than three enrichment sections', () => {
    const unit = clone(goldenUnit2);
    unit.sections.push(extraSection('across_x', 'across_subjects'));
    expect(codes(lintUnit(unit))).toContain('enrichment_count');
  });

  it('fails when an enrichment type is used twice', () => {
    const unit = clone(goldenUnit2);
    unit.sections.push(extraSection('remember_again', 'remember'));
    expect(codes(lintUnit(unit))).toContain('enrichment_duplicate');
  });

  it('accepts exactly two or three enrichment sections', () => {
    const two = clone(goldenUnit2);
    two.sections = two.sections.filter((s) => s.type !== 'remember');
    // the session plan and manual still reference remember_senses, so only look at the count rule
    expect(codes(lintUnit(two))).not.toContain('enrichment_count');
  });

  it('fails when the objective is empty', () => {
    const unit = clone(goldenUnit2);
    unit.header.objective = '   ';
    expect(codes(lintUnit(unit))).toContain('objective_empty');
  });

  it('fails when the workbook does not have three tiers', () => {
    const unit = clone(goldenUnit2);
    unit.workbook.tiers = unit.workbook.tiers.slice(0, 2);
    expect(codes(lintUnit(unit))).toContain('workbook_tiers');
  });

  it('fails when a workbook tier has no questions', () => {
    const unit = clone(goldenUnit2);
    const tier = unit.workbook.tiers[2];
    if (tier) tier.question_ids = [];
    expect(codes(lintUnit(unit))).toContain('workbook_tiers');
  });

  it('fails when the workbook has no application task', () => {
    const unit = clone(goldenUnit2);
    unit.workbook.application_task_id = '';
    expect(codes(lintUnit(unit))).toContain('workbook_application_task');
  });

  it('fails when the quick-answer drill is empty', () => {
    const unit = clone(goldenUnit2);
    unit.workbook.quick_answer_drill.question_ids = [];
    expect(codes(lintUnit(unit))).toContain('workbook_drill');
  });

  it('fails when a deterministic question has no answer spec', () => {
    const unit = clone(goldenUnit2);
    const question = unit.questions.wb_fill_cook as { answer?: unknown } | undefined;
    if (question) delete question.answer;
    const report = lintUnit(unit);
    expect(report.errors.find((e) => e.code === 'answer_spec_missing')?.path).toBe(
      'questions.wb_fill_cook.answer',
    );
  });

  it('fails when an answer spec is unsound', () => {
    const unit = clone(goldenUnit2);
    const mcq = unit.questions.qf_gutter;
    if (mcq?.kind === 'mcq') mcq.answer.correct_index = 9;
    const blank = unit.questions.wb_fill_cook;
    if (blank?.kind === 'fill_blank') blank.answer.blanks.push({ accepted: ['extra'] });
    const sort = unit.questions.mc_places;
    if (sort?.kind === 'sort') sort.answer.mapping = {};
    const report = lintUnit(unit);
    expect(
      report.errors.filter((e) => e.code === 'answer_spec_invalid').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('fails when a free_text question has no rubric', () => {
    const unit = clone(goldenUnit2);
    const free = unit.questions.wb_neighbour as { rubric?: unknown } | undefined;
    if (free) delete free.rubric;
    expect(codes(lintUnit(unit))).toContain('rubric_missing');
  });

  it('fails when the teacher manual is missing or incomplete', () => {
    const missing = clone(goldenUnit2);
    delete (missing as Partial<LessonUnit>).teacher_manual;
    expect(codes(lintUnit(missing))).toContain('teacher_manual_missing');

    const noScript = clone(goldenUnit2);
    noScript.teacher_manual.script = [];
    expect(codes(lintUnit(noScript))).toContain('teacher_manual_script');

    const noMaterials = clone(goldenUnit2);
    noMaterials.teacher_manual.materials = [];
    expect(codes(lintUnit(noMaterials))).toContain('teacher_manual_materials');

    const noGuidance = clone(goldenUnit2);
    noGuidance.teacher_manual.mastery_guidance = { got_it: [], not_yet: '' };
    expect(codes(lintUnit(noGuidance))).toContain('teacher_manual_mastery');
  });

  it('fails when the mastery check has nothing that can be graded deterministically', () => {
    const unit = clone(goldenUnit2);
    const mastery = sectionOfType(unit, 'mastery_check');
    mastery.blocks = [
      { type: 'paragraph', text: 'You have mastered this unit when you can:' },
      { type: 'question', question_id: 'wb_neighbour' },
    ];
    expect(codes(lintUnit(unit))).toContain('mastery_no_gradable');
  });

  it('does not count a deterministic question with a broken answer spec as gradable', () => {
    const unit = clone(goldenUnit2);
    const mastery = sectionOfType(unit, 'mastery_check');
    mastery.blocks = [{ type: 'question', question_id: 'qf_gutter' }];
    const mcq = unit.questions.qf_gutter;
    if (mcq?.kind === 'mcq') mcq.answer.correct_index = 5;
    expect(codes(lintUnit(unit))).toContain('mastery_no_gradable');
  });

  it('fails on a question block that points at nothing', () => {
    const unit = clone(goldenUnit2);
    sectionOfType(unit, 'quick_fire').blocks.push({ type: 'question', question_id: 'q_ghost' });
    const report = lintUnit(unit);
    expect(report.errors.find((e) => e.code === 'dangling_ref')?.path).toBe(
      `sections[${unit.sections.findIndex((s) => s.type === 'quick_fire')}].blocks[5].question_id`,
    );
  });

  it('fails on dangling ids in the workbook, session plan, manual and tutor script', () => {
    const unit = clone(goldenUnit2);
    unit.workbook.tiers[0]?.question_ids.push('q_ghost_a');
    unit.workbook.practice_variants[0]?.question_ids.push('q_ghost_b');
    unit.session_plan[0]?.sections.push('section_ghost');
    unit.teacher_manual.helper_script.push({ section_id: 'section_ghost_2', steps: ['x'] });
    const node = unit.sections[0]?.tutor_script?.nodes[1];
    if (node) node.expect = { question_id: 'q_ghost_c' };
    const dangling = lintUnit(unit).errors.filter((e) => e.code === 'dangling_ref');
    expect(dangling.length).toBe(5);
  });

  it('fails on duplicate section ids and mismatched question keys', () => {
    const unit = clone(goldenUnit2);
    const first = unit.sections[0];
    if (first) unit.sections.push({ ...first });
    const question = unit.questions.qf_cook;
    if (question) question.id = 'qf_other';
    const found = codes(lintUnit(unit));
    expect(found).toContain('duplicate_id');
    expect(found).toContain('question_key_mismatch');
  });

  it('fails on a block type this build does not know', () => {
    const unit = clone(goldenUnit2);
    sectionOfType(unit, 'concept').blocks.push({
      type: 'unknown',
      original_type: 'hologram',
      raw: { type: 'hologram' },
    });
    const report = lintUnit(unit);
    expect(report.errors.find((e) => e.code === 'unknown_block')?.message).toContain('hologram');
  });
});

describe('lintUnit warnings', () => {
  it('flags Think Deeper prompts above the stage rung', () => {
    const unit = clone(goldenUnit2);
    unit.header.stage = 'absorb';
    delete unit.header.stage_to;
    const report = lintUnit(unit);
    expect(warningCodes(report)).toContain('think_deeper_too_hard');
    expect(report.ok).toBe(true); // warnings never block
  });

  it('flags Think Deeper when no prompt reaches the stage rung', () => {
    const unit = clone(goldenUnit2);
    unit.header.stage = 'express';
    unit.header.stage_to = 'express';
    expect(warningCodes(lintUnit(unit))).toContain('think_deeper_rung');
  });

  it('uses stage_to (the higher stage) for the rung check', () => {
    const unit = clone(goldenUnit2);
    expect(warningCodes(lintUnit(unit))).not.toContain('think_deeper_rung');
    expect(warningCodes(lintUnit(unit))).not.toContain('think_deeper_too_hard');
  });

  it('accepts an express rung prompt at the express stage', () => {
    const unit = clone(goldenUnit2);
    unit.header.stage = 'express';
    unit.header.stage_to = 'express';
    const deeper = sectionOfType(unit, 'think_deeper');
    deeper.blocks = [
      {
        type: 'bullets',
        items: [
          { text: 'Explain why we keep the classroom clean.' },
          { text: 'Which is better, and how do you know?' },
        ],
      },
    ];
    const found = warningCodes(lintUnit(unit));
    expect(found).not.toContain('think_deeper_rung');
    expect(found).not.toContain('think_deeper_too_hard');
  });

  it('flags a repeated enrichment trio', () => {
    const previous = ['do_and_discover', 'story_opener', 'remember'] as const;
    expect(warningCodes(lintUnit(goldenUnit2, { previousEnrichment: previous }))).toContain(
      'enrichment_not_rotated',
    );
    expect(
      warningCodes(
        lintUnit(goldenUnit2, { previousEnrichment: ['story_opener', 'across_subjects'] }),
      ),
    ).not.toContain('enrichment_not_rotated');
    expect(warningCodes(lintUnit(goldenUnit2))).not.toContain('enrichment_not_rotated');
  });

  it('flags a unit with no global window, and not one that has it', () => {
    expect(warningCodes(lintUnit(goldenUnit2))).toContain('no_global_window');
    expect(warningCodes(lintUnit(marketDayMathsUnit))).not.toContain('no_global_window');
  });

  it('flags periods that do not total 50 to 70 minutes', () => {
    const tooShort = clone(goldenUnit2);
    const first = tooShort.session_plan[0];
    if (first) first.minutes = [{ segment: 'start', minutes: 30 }];
    const shortReport = lintUnit(tooShort);
    expect(shortReport.warnings.find((w) => w.code === 'session_minutes')?.path).toBe(
      'session_plan[0]',
    );

    const tooLong = clone(goldenUnit2);
    const second = tooLong.session_plan[1];
    if (second) second.minutes.push({ segment: 'close', minutes: 30 });
    expect(warningCodes(lintUnit(tooLong))).toContain('session_minutes');
  });

  it('accepts 50 and 70 minutes', () => {
    for (const total of [50, 70]) {
      const unit = clone(goldenUnit2);
      for (const period of unit.session_plan)
        period.minutes = [{ segment: 'teach', minutes: total }];
      expect(warningCodes(lintUnit(unit))).not.toContain('session_minutes');
    }
  });

  it('flags long sentences for early stages only', () => {
    const long =
      'When the children walked all the way across the very large school playground they saw many different places and people who were working and playing together happily.';
    const unit = clone(goldenUnit2);
    // the rule looks at the AVERAGE over a section, so one long sentence among short ones is fine
    sectionOfType(unit, 'concept').blocks.push({ type: 'paragraph', text: long });
    expect(warningCodes(lintUnit(unit))).not.toContain('reading_level');
    sectionOfType(unit, 'concept').blocks = [{ type: 'paragraph', text: `${long} ${long}` }];
    const section = unit.sections.findIndex((s) => s.type === 'concept');
    const report = lintUnit(unit);
    expect(report.warnings.find((w) => w.code === 'reading_level')?.path).toBe(
      `sections[${section}]`,
    );

    const express = clone(unit);
    express.header.stage = 'express';
    express.header.stage_to = 'express';
    expect(warningCodes(lintUnit(express))).not.toContain('reading_level');
  });

  it('flags a section whose layer disagrees with its type', () => {
    const unit = clone(goldenUnit2);
    sectionOfType(unit, 'concept').layer = 'ENRICH';
    sectionOfType(unit, 'story_opener').layer = 'CORE';
    const mismatches = lintUnit(unit).warnings.filter((w) => w.code === 'layer_mismatch');
    expect(mismatches).toHaveLength(2);
  });

  it('screens for religious terms as whole words, case-insensitively', () => {
    const unit = clone(goldenUnit2);
    sectionOfType(unit, 'concept').blocks.push({
      type: 'paragraph',
      text: 'We go to Church and the MOSQUE, and we pray to God. ALLAH, Jesus, the Bible and the Quran.',
    });
    const religious = lintUnit(unit).warnings.filter((w) => w.code === 'religious_term');
    expect(religious).toHaveLength(1);
    const message = religious[0]?.message ?? '';
    for (const word of ['church', 'mosque', 'pray', 'god', 'allah', 'jesus', 'bible', 'quran']) {
      expect(message).toContain(`"${word}"`);
    }
  });

  it('does not flag words that merely contain a religious term', () => {
    const unit = clone(goldenUnit2);
    sectionOfType(unit, 'concept').blocks.push({
      type: 'paragraph',
      text: 'Godwin has a godmother. We make a prayerful Christmas card? No, a graduation card.',
    });
    const religious = lintUnit(unit).warnings.filter((w) => w.code === 'religious_term');
    expect(religious).toHaveLength(0);
  });

  it('screens question text and the teacher manual too', () => {
    const unit = clone(goldenUnit2);
    const question = unit.questions.qf_gutter;
    if (question) question.prompt = 'Should you pray near a deep gutter?';
    unit.teacher_manual.timing = 'Start with a prayer.';
    const paths = lintUnit(unit)
      .warnings.filter((w) => w.code === 'religious_term')
      .map((w) => w.path);
    expect(paths).toContain('questions.qf_gutter.prompt');
    expect(paths).toContain('teacher_manual.timing');
  });

  it('warns when there is no helper script for pre-readers', () => {
    const unit = clone(goldenUnit2);
    unit.teacher_manual.helper_script = [];
    expect(warningCodes(lintUnit(unit))).toContain('helper_script_empty');
  });
});

describe('lint helpers', () => {
  it('reasoningRungOf classifies prompts by the brief section 9 keywords', () => {
    expect(reasoningRungOf('Name the animal in the picture.')).toBe('absorb');
    expect(reasoningRungOf('What comes next in the pattern?')).toBe('absorb');
    expect(reasoningRungOf('Which one is bigger?')).toBe('absorb');
    expect(reasoningRungOf('Same or different: a ball and a tin?')).toBe('connect');
    expect(reasoningRungOf('Why do you think the plant died?')).toBe('connect');
    expect(reasoningRungOf('What would happen if it did not rain?')).toBe('connect');
    expect(reasoningRungOf('Explain why we need water.')).toBe('express');
    expect(reasoningRungOf('Give your reason.')).toBe('express');
    expect(reasoningRungOf('Which is better, and how do you know?')).toBe('express');
    expect(reasoningRungOf('Sit down quietly.')).toBeNull();
  });

  it('averageSentenceLength counts words per sentence and ignores markup', () => {
    expect(
      averageSentenceLength([{ type: 'paragraph', text: 'One two three. Four five six seven.' }]),
    ).toBe(3.5);
    expect(averageSentenceLength([{ type: 'paragraph', text: '**One** two three four.' }])).toBe(4);
    expect(averageSentenceLength([{ type: 'question', question_id: 'q_one' }])).toBeNull();
    // each bullet is one sentence-like unit, even without a full stop
    expect(
      averageSentenceLength([{ type: 'bullets', items: [{ text: 'a b c d' }, { text: 'a b' }] }]),
    ).toBe(3);
  });
});

describe('lintVersionIds (the stable-ID rule)', () => {
  it('passes when nothing is dropped, and when ids are only added', () => {
    expect(lintVersionIds(goldenUnit2, goldenUnit2).ok).toBe(true);
    const next = clone(goldenUnit2);
    next.sections.push(extraSection('brand_new', 'across_subjects'));
    expect(lintVersionIds(goldenUnit2, next)).toEqual({ errors: [], warnings: [], ok: true });
  });

  it('fails when a section id is dropped', () => {
    const next = clone(goldenUnit2);
    next.sections = next.sections.filter((s) => s.id !== 'staying_safe');
    const report = lintVersionIds(goldenUnit2, next);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ code: 'section_id_dropped' });
    expect(report.errors[0]?.message).toContain('staying_safe');
  });

  it('fails when a question id is dropped or regenerated', () => {
    const next = clone(goldenUnit2);
    const question = next.questions.qf_cook;
    delete next.questions.qf_cook;
    if (question) next.questions.qf_cook_v2 = { ...question, id: 'qf_cook_v2' };
    const report = lintVersionIds(goldenUnit2, next);
    expect(report.errors.map((e) => e.code)).toEqual(['question_id_dropped']);
    expect(report.errors[0]?.message).toContain('qf_cook');
  });

  it('reports every dropped id', () => {
    const next = clone(goldenUnit2);
    next.sections = [];
    next.questions = {};
    const report = lintVersionIds(goldenUnit2, next);
    expect(report.errors).toHaveLength(
      goldenUnit2.sections.length + Object.keys(goldenUnit2.questions).length,
    );
  });
});
