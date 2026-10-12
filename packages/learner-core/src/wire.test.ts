import { describe, expect, it } from 'vitest';
import {
  ChildRow,
  IngestProgressEventsArgs,
  MAX_PUSH_BATCH,
  PackDownload,
  PublishedRow,
  PullResponse,
  PushResult,
  SubjectRow,
  UnitProgressRow,
  UnitRow,
  WireEvent,
} from './wire';
import {
  CHILD_A,
  UNIT_1,
  answeredEvent,
  completedEvent,
  masteryEvent,
  sectionEvent,
  startedEvent,
  uuidN,
} from './test-helpers';

const when = '2026-10-12T08:00:00.123Z';

describe('WireEvent', () => {
  it('accepts every event type with its payload', () => {
    const events = [
      startedEvent(),
      sectionEvent('intro'),
      answeredEvent('q_1', 'correct'),
      answeredEvent('q_2', 'ungraded'),
      masteryEvent(0.9, true),
      completedEvent(),
    ];
    for (const event of events)
      expect(WireEvent.safeParse(event).success, event.event_type).toBe(true);
  });

  it('rejects bad payloads and ids', () => {
    const base = startedEvent();
    const bad = (patch: Record<string, unknown>) =>
      WireEvent.safeParse({ ...base, ...patch }).success;
    expect(bad({ client_event_id: 'nope' })).toBe(false);
    expect(bad({ device_seq: 0 })).toBe(false);
    expect(bad({ device_seq: 1.5 })).toBe(false);
    expect(bad({ occurred_at: 'yesterday' })).toBe(false);
    expect(bad({ event_type: 'something_else' })).toBe(false);
    expect(bad({ device_id: '' })).toBe(false);
    expect(
      WireEvent.safeParse({ ...answeredEvent('q', 'correct'), payload: { question_id: 'q' } })
        .success,
    ).toBe(false);
    expect(WireEvent.safeParse({ ...masteryEvent(1.2, true) }).success).toBe(false);
    expect(WireEvent.safeParse({ ...sectionEvent('') }).success).toBe(false);
    expect(
      WireEvent.safeParse({
        ...answeredEvent('q', 'correct'),
        payload: { question_id: 'q', result: 'maybe', score: 1, attempt: 1 },
      }).success,
    ).toBe(false);
  });

  it('accepts +00:00 offsets as Postgres emits them', () => {
    expect(
      WireEvent.safeParse({ ...startedEvent(), occurred_at: '2026-10-12T08:00:00.123456+00:00' })
        .success,
    ).toBe(true);
  });

  it('is serialisable as JSON without loss', () => {
    const event = masteryEvent(0.8333, true);
    expect(WireEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });
});

describe('push contract', () => {
  it('limits a batch to 100 events', () => {
    const events = Array.from({ length: MAX_PUSH_BATCH }, () => startedEvent());
    expect(IngestProgressEventsArgs.safeParse({ p_events: events }).success).toBe(true);
    expect(
      IngestProgressEventsArgs.safeParse({ p_events: [...events, startedEvent()] }).success,
    ).toBe(false);
    expect(IngestProgressEventsArgs.safeParse({ p_events: [] }).success).toBe(false);
  });

  it('validates per-row results', () => {
    const id = uuidN(1);
    expect(PushResult.safeParse({ client_event_id: id, status: 'accepted' }).success).toBe(true);
    expect(
      PushResult.safeParse({
        client_event_id: id,
        status: 'rejected',
        reason: 'no_access_to_child',
      }).success,
    ).toBe(true);
    expect(PushResult.safeParse({ client_event_id: id, status: 'weird' }).success).toBe(false);
    expect(PushResult.safeParse({ status: 'accepted' }).success).toBe(false);
  });
});

describe('pull contract', () => {
  const sync = { sync_seq: 5, deleted_at: null };
  const child = {
    id: CHILD_A,
    household_id: uuidN(9),
    display_alias: 'Ada',
    avatar: null,
    level_code: 'P1',
    reading_mode: 'reader',
    daily_limit_min: null,
    ...sync,
  };

  it('accepts a full page and a minimal empty one', () => {
    const page = {
      epoch: 3,
      next_seq: 12,
      has_more: false,
      server_time: '2026-10-12T08:00:00+00:00',
      household: { id: uuidN(9), name: 'Okafor' },
      children: [child],
      subjects: [
        {
          id: uuidN(2),
          slug: 'maths',
          name: 'Maths',
          kind: 'core',
          curriculum_source: 'nerdc',
          icon: null,
          colour: null,
          sort: 1,
          ...sync,
        },
      ],
      units: [
        {
          id: UNIT_1,
          subject_id: uuidN(2),
          chapter_number: 1,
          chapter_title: 'Our World',
          unit_no: 2,
          week_no: null,
          kind: 'lesson',
          title: 'Unit',
          objective: null,
          stage: 'absorb',
          level_code: 'P1',
          term: 1,
          ...sync,
        },
      ],
      published: [
        {
          unit_id: UNIT_1,
          version_no: 1,
          schema_version: 1,
          min_app_version: '1.0.0',
          content_hash: 'a'.repeat(64),
          pack_manifest_path: 'packs/x/1/manifest.json',
          ...sync,
        },
      ],
      unit_progress: [
        {
          child_id: CHILD_A,
          unit_id: UNIT_1,
          status: 'mastered',
          mastery_score: 0.9,
          attempts: 2,
          last_section: 'intro',
          updated_at: when,
          ...sync,
        },
      ],
    };
    expect(PullResponse.safeParse(page).success).toBe(true);
    expect(
      PullResponse.safeParse({
        ...page,
        household: null,
        children: [],
        subjects: [],
        units: [],
        published: [],
        unit_progress: [],
      }).success,
    ).toBe(true);
  });

  it('requires sync_seq and deleted_at on syncable rows and checks enums', () => {
    expect(ChildRow.safeParse(child).success).toBe(true);
    expect(ChildRow.safeParse({ ...child, sync_seq: undefined }).success).toBe(false);
    expect(ChildRow.safeParse({ ...child, deleted_at: undefined }).success).toBe(false);
    expect(ChildRow.safeParse({ ...child, level_code: 'P7' }).success).toBe(false);
    expect(ChildRow.safeParse({ ...child, reading_mode: 'baby' }).success).toBe(false);
    expect(ChildRow.safeParse({ ...child, deleted_at: when }).success).toBe(true);
    expect(UnitProgressRow.safeParse({ ...child }).success).toBe(false);
    expect(SubjectRow.safeParse({}).success).toBe(false);
    expect(UnitRow.safeParse({}).success).toBe(false);
    expect(PublishedRow.safeParse({}).success).toBe(false);
  });

  it('ignores extra fields (forward compatible)', () => {
    const parsed = ChildRow.parse({ ...child, future_field: 'x' });
    expect('future_field' in parsed).toBe(false);
  });

  it('rejects a page with a missing array or a bad time', () => {
    expect(
      PullResponse.safeParse({
        epoch: 1,
        next_seq: 0,
        has_more: false,
        server_time: when,
        household: null,
      }).success,
    ).toBe(false);
  });
});

describe('PackDownload', () => {
  it('needs a manifest, urls and an expiry', () => {
    const file = {
      path: 'learner.json',
      sha256: 'a'.repeat(64),
      bytes: 10,
      kind: 'content',
      pack: 'learner',
    };
    const download = {
      manifest: {
        pack_version: 1,
        unit_id: UNIT_1,
        version_no: 1,
        schema_version: 1,
        min_app_version: '1.0.0',
        content_hash: 'b'.repeat(64),
        files: [file],
        learner_content_path: 'learner.json',
        grownup_content_path: null,
      },
      urls: { 'learner.json': 'https://storage.test/x?sig=1' },
      expires_at: '2026-10-12T09:00:00Z',
    };
    expect(PackDownload.safeParse(download).success).toBe(true);
    expect(
      PackDownload.safeParse({ ...download, urls: { 'learner.json': 'not a url' } }).success,
    ).toBe(false);
    expect(PackDownload.safeParse({ ...download, expires_at: 'soon' }).success).toBe(false);
  });
});
