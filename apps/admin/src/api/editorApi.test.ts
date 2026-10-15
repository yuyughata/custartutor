// The live adapter's M2.4 calls, against a recording fake supabase-js client: exact RPC names and arguments, the
// published-history read, the human version save and the typed errors.
import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { isAdminApiError, renumberDetail, type AdminApiError } from './errors';
import { createSupabaseAdminApi } from './supabaseAdminApi';
import { FakeFetch, FakeSupabase } from './testing/fakeSupabase';

const SCHEME_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const NEW_VERSION_ID = '44444444-4444-4444-8444-444444444444';

function setup() {
  const supabase = new FakeSupabase();
  const api = createSupabaseAdminApi(supabase.asClient(), {
    url: 'https://example.supabase.co/',
    publishableKey: 'sb_publishable_test',
    fetch: new FakeFetch().fetch,
    randomId: () => 'fixed',
  });
  return { supabase, api };
}

async function caught(promise: Promise<unknown>): Promise<AdminApiError> {
  try {
    await promise;
  } catch (error) {
    if (isAdminApiError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const layout = {
  chapters: [{ id: 'c1', units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] }],
  removed: [],
};

const layoutReply = {
  chapters: 1,
  units: '4',
  units_created: 1,
  units_updated: 0,
  units_moved: 0,
  units_renumbered: 0,
  units_archived: 0,
  chapters_created: 0,
  created_unit_ids: [UNIT_ID],
  created_chapter_ids: [],
  layout: [
    { chapter_id: 'c1', number: 1, title: 'Our Environment', units: [{ id: UNIT_ID, unit_no: 4 }] },
  ],
};

describe('apply_unit_layout', () => {
  it('sends the exact arguments and validates the reply', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('apply_unit_layout', { data: layoutReply });
    const out = await api.chapters.applyLayout(SCHEME_ID, layout);
    expect(supabase.rpcCalls).toEqual([
      {
        name: 'apply_unit_layout',
        args: { p_scheme_id: SCHEME_ID, p_layout: layout, p_confirm_renumber: false },
      },
    ]);
    expect(out.units).toBe(4);
    expect(out.created_unit_ids).toEqual([UNIT_ID]);
    expect(out.layout[0]?.units[0]?.unit_no).toBe(4);
  });

  it('passes the confirmation only when asked', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('apply_unit_layout', { data: layoutReply });
    await api.chapters.applyLayout(SCHEME_ID, layout, { confirmRenumber: true });
    expect(supabase.rpcCalls[0]?.args.p_confirm_renumber).toBe(true);
  });

  it('turns a reply that is not the expected shape into a bad_response error', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('apply_unit_layout', { data: { chapters: 'many' } });
    expect((await caught(api.chapters.applyLayout(SCHEME_ID, layout))).kind).toBe('bad_response');
  });

  it.each([
    ['layout_out_of_date', 'conflict', 'Reload'],
    ['chapter_unit_count_invalid', 'invalid', '3 to 5'],
    ['unit_has_versions', 'conflict', 'Edit by hand'],
    ['published_unit_cannot_move', 'conflict', 'published'],
    ['chapter_order_changed', 'invalid', 'order'],
    ['unit_not_in_scheme', 'not_found', 'no longer'],
    ['invalid_layout_unit', 'invalid', 'title'],
  ])('maps %s to a typed error in plain words', async (message, kind, words) => {
    const { supabase, api } = setup();
    supabase.onRpc('apply_unit_layout', { error: { message, code: '22023' } });
    const error = await caught(api.chapters.applyLayout(SCHEME_ID, layout));
    expect(error.code).toBe(message);
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(words);
  });

  it('reads the DETAIL of a renumber refusal as the list of units', async () => {
    const { supabase, api } = setup();
    const detail = [{ id: 'u6', title: 'Unit 6', from: 6, to: 7 }];
    supabase.onRpc('apply_unit_layout', {
      error: {
        message: 'layout_renumbers_versioned_units',
        code: '22023',
        details: JSON.stringify(detail),
      },
    });
    const error = await caught(api.chapters.applyLayout(SCHEME_ID, layout));
    expect(error.code).toBe('layout_renumbers_versioned_units');
    expect(renumberDetail(error)).toEqual(detail);
    expect(renumberDetail(new Error('x'))).toBeNull();
  });
});

