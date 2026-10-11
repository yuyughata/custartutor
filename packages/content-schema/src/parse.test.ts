import { describe, expect, it } from 'vitest';
import { colourChartProject, goldenUnit2, marketDayMathsUnit } from './fixtures';
import { lintUnit } from './lint';
import { SchemaVersionError } from './migrate';
import { UnitParseError, formatPath, normalizeDeep, parseUnit, parseUnitLenient } from './parse';
import { clone, getAt, pushAt, rawClone, removeAt, setAt } from './test-utils';

function parseError(raw: unknown, parse: (value: unknown) => unknown = parseUnit): UnitParseError {
  try {
    parse(raw);
  } catch (error) {
    if (error instanceof UnitParseError) return error;
    throw error;
  }
  throw new Error('expected parse to throw');
}

describe('parseUnit (strict)', () => {
  it('parses all three fixtures', () => {
    expect(parseUnit(goldenUnit2)).toEqual(goldenUnit2);
    expect(parseUnit(marketDayMathsUnit)).toEqual(marketDayMathsUnit);
    expect(parseUnit(colourChartProject)).toEqual(colourChartProject);
  });

  it('parses JSON that went through a string', () => {
    const raw: unknown = JSON.parse(JSON.stringify(goldenUnit2));
    expect(parseUnit(raw)).toEqual(goldenUnit2);
  });

  it('reports readable paths for every problem', () => {
    const raw = rawClone(goldenUnit2);
    removeAt(raw, ['header', 'objective']);
    setAt(raw, ['sections', 1, 'blocks', 0, 'text'], '');
    setAt(raw, ['questions', 'qf_gutter', 'tier'], 4);
    setAt(raw, ['workbook', 'quick_answer_drill', 'seconds'], 'sixty');
    const error = parseError(raw);
    const paths = error.issues.map((issue) => issue.path);
    expect(paths).toContain('header.objective');
    expect(paths).toContain('sections[1].blocks[0].text');
    expect(paths).toContain('questions.qf_gutter.tier');
    expect(paths).toContain('workbook.quick_answer_drill.seconds');
    expect(error.message).toContain('4 problem(s)');
    expect(error.message).toContain('header.objective:');
  });

  it('reports a bad discriminator', () => {
    const error = parseError({ ...clone(goldenUnit2), kind: 'worksheet' });
    expect(error.issues[0]?.path).toBe('kind');
  });

  it('reports question ids that do not resolve, with the path of the reference', () => {
    const raw = clone(goldenUnit2);
    const quick = raw.sections.find((s) => s.type === 'quick_fire');
    quick?.blocks.push({ type: 'question', question_id: 'q_ghost' });
    const issue = parseError(raw).issues.find((i) => i.message.includes('q_ghost'));
    expect(issue?.path).toMatch(/^sections\[\d+\]\.blocks\[5\]\.question_id$/);
  });

  it('reports keys that are not valid ids', () => {
    const raw = rawClone(goldenUnit2);
    setAt(raw, ['questions', 'Bad Key'], getAt(raw, ['questions', 'qf_cook']));
    const error = parseError(raw);
    expect(error.issues.some((i) => i.path === 'questions["Bad Key"]')).toBe(true);
  });

  it('rejects a block type it does not recognise, naming the path and the type', () => {
    const raw = rawClone(goldenUnit2);
    pushAt(raw, ['sections', 2, 'blocks'], { type: 'hologram', depth: 3 });
    const error = parseError(raw);
    expect(error.issues).toEqual([
      { path: 'sections[2].blocks[2].type', message: 'Unrecognised block type "hologram"' },
    ]);
  });

  it('rejects the degraded unknown stand-in in strict mode', () => {
    const raw = rawClone(goldenUnit2);
    pushAt(raw, ['sections', 0, 'blocks'], { type: 'unknown', original_type: 'hologram', raw: {} });
    expect(parseError(raw).issues[0]?.path).toBe('sections[0].blocks[4].type');
  });

  it('migrates old schema versions first', () => {
    const v0 = rawClone(goldenUnit2);
    removeAt(v0, ['schema_version']);
    setAt(v0, ['header', 'nerdc_objective'], getAt(v0, ['header', 'objective']));
    removeAt(v0, ['header', 'objective']);
    setAt(v0, ['questions'], Object.values(getAt(v0, ['questions']) as object));
    expect(parseUnit(v0)).toEqual(goldenUnit2);
  });

  it('throws a typed error for newer content and a TypeError for non-objects', () => {
    expect(() => parseUnit({ ...clone(goldenUnit2), schema_version: 99 })).toThrow(
      SchemaVersionError,
    );
    expect(() => parseUnit('nope')).toThrow(TypeError);
  });

  it('strips unknown fields so newer packs still open in older builds', () => {
    const raw = rawClone(goldenUnit2);
    setAt(raw, ['future_field'], { anything: true });
    setAt(raw, ['sections', 0, 'future_flag'], 1);
    expect(parseUnit(raw)).toEqual(goldenUnit2);
  });

  it('normalises text to Unicode NFC', () => {
    const raw = rawClone(goldenUnit2);
    const decomposed = `Places in Our Scho${String.fromCharCode(0x6f, 0x301)}l`; // o + combining acute
    setAt(raw, ['sections', 2, 'heading'], decomposed);
    const parsed = parseUnit(raw);
    const composed = `Places in Our Scho${String.fromCharCode(0xf3)}l`;
    expect(decomposed).not.toBe(composed);
    expect(parsed.kind === 'lesson' && parsed.sections[2]?.heading).toBe(composed);
  });
});

