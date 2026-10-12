// Test helpers for Tutor Lite: every script of the fixtures, and a reply that a child who knew the answer would type.
import {
  goldenUnit2,
  marketDayMathsUnit,
  colourChartProject,
} from '@custar/content-schema/fixtures';
import { questionsOf, sectionsOf } from '@custar/content-schema';
import type { Question, TutorNode, TutorScript, UnitContent } from '@custar/content-schema';

export interface NamedScript {
  name: string;
  script: TutorScript;
  questions: Record<string, Question>;
}

export function scriptsOf(name: string, unit: UnitContent): NamedScript[] {
  const questions = questionsOf(unit);
  const found: NamedScript[] = [];
  if ('tutor_script' in unit && unit.tutor_script) {
    found.push({ name: `${name}:unit`, script: unit.tutor_script, questions });
  }
  for (const section of sectionsOf(unit)) {
    if (section.tutor_script)
      found.push({ name: `${name}:${section.id}`, script: section.tutor_script, questions });
  }
  return found;
}

export const FIXTURE_SCRIPTS: NamedScript[] = [
  ...scriptsOf('golden', goldenUnit2),
  ...scriptsOf('market', marketDayMathsUnit),
  ...scriptsOf('colours', colourChartProject),
];

/** What a child who knows the answer would type for `question`. */
export function rightReplyFor(question: Question): string {
  switch (question.kind) {
    case 'mcq':
      return question.options[question.answer.correct_index] ?? '';
    case 'fill_blank':
      return question.answer.blanks.map((blank) => blank.accepted[0]).join(', ');
    case 'circle':
      return question.answer.correct.join(', ');
    case 'match':
      return question.answer.pairs.map((pair) => `${pair.left} - ${pair.right}`).join(', ');
    case 'sort':
      return Object.entries(question.answer.mapping)
        .map(([item, category]) => `${item} - ${category}`)
        .join(', ');
    case 'tap_image':
      return question.answer.hotspots
        .filter((h) => h.correct)
        .map((h) => h.label)
        .join(', ');
    case 'speak':
      return question.answer.expected[0] ?? '';
    default:
      return 'yes';
  }
}

export function rightReply(node: TutorNode, questions: Record<string, Question>): string {
  const expect = node.expect;
  if (expect?.accepted) return expect.accepted[0] ?? '';
  const question = expect?.question_id ? questions[expect.question_id] : undefined;
  return question ? rightReplyFor(question) : 'yes';
}
