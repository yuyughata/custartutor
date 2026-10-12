-- 16 M2 content engine, part 3: the content RPCs of docs/m2-plan.md "The server surface".
--
--   save_scheme_draft, approve_scheme, apply_chapter_plan      scheme and plan workflow
--   create_unit_version_draft, set_unit_version_status         versions and the review workflow
--   get_ai_settings, set_app_setting, get_ai_usage_summary     settings and usage
--
-- Thin SECURITY INVOKER `public.*` wrappers over `private.*` implementations, callable by `authenticated` only, all
-- requiring an admin role at aal2 (`private.has_admin_role`). Stable snake_case messages; SQLSTATE 42501 = not allowed,
-- P0002 = not found, 22023 = bad request / refused state.
--
-- Definer or invoker? The two functions that write `unit_versions` are SECURITY INVOKER implementations ON PURPOSE:
-- the guard trigger `unit_versions_guard_write` lets the owner through, so a definer function would bypass it. As
-- invoker, RLS and the guard stay the last line of defence (new rows start as draft, only reviewer/super_admin
-- approve, approved content is frozen, provenance is immutable). Everything else is a definer implementation
-- because it needs rows or privileges the caller's role does not have (scheme_weeks deletes, the ai_usage ledger, ...).

-- validation helpers (definer-side only: no API role may execute them) ---------------------------------------------------
-- an integer inside [min, max], or NULL
create or replace function private.json_int(p_value jsonb, p_min int, p_max int)
returns int
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'number' and (p_value #>> '{}') ~ '^[0-9]{1,9}$'
    then case when (p_value #>> '{}')::int between p_min and p_max then (p_value #>> '{}')::int end
  end;
$$;

-- a trimmed non-blank string of at most p_max characters, or NULL
create or replace function private.json_text(p_value jsonb, p_max int)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'string'
     and btrim(p_value #>> '{}') <> ''
     and char_length(p_value #>> '{}') <= p_max
    then btrim(p_value #>> '{}')
  end;
$$;

-- a JSON number >= 0 (or > 0 when p_positive)
create or replace function private.json_number_ok(p_value jsonb, p_positive boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'number'
    then case when p_positive then (p_value #>> '{}')::numeric > 0 else (p_value #>> '{}')::numeric >= 0 end
    else false
  end;
$$;

-- one entry of ai.prices: exactly the four non-negative per-million-token prices
create or replace function private.price_entry_ok(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p_value)) <> 4 then
    return false;
  end if;
  return coalesce(
    private.json_number_ok(p_value -> 'input_per_mtok', false)
    and private.json_number_ok(p_value -> 'output_per_mtok', false)
    and private.json_number_ok(p_value -> 'cache_read_per_mtok', false)
    and private.json_number_ok(p_value -> 'cache_write_per_mtok', false),
    false
  );
end;
$$;

-- is p_value an acceptable value for the app_settings key? (mirrors AiSettings in contract.ts)
create or replace function private.app_setting_value_ok(p_key text, p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null then
    return false;
  end if;
  if p_key = 'ai.kill_switch' then
    return jsonb_typeof(p_value) = 'boolean';
  end if;
  if p_key = 'ai.prompt_version' then
    return private.json_text(p_value, 64) is not null;
  end if;
  if p_key is null or p_key not in ('ai.models', 'ai.budget', 'ai.prices', 'ai.effort') then
    return false;
  end if;
  if jsonb_typeof(p_value) is distinct from 'object' then
    return false;
  end if;

  if p_key = 'ai.models' then
    -- exactly the three tasks, each a non-empty model id
    if (select count(*) from jsonb_object_keys(p_value)) <> 3 then
      return false;
    end if;
    return private.json_text(p_value -> 'authoring', 100) is not null
       and private.json_text(p_value -> 'tutor', 100) is not null
       and private.json_text(p_value -> 'moderation', 100) is not null;
  elsif p_key = 'ai.budget' then
    -- both caps present; each null (no cap) or a positive number
    if (select count(*) from jsonb_object_keys(p_value)) <> 2 then
      return false;
    end if;
    return coalesce(
      (jsonb_typeof(p_value -> 'max_usd_per_job') = 'null'
         or private.json_number_ok(p_value -> 'max_usd_per_job', true))
      and (jsonb_typeof(p_value -> 'daily_usd_cap') = 'null'
         or private.json_number_ok(p_value -> 'daily_usd_cap', true)),
      false
    );
  elsif p_key = 'ai.prices' then
    -- model id -> price entry
    return not exists (
      select 1 from jsonb_each(p_value) e
       where btrim(e.key) = '' or not private.price_entry_ok(e.value)
    );
  else
    -- ai.effort: step family -> effort
    return not exists (
      select 1 from jsonb_each(p_value) e
       where btrim(e.key) = ''
          or jsonb_typeof(e.value) is distinct from 'string'
          or (e.value #>> '{}') not in ('low', 'medium', 'high', 'xhigh', 'max')
    );
  end if;
end;
$$;

revoke all on function
  private.json_int(jsonb, int, int),
  private.json_text(jsonb, int),
  private.json_number_ok(jsonb, boolean),
  private.price_entry_ok(jsonb),
  private.app_setting_value_ok(text, jsonb)
  from public, anon, authenticated;

-- save_scheme_draft ------------------------------------------------------------------------------------------------------
-- super_admin, content_editor. Creates or replaces the DRAFT scheme for (subject, level, term); p_weeks is a
-- SchemeWeek[] ({week_no 1..20, kind, topic, subtopics[]}, no duplicate week_no, topics non-blank). A scheme that is
-- approved or archived is never touched (scheme_not_draft). Returns the scheme id.
create or replace function private.save_scheme_draft(
  p_subject_id uuid,
  p_level_code text,
  p_term int,
  p_weeks jsonb,
  p_source_note text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_note text := nullif(btrim(coalesce(p_source_note, '')), '');
  v_scheme public.schemes%rowtype;
  v_week jsonb;
  v_no int;
  v_seen int[] := '{}';
  v_n bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_term is null or p_term not between 1 and 3 then
    raise exception 'invalid_term' using errcode = '22023';
  end if;
  if p_level_code is null or not exists (select 1 from public.levels l where l.code = p_level_code) then
    raise exception 'invalid_level' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'invalid_source_note' using errcode = '22023';
  end if;
  if p_subject_id is null or not exists (select 1 from public.subjects s where s.id = p_subject_id) then
    raise exception 'subject_not_found' using errcode = 'P0002';
  end if;

  if p_weeks is null or jsonb_typeof(p_weeks) is distinct from 'array' then
    raise exception 'invalid_scheme_weeks' using errcode = '22023';
  end if;
  if jsonb_array_length(p_weeks) not between 1 and 20 then
    raise exception 'invalid_scheme_weeks' using errcode = '22023';
  end if;
  for v_week in select e.value from jsonb_array_elements(p_weeks) as e loop
    if jsonb_typeof(v_week) is distinct from 'object' then
      raise exception 'invalid_scheme_weeks' using errcode = '22023';
    end if;
    v_no := private.json_int(v_week -> 'week_no', 1, 20);
    if v_no is null
       or (v_week ->> 'kind') is null
       or (v_week ->> 'kind') not in ('teaching', 'mid_term_exam', 'break', 'revision', 'exam', 'closing')
       or private.json_text(v_week -> 'topic', 500) is null then
      raise exception 'invalid_scheme_weeks' using errcode = '22023';
    end if;
    if v_no = any (v_seen) then
      raise exception 'invalid_scheme_weeks' using errcode = '22023';
    end if;
    v_seen := v_seen || v_no;
    if v_week ? 'subtopics' then
      if jsonb_typeof(v_week -> 'subtopics') is distinct from 'array'
         or exists (
           select 1 from jsonb_array_elements(v_week -> 'subtopics') t
            where private.json_text(t.value, 500) is null
         ) then
        raise exception 'invalid_scheme_weeks' using errcode = '22023';
      end if;
    end if;
  end loop;

  select * into v_scheme
    from public.schemes s
   where s.subject_id = p_subject_id and s.level_code = p_level_code and s.term = p_term
   for update;
  if not found then
    insert into public.schemes (subject_id, level_code, term, status, source_note)
    values (p_subject_id, p_level_code, p_term, 'draft', v_note)
    on conflict (subject_id, level_code, term) do nothing
    returning * into v_scheme;
    if not found then
      -- lost a race with another save: lock the winner's row
      select * into v_scheme
        from public.schemes s
       where s.subject_id = p_subject_id and s.level_code = p_level_code and s.term = p_term
       for update;
    end if;
  end if;
  if v_scheme.status <> 'draft' then
    raise exception 'scheme_not_draft' using errcode = '22023';
  end if;

  if v_scheme.source_note is distinct from v_note then
    update public.schemes s set source_note = v_note where s.id = v_scheme.id;
  end if;

  with gone as (delete from public.scheme_weeks w where w.scheme_id = v_scheme.id returning 1)
  select count(*) into v_n from gone;

  insert into public.scheme_weeks (scheme_id, week_no, kind, topic, subtopics)
  select
    v_scheme.id,
    (e.value ->> 'week_no')::int,
    e.value ->> 'kind',
    btrim(e.value ->> 'topic'),
    coalesce(
      array(
        select btrim(t.value #>> '{}')
          from jsonb_array_elements(coalesce(e.value -> 'subtopics', '[]'::jsonb)) with ordinality as t(value, n)
         order by t.n
      ),
      '{}'
    )
  from jsonb_array_elements(p_weeks) as e;

  return v_scheme.id;
end;
$$;

-- approve_scheme ----------------------------------------------------------------------------------------------------------
-- super_admin, reviewer. draft -> approved; the scheme needs at least one teaching week. Approving an approved scheme
-- is a no-op (a double click); an archived scheme raises scheme_not_draft. Audited.
create or replace function private.approve_scheme(p_scheme_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_scheme public.schemes%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'reviewer']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;

  select * into v_scheme from public.schemes s where s.id = p_scheme_id for update;
  if not found then
    raise exception 'scheme_not_found' using errcode = 'P0002';
  end if;
  if v_scheme.status = 'approved' then
    return;
  end if;
  if v_scheme.status <> 'draft' then
    raise exception 'scheme_not_draft' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.scheme_weeks w where w.scheme_id = v_scheme.id and w.kind = 'teaching'
  ) then
    raise exception 'scheme_has_no_teaching_weeks' using errcode = '22023';
  end if;

  update public.schemes s set status = 'approved' where s.id = v_scheme.id;
  perform private.write_audit(
    'scheme_approved', 'schemes', v_scheme.id::text,
    jsonb_build_object('subject_id', v_scheme.subject_id, 'level_code', v_scheme.level_code, 'term', v_scheme.term)
  );
end;
$$;

-- apply_chapter_plan ------------------------------------------------------------------------------------------------------
-- super_admin, content_editor. Needs an approved scheme. p_plan is a ChapterPlan ({chapters: [{chapter_no, title,
-- theme?: {title, lens}, units: [{unit_no, week_no, kind, title, objective, stage, stage_to?, periods}]}]}). Creates
-- chapters and units as DRAFT, 3 to 5 units per chapter (chapter_unit_count_invalid), unit_no unique over the whole plan
-- (the term ordinal), every week_no a week of the scheme. A chapter theme becomes a `themes` row (found by term and
-- title) and a `theme_units` link per unit carrying the lens. `stage_to` is validated but not stored (units has no
-- column for it; it lives in the content header).
-- Re-applying is idempotent: an unchanged plan changes nothing (no rows touched, no sync_seq drawn). A changed unit
-- that has NO version yet is updated in place; one that has a version is never touched (unit_has_versions). Units and
-- chapters that the plan no longer contains are removed when they have no version, else unit_has_versions.
-- Returns {chapters, units, chapters_created, units_created, units_updated, units_removed, chapters_removed}.
create or replace function private.apply_chapter_plan(p_scheme_id uuid, p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_scheme public.schemes%rowtype;
  v_ch jsonb;
  v_un jsonb;
  v_theme jsonb;
  v_chapter public.chapters%rowtype;
  v_unit public.units%rowtype;
  v_chapter_nos int[] := '{}';
  v_unit_nos int[] := '{}';
  v_chapter_no int;
  v_unit_no int;
  v_title text;
  v_theme_title text;
  v_theme_lens text;
  v_theme_id uuid;
  v_week int;
  v_kind text;
  v_objective text;
  v_stage text;
  v_stage_to text;
  v_periods int;
  v_n bigint;
  v_plan_units int := 0;
  v_chapters_created int := 0;
  v_units_created int := 0;
  v_units_updated int := 0;
  v_units_removed int := 0;
  v_chapters_removed int := 0;
  v_stages constant text[] := array['absorb', 'connect', 'express'];
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

  -- 1. validate the whole plan before touching anything
  if p_plan is null or jsonb_typeof(p_plan) is distinct from 'object'
     or jsonb_typeof(p_plan -> 'chapters') is distinct from 'array' then
    raise exception 'invalid_chapter_plan' using errcode = '22023';
  end if;
  if jsonb_array_length(p_plan -> 'chapters') not between 1 and 50 then
    raise exception 'invalid_chapter_plan' using errcode = '22023';
  end if;

  for v_ch in select e.value from jsonb_array_elements(p_plan -> 'chapters') as e loop
    if jsonb_typeof(v_ch) is distinct from 'object' then
      raise exception 'invalid_chapter_plan' using errcode = '22023';
    end if;
    v_chapter_no := private.json_int(v_ch -> 'chapter_no', 1, 999);
    if v_chapter_no is null
       or private.json_text(v_ch -> 'title', 200) is null
       or jsonb_typeof(v_ch -> 'units') is distinct from 'array' then
      raise exception 'invalid_chapter_plan' using errcode = '22023';
    end if;
    if v_chapter_no = any (v_chapter_nos) then
      raise exception 'duplicate_chapter_no' using errcode = '22023';
    end if;
    v_chapter_nos := v_chapter_nos || v_chapter_no;
    if jsonb_array_length(v_ch -> 'units') not between 3 and 5 then
      raise exception 'chapter_unit_count_invalid' using errcode = '22023';
    end if;
    if jsonb_typeof(v_ch -> 'theme') is not null and jsonb_typeof(v_ch -> 'theme') <> 'null' then
      if jsonb_typeof(v_ch -> 'theme') <> 'object'
         or private.json_text(v_ch -> 'theme' -> 'title', 200) is null
         or private.json_text(v_ch -> 'theme' -> 'lens', 200) is null then
        raise exception 'invalid_chapter_plan' using errcode = '22023';
      end if;
    end if;

    for v_un in select e.value from jsonb_array_elements(v_ch -> 'units') as e loop
      if jsonb_typeof(v_un) is distinct from 'object' then
        raise exception 'invalid_chapter_plan' using errcode = '22023';
      end if;
      v_unit_no := private.json_int(v_un -> 'unit_no', 1, 9999);
      v_week := private.json_int(v_un -> 'week_no', 1, 15);
      v_stage := v_un ->> 'stage';
      v_stage_to := case when jsonb_typeof(v_un -> 'stage_to') = 'string' then v_un ->> 'stage_to' end;
      if v_unit_no is null
         or v_week is null
         or private.json_int(v_un -> 'periods', 1, 10) is null
         or private.json_text(v_un -> 'title', 200) is null
         or private.json_text(v_un -> 'objective', 2000) is null
         or (v_un ->> 'kind') is null
         or (v_un ->> 'kind') not in ('lesson', 'mini_project', 'term_project', 'revision', 'assessment')
         or v_stage is null
         or v_stage <> all (v_stages)
         or (jsonb_typeof(v_un -> 'stage_to') is not null
             and jsonb_typeof(v_un -> 'stage_to') <> 'null'
             and (v_stage_to is null or v_stage_to <> all (v_stages)
                  or array_position(v_stages, v_stage_to) < array_position(v_stages, v_stage))) then
        raise exception 'invalid_chapter_plan' using errcode = '22023';
      end if;
      if v_unit_no = any (v_unit_nos) then
        raise exception 'duplicate_unit_no' using errcode = '22023';
      end if;
      v_unit_nos := v_unit_nos || v_unit_no;
      if not exists (
        select 1 from public.scheme_weeks w where w.scheme_id = v_scheme.id and w.week_no = v_week
      ) then
        raise exception 'unknown_scheme_week' using errcode = '22023';
      end if;
      v_plan_units := v_plan_units + 1;
    end loop;
  end loop;

  -- 2. create or update, chapter by chapter in plan order
  for v_ch in
    select e.value from jsonb_array_elements(p_plan -> 'chapters') with ordinality as e(value, n) order by e.n
  loop
    v_chapter_no := (v_ch ->> 'chapter_no')::int;
    v_title := btrim(v_ch ->> 'title');
    v_theme := case when jsonb_typeof(v_ch -> 'theme') = 'object' then v_ch -> 'theme' end;
    v_theme_id := null;
    if v_theme is not null then
      v_theme_title := btrim(v_theme ->> 'title');
      v_theme_lens := btrim(v_theme ->> 'lens');
      -- themes have no unique key: serialise find-or-create per (term, title)
      perform pg_advisory_xact_lock(hashtextextended('theme:' || v_scheme.term::text || ':' || v_theme_title, 0));
      select t.id into v_theme_id
        from public.themes t
       where t.term = v_scheme.term and t.title = v_theme_title
       order by t.created_at, t.id
       limit 1;
      if v_theme_id is null then
        insert into public.themes (term, title) values (v_scheme.term, v_theme_title)
        returning id into v_theme_id;
      end if;
    end if;

    select * into v_chapter
      from public.chapters c
     where c.scheme_id = v_scheme.id and c.number = v_chapter_no
     for update;
    if not found then
      insert into public.chapters (scheme_id, number, title, theme_id, status)
      values (v_scheme.id, v_chapter_no, v_title, v_theme_id, 'draft')
      returning * into v_chapter;
      v_chapters_created := v_chapters_created + 1;
    elsif v_chapter.title is distinct from v_title or v_chapter.theme_id is distinct from v_theme_id then
      if v_chapter.title is distinct from v_title and v_chapter.status <> 'draft' then
        raise exception 'chapter_not_draft' using errcode = '22023';
      end if;
      update public.chapters c set title = v_title, theme_id = v_theme_id
       where c.id = v_chapter.id
      returning * into v_chapter;
    end if;

    for v_un in
      select e.value from jsonb_array_elements(v_ch -> 'units') with ordinality as e(value, n) order by e.n
    loop
      v_unit_no := (v_un ->> 'unit_no')::int;
      v_week := (v_un ->> 'week_no')::int;
      v_kind := v_un ->> 'kind';
      v_objective := btrim(v_un ->> 'objective');
      v_stage := v_un ->> 'stage';
      v_periods := (v_un ->> 'periods')::int;
      v_title := btrim(v_un ->> 'title');

      select * into v_unit
        from public.units u
       where u.chapter_id = v_chapter.id and u.unit_no = v_unit_no
       for update;
      if not found then
        insert into public.units (chapter_id, unit_no, week_no, kind, title, objective, stage, periods, status)
        values (v_chapter.id, v_unit_no, v_week, v_kind, v_title, v_objective, v_stage, v_periods, 'draft')
        returning * into v_unit;
        v_units_created := v_units_created + 1;
      elsif (v_unit.week_no, v_unit.kind, v_unit.title, v_unit.objective, v_unit.stage, v_unit.periods)
            is distinct from (v_week, v_kind, v_title, v_objective, v_stage, v_periods) then
        if exists (select 1 from public.unit_versions uv where uv.unit_id = v_unit.id) then
          raise exception 'unit_has_versions' using errcode = '22023';
        end if;
        update public.units u
           set week_no = v_week, kind = v_kind, title = v_title, objective = v_objective,
               stage = v_stage, periods = v_periods
         where u.id = v_unit.id
        returning * into v_unit;
        v_units_updated := v_units_updated + 1;
      end if;

      if v_theme_id is not null then
        insert into public.theme_units (theme_id, unit_id, lens)
        values (v_theme_id, v_unit.id, v_theme_lens)
        on conflict (theme_id, unit_id) do update set lens = excluded.lens
          where public.theme_units.lens is distinct from excluded.lens;
      end if;
      with gone as (delete from public.theme_units tu where tu.unit_id = v_unit.id and tu.theme_id is distinct from v_theme_id returning 1)
      select count(*) into v_n from gone;
    end loop;
  end loop;

  -- 3. what the plan no longer contains: units without a version go, units with one block the apply
  for v_unit in
    select u.*
      from public.units u
      join public.chapters c on c.id = u.chapter_id
     where c.scheme_id = v_scheme.id
       and not exists (
         select 1
           from jsonb_array_elements(p_plan -> 'chapters') as pc,
                jsonb_array_elements(pc.value -> 'units') as pu
          where (pc.value ->> 'chapter_no')::int = c.number
            and (pu.value ->> 'unit_no')::int = u.unit_no
       )
     order by c.number, u.unit_no
       for update of u
  loop
    if exists (select 1 from public.unit_versions uv where uv.unit_id = v_unit.id) then
      raise exception 'unit_has_versions' using errcode = '22023';
    end if;
    with gone as (delete from public.units x where x.id = v_unit.id returning 1)
    select count(*) into v_n from gone;
    v_units_removed := v_units_removed + 1;
  end loop;

  for v_chapter in
    select c.*
      from public.chapters c
     where c.scheme_id = v_scheme.id and c.number <> all (v_chapter_nos)
     order by c.number
       for update of c
  loop
    if exists (select 1 from public.units u where u.chapter_id = v_chapter.id) then
      raise exception 'unit_has_versions' using errcode = '22023';
    end if;
    with gone as (delete from public.chapters x where x.id = v_chapter.id returning 1)
    select count(*) into v_n from gone;
    v_chapters_removed := v_chapters_removed + 1;
  end loop;

  perform private.write_audit(
    'chapter_plan_applied', 'schemes', v_scheme.id::text,
    jsonb_build_object('chapters', cardinality(v_chapter_nos), 'units', v_plan_units,
                       'chapters_created', v_chapters_created, 'units_created', v_units_created,
                       'units_updated', v_units_updated, 'units_removed', v_units_removed,
                       'chapters_removed', v_chapters_removed)
  );

  return jsonb_build_object(
    'chapters', cardinality(v_chapter_nos),
    'units', v_plan_units,
    'chapters_created', v_chapters_created,
    'units_created', v_units_created,
    'units_updated', v_units_updated,
    'units_removed', v_units_removed,
    'chapters_removed', v_chapters_removed
  );
end;
$$;

-- create_unit_version_draft (SECURITY INVOKER: RLS and the unit_versions guard trigger stay in force) ------------------------
-- super_admin, content_editor. Inserts the next `unit_versions` row of the unit as a DRAFT (whoever wrote it, an AI
-- draft never starts in any other state) and returns {id, version}. The unit row is locked for the numbering, so
-- concurrent saves get 1, 2, ... in order. p_base_version_id must be the unit's latest version, or null for the first
-- one; anything else is `stale_base` (somebody saved in between). An AI draft must name its model and prompt version.
-- The content check is cheap (an object with schema_version and header); the Zod parse is the engine's and the
-- client's job.
create or replace function private.create_unit_version_draft(
  p_unit_id uuid,
  p_content jsonb,
  p_lint_report jsonb,
  p_generated_by text,
  p_model text,
  p_prompt_version text,
  p_base_version_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_prompt text := nullif(btrim(coalesce(p_prompt_version, '')), '');
  v_unit public.units%rowtype;
  v_latest public.unit_versions%rowtype;
  v_has_latest boolean;
  v_version int;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_generated_by is null or p_generated_by not in ('ai', 'human') then
    raise exception 'invalid_generated_by' using errcode = '22023';
  end if;
  if p_content is null or jsonb_typeof(p_content) is distinct from 'object'
     or jsonb_typeof(p_content -> 'header') is distinct from 'object'
     or jsonb_typeof(p_content -> 'schema_version') is distinct from 'number'
     or (p_content ->> 'schema_version') !~ '^[0-9]{1,6}$' then
    raise exception 'invalid_unit_content' using errcode = '22023';
  end if;
  if (p_content ->> 'schema_version')::int < 1 then
    raise exception 'invalid_unit_content' using errcode = '22023';
  end if;
  if octet_length(p_content::text) > 5000000 then
    raise exception 'unit_content_too_large' using errcode = '22023';
  end if;
  if p_lint_report is not null and jsonb_typeof(p_lint_report) is distinct from 'object' then
    raise exception 'invalid_lint_report' using errcode = '22023';
  end if;
  if p_generated_by = 'ai' and (v_model is null or v_prompt is null) then
    raise exception 'invalid_ai_provenance' using errcode = '22023';
  end if;

  select * into v_unit from public.units u where u.id = p_unit_id for update;
  if not found then
    raise exception 'unit_not_found' using errcode = 'P0002';
  end if;
  if v_unit.deleted_at is not null or v_unit.status = 'archived' then
    raise exception 'unit_not_editable' using errcode = '22023';
  end if;

  select * into v_latest
    from public.unit_versions v
   where v.unit_id = p_unit_id
   order by v.version desc
   limit 1;
  v_has_latest := found;
  if v_has_latest then
    if p_base_version_id is distinct from v_latest.id then
      raise exception 'stale_base' using errcode = '22023';
    end if;
  elsif p_base_version_id is not null then
    raise exception 'stale_base' using errcode = '22023';
  end if;
  v_version := case when v_has_latest then v_latest.version + 1 else 1 end;

  insert into public.unit_versions
    (unit_id, version, schema_version, content, status, generated_by, model, prompt_version,
     lint_report, base_version_id, created_by)
  values
    (p_unit_id, v_version, (p_content ->> 'schema_version')::int, p_content, 'draft', p_generated_by,
     v_model, v_prompt, p_lint_report, p_base_version_id, v_uid)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'version', v_version);
end;
$$;

-- set_unit_version_status (SECURITY INVOKER, like the one above: the guard trigger is the last line of defence) -------------
-- draft -> in_review: super_admin, content_editor, reviewer. in_review -> approved and in_review -> draft:
-- reviewer, super_admin (reviewer_required for anyone else). Every other move, including a repeat of the current
-- status, raises illegal_status_move; publishing stays with publish_unit_version.
create or replace function private.set_unit_version_status(p_unit_version_id uuid, p_status text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ver public.unit_versions%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('draft', 'in_review', 'approved', 'published', 'superseded') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_ver from public.unit_versions v where v.id = p_unit_version_id for update;
  if not found then
    raise exception 'unit_version_not_found' using errcode = 'P0002';
  end if;

  if v_ver.status = 'draft' and p_status = 'in_review' then
    null; -- any content staff may submit for review
  elsif v_ver.status = 'in_review' and p_status in ('approved', 'draft') then
    if not private.has_admin_role(array['super_admin', 'reviewer']) then
      raise exception 'reviewer_required' using errcode = '42501';
    end if;
  else
    raise exception 'illegal_status_move' using errcode = '22023';
  end if;

  update public.unit_versions v set status = p_status where v.id = v_ver.id;
end;
$$;

-- get_ai_settings ----------------------------------------------------------------------------------------------------------
-- Content staff. The assembled AiSettings (contract.ts) with the defaults for keys that were never set.
create or replace function private.get_ai_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  return private.ai_settings_json();
end;
$$;

-- set_app_setting ----------------------------------------------------------------------------------------------------------
-- super_admin. Upserts one key after validating its shape (invalid_setting_key / invalid_setting_value); an unchanged
-- value writes nothing. The audit trigger on app_settings records old and new value.
create or replace function private.set_app_setting(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_key is null
     or p_key not in ('ai.models', 'ai.kill_switch', 'ai.budget', 'ai.prices', 'ai.effort', 'ai.prompt_version') then
    raise exception 'invalid_setting_key' using errcode = '22023';
  end if;
  if not private.app_setting_value_ok(p_key, p_value) then
    raise exception 'invalid_setting_value' using errcode = '22023';
  end if;

  insert into public.app_settings as s (key, value, updated_by)
  values (p_key, p_value, v_uid)
  on conflict (key) do update
    set value = excluded.value, updated_by = excluded.updated_by
    where s.value is distinct from excluded.value;
end;
$$;

-- get_ai_usage_summary --------------------------------------------------------------------------------------------------------
-- super_admin, content_editor, analyst. Usage and jobs created in [p_from, p_to) (at most 366 days; invalid_range):
--   {totals, by_day, by_model, by_kind}
-- Each usage aggregate has calls, the four token sums, est_cost_usd (the sum of KNOWN costs; NULL when no call in
-- the group has a price) and unpriced_calls. `totals` also carries jobs: {queued, running, succeeded, failed,
-- cancelled}. by_day (UTC days) and by_model are ordered; by_kind lists the four job kinds, each with its jobs by status.
create or replace function private.get_ai_usage_summary(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_totals jsonb;
  v_jobs jsonb;
  v_by_day jsonb;
  v_by_model jsonb;
  v_by_kind jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor', 'analyst']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  select jsonb_build_object(
           'calls', count(*),
           'input_tokens', coalesce(sum(u.input_tokens), 0),
           'output_tokens', coalesce(sum(u.output_tokens), 0),
           'cache_read_tokens', coalesce(sum(u.cache_read_tokens), 0),
           'cache_creation_tokens', coalesce(sum(u.cache_creation_tokens), 0),
           'est_cost_usd', sum(u.est_cost_usd),
           'unpriced_calls', count(*) filter (where u.est_cost_usd is null)
         )
    into v_totals
    from public.ai_usage u
   where u.created_at >= p_from and u.created_at < p_to;

  select jsonb_object_agg(st.status, coalesce(c.n, 0))
    into v_jobs
    from unnest(array['queued', 'running', 'succeeded', 'failed', 'cancelled']) as st(status)
    left join (
      select j.status, count(*) as n
        from public.ai_jobs j
       where j.created_at >= p_from and j.created_at < p_to
       group by j.status
    ) c on c.status = st.status;

  select coalesce(jsonb_agg(d.row order by d.day), '[]'::jsonb)
    into v_by_day
    from (
      select (u.created_at at time zone 'utc')::date as day,
             jsonb_build_object(
               'day', to_char((u.created_at at time zone 'utc')::date, 'YYYY-MM-DD'),
               'calls', count(*),
               'input_tokens', coalesce(sum(u.input_tokens), 0),
               'output_tokens', coalesce(sum(u.output_tokens), 0),
               'cache_read_tokens', coalesce(sum(u.cache_read_tokens), 0),
               'cache_creation_tokens', coalesce(sum(u.cache_creation_tokens), 0),
               'est_cost_usd', sum(u.est_cost_usd),
               'unpriced_calls', count(*) filter (where u.est_cost_usd is null)
             ) as row
        from public.ai_usage u
       where u.created_at >= p_from and u.created_at < p_to
       group by (u.created_at at time zone 'utc')::date
    ) d;

  select coalesce(jsonb_agg(m.row order by m.model), '[]'::jsonb)
    into v_by_model
    from (
      select u.model,
             jsonb_build_object(
               'model', u.model,
               'calls', count(*),
               'input_tokens', coalesce(sum(u.input_tokens), 0),
               'output_tokens', coalesce(sum(u.output_tokens), 0),
               'cache_read_tokens', coalesce(sum(u.cache_read_tokens), 0),
               'cache_creation_tokens', coalesce(sum(u.cache_creation_tokens), 0),
               'est_cost_usd', sum(u.est_cost_usd),
               'unpriced_calls', count(*) filter (where u.est_cost_usd is null)
             ) as row
        from public.ai_usage u
       where u.created_at >= p_from and u.created_at < p_to
       group by u.model
    ) m;

  select jsonb_agg(
           jsonb_build_object(
             'kind', k.kind,
             'calls', coalesce(a.calls, 0),
             'input_tokens', coalesce(a.input_tokens, 0),
             'output_tokens', coalesce(a.output_tokens, 0),
             'cache_read_tokens', coalesce(a.cache_read_tokens, 0),
             'cache_creation_tokens', coalesce(a.cache_creation_tokens, 0),
             'est_cost_usd', a.est_cost_usd,
             'unpriced_calls', coalesce(a.unpriced_calls, 0),
             'jobs', (
               select jsonb_object_agg(
                        st.status,
                        (select count(*) from public.ai_jobs j
                          where j.kind = k.kind and j.status = st.status
                            and j.created_at >= p_from and j.created_at < p_to)
                      )
                 from unnest(array['queued', 'running', 'succeeded', 'failed', 'cancelled']) as st(status)
             )
           )
           order by k.ord
         )
    into v_by_kind
    from unnest(array['scheme_ingest', 'chapter_plan', 'unit_generate', 'unit_revise'])
         with ordinality as k(kind, ord)
    left join (
      select j.kind,
             count(*) as calls,
             coalesce(sum(u.input_tokens), 0) as input_tokens,
             coalesce(sum(u.output_tokens), 0) as output_tokens,
             coalesce(sum(u.cache_read_tokens), 0) as cache_read_tokens,
             coalesce(sum(u.cache_creation_tokens), 0) as cache_creation_tokens,
             sum(u.est_cost_usd) as est_cost_usd,
             count(*) filter (where u.est_cost_usd is null) as unpriced_calls
        from public.ai_usage u
        join public.ai_jobs j on j.id = u.job_id
       where u.created_at >= p_from and u.created_at < p_to
       group by j.kind
    ) a on a.kind = k.kind;

  return jsonb_build_object(
    'totals', v_totals || jsonb_build_object('jobs', v_jobs),
    'by_day', v_by_day,
    'by_model', v_by_model,
    'by_kind', v_by_kind
  );
end;
$$;

-- grants: private implementations --------------------------------------------------------------------------------------------
revoke all on function
  private.save_scheme_draft(uuid, text, int, jsonb, text),
  private.approve_scheme(uuid),
  private.apply_chapter_plan(uuid, jsonb),
  private.create_unit_version_draft(uuid, jsonb, jsonb, text, text, text, uuid),
  private.set_unit_version_status(uuid, text),
  private.get_ai_settings(),
  private.set_app_setting(text, jsonb),
  private.get_ai_usage_summary(timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function
  private.save_scheme_draft(uuid, text, int, jsonb, text),
  private.approve_scheme(uuid),
  private.apply_chapter_plan(uuid, jsonb),
  private.create_unit_version_draft(uuid, jsonb, jsonb, text, text, text, uuid),
  private.set_unit_version_status(uuid, text),
  private.get_ai_settings(),
  private.set_app_setting(text, jsonb),
  private.get_ai_usage_summary(timestamptz, timestamptz)
  to authenticated;

-- public wrappers (SECURITY INVOKER) -------------------------------------------------------------------------------------------
create or replace function public.save_scheme_draft(
  p_subject_id uuid,
  p_level_code text,
  p_term int,
  p_weeks jsonb,
  p_source_note text
)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.save_scheme_draft(p_subject_id, p_level_code, p_term, p_weeks, p_source_note); $$;

create or replace function public.approve_scheme(p_scheme_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$ select private.approve_scheme(p_scheme_id); $$;

create or replace function public.apply_chapter_plan(p_scheme_id uuid, p_plan jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.apply_chapter_plan(p_scheme_id, p_plan); $$;

create or replace function public.create_unit_version_draft(
  p_unit_id uuid,
  p_content jsonb,
  p_lint_report jsonb,
  p_generated_by text,
  p_model text,
  p_prompt_version text,
  p_base_version_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.create_unit_version_draft(
    p_unit_id, p_content, p_lint_report, p_generated_by, p_model, p_prompt_version, p_base_version_id
  );
$$;

create or replace function public.set_unit_version_status(p_unit_version_id uuid, p_status text)
returns void
language sql
security invoker
set search_path = ''
as $$ select private.set_unit_version_status(p_unit_version_id, p_status); $$;

create or replace function public.get_ai_settings()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.get_ai_settings(); $$;

create or replace function public.set_app_setting(p_key text, p_value jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$ select private.set_app_setting(p_key, p_value); $$;

create or replace function public.get_ai_usage_summary(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.get_ai_usage_summary(p_from, p_to); $$;

revoke all on function
  public.save_scheme_draft(uuid, text, int, jsonb, text),
  public.approve_scheme(uuid),
  public.apply_chapter_plan(uuid, jsonb),
  public.create_unit_version_draft(uuid, jsonb, jsonb, text, text, text, uuid),
  public.set_unit_version_status(uuid, text),
  public.get_ai_settings(),
  public.set_app_setting(text, jsonb),
  public.get_ai_usage_summary(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function
  public.save_scheme_draft(uuid, text, int, jsonb, text),
  public.approve_scheme(uuid),
  public.apply_chapter_plan(uuid, jsonb),
  public.create_unit_version_draft(uuid, jsonb, jsonb, text, text, text, uuid),
  public.set_unit_version_status(uuid, text),
  public.get_ai_settings(),
  public.set_app_setting(text, jsonb),
  public.get_ai_usage_summary(timestamptz, timestamptz)
  to authenticated;

comment on function public.save_scheme_draft(uuid, text, int, jsonb, text) is
  'super_admin, content_editor at aal2. Creates or replaces the DRAFT scheme for (subject, level, term) with p_weeks (SchemeWeek[], validated: invalid_scheme_weeks). scheme_not_draft when the scheme is approved or archived. Returns the scheme id.';
comment on function public.approve_scheme(uuid) is
  'super_admin, reviewer at aal2. draft -> approved (needs a teaching week: scheme_has_no_teaching_weeks); approving an approved scheme is a no-op. Audited.';
comment on function public.apply_chapter_plan(uuid, jsonb) is
  'super_admin, content_editor at aal2. Needs an approved scheme. Creates/updates chapters and units (draft) from a ChapterPlan: 3-5 units per chapter, idempotent for an unchanged plan, never touches a unit that has a version (unit_has_versions). Returns {chapters, units, chapters_created, units_created, units_updated, units_removed, chapters_removed}.';
comment on function public.create_unit_version_draft(uuid, jsonb, jsonb, text, text, text, uuid) is
  'super_admin, content_editor at aal2 (SECURITY INVOKER chain: RLS and the guard trigger apply). Inserts the next unit_versions row as a draft and returns {id, version}. stale_base unless p_base_version_id is the latest version (null for the first).';
comment on function public.set_unit_version_status(uuid, text) is
  'Content staff at aal2. draft -> in_review (any); in_review -> approved | draft (reviewer, super_admin). Anything else: illegal_status_move.';
comment on function public.get_ai_settings() is
  'Content staff at aal2. The assembled AiSettings with defaults for missing keys.';
comment on function public.set_app_setting(text, jsonb) is
  'super_admin at aal2. Upserts one ai.* key after validating its shape (invalid_setting_key / invalid_setting_value). Audited.';
comment on function public.get_ai_usage_summary(timestamptz, timestamptz) is
  'super_admin, content_editor, analyst at aal2. {totals, by_day, by_model, by_kind} over [p_from, p_to): calls, tokens, estimated cost (NULL when unpriced) and jobs by status.';