describe('the published history', () => {
  it('reads every published snapshot of the unit, oldest first, with its content', async () => {
    const { supabase, api } = setup();
    supabase.onTable('published_units', {
      data: [
        {
          id: 'p1',
          version_no: 1,
          is_current: false,
          published_at: '2026-10-01T00:00:00Z',
          content: goldenUnit2,
        },
        {
          id: 'p2',
          version_no: 2,
          is_current: true,
          published_at: '2026-10-02T00:00:00Z',
          content: goldenUnit2,
        },
      ],
    });
    const history = await api.units.publishedHistory(UNIT_ID);
    expect(history.map((s) => s.version_no)).toEqual([1, 2]);
    expect(history[1]?.is_current).toBe(true);
    const query = supabase.queries[0];
    expect(query?.table).toBe('published_units');
    expect(query?.select).toBe('id,version_no,is_current,published_at,content');
    expect(query?.filters).toEqual([{ op: 'eq', column: 'unit_id', value: UNIT_ID }]);
    expect(query?.order).toEqual([{ column: 'version_no', ascending: true }]);
  });

  it('an unpublished unit has no history, and a malformed row is a bad_response', async () => {
    const { supabase, api } = setup();
    supabase.onTable('published_units', { data: [] });
    expect(await api.units.publishedHistory(UNIT_ID)).toEqual([]);
    supabase.onTable('published_units', { data: [{ id: 'p1' }] });
    expect((await caught(api.units.publishedHistory(UNIT_ID))).kind).toBe('bad_response');
  });
});

describe('saving a human version', () => {
  const report = { errors: [], warnings: [], ok: true, review: [], summary: 'by hand' };

  it('calls create_unit_version_draft as a human with no model and no prompt version', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('create_unit_version_draft', { data: { id: NEW_VERSION_ID, version: 3 } });
    const out = await api.units.saveHumanVersion({
      unitId: UNIT_ID,
      content: goldenUnit2 as never,
      lintReport: report,
      baseVersionId: VERSION_ID,
    });
    expect(out).toEqual({ id: NEW_VERSION_ID, version: 3 });
    expect(supabase.rpcCalls).toEqual([
      {
        name: 'create_unit_version_draft',
        args: {
          p_unit_id: UNIT_ID,
          p_content: JSON.parse(JSON.stringify(goldenUnit2)),
          p_lint_report: report,
          p_generated_by: 'human',
          p_model: null,
          p_prompt_version: null,
          p_base_version_id: VERSION_ID,
        },
      },
    ]);
  });

  it('shows a stale base as a conflict, and a role problem as forbidden', async () => {
    const { supabase, api } = setup();
    const input = {
      unitId: UNIT_ID,
      content: goldenUnit2 as never,
      lintReport: report,
      baseVersionId: VERSION_ID,
    };
    supabase.onRpc('create_unit_version_draft', {
      error: { message: 'stale_base', code: '22023' },
    });
    const stale = await caught(api.units.saveHumanVersion(input));
    expect(stale).toMatchObject({ kind: 'conflict', code: 'stale_base' });
    supabase.onRpc('create_unit_version_draft', {
      error: { message: 'admin_role_required', code: '42501' },
    });
    expect((await caught(api.units.saveHumanVersion(input))).kind).toBe('forbidden');
    supabase.onRpc('create_unit_version_draft', {
      error: { message: 'unit_not_editable', code: '22023' },
    });
    expect((await caught(api.units.saveHumanVersion(input))).message).toContain('removed');
  });
});
