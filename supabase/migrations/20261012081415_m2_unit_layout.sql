-- 18 M2.4 (owner requirement, 2026-10-12): units added, removed and reordered by hand, up to five per chapter.
--
--   apply_unit_layout(p_scheme_id, p_layout, p_confirm_renumber)   one atomic RPC for the whole layout of a scheme
--
-- Thin SECURITY INVOKER `public.apply_unit_layout` over the SECURITY DEFINER `private.apply_unit_layout` (it writes
-- chapters/units/theme_units and the audit log, like apply_chapter_plan). super_admin and content_editor at aal2.
-- Stable snake_case messages; SQLSTATE 42501 = not allowed, P0002 = not found, 22023 = refused.
--
-- THE LAYOUT. p_layout names EVERY live chapter and EVERY live unit of the scheme exactly once, in teaching order:
--
--   { "chapters": [
--       { "id": "<chapter uuid>",              -- an existing chapter
--         "units": [ { "id": "<unit uuid>" },                                -- an existing unit, as it is
--                    { "id": "<unit uuid>", "set": { "title": ..., "objective": ..., "kind": ..., "stage": ...,
--                                                    "periods": ..., "week_no": ... | null } },   -- version-less units only
--                    { "new": { "title", "objective", "kind", "stage", "periods"?, "week_no"?, "lens"? } } ] },
--       { "new": { "title": "..." }, "units": [ ... ] }            -- a new chapter, only after all existing ones
--     ],
--     "removed": [ "<unit uuid>", ... ] }                          -- units to archive (explicit, never implied)
--
-- A layout that does not account for exactly the live chapters and units (somebody else added or removed one since the
-- admin loaded the page) is refused with `layout_out_of_date`, so a stale page can never archive a colleague's unit.
--
-- NUMBERING DECISION. `units.unit_no` is the 1-based ORDINAL of a unit within its TERM, in teaching order (chapter
-- number, then position in the chapter): that is what the learner app prints ("Unit 5: ..."), sorts by
-- (chapter_number, unit_no), what apply_chapter_plan requires to be unique over the whole plan, and what
-- `header.unit_no` of the unit content means. The RPC therefore gives every live unit its rank in the layout: dense,
-- unique term-wide, always consistent. The least invasive way to keep that true:
--   * a unit WITHOUT versions is renumbered, moved and edited freely (nothing about it is published or drafted);
--   * a unit WITH versions keeps its row, its id and its versions; its chapter/position may change, but only when
--     the caller passes p_confirm_renumber = true after being told which numbers change (`layout_renumbers_versioned_units`
--     carries the list in the error DETAIL). Its title, objective, kind, stage, periods and week are never edited here
--     (`unit_has_versions`); that is what new versions are for. A unit that was ever published stays in its chapter
--     (`published_unit_cannot_move`) and can never be removed;
--   * published snapshots are immutable and are never touched; the editor re-stamps `header.unit_no` and
--     `header.chapter` on the next version it saves and warns while a version's header differs from the unit row;
--   * adding a unit at the end of the LAST chapter, or removing one, renumbers nothing that has a version.
-- Trade-off: adding a unit in an EARLIER chapter shifts the numbers of every later unit by one (the dense ordinal),
-- including those that already have drafts; that is why it needs the explicit confirmation. The alternative (sparse
-- numbers, "Unit 9" before "Unit 5") would leave nothing to renumber but would print numbers out of order.
--
-- REMOVAL IS ARCHIVAL. A removed unit (it must have NO version) becomes status 'archived' with deleted_at set and its
-- number parked at 10000 + n inside its chapter, which frees the (chapter_id, unit_no) slot for the unique
-- constraint. Archived units stay readable to content staff, are ignored by chapter_unit_count_ok, and cannot get a
-- version (create_unit_version_draft: unit_not_editable). apply_chapter_plan (unchanged) still works: it matches
-- units by (chapter number, unit_no) and a later plan re-apply removes units without a version that the plan lacks.
--
-- 3 TO 5 UNITS. Every chapter of the layout must end with 3 to 5 units (`chapter_unit_count_invalid`, the code
-- apply_chapter_plan and publish_unit_version already use). publish_unit_version still counts live units at publish.
--
-- LOCKING. The scheme row is locked FOR UPDATE first (so this serialises with apply_chapter_plan and with other
-- layouts), then only the units that will change are locked, in id order, and their versions are checked AFTER the
-- lock (create_unit_version_draft locks the unit row before it numbers a version, so no version can slip in). Writes
-- then run in id order, after all validation, because every write draws a global sync_seq under one advisory lock
-- (see supabase/migrations/README.md "Sync contract"): a rare 40P01 against a concurrent publish in the same chapter
-- is retried by the caller. The numbers are changed in two passes (park, then final) because the unique constraint
-- is checked row by row. An unchanged layout writes nothing at all (no sync_seq, no audit row).
--
-- Returns {chapters, units, units_created, units_updated, units_moved, units_renumbered, units_archived,
--          chapters_created, created_unit_ids, created_chapter_ids, layout: [{chapter_id, number, title,
--          units: [{id, unit_no}]}]}.

