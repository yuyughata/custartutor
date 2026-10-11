/**
 * Cross-reference checks for a unit: every id that points at a section or a question must resolve, and
 * section ids and question ids must be unique. Used by the Zod `superRefine` in `unit.ts` and by
 * `lintUnit`. Structural input types keep this file independent of the schemas (no import cycle).
 */

export interface RefIssue {
  code: 'dangling_ref' | 'duplicate_id' | 'question_key_mismatch';
  message: string;
  path: (string | number)[];
}

interface SectionRef {
  id: string;
  blocks: readonly { type: string; question_id?: string }[];
  tutor_script?: { nodes: readonly { expect?: { question_id?: string } }[] };
}

export interface UnitRefInput {
  tutor_script?: SectionRef['tutor_script'];
  sections?: readonly SectionRef[];
  questions?: Readonly<Record<string, { id: string }>>;
  session_plan?: readonly { sections: readonly string[] }[];
  workbook?: {
    tiers: readonly { question_ids: readonly string[] }[];
    quick_answer_drill: { question_ids: readonly string[] };
    application_task_id: string;
    practice_variants: readonly { question_ids: readonly string[] }[];
  };
  teacher_manual?: {
    script: readonly { section_id: string }[];
    helper_script: readonly { section_id: string }[];
  };
}

export function findRefIssues(unit: UnitRefInput): RefIssue[] {
  const issues: RefIssue[] = [];
  const sections = unit.sections ?? [];
  const questions = unit.questions ?? {};

  const sectionIds = new Set<string>();
  sections.forEach((section, index) => {
    if (sectionIds.has(section.id)) {
      issues.push({
        code: 'duplicate_id',
        message: `duplicate section id "${section.id}"`,
        path: ['sections', index, 'id'],
      });
    }
    sectionIds.add(section.id);
  });

  for (const [key, question] of Object.entries(questions)) {
    if (question.id !== key) {
      issues.push({
        code: 'question_key_mismatch',
        message: `questions["${key}"] has id "${question.id}"; the map key must equal the question id`,
        path: ['questions', key, 'id'],
      });
    }
  }

  const needQuestion = (id: string, path: (string | number)[]) => {
    if (!Object.hasOwn(questions, id)) {
      issues.push({
        code: 'dangling_ref',
        message: `question "${id}" is not defined in questions`,
        path,
      });
    }
  };
  const needSection = (id: string, path: (string | number)[]) => {
    if (!sectionIds.has(id)) {
      issues.push({
        code: 'dangling_ref',
        message: `section "${id}" does not exist`,
        path,
      });
    }
  };

  unit.tutor_script?.nodes.forEach((node, nodeIndex) => {
    const id = node.expect?.question_id;
    if (id !== undefined) {
      needQuestion(id, ['tutor_script', 'nodes', nodeIndex, 'expect', 'question_id']);
    }
  });

  sections.forEach((section, sectionIndex) => {
    section.blocks.forEach((block, blockIndex) => {
      if (block.type === 'question' && typeof block.question_id === 'string') {
        needQuestion(block.question_id, [
          'sections',
          sectionIndex,
          'blocks',
          blockIndex,
          'question_id',
        ]);
      }
    });
    section.tutor_script?.nodes.forEach((node, nodeIndex) => {
      const id = node.expect?.question_id;
      if (id !== undefined) {
        needQuestion(id, [
          'sections',
          sectionIndex,
          'tutor_script',
          'nodes',
          nodeIndex,
          'expect',
          'question_id',
        ]);
      }
    });
  });

  unit.session_plan?.forEach((period, periodIndex) => {
    period.sections.forEach((id, index) => {
      needSection(id, ['session_plan', periodIndex, 'sections', index]);
    });
  });

  const workbook = unit.workbook;
  if (workbook) {
    workbook.tiers.forEach((tier, tierIndex) => {
      tier.question_ids.forEach((id, index) => {
        needQuestion(id, ['workbook', 'tiers', tierIndex, 'question_ids', index]);
      });
    });
    workbook.quick_answer_drill.question_ids.forEach((id, index) => {
      needQuestion(id, ['workbook', 'quick_answer_drill', 'question_ids', index]);
    });
    needQuestion(workbook.application_task_id, ['workbook', 'application_task_id']);
    workbook.practice_variants.forEach((variant, variantIndex) => {
      variant.question_ids.forEach((id, index) => {
        needQuestion(id, ['workbook', 'practice_variants', variantIndex, 'question_ids', index]);
      });
    });
  }

  const manual = unit.teacher_manual;
  if (manual) {
    manual.script.forEach((entry, index) => {
      needSection(entry.section_id, ['teacher_manual', 'script', index, 'section_id']);
    });
    manual.helper_script.forEach((entry, index) => {
      needSection(entry.section_id, ['teacher_manual', 'helper_script', index, 'section_id']);
    });
  }

  return issues;
}
