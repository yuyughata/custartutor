// The tutor's two tools. They are ADVISORY and NOT forced (the request never sets a tool choice; the model decides).
// show_activity points at a practice question; record_evidence leaves a short note for the grown-up. Neither
// changes progress or mastery: only the deterministic grading of the mastery check does (CLAUDE.md rule 4).
// Arguments are untrusted until `validateToolCalls` (pipeline) has checked them against the grounding.
import type { Json } from '@custar/authoring-core';
import type { TutorLlmRequest } from '../contract';

export const SHOW_ACTIVITY_TOOL: TutorLlmRequest['tools'][number] = {
  name: 'show_activity',
  description:
    'Show the child ONE practice question from this unit on screen so they can try it. Use it only when the child is ready to practise. question_id must be one of the practice question ids in the unit data. Never use it for the mastery check.',
  schema: {
    type: 'object',
    properties: {
      question_id: {
        type: 'string',
        description: 'The id of a practice question listed in the unit data.',
      },
    },
    required: ['question_id'],
    additionalProperties: false,
  } as Record<string, Json>,
};

export const RECORD_EVIDENCE_TOOL: TutorLlmRequest['tools'][number] = {
  name: 'record_evidence',
  description:
    'Leave a short note for the grown-up about how the child is doing with the idea. It does not give marks and does not change progress. Never put a name, number or address in the note.',
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['understood', 'struggling', 'misconception'],
        description: 'How the child is doing.',
      },
      question_id: {
        type: 'string',
        description: 'The id of the question the note is about, if there is one.',
      },
      note: {
        type: 'string',
        description: 'One short sentence, at most 200 characters.',
      },
    },
    required: ['kind', 'note'],
    additionalProperties: false,
  } as Record<string, Json>,
};

export const TUTOR_TOOLS: TutorLlmRequest['tools'] = [SHOW_ACTIVITY_TOOL, RECORD_EVIDENCE_TOOL];
