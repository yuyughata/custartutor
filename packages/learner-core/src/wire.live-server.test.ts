import { describe, expect, it } from 'vitest';
import live from './fixtures/live-server-output.json';
import { PullResponse, PushResults } from './wire';

/**
 * `live-server-output.json` was captured from the real CUSTAR Tutor dev database on 2026-10-12: a guardian
 * and one child were created, a pack was registered for the golden unit, seven events were pushed with
 * `ingest_progress_events` (five valid, one inconsistent mastery, one duplicate) and `sync_pull(0, 500)` was
 * called, all in one rolled-back transaction. If the SQL and `wire.ts` drift apart, this test fails.
 */
describe('wire contract against the live server output', () => {
  it('sync_pull output satisfies PullResponse', () => {
    const parsed = PullResponse.parse(live.pull);
    expect(parsed.household?.name).toBe('Contract family');
    expect(parsed.children).toHaveLength(1);
    expect(parsed.published).toHaveLength(1);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_seq).toBe(Math.max(...parsed.unit_progress.map((row) => row.sync_seq)));
  });

  it('derives mastered progress from the pushed events', () => {
    const [row] = PullResponse.parse(live.pull).unit_progress;
    expect(row?.status).toBe('mastered');
    expect(row?.attempts).toBe(1);
    expect(row?.mastery_score).toBe(1);
  });

  it('ingest_progress_events output satisfies PushResults, row by row', () => {
    const results = PushResults.parse(live.ingest);
    expect(results.map((result) => result.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'rejected',
      'duplicate',
    ]);
    expect(results[5]?.reason).toBe('inconsistent_mastery');
  });
});
