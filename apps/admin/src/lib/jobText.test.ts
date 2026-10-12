import { describe, expect, it } from 'vitest';
import type { JobRow } from '@custar/authoring-core';
import {
  explainJobError,
  humanizeId,
  isTerminal,
  jobHeadline,
  jobKindLabel,
  jobStatusStyle,
  stepLabel,
  summarizeProgress,
} from './jobText';

const job = (patch: Partial<Pick<JobRow, 'kind' | 'status' | 'progress'>> = {}) => ({
  kind: 'unit_generate' as const,
  status: 'running' as const,
  progress: { done: ['outline', 'section:story_opener'], next: 'section:concept_1', total: 9 },
  ...patch,
});

describe('step names', () => {
  it('names the known steps in plain words', () => {
    expect(stepLabel('outline')).toBe('Planning the outline');
    expect(stepLabel('workbook')).toBe('Writing the workbook');
    expect(stepLabel('manual')).toBe("Writing the teacher's manual");
    expect(stepLabel('assemble')).toBe('Putting the unit together');
    expect(stepLabel('review')).toBe('Advisory review');
  });

  it('names a section step by its id', () => {
    expect(stepLabel('section:story_opener')).toBe('Writing "Story opener"');
    expect(stepLabel('section:come_and_explore')).toBe('Writing "Come and explore"');
    expect(stepLabel('section:concept_2')).toBe('Writing "Concept 2"');
  });

  it('names repair rounds and revisions', () => {
    expect(stepLabel('repair:1')).toBe('Fixing problems (round 1)');
    expect(stepLabel('repair_2')).toBe('Fixing problems (round 2)');
    expect(stepLabel('revise:practice')).toBe('Rewriting "Practice"');
  });

  it('uses the engine step names exactly, per job kind', () => {
    expect(stepLabel('extract', 'scheme_ingest')).toBe(
      'Reading the document and listing the weeks',
    );
    expect(stepLabel('check', 'scheme_ingest')).toBe('Checking the weeks for gaps and odd entries');
    expect(stepLabel('group', 'chapter_plan')).toBe('Grouping the teaching weeks into chapters');
    expect(stepLabel('title', 'chapter_plan')).toBe(
      'Naming the chapters and units, proposing themes',
    );
    expect(stepLabel('patch', 'unit_revise')).toBe('Working out the changes');
    expect(stepLabel('review', 'unit_revise')).toBe('Advisory review of the change');
    expect(stepLabel('review', 'unit_generate')).toBe('Advisory review');
    expect(stepLabel('section:story_opener', 'unit_generate')).toBe('Writing "Story opener"');
    expect(stepLabel('repair:2', 'unit_generate')).toBe('Fixing problems (round 2)');
  });

  it('falls back to readable words', () => {
    expect(stepLabel('some_new_step')).toBe('Some new step');
    expect(humanizeId('s3_come_and_explore')).toBe('Come and explore');
    expect(humanizeId('___')).toBe('___');
  });
});

describe('labels', () => {
  it('labels kinds and statuses, with glyphs', () => {
    expect(jobKindLabel('unit_generate')).toBe('Draft a unit');
    expect(jobKindLabel('mystery')).toBe('mystery');
    expect(jobStatusStyle('failed')).toMatchObject({ label: 'Failed', glyph: '✕', tone: 'danger' });
    expect(jobStatusStyle('succeeded').label).toBe('Done');
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('cancelled')).toBe(true);
  });

  it('summarises progress', () => {
    expect(summarizeProgress(job())).toMatchObject({
      done: 2,
      total: 9,
      currentLabel: 'Writing "Concept 1"',
    });
    expect(summarizeProgress(job()).fraction).toBeCloseTo(2 / 9);
    expect(
      summarizeProgress(
        job({ status: 'succeeded', progress: { done: ['a'], next: null, total: 1 } }),
      ).fraction,
    ).toBe(1);
    expect(summarizeProgress(job({ progress: { done: [], next: null, total: 0 } })).fraction).toBe(
      0,
    );
    expect(jobHeadline(job())).toBe('Draft a unit · 2 of 9 steps');
    expect(jobHeadline(job({ status: 'queued' }))).toBe('Draft a unit');
  });
});

describe('explainJobError', () => {
  it('returns null when there is no error', () => {
    expect(explainJobError(null, { status: 'running', attempts: 0 })).toBeNull();
  });

  it('says a retryable error is being retried, with the attempt number', () => {
    const out = explainJobError(
      { code: 'transport', message: 'rate limited (429)', retryable: true, step: 'outline' },
      { status: 'running', attempts: 1 },
    );
    expect(out?.retrying).toBe(true);
    expect(out?.title).toContain('The connection to Claude failed');
    expect(out?.title).toContain('Trying again (attempt 2 of 3)');
    expect(out?.hint).toBeUndefined();
    expect(out?.detail).toBe('rate limited (429)');
  });

  it('gives a hint and no retry for a refusal on a failed job', () => {
    const out = explainJobError(
      { code: 'refusal', message: 'The model declined', retryable: false },
      { status: 'failed', attempts: 0 },
    );
    expect(out?.retrying).toBe(false);
    expect(out?.title).toBe('Claude declined to write this part.');
    expect(out?.hint).toMatch(/rewording/);
  });

  it('stops saying "trying again" once the attempts are used up', () => {
    const out = explainJobError(
      { code: 'transport', message: 'x', retryable: true },
      { status: 'running', attempts: 3 },
    );
    expect(out?.retrying).toBe(false);
  });

  it('uses the server message for an unknown code', () => {
    const out = explainJobError(
      { code: 'weird', message: 'Something odd happened' },
      { status: 'failed', attempts: 0 },
    );
    expect(out?.title).toBe('Something odd happened');
    expect(out?.detail).toBeUndefined();
  });

  it('explains switch and budget stops', () => {
    expect(
      explainJobError({ code: 'kill_switch', message: 'off' }, { status: 'failed', attempts: 0 })
        ?.title,
    ).toBe('AI drafting is switched off.');
    expect(
      explainJobError(
        { code: 'budget_exceeded', message: 'cap' },
        { status: 'failed', attempts: 0 },
      )?.hint,
    ).toMatch(/raise the cap/);
  });
});
