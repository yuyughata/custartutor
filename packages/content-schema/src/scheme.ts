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

function within(sizes: readonly number[], min: number, max: number): boolean {
  return sizes.every((size) => size >= min && size <= max);
}

/** Greedy chunks of `target`, with the short-tail rules (merge, then rebalance). */
function greedySizes(count: number, min: number, max: number, target: number): number[] {
  const sizes: number[] = [];
  for (let remaining = count; remaining > 0; remaining -= target) {
    sizes.push(Math.min(target, remaining));
  }
  const last = sizes[sizes.length - 1] ?? 0;
  const previous = sizes[sizes.length - 2];
  if (last < min && previous !== undefined) {
    const pooled = previous + last;
    sizes.splice(sizes.length - 2, 2);
    if (pooled <= max) {
      sizes.push(pooled); // merge the tail into the previous chapter
    } else {
      sizes.push(Math.ceil(pooled / 2), Math.floor(pooled / 2)); // rebalance the two as evenly as possible
    }
  }
  return sizes;
}

/** `chapters` chapters of as equal a size as possible, the larger ones first. */
function evenSizes(count: number, chapters: number): number[] {
  const base = Math.floor(count / chapters);
  const extra = count % chapters;
  return Array.from({ length: chapters }, (_, index) => (index < extra ? base + 1 : base));
}

/** The chapter count whose even split is valid and whose average size is closest to `target`. */
function bestEvenSizes(count: number, min: number, max: number, target: number): number[] | null {
  let best: number[] | null = null;
  for (let chapters = Math.ceil(count / max); chapters <= Math.floor(count / min); chapters += 1) {
    const candidate = evenSizes(count, chapters);
    if (!within(candidate, min, max)) continue;
    if (!best || Math.abs(count / chapters - target) < Math.abs(count / best.length - target)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Proposes chapter groupings: runs of consecutive TEACHING weeks, 3 to 5 units each.
 *
 * Algorithm:
 *  1. Keep only weeks of kind `teaching`, ordered by week number. Exams, breaks, revision and closing
 *     weeks are skipped, so a chapter may sit on either side of the mid-term break.
 *  2. Cut the list greedily into chunks of the target size, the midpoint of min and max (4 by default).
 *  3. If the last chunk is smaller than `min` (a short tail of 1 or 2 weeks by default):
 *       a. merge it into the previous chunk when the result is no larger than `max`;
 *       b. otherwise rebalance: pool the previous chunk and the tail and split them as evenly as possible
 *          into two chunks (for example 4 + 2 becomes 3 + 3).
 *  4. If that still leaves a chunk outside [min, max] (only possible with unusual bounds), fall back to
 *     an even split into the number of chapters that fits and is closest to the target size. If no
 *     number of chapters fits, the greedy result is returned together with a warning.
 *  5. A term with fewer than `min` teaching weeks becomes one short chapter, with a warning.
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
  const count = teaching.length;

  if (count === 0) return { chapters: [], warnings };
  if (count < min) {
    warnings.push(`Only ${count} teaching week(s); a chapter needs ${min} to ${max} units.`);
  }

  const target = Math.min(max, Math.max(min, Math.round((min + max) / 2)));
  let sizes = count < min ? [count] : greedySizes(count, min, max, target);
  if (count >= min && !within(sizes, min, max)) {
    const even = bestEvenSizes(count, min, max, target);
    if (even) {
      sizes = even;
    } else {
      warnings.push(`No grouping keeps every chapter within ${min}-${max} units; adjust by hand.`);
    }
  }

  const chapters: ChapterProposal[] = [];
  let start = 0;
  for (const size of sizes) {
    const group = teaching.slice(start, start + size);
    chapters.push({
      chapter_no: chapters.length + 1,
      week_nos: group.map((week) => week.week_no),
      topics: group.map((week) => week.topic),
    });
    start += size;
  }
  return { chapters, warnings };
}