-- a uuid held in a JSON string, or NULL (helper: no API role may execute it)
create or replace function private.json_uuid(p_value jsonb)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'string'
     and (p_value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_value #>> '{}')::uuid
  end;
$$;

-- the validated editable fields of one unit entry ({} for an omitted `set`); p_require_all for a NEW unit
create or replace function private.layout_unit_fields(p_fields jsonb, p_scheme_id uuid, p_require_all boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_text text;
  v_int int;
begin
  if p_fields is null or jsonb_typeof(p_fields) = 'null' then
    p_fields := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object' then
    raise exception 'invalid_layout_unit' using errcode = '22023';
  end if;

  if p_fields ? 'title' then
    v_text := private.json_text(p_fields -> 'title', 200);
    if v_text is null then raise exception 'invalid_layout_unit' using errcode = '22023'; end if;
    v_out := v_out || jsonb_build_object('title', v_text);
  elsif p_require_all then
    raise exception 'invalid_layout_unit' using errcode = '22023';
  end if;

  if p_fields ? 'objective' then
    v_text := private.json_text(p_fields -> 'objective', 2000);
    if v_text is null then raise exception 'invalid_layout_unit' using errcode = '22023'; end if;
    v_out := v_out || jsonb_build_object('objective', v_text);
  elsif p_require_all then
    raise exception 'invalid_layout_unit' using errcode = '22023';
  end if;

  if p_fields ? 'kind' then
    v_text := case when jsonb_typeof(p_fields -> 'kind') = 'string' then p_fields ->> 'kind' end;
    if v_text is null or v_text <> all (array['lesson', 'mini_project', 'term_project', 'revision', 'assessment']) then
      raise exception 'invalid_layout_unit' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_object('kind', v_text);
  elsif p_require_all then
    raise exception 'invalid_layout_unit' using errcode = '22023';
  end if;

  if p_fields ? 'stage' then
    v_text := case when jsonb_typeof(p_fields -> 'stage') = 'string' then p_fields ->> 'stage' end;
    if v_text is null or v_text <> all (array['absorb', 'connect', 'express']) then
      raise exception 'invalid_layout_unit' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_object('stage', v_text);
  elsif p_require_all then
    raise exception 'invalid_layout_unit' using errcode = '22023';
  end if;

  if p_fields ? 'periods' then
    v_int := private.json_int(p_fields -> 'periods', 1, 10);
    if v_int is null then raise exception 'invalid_layout_unit' using errcode = '22023'; end if;
    v_out := v_out || jsonb_build_object('periods', v_int);
  elsif p_require_all then
    v_out := v_out || jsonb_build_object('periods', 1);
  end if;

  if p_fields ? 'week_no' then
    if jsonb_typeof(p_fields -> 'week_no') = 'null' then
      v_out := v_out || jsonb_build_object('week_no', null::int);
    else
      v_int := private.json_int(p_fields -> 'week_no', 1, 15);
      if v_int is null then raise exception 'invalid_layout_unit' using errcode = '22023'; end if;
      if not exists (select 1 from public.scheme_weeks w where w.scheme_id = p_scheme_id and w.week_no = v_int) then
        raise exception 'unknown_scheme_week' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object('week_no', v_int);
    end if;
  end if;

  if p_require_all and p_fields ? 'lens' and jsonb_typeof(p_fields -> 'lens') <> 'null' then
    v_text := private.json_text(p_fields -> 'lens', 200);
    if v_text is null then raise exception 'invalid_layout_unit' using errcode = '22023'; end if;
    v_out := v_out || jsonb_build_object('lens', v_text);
  end if;
  return v_out;
end;
$$;

create or replace function private.apply_unit_layout(
  p_scheme_id uuid,
  p_layout jsonb,
  p_confirm_renumber boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_scheme public.schemes%rowtype;
  v_ch jsonb;
  v_ch_pos int;
  v_un jsonb;
  v_item jsonb;
  v_ch_id uuid;
  v_ch_no int;
  v_last_no int := 0;
  v_seen_new boolean := false;
  v_new_base int;
  v_new_chapters int := 0;
  v_unit_id uuid;
  v_fields jsonb;
  v_rank int := 0;
  v_pos int;
  v_chapter_ids uuid[] := '{}';
  v_unit_ids uuid[] := '{}';
  v_removed uuid[] := '{}';
  v_chapters jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_pos_ids uuid[] := '{}';
  v_cur public.units%rowtype;
  v_target uuid;
  v_changed_pos uuid[] := '{}';
  v_changed_fields uuid[] := '{}';
  v_lock uuid[];
  v_versioned jsonb := '[]'::jsonb;
  v_moved int := 0;
  v_renumbered int := 0;
  v_updated int := 0;
  v_archived int := 0;
  v_created_units int := 0;
  v_created_chapters int := 0;
  v_created uuid[] := '{}';
  v_created_ch uuid[] := '{}';
  v_theme uuid;
  v_parked int;
  v_new_id uuid;
  v_has_new boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;

  select * into v_scheme from public.schemes s where s.id = p_scheme_id for update;
  if not found then
    raise exception 'scheme_not_found' using errcode = 'P0002';
  end if;
  if v_scheme.status <> 'approved' then
    raise exception 'scheme_not_approved' using errcode = '22023';
  end if;

  -- 1. validate the whole layout before touching anything ------------------------------------------------------------
  if p_layout is null or jsonb_typeof(p_layout) is distinct from 'object'
     or jsonb_typeof(p_layout -> 'chapters') is distinct from 'array'
     or jsonb_array_length(p_layout -> 'chapters') not between 1 and 50 then
    raise exception 'invalid_unit_layout' using errcode = '22023';
  end if;
  if p_layout ? 'removed' and jsonb_typeof(p_layout -> 'removed') <> 'null' then
    if jsonb_typeof(p_layout -> 'removed') <> 'array' or jsonb_array_length(p_layout -> 'removed') > 250 then
      raise exception 'invalid_unit_layout' using errcode = '22023';
    end if;
    for v_item in select e.value from jsonb_array_elements(p_layout -> 'removed') as e(value) loop
      v_unit_id := private.json_uuid(v_item);
      if v_unit_id is null or v_unit_id = any (v_removed) then
        raise exception 'invalid_unit_layout' using errcode = '22023';
      end if;
      v_removed := v_removed || v_unit_id;
    end loop;
  end if;

  select coalesce(max(c.number), 0) into v_new_base from public.chapters c where c.scheme_id = p_scheme_id;

  for v_ch, v_ch_pos in
    select e.value, e.n::int from jsonb_array_elements(p_layout -> 'chapters') with ordinality as e(value, n) order by e.n
  loop
    if jsonb_typeof(v_ch) is distinct from 'object' or jsonb_typeof(v_ch -> 'units') is distinct from 'array' then
      raise exception 'invalid_unit_layout' using errcode = '22023';
    end if;
    if jsonb_array_length(v_ch -> 'units') not between 3 and 5 then
      raise exception 'chapter_unit_count_invalid' using errcode = '22023';
    end if;

    if v_ch ? 'id' and jsonb_typeof(v_ch -> 'id') <> 'null' then
      v_ch_id := private.json_uuid(v_ch -> 'id');
      if v_ch_id is null or v_ch_id = any (v_chapter_ids) then
        raise exception 'invalid_unit_layout' using errcode = '22023';
      end if;
      select c.number into v_ch_no
        from public.chapters c
       where c.id = v_ch_id and c.scheme_id = p_scheme_id and c.deleted_at is null and c.status <> 'archived';
      if not found then
        raise exception 'chapter_not_in_scheme' using errcode = 'P0002';
      end if;
      if v_seen_new or v_ch_no <= v_last_no then
        raise exception 'chapter_order_changed' using errcode = '22023';
      end if;
      v_last_no := v_ch_no;
      v_chapter_ids := v_chapter_ids || v_ch_id;
      v_pos_ids[v_ch_pos] := v_ch_id;
      v_chapters := v_chapters || jsonb_build_object('pos', v_ch_pos, 'chapter_id', v_ch_id, 'number', v_ch_no);
    else
      if jsonb_typeof(v_ch -> 'new') is distinct from 'object'
         or private.json_text(v_ch -> 'new' -> 'title', 200) is null then
        raise exception 'invalid_unit_layout' using errcode = '22023';
      end if;
      v_seen_new := true;
      v_new_chapters := v_new_chapters + 1;
      v_chapters := v_chapters || jsonb_build_object(
        'pos', v_ch_pos, 'chapter_id', null::uuid, 'number', v_new_base + v_new_chapters,
        'title', private.json_text(v_ch -> 'new' -> 'title', 200)
      );
    end if;

    for v_un in
      select e.value from jsonb_array_elements(v_ch -> 'units') with ordinality as e(value, n) order by e.n
    loop
      if jsonb_typeof(v_un) is distinct from 'object' then
        raise exception 'invalid_unit_layout' using errcode = '22023';
      end if;
      v_rank := v_rank + 1;
      if v_un ? 'id' then
        v_unit_id := private.json_uuid(v_un -> 'id');
        if v_unit_id is null then
          raise exception 'invalid_unit_layout' using errcode = '22023';
        end if;
        if v_unit_id = any (v_unit_ids) or v_unit_id = any (v_removed) then
          raise exception 'duplicate_unit_in_layout' using errcode = '22023';
        end if;
        if not exists (
          select 1
            from public.units u
            join public.chapters c on c.id = u.chapter_id
           where u.id = v_unit_id and c.scheme_id = p_scheme_id and u.deleted_at is null and u.status <> 'archived'
        ) then
          raise exception 'unit_not_in_scheme' using errcode = 'P0002';
        end if;
        v_unit_ids := v_unit_ids || v_unit_id;
        v_fields := private.layout_unit_fields(v_un -> 'set', p_scheme_id, false);
      elsif jsonb_typeof(v_un -> 'new') = 'object' then
        v_unit_id := null;
        v_fields := private.layout_unit_fields(v_un -> 'new', p_scheme_id, true);
      else
        raise exception 'invalid_unit_layout' using errcode = '22023';
      end if;
      v_items := v_items || jsonb_build_object(
        'pos', v_ch_pos, 'unit_id', v_unit_id, 'rank', v_rank, 'fields', v_fields
      );
    end loop;
  end loop;

  -- the layout must account for exactly the live chapters and units
  if exists (
    select 1 from public.chapters c
     where c.scheme_id = p_scheme_id and c.deleted_at is null and c.status <> 'archived'
       and c.id <> all (v_chapter_ids)
  ) then
    raise exception 'layout_out_of_date' using errcode = '22023';
  end if;
  if exists (
    select 1
      from public.units u
      join public.chapters c on c.id = u.chapter_id
     where c.scheme_id = p_scheme_id and u.deleted_at is null and u.status <> 'archived'
       and u.id <> all (v_unit_ids || v_removed)
  ) then
    raise exception 'layout_out_of_date' using errcode = '22023';
  end if;
  foreach v_unit_id in array v_removed loop
    if not exists (
      select 1
        from public.units u
        join public.chapters c on c.id = u.chapter_id
       where u.id = v_unit_id and c.scheme_id = p_scheme_id and u.deleted_at is null and u.status <> 'archived'
    ) then
      raise exception 'unit_not_in_scheme' using errcode = 'P0002';
    end if;
  end loop;

  -- 2. what changes -----------------------------------------------------------------------------------------------------
  for v_item in
    select e.value from jsonb_array_elements(v_items) as e(value) where jsonb_typeof(e.value -> 'unit_id') = 'string'
  loop
    v_unit_id := (v_item ->> 'unit_id')::uuid;
    v_pos := (v_item ->> 'pos')::int;
    v_fields := v_item -> 'fields';
    select * into v_cur from public.units u where u.id = v_unit_id;
    v_target := v_pos_ids[v_pos];
    if v_target is distinct from v_cur.chapter_id then
      v_moved := v_moved + 1;
    end if;
    if v_cur.unit_no <> (v_item ->> 'rank')::int then
      v_renumbered := v_renumbered + 1;
    end if;
    if v_target is distinct from v_cur.chapter_id or v_cur.unit_no <> (v_item ->> 'rank')::int then
      v_changed_pos := v_changed_pos || v_unit_id;
    end if;
    if (v_fields ? 'title' and (v_fields ->> 'title') is distinct from v_cur.title)
       or (v_fields ? 'objective' and (v_fields ->> 'objective') is distinct from v_cur.objective)
       or (v_fields ? 'kind' and (v_fields ->> 'kind') is distinct from v_cur.kind)
       or (v_fields ? 'stage' and (v_fields ->> 'stage') is distinct from v_cur.stage)
       or (v_fields ? 'periods' and (v_fields ->> 'periods')::int is distinct from v_cur.periods)
       or (v_fields ? 'week_no' and (v_fields ->> 'week_no')::int is distinct from v_cur.week_no) then
      v_changed_fields := v_changed_fields || v_unit_id;
      v_updated := v_updated + 1;
    end if;
  end loop;
  v_has_new := exists (select 1 from jsonb_array_elements(v_items) as e(value) where jsonb_typeof(e.value -> 'unit_id') <> 'string');

  if cardinality(v_changed_pos) = 0 and cardinality(v_changed_fields) = 0 and cardinality(v_removed) = 0
     and not v_has_new and v_new_chapters = 0 then
    -- an unchanged layout writes nothing: no sync_seq is drawn and no audit row is added
    return private.unit_layout_result(p_scheme_id, 0, 0, 0, 0, 0, 0, '{}', '{}');
  end if;

  -- 3. lock what will change (in id order), then check versions AFTER the lock ---------------------------------------
  select coalesce(array_agg(distinct x), '{}') into v_lock
    from unnest(v_changed_pos || v_changed_fields || v_removed) as t(x);
  perform u.id from public.units u where u.id = any (v_lock) order by u.id for update;

  for v_item in
    select e.value from jsonb_array_elements(v_items) as e(value) where jsonb_typeof(e.value -> 'unit_id') = 'string'
  loop
    v_unit_id := (v_item ->> 'unit_id')::uuid;
    if v_unit_id = any (v_changed_pos) or v_unit_id = any (v_changed_fields) then
      v_pos := (v_item ->> 'pos')::int;
      select * into v_cur from public.units u where u.id = v_unit_id;
      if exists (select 1 from public.unit_versions uv where uv.unit_id = v_unit_id) then
        if v_unit_id = any (v_changed_fields) then
          raise exception 'unit_has_versions' using errcode = '22023';
        end if;
        if v_pos_ids[v_pos] is distinct from v_cur.chapter_id
           and exists (select 1 from public.published_units pu where pu.unit_id = v_unit_id) then
          raise exception 'published_unit_cannot_move' using errcode = '22023';
        end if;
        v_versioned := v_versioned || jsonb_build_object(
          'id', v_unit_id, 'title', v_cur.title, 'from', v_cur.unit_no, 'to', (v_item ->> 'rank')::int
        );
      end if;
    end if;
  end loop;
  foreach v_unit_id in array v_removed loop
    if exists (select 1 from public.unit_versions uv where uv.unit_id = v_unit_id) then
      raise exception 'unit_has_versions' using errcode = '22023';
    end if;
  end loop;
  if jsonb_array_length(v_versioned) > 0 and not coalesce(p_confirm_renumber, false) then
    raise exception 'layout_renumbers_versioned_units' using errcode = '22023', detail = v_versioned::text;
  end if;

  -- 4. write: new chapters, then park/archive, then the final numbers, then new units ---------------------------------
  for v_item in
    select e.value from jsonb_array_elements(v_chapters) as e(value)
     where jsonb_typeof(e.value -> 'chapter_id') <> 'string' order by (e.value ->> 'pos')::int
  loop
    insert into public.chapters (scheme_id, number, title, status)
    values (p_scheme_id, (v_item ->> 'number')::int, v_item ->> 'title', 'draft')
    returning id into v_new_id;
    v_pos_ids[(v_item ->> 'pos')::int] := v_new_id;
    v_created_ch := v_created_ch || v_new_id;
    v_created_chapters := v_created_chapters + 1;
  end loop;

  -- units that were archived or tombstoned earlier must not hold a live number in the way
  for v_unit_id in
    select u.id from public.units u join public.chapters c on c.id = u.chapter_id
     where c.scheme_id = p_scheme_id and (u.deleted_at is not null or u.status = 'archived') and u.unit_no < 10000
     order by u.id
  loop
    select coalesce(max(u.unit_no) filter (where u.unit_no between 10000 and 99999), 9999) + 1 into v_parked
      from public.units u where u.chapter_id = (select x.chapter_id from public.units x where x.id = v_unit_id);
    update public.units u set unit_no = v_parked where u.id = v_unit_id;
  end loop;

  for v_unit_id in
    select x from unnest(v_changed_pos || v_removed) as t(x) group by x order by x
  loop
    if v_unit_id = any (v_removed) then
      select coalesce(max(u.unit_no) filter (where u.unit_no between 10000 and 99999), 9999) + 1 into v_parked
        from public.units u where u.chapter_id = (select x.chapter_id from public.units x where x.id = v_unit_id);
      update public.units u
         set status = 'archived', deleted_at = now(), unit_no = v_parked
       where u.id = v_unit_id;
      v_archived := v_archived + 1;
    else
      update public.units u set unit_no = u.unit_no + 100000 where u.id = v_unit_id;
    end if;
  end loop;

  for v_unit_id in
    select x from unnest(v_changed_pos || v_changed_fields) as t(x) group by x order by x
  loop
    select e.value into v_item
      from jsonb_array_elements(v_items) as e(value)
     where e.value ->> 'unit_id' = v_unit_id::text;
    v_fields := v_item -> 'fields';
    update public.units u
       set chapter_id = v_pos_ids[(v_item ->> 'pos')::int],
           unit_no = (v_item ->> 'rank')::int,
           title = case when v_fields ? 'title' then v_fields ->> 'title' else u.title end,
           objective = case when v_fields ? 'objective' then v_fields ->> 'objective' else u.objective end,
           kind = case when v_fields ? 'kind' then v_fields ->> 'kind' else u.kind end,
           stage = case when v_fields ? 'stage' then v_fields ->> 'stage' else u.stage end,
           periods = case when v_fields ? 'periods' then (v_fields ->> 'periods')::int else u.periods end,
           week_no = case when v_fields ? 'week_no' then (v_fields ->> 'week_no')::int else u.week_no end
     where u.id = v_unit_id;
  end loop;

  for v_item in
    select e.value from jsonb_array_elements(v_items) as e(value)
     where jsonb_typeof(e.value -> 'unit_id') <> 'string' order by (e.value ->> 'rank')::int
  loop
    v_fields := v_item -> 'fields';
    insert into public.units (chapter_id, unit_no, week_no, kind, title, objective, stage, periods, status)
    values (
      v_pos_ids[(v_item ->> 'pos')::int], (v_item ->> 'rank')::int, (v_fields ->> 'week_no')::int,
      v_fields ->> 'kind', v_fields ->> 'title', v_fields ->> 'objective', v_fields ->> 'stage',
      (v_fields ->> 'periods')::int, 'draft'
    )
    returning id into v_new_id;
    v_created := v_created || v_new_id;
    v_created_units := v_created_units + 1;
    if v_fields ? 'lens' then
      select c.theme_id into v_theme from public.chapters c where c.id = v_pos_ids[(v_item ->> 'pos')::int];
      if v_theme is not null then
        insert into public.theme_units (theme_id, unit_id, lens)
        values (v_theme, v_new_id, v_fields ->> 'lens')
        on conflict (theme_id, unit_id) do nothing;
      end if;
    end if;
  end loop;

  perform private.write_audit(
    'unit_layout_applied', 'schemes', p_scheme_id::text,
    jsonb_build_object('units_created', v_created_units, 'units_updated', v_updated, 'units_moved', v_moved,
                       'units_renumbered', v_renumbered, 'units_archived', v_archived,
                       'chapters_created', v_created_chapters,
                       'versioned_units_renumbered', jsonb_array_length(v_versioned))
  );

  return private.unit_layout_result(
    p_scheme_id, v_created_units, v_updated, v_moved, v_renumbered, v_archived, v_created_chapters,
    v_created, v_created_ch
  );
end;
$$;

-- the shared tail of apply_unit_layout: counts plus the resulting layout (live chapters and units, in order)
create or replace function private.unit_layout_result(
  p_scheme_id uuid,
  p_created int,
  p_updated int,
  p_moved int,
  p_renumbered int,
  p_archived int,
  p_chapters_created int,
  p_created_unit_ids uuid[],
  p_created_chapter_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'chapters', (select count(*) from public.chapters c
                  where c.scheme_id = p_scheme_id and c.deleted_at is null and c.status <> 'archived'),
    'units', (select count(*) from public.units u join public.chapters c on c.id = u.chapter_id
               where c.scheme_id = p_scheme_id and u.deleted_at is null and u.status <> 'archived'),
    'units_created', p_created,
    'units_updated', p_updated,
    'units_moved', p_moved,
    'units_renumbered', p_renumbered,
    'units_archived', p_archived,
    'chapters_created', p_chapters_created,
    'created_unit_ids', to_jsonb(p_created_unit_ids),
    'created_chapter_ids', to_jsonb(p_created_chapter_ids),
    'layout', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'chapter_id', c.id, 'number', c.number, 'title', c.title,
                 'units', coalesce((
                   select jsonb_agg(jsonb_build_object('id', u.id, 'unit_no', u.unit_no) order by u.unit_no)
                     from public.units u
                    where u.chapter_id = c.id and u.deleted_at is null and u.status <> 'archived'
                 ), '[]'::jsonb)
               ) order by c.number)
        from public.chapters c
       where c.scheme_id = p_scheme_id and c.deleted_at is null and c.status <> 'archived'
    ), '[]'::jsonb)
  );
