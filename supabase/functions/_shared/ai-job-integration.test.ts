import { describe, expect, it } from 'vitest';
import { createJobEngine } from '../../../packages/authoring-core/src';
import { ChapterPlanResult } from '../../../packages/authoring-core/src';
import { createDemoLlm } from '../../../packages/authoring-core/src/fakes';
import { lintUnit, parseUnit } from '../../../packages/content-schema/src';
import { p1BasicScienceSchemes } from '../../../packages/content-schema/src/fixtures';
import type { Row } from './ai-job-fake-db.ts';
import type { AuthoringCore, JobEngine } from './ai-job-types.ts';
import { IDS, makeEnv, seedCurriculum } from './ai-job-test-kit.ts';
import type { Env, SendOptions } from './ai-job-test-kit.ts';

// ONE end-to-end check through the real pieces: the handler, the input resolver, the REAL step engine of
// @custar/authoring-core and its fixture-backed demo model (not Claude). Only the database is a fake (the in-memory
// job backend mirrors the SQL that pgTAP tests). It proves the handler's wiring agrees with the engine: what the
// resolver builds is what the engine parses, what the engine returns is what the handler saves and stores.

const DEMO_MODEL = 'demo-fixture-model';

function curriculumFromFixture(): Record<string, Row[]> {
  const tables = seedCurriculum();
  const term1 = p1BasicScienceSchemes[0]!;
  tables['scheme_weeks'] = term1.weeks.map((week) => ({
    scheme_id: IDS.scheme,
    week_no: week.week_no,
    kind: week.kind,
    topic: week.topic,
    subtopics: week.subtopics,
  }));
  return tables;
}

async function run(env: Env, jobId: string, options: SendOptions = {}): Promise<number> {
  let requests = 0;
  for (; requests < 80; requests += 1) {
    const response = await env.send({ action: 'step', job_id: jobId }, options);
    expect([200, 202]).toContain(response.status);
    await env.flush();
    const status = env.backend.row(jobId)['status'];
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled')
      return requests + 1;
  }
  throw new Error('the job did not finish');
}

