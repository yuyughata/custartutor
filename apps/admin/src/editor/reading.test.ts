import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import {
  MAX_AVERAGE_SENTENCE_WORDS,
  averageSentenceLength,
  lintUnit,
  type AnyBlock,
  type UnitContent,
} from '@custar/content-schema';
import { readingLabel, readingMeter } from './reading';

const paragraph = (text: string): AnyBlock => ({ type: 'paragraph', text });

describe('readingMeter', () => {
  it('is the content-schema average against the stage limit', () => {
    const blocks = [paragraph('We cook. We eat. We sleep.')];
    const meter = readingMeter(blocks, 'absorb');
    expect(meter.average).toBe(averageSentenceLength(blocks));
    expect(meter.average).toBeCloseTo(2);
    expect(meter.limit).toBe(MAX_AVERAGE_SENTENCE_WORDS);
    expect(meter.status).toBe('ok');
    expect(meter.sentences).toBe(3);
    expect(meter.words).toBe(6);
  });

  it('flags a section over the limit and finds the longest sentence', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const meter = readingMeter([paragraph(`Short one. ${long}.`)], 'connect');
    expect(meter.status).toBe('over');
    expect(meter.longest?.words).toBe(30);
    expect(readingLabel(meter)).toContain('over the limit of 12');
  });

  it('has no limit at the express stage and says so when there is no text', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    expect(readingMeter([paragraph(long)], 'express').status).toBe('no_limit');
    expect(readingMeter([paragraph(long)], 'express').limit).toBeNull();
    expect(readingMeter([], 'absorb').status).toBe('no_text');
    expect(readingLabel(readingMeter([], 'absorb'))).toBe('No sentences yet');
  });

  it('ignores bold markers and non-prose blocks', () => {
    const blocks: AnyBlock[] = [paragraph('**Quick** now.'), { type: 'question', question_id: 'x' }];
    expect(readingMeter(blocks, 'absorb').words).toBe(2);
  });

  it('agrees with the reading_level lint warning on every section of the golden unit', () => {
    const unit = goldenUnit2 as UnitContent;
    const warned = new Set(
      lintUnit(unit)
        .warnings.filter((w) => w.code === 'reading_level')
        .map((w) => w.path),
    );
    (unit.sections ?? []).forEach((section, index) => {
      const meter = readingMeter(section.blocks, unit.header.stage);
      expect(meter.status === 'over').toBe(warned.has(`sections[${index}]`));
      expect(meter.average).toBe(averageSentenceLength(section.blocks));
    });
  });
});
