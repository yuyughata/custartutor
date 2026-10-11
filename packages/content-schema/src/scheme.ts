import { z } from 'zod';
import { LevelCode, Slug, Term, Text } from './common';

/**
 * A NERDC scheme of work for one subject, level and term. The base layer: never rewritten by AI.
 */

export const WEEK_KINDS = [
  'teaching',
  'mid_term_exam',
  'break',
  'revision',
  'exam',
  'closing',
] as const;
export const WeekKind = z.enum(WEEK_KINDS);
export type WeekKind = z.infer<typeof WeekKind>;

export const SchemeWeek = z.object({
  week_no: z.number().int().min(1).max(20),
  kind: WeekKind,
  topic: Text,
  /** Breakdown of the topic, exactly as printed in the scheme. */
  subtopics: z.array(Text),
});
export type SchemeWeek = z.infer<typeof SchemeWeek>;

export const Scheme = z
  .object({
    subject_slug: Slug,
    level_code: LevelCode,
    term: Term,
    weeks: z.array(SchemeWeek).min(1),
  })
  .superRefine((scheme, ctx) => {
    const seen = new Set<number>();
    scheme.weeks.forEach((week, index) => {
      if (seen.has(week.week_no)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate week_no ${week.week_no}`,
          path: ['weeks', index, 'week_no'],
        });
      }
      seen.add(week.week_no);
    });
  });
export type Scheme = z.infer<typeof Scheme>;

export interface ChapterProposal {
  /** 1-based chapter number within the term. */
  chapter_no: number;
  /** Scheme weeks (teaching weeks only) grouped into this chapter, ascending. */
  week_nos: number[];
  /** The topics of those weeks, in order. */
  topics: string[];
}

export interface ChapterGrouping {
  chapters: ChapterProposal[];
  /** Human-readable notes, for example when the term has too few teaching weeks for a valid chapter. */
  warnings: string[];
}

export interface ChapterGroupingOptions {
  /** Fewest units in a chapter. Default 3. */
  min?: number;
  /** Most units in a chapter. Default 5. */
  max?: number;
}

/**
 * Proposes chapter groupings: runs of consecutive TEACHING weeks, 3 to 5 units each.
 *
 * Algorithm:
 *  1. Keep only weeks of kind `teaching`, ordered by week number. Exams, breaks, revision and closing
 *     weeks are skipped, so a chapter may sit on either side of the mid-term break.
 *  2. Cut the list greedily into chunks of the target size, the midpoint of min and max (4 by default).
 *  3. If the last chunk is smaller than `min`, it is a short tail (1 or 2 weeks):
 *       a. merge it into the previous chunk when the result is no larger than `max`;
 *       b. otherwise rebalance: pool the previous chunk and the tail and split them as evenly as possible
 *          into two chunks (for example 4 + 2 becomes 3 + 3).
 *     If neither keeps every chunk within [min, max] (only possible with unusual min/max values), the
 *     tail is merged anyway and a warning is returned.
 *  4. A term with fewer than `min` teaching weeks becomes one short chapter, with a warning.
 *
 * Examples with the defaults: 8 weeks -> 4+4; 9 -> 4+5; 10 -> 4+3+3; 11 -> 4+4+3; 12 -> 4+4+4.
 *
 * This is a proposal for the admin to edit; it does not look at topic content.
 */
export function groupIntoChapters(
  scheme: Scheme,
  options: ChapterGroupingOptions = {},
): ChapterGrouping {
  const min = options.min ?? 3;
  const max = options.max ?? 5;
  if (min < 1 || max < min) {
    throw new RangeError('groupIntoChapters needs 1 <= min <= max');
  }
  const warnings: string[] = [];
  const teaching = scheme.weeks
    .filter((week) => week.kind === 'teaching')
    .sort((a, b) => a.week_no - b.week_no);

  if (teaching.length === 0) return { chapters: [], warnings };

  const target = Math.min(max, Math.max(min, Math.round((min + max) / 2)));
  const chunks: SchemeWeek[][] = [];
  for (let start = 0; start < teaching.length; start += target) {
    chunks.push(teaching.slice(start, start + target));
  }

  const last = chunks[chunks.length - 1];
  if (last && last.length < min && chunks.length > 1) {
    const previous = chunks[chunks.length - 2] ?? [];
    const pooled = [...previous, ...last];
    if (pooled.length <= max) {
      chunks.splice(chunks.length - 2, 2, pooled);
    } else {
      const firstSize = Math.ceil(pooled.length / 2);
      const first = pooled.slice(0, firstSize);
      const second = pooled.slice(firstSize);
      if (first.length >= min && second.length >= min && first.length <= max && second.length <= max) {
        chunks.splice(chunks.length - 2, 2, first, second);
      } else {
        chunks.splice(chunks.length - 2, 2, pooled);
        warnings.push(
          `The last chapter has ${pooled.length} units, outside ${min}-${max}; adjust it by hand.`,
        );
      }
    }
  }

  if (chunks.length === 1 && (chunks[0]?.length ?? 0) < min) {
    warnings.push(
      `Only ${teaching.length} teaching week(s); a chapter needs ${min} to ${max} units.`,
    );
  }

  return {
    chapters: chunks.map((weeks, index) => ({
      chapter_no: index + 1,
      week_nos: weeks.map((week) => week.week_no),
      topics: weeks.map((week) => week.topic),
    })),
    warnings,
  };
}
