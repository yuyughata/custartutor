// The unit row (the planner's list) owns a lesson's number, chapter and week; the content header repeats them (the
// lesson page prints "Unit 5 — Title"). They drift when a unit is added in an earlier chapter (every later unit moves
// up by one) or moved. The editor shows the drift and writes the current values into the header it saves, so the
// next version is right; published snapshots are immutable and keep the numbers they were published with.
import type { UnitContent } from '@custar/content-schema';
import { getAt, setAt } from './path';

export interface HeaderContext {
  unit_no: number;
  week_no: number | null;
  chapter: { number: number; title: string };
}

export interface Drift {
  field: 'unit_no' | 'chapter' | 'week_no';
  label: string;
  have: string;
  want: string;
}

function text(value: unknown): string {
  return value === undefined || value === null || value === '' ? 'none' : String(value);
}

export function headerDrift(unit: UnitContent, ctx: HeaderContext): Drift[] {
  const out: Drift[] = [];
  const unitNo = getAt(unit, ['header', 'unit_no']);
  if (unitNo !== ctx.unit_no) {
    out.push({
      field: 'unit_no',
      label: 'Unit number',
      have: text(unitNo),
      want: String(ctx.unit_no),
    });
  }
  const number = getAt(unit, ['header', 'chapter', 'number']);
  const title = getAt(unit, ['header', 'chapter', 'title']);
  if (number !== ctx.chapter.number || title !== ctx.chapter.title) {
    out.push({
      field: 'chapter',
      label: 'Chapter',
      have: number === undefined ? 'none' : `${text(number)}: ${text(title)}`,
      want: `${ctx.chapter.number}: ${ctx.chapter.title}`,
    });
  }
  const week = getAt(unit, ['header', 'week_no']);
  if (ctx.week_no !== null && week !== ctx.week_no) {
    out.push({
      field: 'week_no',
      label: 'Scheme week',
      have: text(week),
      want: String(ctx.week_no),
    });
  }
  return out;
}

/** Writes the unit row's number, chapter and (when it has one) week into the header. */
export function stampHeader(unit: UnitContent, ctx: HeaderContext): UnitContent {
  let next = setAt(unit, ['header', 'unit_no'], ctx.unit_no);
  next = setAt(next, ['header', 'chapter'], {
    number: ctx.chapter.number,
    title: ctx.chapter.title,
  });
  if (ctx.week_no !== null) next = setAt(next, ['header', 'week_no'], ctx.week_no);
  return next;
}