describe('the real engine with the demo model, through the handler', () => {
  it('drafts a chapter plan', async () => {
    const env = makeEnv({
      engine: createJobEngine(),
      llm: createDemoLlm(),
      tables: curriculumFromFixture(),
      settings: {
        prices: {
          'claude-opus-5-5': {
            input_per_mtok: 5,
            output_per_mtok: 25,
            cache_read_per_mtok: 0.5,
            cache_write_per_mtok: 6.25,
          },
        },
      },
    });
    const job = await env.createJob('chapter_plan', { scheme_id: IDS.scheme });
    const jobId = String(job['id']);
    expect(job['scheme_id']).toBe(IDS.scheme);

    const requests = await run(env, jobId);
    const row = env.backend.row(jobId);
    expect(row['status'], JSON.stringify(row['error'])).toBe('succeeded');
    expect(row['error']).toBeNull();
    expect(row['lease_until']).toBeNull();
    expect(requests).toBeGreaterThanOrEqual(2);
    // the progress the handler stored is the engine's
    expect(row['progress']).toMatchObject({ next: null });

    const result = ChapterPlanResult.parse(row['result']);
    expect(result.plan.chapters.length).toBeGreaterThan(1);
    for (const chapter of result.plan.chapters) {
      expect(chapter.units.length).toBeGreaterThanOrEqual(1);
      expect(chapter.units.length).toBeLessThanOrEqual(5);
    }
    const units = result.plan.chapters.flatMap((chapter) => chapter.units);
    expect(units.map((unit) => unit.unit_no)).toEqual(units.map((_, index) => index + 1));

    // the model calls were logged by the database (the service role only), under the demo id, never as Claude
    expect(env.backend.usage.length).toBeGreaterThan(0);
    expect(new Set(env.backend.usage.map((entry) => entry.model))).toEqual(new Set([DEMO_MODEL]));
    expect(env.backend.usage.every((entry) => entry.job_id === jobId)).toBe(true);
  });

  it('drafts a unit, saves it as a draft version made by the AI and reports it', async () => {
    const tables = curriculumFromFixture();
    const env = makeEnv({ engine: createJobEngine(), llm: createDemoLlm(), tables });
    const job = await env.createJob('unit_generate', {
      unit_id: IDS.unit(2),
      notes: 'Keep it short.',
    });
    const jobId = String(job['id']);

    await run(env, jobId);
    const row = env.backend.row(jobId);
    expect(row['status'], JSON.stringify(row['error'])).toBe('succeeded');

    const versions = (tables['unit_versions'] ?? []).filter(
      (version) => version['unit_id'] === IDS.unit(2),
    );
    expect(versions).toHaveLength(1);
    const saved = versions[0]!;
    expect(saved).toMatchObject({
      version: 1,
      generated_by: 'ai',
      model: DEMO_MODEL,
      prompt_version: 'm2-v1',
      base_version_id: null,
      status: 'draft',
      created_by: 'f9000000-0000-4000-8000-000000000002',
    });

    // what was saved is a unit the content schema accepts, and its lint report is stored beside it
    const unit = parseUnit(saved['content']);
    expect((unit.sections ?? []).length).toBeGreaterThan(3);
    expect(lintUnit(unit).errors).toEqual([]);
    const report = saved['lint_report'] as {
      errors: unknown[];
      ok: boolean;
      review: Array<{ message: string }>;
      summary: string;
    };
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    // the demo model says so in its own review flags
    expect(report.review.map((flag) => flag.message).join(' ')).toMatch(/demo/i);

    const result = row['result'] as {
      unit_version_id: string;
      version: number;
      lint: { ok: boolean };
    };
    expect(result.unit_version_id).toBe(saved['id']);
    expect(result.version).toBe(1);
    expect(result.lint.ok).toBe(true);

    // many steps (outline, one per section, assemble), each one logged and none leaving a lease behind
    expect(env.backend.usage.length).toBeGreaterThan(3);
    expect(row['lease_until']).toBeNull();
    expect(env.logs.filter((log) => log.event === 'step_failed')).toEqual([]);
  });

  it('revises the draft it just made on top of that version', async () => {
    const tables = curriculumFromFixture();
    const env = makeEnv({ engine: createJobEngine(), llm: createDemoLlm(), tables });
    const generate = await env.createJob('unit_generate', { unit_id: IDS.unit(2) });
    await run(env, String(generate['id']));
    const first = (tables['unit_versions'] ?? [])[0]!;
    const content = parseUnit(first['content']);
    const sectionId = (content.sections ?? []).find((section) => section.type === 'concept')?.id;
    expect(sectionId).toBeDefined();

    const revise = await env.createJob('unit_revise', {
      unit_version_id: String(first['id']),
      instruction: 'Use a simpler example.',
      section_ids: [sectionId],
    });
    await run(env, String(revise['id']));
    const row = env.backend.row(String(revise['id']));
    expect(row['status'], JSON.stringify(row['error'])).toBe('succeeded');
    const versions = (tables['unit_versions'] ?? []).filter(
      (version) => version['unit_id'] === IDS.unit(2),
    );
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      version: 2,
      base_version_id: first['id'],
      generated_by: 'ai',
      status: 'draft',
    });
  });

  it('also runs on the Deno bundle (vendor/authoring-core.js) that the deployed function imports', async () => {
    // The glue in ai-job/index.ts uses the bundle made by `node scripts/vendor-authoring.mjs`, so check the handler
    // against it as well: its engine, its schemas, its error classes (a different copy of StepError than the source).
    const bundlePath = './vendor/authoring-core.js';
    const bundle = (await import(/* @vite-ignore */ bundlePath)) as AuthoringCore & {
      createJobEngine(): JobEngine;
      LlmError: new (
        code: string,
        message: string,
        options?: { raw?: string; retryable?: boolean },
      ) => Error;
    };
    const tables = curriculumFromFixture();
    const env = makeEnv({ engine: bundle.createJobEngine(), llm: createDemoLlm(), tables });
    env.deps.core = bundle;

    const job = await env.createJob('unit_generate', { unit_id: IDS.unit(3) });
    await run(env, String(job['id']));
    const row = env.backend.row(String(job['id']));
    expect(row['status'], JSON.stringify(row['error'])).toBe('succeeded');
    expect(
      (tables['unit_versions'] ?? []).filter((version) => version['unit_id'] === IDS.unit(3)),
    ).toHaveLength(1);

    // a failure raised by the bundle's own error classes is still understood (matched by shape, not by class),
    // and nothing of the model's raw reply or of a key in its message reaches the job row
    const refusing = {
      generate: () =>
        Promise.reject(
          new bundle.LlmError('refusal', 'The model refused sk-ant-api03-SECRETKEY', {
            raw: 'RAW-MODEL-REPLY',
            retryable: false,
          }),
        ),
    };
    const failing = makeEnv({
      engine: bundle.createJobEngine(),
      llm: refusing,
      tables: curriculumFromFixture(),
    });
    failing.deps.core = bundle;
    const bad = await failing.createJob('chapter_plan', { scheme_id: IDS.scheme });
    await run(failing, String(bad['id']));
    const failed = failing.backend.row(String(bad['id']));
    expect(failed['status']).toBe('failed');
    expect(failed['error']).toMatchObject({ code: 'refusal', retryable: false });
    expect(JSON.stringify(failed)).not.toMatch(/SECRETKEY|RAW-MODEL-REPLY|sk-ant/);
    expect(JSON.stringify(failing.logs)).not.toMatch(/SECRETKEY|RAW-MODEL-REPLY/);
  });
});
