// Plain-text renderings of unit content for prompts: "the unit so far" for later section steps, and the full
// text of a draft for the review step. Everything the child, the helper and the tutor will see or hear is
// included (picture briefs, alt text, tutor lines, answers), because the reviewer must see it too.
import type {
  AnyBlock,
  Question,
  Section,
  TeacherManual,
  UnitContent,
  Workbook,
} from '@custar/content-schema';
import { questionsOf, sectionsOf } from '@custar/content-schema';

export function renderQuestion(question: Question): string {
  const head = `[question ${question.id} · ${question.kind} · tier ${question.tier}] ${question.prompt}`;
  const lines: string[] = [head];
  switch (question.kind) {
    case 'mcq':
      lines.push(`  options: ${question.options.join(' | ')}`);
      lines.push(`  correct: ${question.options[question.answer.correct_index] ?? '?'}`);
      break;
    case 'circle':
      lines.push(`  options: ${question.options.join(' | ')}`);
      lines.push(`  correct: ${question.answer.correct.join(' | ')}`);
      break;
    case 'fill_blank':
      question.answer.blanks.forEach((blank, index) => {
        lines.push(`  blank ${index + 1} accepts: ${blank.accepted.join(' | ')}${blank.numeric ? ' (numeric)' : ''}`);
      });
      break;
    case 'match':
      lines.push(`  pairs: ${question.answer.pairs.map((p) => `${p.left} = ${p.right}`).join(' ; ')}`);
      break;
    case 'sort':
      lines.push(`  sort: ${Object.entries(question.answer.mapping).map(([i, c]) => `${i} -> ${c}`).join(' ; ')}`);
      break;
    case 'free_text':
    case 'spoken':
      lines.push(`  rubric: ${question.rubric.criteria.join(' ; ')}${question.rubric.exemplar ? ` (model answer: ${question.rubric.exemplar})` : ''}`);
      break;
    case 'draw':
      lines.push(`  self-check: ${(question.self_check ?? []).join(' ; ')}`);
      break;
    case 'tap_image':
      lines.push(`  picture: ${question.alt}`);
      break;
    case 'speak':
      lines.push(`  expected: ${question.answer.expected.join(' | ')}`);
      break;
  }
  if (question.hint) lines.push(`  hint: ${question.hint}`);
  if (question.explanation) lines.push(`  explanation: ${question.explanation}`);
  return lines.join('\n');
}

export function renderBlock(block: AnyBlock, questions: Readonly<Record<string, Question>>): string {
  switch (block.type) {
    case 'paragraph':
      return block.text;
    case 'bullets':
      return block.items.map((item) => `- ${item.lead ? `${item.lead}: ` : ''}${item.text}`).join('\n');
    case 'definition':
      return `[definition] ${block.term}: ${block.meaning}`;
    case 'example':
      return `[example] ${block.label}: ${block.text}`;
    case 'dialogue':
      return block.lines.map((line) => `${line.character}: ${line.text}`).join('\n');
    case 'illustration':
      return `[picture] draw: ${block.brief} | alt text: ${block.alt}`;
    case 'callout':
      return `[callout: ${block.tone}] ${block.text}`;
    case 'activity_steps':
      return block.steps.map((step, index) => `${index + 1}. ${step.label}: ${step.text}`).join('\n');
    case 'table':
      return [block.headers.join(' | '), ...block.rows.map((row) => row.join(' | '))].join('\n');
    case 'question': {
      const question = questions[block.question_id];
      return question ? renderQuestion(question) : `[question ${block.question_id}: not defined]`;
    }
    case 'unknown':
      return `[unknown block ${block.original_type}]`;
  }
}

export function renderTutorScript(section: Section): string {
  const nodes = section.tutor_script?.nodes ?? [];
  if (nodes.length === 0) return '';
  const lines = ['Tutor script:'];
  for (const node of nodes) {
    lines.push(`  tutor says: ${node.say}`);
    if (node.expect?.accepted) lines.push(`    listens for: ${node.expect.accepted.join(' | ')}`);
    if (node.expect?.question_id) lines.push(`    graded by question: ${node.expect.question_id}`);
    if (node.on_correct.length > 0) lines.push(`    if right: ${node.on_correct.join(' | ')}`);
    if (node.on_incorrect.length > 0) lines.push(`    if wrong: ${node.on_incorrect.join(' | ')}`);
    if (node.hint.length > 0) lines.push(`    hint: ${node.hint.join(' | ')}`);
  }
  return lines.join('\n');
}

export function renderSection(
  section: Section,
  questions: Readonly<Record<string, Question>>,
  options: { tutor?: boolean } = {},
): string {
  const parts = [`### ${section.id} (${section.type}, ${section.layer}): ${section.heading}`];
  for (const block of section.blocks) parts.push(renderBlock(block, questions));
  if (options.tutor !== false) {
    const tutor = renderTutorScript(section);
    if (tutor !== '') parts.push(tutor);
  }
  return parts.join('\n');
}

