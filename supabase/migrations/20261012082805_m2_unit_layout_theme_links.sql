-- 19 M2.4 follow-up to m2_unit_layout (found by pgTAP 120): a unit that changes chapter must not keep its link to the
-- theme of the chapter it left. theme_units links a unit to ITS chapter's theme (with the subject's lens), as
-- apply_chapter_plan writes them; after a move only the link to the new chapter's theme survives. The rest of
-- apply_unit_layout is unchanged (see the header of 20261012081415_m2_unit_layout.sql for the full contract).

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
  v_old_chapter uuid;
  v_n bigint;
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
    select u.chapter_id into v_old_chapter from public.units u where u.id = v_unit_id;
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
    if v_old_chapter is distinct from v_pos_ids[(v_item ->> 'pos')::int] then
      -- a unit that changes chapter keeps only a link to the theme of its NEW chapter (apply_chapter_plan's rule)
      with gone as (delete from public.theme_units tu
         where tu.unit_id = v_unit_id
           and tu.theme_id is distinct from (select c.theme_id from public.chapters c where c.id = v_pos_ids[(v_item ->> 'pos')::int])
        returning 1)
      select count(*) into v_n from gone;
    end if;
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
