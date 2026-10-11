import { z } from 'zod';
import { Id, Text } from './common';

/**
 * "Tutor Lite": a scripted, offline dialogue the app can run with no network and no model.
 * Nodes run in order unless `next` jumps to another node of the same script. When a node `expect`s
 * something, the child's reply is graded deterministically (by the referenced question, or against the
 * `accepted` strings with the same matching rules as fill-in-the-blank), and the app says one of
 * `on_correct` or `on_incorrect` (it picks a line, for variety) before moving on. `hint` lines are
 * offered after a miss. Free-form Claude chat resumes only when online.
 */

export const TutorExpectation = z
  .object({
    /** Grade the reply with this question from the unit's `questions` map. */
    question_id: Id.optional(),
    /** Or compare the reply with these accepted answers. */
    accepted: z.array(Text).min(1).optional(),
  })
  .superRefine((expect, ctx) => {
    const set = [expect.question_id !== undefined, expect.accepted !== undefined].filter(Boolean).length;
    if (set !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'expect needs exactly one of question_id or accepted',
        path: [],
      });
    }
  });
export type TutorExpectation = z.infer<typeof TutorExpectation>;

export const TutorNode = z.object({
  id: Id,
  /** What the tutor says. Plain text (TTS friendly); `**bold**` markers are stripped when spoken. */
  say: Text,
  expect: TutorExpectation.optional(),
  on_correct: z.array(Text).default([]),
  on_incorrect: z.array(Text).default([]),
  hint: z.array(Text).default([]),
  /** Node to jump to afterwards. Defaults to the next node in order. */
  next: Id.optional(),
});
export type TutorNode = z.infer<typeof TutorNode>;

export const TutorScript = z
  .object({
    nodes: z.array(TutorNode).min(1),
  })
  .superRefine((script, ctx) => {
    const ids = new Set<string>();
    script.nodes.forEach((node, index) => {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate tutor node id "${node.id}"`,
          path: ['nodes', index, 'id'],
        });
      }
      ids.add(node.id);
    });
    script.nodes.forEach((node, index) => {
      if (node.next !== undefined && !ids.has(node.next)) {
        ctx.addIssue({
          code: 'custom',
          message: `next "${node.next}" is not a node of this script`,
          path: ['nodes', index, 'next'],
        });
      }
    });
  });
export type TutorScript = z.infer<typeof TutorScript>;
