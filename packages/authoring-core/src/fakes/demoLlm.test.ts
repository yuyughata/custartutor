import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseUnit, sectionsOf, type UnitContent } from '@custar/content-schema';
import { LlmError, type LlmClient, type LlmRequest } from '../contract';
import { createJobEngine } from '../engine/engine';
import {
  goldenUnit2,
  makeDeps,
  marketDayMathsUnit,
  p1BasicScienceTerm1,
  runJobToEnd,
  sampleChapterPlanInput,
  sampleSchemeInput,
  sampleUnitInput,
} from '../../test-support/testKit';
import { DEMO_MODEL_ID, createDemoLlm } from './demoLlm';

const engine = createJobEngine();

function strings(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (typeof value === 'object' && value !== null)
    Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe('createDemoLlm', () => {
  it('reports a demo model id that can never be mistaken for a Claude id', async () => {
    expect(DEMO_MODEL_ID).toBe('demo-fixture-model');
    expect(DEMO_MODEL_ID).not.toMatch(/claude/i);
    const calls: string[] = [];
    const demo = createDemoLlm();
    const llm: LlmClient = {
      async generate(request) {
        const result = await demo.generate(request);
        calls.push(result.model);
        return result;
      },
    };
    await runJobToEnd(
      engine,
      'unit_generate',
      engine.parseInput('unit_generate', sampleUnitInput()),
      makeDeps(llm),
    );
    expect(calls.length).toBeGreaterThan(15);
    expect(new Set(calls)).toEqual(new Set([DEMO_MODEL_ID]));
  });

  it('is deterministic: the same job gives the same unit and the same steps', async () => {
    const a = await runJobToEnd(
      engine,
      'unit_generate',
      engine.parseInput('unit_generate', sampleUnitInput()),
      makeDeps(createDemoLlm()),
    );
    const b = await runJobToEnd(
      engine,
      'unit_generate',
      engine.parseInput('unit_generate', sampleUnitInput()),
      makeDeps(createDemoLlm()),
    );
    expect(a.result).toEqual(b.result);
    expect(a.steps).toEqual(b.steps);
  });

  it('ingests the fixture scheme for the requested term (exact topics and subtopics)', async () => {
    for (const term of [1, 2, 3] as const) {
      const run = await runJobToEnd(
        engine,
        'scheme_ingest',
        engine.parseInput('scheme_ingest', sampleSchemeInput({ term })),
        makeDeps(createDemoLlm()),
      );
      expect(run.result!.scheme.term).toBe(term);
      expect(run.result!.scheme.weeks).toHaveLength(13);
    }
    const first = await runJobToEnd(
      engine,
      'scheme_ingest',
      engine.parseInput('scheme_ingest', sampleSchemeInput()),
      makeDeps(createDemoLlm()),
    );
    expect(first.result!.scheme.weeks).toEqual(p1BasicScienceTerm1.weeks);
  });

  it('titles chapters and units from the scheme topics', async () => {
    const run = await runJobToEnd(
      engine,
      'chapter_plan',
      engine.parseInput('chapter_plan', sampleChapterPlanInput()),
      makeDeps(createDemoLlm()),
    );
    const topics = new Map(p1BasicScienceTerm1.weeks.map((w) => [w.week_no, w.topic]));
    for (const unit of run.result!.plan.chapters.flatMap((c) => c.units))
      expect(unit.title).toBe(topics.get(unit.week_no));
  });

  it('writes every authored string of a lesson from the fixtures, nothing of its own', async () => {
    const run = await runJobToEnd(
      engine,
      'unit_generate',
      engine.parseInput(
        'unit_generate',
        sampleUnitInput({
          previous_enrichment: [
            'story_opener',
            'remember',
            'do_and_discover',
            'character_values',
            'tell_it_back',
          ],
        }),
      ),
      makeDeps(createDemoLlm()),
    );
    const unit = parseUnit(run.result!.content) as Extract<UnitContent, { kind: 'lesson' }>;
    const fixtures = new Set([...strings(goldenUnit2), ...strings(marketDayMathsUnit)]);
    const authored = {
      sections: sectionsOf(unit),
      questions: unit.questions,
      workbook: {
        ...unit.workbook,
        intro: undefined,
        answers_note: undefined,
        tiers: unit.workbook.tiers.map((t) => ({ title: t.title })),
        quick_answer_drill: undefined,
        practice_variants: undefined,
        application_task_id: undefined,
      },
      manual: { ...unit.teacher_manual, timing: undefined },
    };
    const keep = (text: string) => !/^(sections|questions)$/.test(text);
    const foreign = [...strings(authored)].filter(keep).filter((text) => !fixtures.has(text));
    // the only strings of the section structure that are not text are ids, types and layers: filter those by shape
    const idLike = /^[a-z][a-z0-9_]*$/;
    expect(foreign.filter((text) => !idLike.test(text))).toEqual([]);
  });

  it('turns a mini project, a revision and an assessment from fixtures too', async () => {
    const base = sampleUnitInput();
    for (const kind of ['mini_project', 'revision', 'assessment'] as const) {
      const input = engine.parseInput('unit_generate', {
        ...base,
        unit: { ...base.unit, kind },
        theme: undefined,
      });
      const run = await runJobToEnd(engine, 'unit_generate', input, makeDeps(createDemoLlm()));
      expect(parseUnit(run.result!.content).kind).toBe(kind);
      expect(run.result!.lint.errors).toEqual([]);
    }
  });

  it('simulates prompt caching: the first call writes the cache, later calls read it', async () => {
    const demo = createDemoLlm();
    const request = (text: string): LlmRequest<{ flags: unknown[] }> => ({
      task: 'authoring',
      label: 'x',
      system: [{ text: 'A stable prefix. '.repeat(100), cache: true }],
      messages: [{ role: 'user', content: text }],
      schema: z.object({ flags: z.array(z.unknown()) }) as never,
      schemaName: 'unit_review',
      effort: 'low',
      maxTokens: 100,
    });
    const first = await demo.generate(request('one'));
    const second = await demo.generate(request('two'));
    expect(first.usage.cache_creation_tokens).toBeGreaterThan(0);
    expect(first.usage.cache_read_tokens).toBe(0);
    expect(second.usage.cache_read_tokens).toBe(first.usage.cache_creation_tokens);
    expect(second.usage.cache_creation_tokens).toBe(0);
    expect(first.stopReason).toBe('end_turn');
  });

  it('fails like the adapter does: an unknown step is a refusal, a reply that does not fit the schema is a schema error', async () => {
    const demo = createDemoLlm();
    const base: Omit<LlmRequest<unknown>, 'schemaName' | 'schema'> = {
      task: 'authoring',
      label: 'x',
      system: [{ text: 's' }],
      messages: [{ role: 'user', content: 'u' }],
      effort: 'low',
      maxTokens: 10,
    };
    await expect(
      demo.generate({ ...base, schemaName: 'something_else', schema: z.object({}) }),
    ).rejects.toMatchObject({ code: 'refusal' });
    const error = await demo
      .generate({ ...base, schemaName: 'unit_review', schema: z.object({ nope: z.string() }) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe('schema');
  });
});