$$;

-- grants -------------------------------------------------------------------------------------------------------------------------
revoke all on function
  private.json_uuid(jsonb),
  private.layout_unit_fields(jsonb, uuid, boolean),
  private.unit_layout_result(uuid, int, int, int, int, int, int, uuid[], uuid[])
  from public, anon, authenticated;

revoke all on function private.apply_unit_layout(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function private.apply_unit_layout(uuid, jsonb, boolean) to authenticated;

create or replace function public.apply_unit_layout(
  p_scheme_id uuid,
  p_layout jsonb,
  p_confirm_renumber boolean default false
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.apply_unit_layout(p_scheme_id, p_layout, p_confirm_renumber); $$;

revoke all on function public.apply_unit_layout(uuid, jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function public.apply_unit_layout(uuid, jsonb, boolean) to authenticated;

comment on function public.apply_unit_layout(uuid, jsonb, boolean) is
  'super_admin, content_editor at aal2. Needs an approved scheme. Sets chapter membership, order and term-wide unit numbers of all live units of the scheme in one atomic call; creates new units (and chapters), archives the units named in "removed" (they must have no version). 3 to 5 units per chapter (chapter_unit_count_invalid); a stale layout is layout_out_of_date; a unit with versions is never edited or removed (unit_has_versions), cannot leave its chapter once published (published_unit_cannot_move), and is renumbered only with p_confirm_renumber (layout_renumbers_versioned_units, DETAIL lists the units). Idempotent. Returns counts, created ids and the resulting layout.';
