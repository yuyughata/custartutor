// A starting point for a unit that has no version yet (one added by hand in the chapter planner, or one Claude has not
// drafted). It has the structure a unit of its kind needs and NO words: every text is blank, which the checks refuse,
// so nothing can be saved with a placeholder nobody wrote. The scheme's own title, objective and stage come from the
// unit row; the number, chapter and week are stamped from it too.
import { ALWAYS_PRESENT_TYPES, type SectionType, type UnitKind } from '@custar/content-schema';
import { newSection } from './factories';
import { nextFreeId, sectionIdPrefix } from './ids';
import { SEGMENTS } from './ops';

export interface StarterContext {
  kind: UnitKind;
  title: string;
  objective: string | null;
  stage: 'absorb' | 'connect' | 'express';
  unit_no: number;
  week_no: number | null;
  chapter: { number: number; title: string };
  subject_slug: string;
  level_code: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  term: 1 | 2 | 3;
}

/** The two enrichment sections a new lesson starts with (the template allows two to five). */
const STARTER_ENRICHMENT: readonly SectionType[] = ['story_opener', 'tell_it_back'];

function header(ctx: StarterContext): Record<string, unknown> {
  return {
    subject_slug: ctx.subject_slug,
    level_code: ctx.level_code,
    term: ctx.term,
    title: ctx.title,
    objective: ctx.objective ?? '',
    stage: ctx.stage,
    chapter: ctx.chapter,
    unit_no: ctx.unit_no,
    ...(ctx.week_no !== null ? { week_no: ctx.week_no } : ctx.kind === 'lesson' ? { week_no: 1 } : {}),
  };
}

export function starterUnit(ctx: StarterContext): Record<string, unknown> {
  const base = { schema_version: 1, kind: ctx.kind, header: header(ctx) };
  switch (ctx.kind) {
    case 'lesson': {
      const types: SectionType[] = [STARTER_ENRICHMENT[0] as SectionType, ...ALWAYS_PRESENT_TYPES, STARTER_ENRICHMENT[1] as SectionType];
      const used = new Set<string>();
      const sections = types.map((type) => {
        const id = nextFreeId(sectionIdPrefix(type), used);
        used.add(id);
        return newSection(type, id);
      });
      const ids = sections.map((s) => s.id);
      return {
        ...base,
        sections,
        questions: {},
        session_plan: [
          {
            period: 1,
            sections: ids,
            minutes: SEGMENTS.map((segment) => ({ segment, minutes: 12 })),
          },
        ],
        workbook: {
          tiers: [
            { tier: 1, title: "Let's Start Together", question_ids: [] },
            { tier: 2, title: 'Now You Try', question_ids: [] },
            { tier: 3, title: 'Stretch Yourself', question_ids: [] },
          ],
          quick_answer_drill: { seconds: 60, question_ids: [] },
          take_it_home: '',
          application_task_id: '',
          practice_variants: [],
        },
        teacher_manual: {
          script: ids.map((section_id) => ({ section_id, say: '', ask: '', watch_for: '' })),
          timing: '',
          materials: [],
          mastery_guidance: { got_it: [], not_yet: '' },
          helper_script: [],
        },
      };
    }
    case 'mini_project':
    case 'term_project':
      return {
        ...base,
        brief: '',
        steps: [{ n: 1, text: '' }],
        materials: [''],
        rubric: [
          {
            criterion: '',
            levels: [
              { level: 1, descriptor: '' },
              { level: 2, descriptor: '' },
            ],
          },
        ],
        evidence_options: ['photo'],
        reflection_prompts: [''],
      };
    case 'revision':
      return { ...base, sections: [newSection('revision_topic', nextFreeId(sectionIdPrefix('revision_topic'), new Set()))], questions: {}, scoring: { total_marks: 10, pass_mark: 5 } };
    case 'assessment':
      return { ...base, sections: [newSection('assessment_part', nextFreeId(sectionIdPrefix('assessment_part'), new Set()))], questions: {}, scoring: { total_marks: 10, pass_mark: 5 } };
  }
}
