import {
  questionsOf,
  sectionsOf,
  type Question,
  type TutorScript,
  type UnitContent,
} from '@custar/content-schema';

/** Helpers that read a lesson for the tutor: which parts have an offline script, where a question lives. */

/** Stands in for the section id when a project unit has one script for the whole unit. */
export const UNIT_SCRIPT_ID = '_unit';

export interface LiteTarget {
  sectionId: string;
  heading: string;
  script: TutorScript;
}

/** The parts of a unit the offline tutor can talk about: sections with a `tutor_script`, in lesson order. */
export function liteTargets(unit: UnitContent): LiteTarget[] {
  const targets: LiteTarget[] = [];
  if ('tutor_script' in unit && unit.tutor_script) {
    targets.push({
      sectionId: UNIT_SCRIPT_ID,
      heading: unit.header.title,
      script: unit.tutor_script,
    });
  }
  for (const section of sectionsOf(unit)) {
    if (section.tutor_script) {
      targets.push({
        sectionId: section.id,
        heading: section.heading,
        script: section.tutor_script,
      });
    }
  }
  return targets;
}

/** The questions the offline tutor may grade with (the unit's whole map). */
export function liteQuestions(unit: UnitContent): Record<string, Question> {
  return questionsOf(unit);
}

/** The section that places a question in its flow, or null. */
export function sectionOfQuestion(unit: UnitContent, questionId: string): string | null {
  for (const section of sectionsOf(unit)) {
    if (
      section.blocks.some((block) => block.type === 'question' && block.question_id === questionId)
    ) {
      return section.id;
    }
  }
  return null;
}

/** The part to start Tutor Lite on: where the child last answered a question, if that part has a script. */
export function defaultLiteTarget(
  unit: UnitContent,
  lastQuestionId: string | null | undefined,
): LiteTarget | null {
  const targets = liteTargets(unit);
  if (lastQuestionId) {
    const sectionId = sectionOfQuestion(unit, lastQuestionId);
    const match = targets.find((target) => target.sectionId === sectionId);
    if (match) return match;
  }
  return null;
}

export interface ActivityInfo {
  questionId: string;
  prompt: string;
  /** The heading of the lesson part that holds the question. */
  where: string | null;
}

/**
 * What to show for the tutor's "try this question" suggestion. The server only suggests practice questions;
 * this checks again and never shows one from the mastery check, whatever arrives.
 */
export function activityInfo(unit: UnitContent, questionId: string): ActivityInfo | null {
  const question = questionsOf(unit)[questionId];
  if (!question) return null;
  const sectionId = sectionOfQuestion(unit, questionId);
  const section = sectionsOf(unit).find((candidate) => candidate.id === sectionId);
  if (section?.type === 'mastery_check') return null;
  return { questionId, prompt: question.prompt, where: section?.heading ?? null };
}

/** The part of a lesson that is a question's section, for the tutor's position in a request. */
export function positionFor(
  unit: UnitContent,
  lastQuestionId: string | null | undefined,
): { sectionId?: string; questionId?: string } {
  if (!lastQuestionId) return {};
  const sectionId = sectionOfQuestion(unit, lastQuestionId);
  return {
    questionId: lastQuestionId,
    ...(sectionId ? { sectionId } : {}),
  };
}

export interface TextRun {
  text: string;
  bold: boolean;
}

/** Splits `**bold**` markers into runs, so lesson text can be shown as text with no markup engine. */
export function splitBold(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const parts = text.split('**');
  parts.forEach((part, index) => {
    if (part.length > 0) runs.push({ text: part, bold: index % 2 === 1 });
  });
  return runs.length > 0 ? runs : [{ text: '', bold: false }];
}