describe('parseUnitLenient (readers)', () => {
  it('degrades an unrecognised block type instead of failing', () => {
    const raw = rawClone(goldenUnit2);
    const hologram = { type: 'hologram', depth: 3 };
    pushAt(raw, ['sections', 2, 'blocks'], hologram);
    const parsed = parseUnitLenient(raw);
    if (parsed.kind !== 'lesson') throw new Error('expected a lesson');
    const blocks = parsed.sections[2]?.blocks ?? [];
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toEqual({ type: 'unknown', original_type: 'hologram', raw: hologram });
    // everything else is intact
    expect(blocks[0]).toEqual(goldenUnit2.sections[2]?.blocks[0]);
    expect(parsed.questions).toEqual(goldenUnit2.questions);
  });

  it('still validates everything else strictly', () => {
    const raw = rawClone(goldenUnit2);
    pushAt(raw, ['sections', 2, 'blocks'], { type: 'hologram' });
    removeAt(raw, ['header', 'title']);
    expect(parseError(raw, parseUnitLenient).issues.map((i) => i.path)).toEqual(['header.title']);
  });

  it('still rejects a known block type with an invalid shape', () => {
    const raw = rawClone(goldenUnit2);
    setAt(raw, ['sections', 0, 'blocks', 0], { type: 'paragraph' });
    expect(parseError(raw, parseUnitLenient).issues[0]?.path).toBe('sections[0].blocks[0].text');
  });

  it('is idempotent on content that already holds unknown stand-ins, and lint blocks publishing it', () => {
    const raw = rawClone(goldenUnit2);
    pushAt(raw, ['sections', 0, 'blocks'], { type: 'quiz_game', level: 2 });
    const once = parseUnitLenient(raw);
    const twice = parseUnitLenient(once);
    expect(twice).toEqual(once);
    const report = lintUnit(once);
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain('unknown_block');
  });

  it('treats a block with no usable type as unknown', () => {
    const raw = rawClone(goldenUnit2);
    pushAt(raw, ['sections', 0, 'blocks'], 'stray text', { text: 'no type' }, null);
    const parsed = parseUnitLenient(raw);
    if (parsed.kind !== 'lesson') throw new Error('expected a lesson');
    const blocks = parsed.sections[0]?.blocks.slice(-3) ?? [];
    expect(blocks.map((b) => (b.type === 'unknown' ? b.original_type : b.type))).toEqual([
      '(missing)',
      '(missing)',
      '(missing)',
    ]);
  });
});

describe('helpers', () => {
  it('formatPath renders indexes and keys', () => {
    expect(formatPath(['sections', 3, 'blocks', 0, 'text'])).toBe('sections[3].blocks[0].text');
    expect(formatPath(['questions', 'Bad Key', 'id'])).toBe('questions["Bad Key"].id');
    expect(formatPath([])).toBe('');
  });

  it('normalizeDeep normalises strings and keys without touching other values', () => {
    const decomposed = `e${String.fromCharCode(0x301)}`;
    const composed = String.fromCharCode(0xe9);
    const out = normalizeDeep({ [decomposed]: [decomposed, 1, null, true] });
    expect(out).toEqual({ [composed]: [composed, 1, null, true] });
  });
});
