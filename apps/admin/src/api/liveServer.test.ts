import { describe, expect, it } from 'vitest';
import { AiSettings, JobRow } from '@custar/authoring-core';
import live from './fixtures/live-server-output.json';
import {
  AiSettingsSchema,
  ApplyPlanSchema,
  JobRowLoose,
  UsageSummarySchema,
  UuidResult,
} from './schemas';

/**
 * `fixtures/live-server-output.json` was captured from the real CUSTAR Tutor dev database on 2026-10-12: an
 * admin was impersonated at aal2 and the M2 RPCs were called in sequence (settings, a priced model, a scheme
 * draft, approval, a chapter plan applied twice, a job created, leased and stepped with two usage rows, the
 * usage summary and a unit-version draft), all inside one rolled-back transaction. If the SQL and the shapes
 * the admin app parses drift apart, this test fails.
 */
describe('admin schemas against the live server output', () => {
  it('get_ai_settings satisfies AiSettings, with defaults and with a price entered', () => {
    expect(AiSettings.parse(live.settings_default).prices).toEqual({});
    expect(
      AiSettingsSchema.parse(live.settings_priced).prices['claude-opus-5-5']?.input_per_mtok,
    ).toBe(1);
  });

  it('save_scheme_draft returns a uuid and apply_chapter_plan its counts, idempotently', () => {
    expect(UuidResult.parse(live.save_scheme_draft)).toMatch(/^[0-9a-f-]{36}$/);
    expect(ApplyPlanSchema.parse(live.apply_chapter_plan)).toEqual({ chapters: 2, units: 6 });
    expect(live.apply_chapter_plan_again.units_created).toBe(0);
  });

  it('job rows satisfy the contract JobRow, queued and running', () => {
    for (const row of [live.create_ai_job, live.job_row_running]) {
      expect(JobRow.parse(row).id).toBe(live.create_ai_job.id);
      expect(JobRowLoose.parse(row).kind).toBe('unit_generate');
    }
    expect(JobRow.parse(live.job_row_running).progress).toEqual({
      done: ['outline'],
      next: 'section:story_opener',
      total: 19,
    });
  });

  it('a client row carries none of the server-only columns', () => {
    for (const column of ['input', 'state', 'lease_token', 'params']) {
      expect(live.create_ai_job).not.toHaveProperty(column);
      expect(live.job_row_running).not.toHaveProperty(column);
    }
  });

  it('get_ai_usage_summary satisfies the usage schema; unpriced calls stay unknown, never zero', () => {
    const summary = UsageSummarySchema.parse(live.usage_summary);
    expect(summary.totals.calls).toBe(2);
    expect(summary.totals.unpriced_calls).toBe(1);
    expect(summary.totals.jobs_by_status).toMatchObject({ running: 1 });
    const priced = summary.by_model.find((row) => row.model === 'claude-opus-5-5-20261001');
    const unpriced = summary.by_model.find((row) => row.model === 'unpriced-model');
    // a dated snapshot id is priced through the alias entry (longest-prefix rule)
    expect(priced?.est_cost_usd).toBeCloseTo(0.002575, 9);
    expect(unpriced?.est_cost_usd).toBeNull();
    expect(summary.by_kind.find((row) => row.kind === 'scheme_ingest')?.est_cost_usd).toBeNull();
  });

  it('create_unit_version_draft returns the new id and number', () => {
    expect(live.create_unit_version_draft.version).toBe(1);
    expect(UuidResult.parse(live.create_unit_version_draft.id)).toBeTruthy();
  });
});