export function renderWorkbook(workbook: Workbook, questions: Readonly<Record<string, Question>>): string {
  const lines = ['### Workbook'];
  if (workbook.intro) lines.push(`intro: ${workbook.intro}`);
  for (const tier of workbook.tiers) {
    lines.push(`Tier ${tier.tier}: ${tier.title} (${tier.question_ids.join(', ')})`);
  }
  lines.push(`Quick-answer drill (${workbook.quick_answer_drill.seconds} s):`);
  for (const id of workbook.quick_answer_drill.question_ids) {
    const question = questions[id];
    if (question) lines.push(renderQuestion(question));
  }
  lines.push(`Take it home: ${workbook.take_it_home}`);
  const application = questions[workbook.application_task_id];
  if (application) lines.push(renderQuestion(application));
  if (workbook.not_yet) lines.push(`Not yet: ${workbook.not_yet}`);
  if (workbook.answers_note) lines.push(`Answers note: ${workbook.answers_note}`);
  for (const variant of workbook.practice_variants) {
    lines.push(`Practice pool ${variant.id}:`);
    for (const id of variant.question_ids) {
      const question = questions[id];
      if (question) lines.push(renderQuestion(question));
    }
  }
  return lines.join('\n');
}

export function renderManual(manual: TeacherManual): string {
  const lines = ["### Teacher's manual"];
  for (const entry of manual.script) {
    lines.push(`${entry.section_id}: say: ${entry.say} | ask: ${entry.ask} | watch for: ${entry.watch_for}`);
  }
  if (manual.theme_map) {
    for (const lens of manual.theme_map.lenses) {
      lines.push(`theme lens: ${lens.subject} (${lens.lens}): ${lens.what_child_does}`);
    }
    lines.push(`connection moment: ${manual.theme_map.connection_moment}`);
  }
  lines.push(`timing: ${manual.timing}`);
  lines.push(`materials: ${manual.materials.join(' ; ')}`);
  lines.push(`got it: ${manual.mastery_guidance.got_it.join(' ; ')}`);
  lines.push(`not yet: ${manual.mastery_guidance.not_yet}`);
  for (const entry of manual.helper_script) {
    lines.push(`helper ${entry.section_id}: ${entry.steps.join(' / ')}`);
  }
  return lines.join('\n');
}

export interface RenderUnitOptions {
  /** Limit the sections and questions shown (the changed parts of a revision). */
  onlySectionIds?: readonly string[];
  onlyQuestionIds?: readonly string[];
  includeWorkbook?: boolean;
  includeManual?: boolean;
}

/** Everything a reviewer reads, as plain text. */
export function renderUnit(unit: UnitContent, options: RenderUnitOptions = {}): string {
  const questions = questionsOf(unit);
  const parts: string[] = [
    `# ${unit.header.title}`,
    `Subject ${unit.header.subject_slug}, ${unit.header.level_code}, term ${unit.header.term}. Stage: ${unit.header.stage}${unit.header.stage_to ? ` to ${unit.header.stage_to}` : ''}.`,
    `NERDC objective: ${unit.header.objective}`,
  ];
  const only = options.onlySectionIds ? new Set(options.onlySectionIds) : null;
  for (const section of sectionsOf(unit)) {
    if (only && !only.has(section.id)) continue;
    parts.push(renderSection(section, questions));
  }
  if (options.onlyQuestionIds) {
    const placed = new Set(
      sectionsOf(unit).flatMap((section) =>
        section.blocks.flatMap((block) => (block.type === 'question' ? [block.question_id] : [])),
      ),
    );
    for (const id of options.onlyQuestionIds) {
      const question = questions[id];
      if (question && !placed.has(id)) parts.push(renderQuestion(question));
    }
  }
  if (unit.kind === 'lesson') {
    if (options.includeWorkbook !== false && !only) parts.push(renderWorkbook(unit.workbook, questions));
    if (options.includeManual !== false && !only) parts.push(renderManual(unit.teacher_manual));
  } else if (unit.kind === 'mini_project' || unit.kind === 'term_project') {
    parts.push(`Brief: ${unit.brief}`);
    parts.push(`Steps: ${unit.steps.map((s) => `${s.n}. ${s.text}`).join(' ')}`);
    parts.push(`Materials: ${unit.materials.join('; ')}`);
    parts.push(`Rubric: ${unit.rubric.map((r) => `${r.criterion}: ${r.levels.map((l) => `${l.level}=${l.descriptor}`).join(' / ')}`).join(' ; ')}`);
    parts.push(`Reflection: ${unit.reflection_prompts.join(' ; ')}`);
  }
  return parts.join('\n\n');
}
