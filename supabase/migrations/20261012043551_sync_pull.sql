-- 14 sync_pull: one page of changes for the learner app (wire.ts PullResponse).
--
-- Scope: the caller's PRIMARY guardian household = their earliest active guardian membership. Without one the
-- caller gets epoch 0, household null and only the global curriculum rows (subjects, units, published).
-- Rows (merged across tables in ascending sync_seq, at most p_limit in total, p_limit clamped to 1..500):
--   children       the household's children (soft-deleted ones as tombstones)
--   subjects       all subjects (deleted or inactive ones as tombstones)
--   units          FLATTENED (chapter + scheme fields); only units that have, or once had, a built pack. A unit
--                  with no serving pack is a tombstone. Its sync_seq advances with its chapter / scheme /
--                  published rows (triggers in 20261012042817_sync_cursor_and_epoch.sql)
--   published      built pack rows (pack_manifest_path is not null); a row that no longer SERVES (superseded
--                  once a newer version is built, or unpublished) is emitted as a tombstone
--   unit_progress  the household's live children's derived progress
--
-- Cursor safety: this function is STABLE, so every statement in it (and in private.pack_is_serving) uses the one
-- snapshot of the calling statement. Together with the serialised sync_seq assignment (writers draw sync_seq
-- in commit order, see the sync_cursor_and_epoch migration) a page can never contain sync_seq N+1 without N.
-- next_seq is the greatest sync_seq in the page (the input cursor when the page is empty); has_more is true
-- when rows beyond next_seq exist.
--
-- This is SECURITY DEFINER and builds the household scope by hand (RLS-equivalent): it reads only the caller's
-- household, never a client-supplied id.

-- ISO 8601 UTC with milliseconds, exactly the shape of JavaScript's Date.toISOString()
create or replace function private.iso(p_ts timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

revoke all on function private.iso(timestamptz) from public, anon, authenticated;

create or replace function private.sync_pull(p_since_seq bigint, p_limit int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_since bigint := p_since_seq;
  v_limit int;
  v_hid uuid;
  v_hname text;
  v_epoch int;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_since_seq is null or p_since_seq < 0 then
    raise exception 'invalid_cursor' using errcode = '22023';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 200), 1), 500);

  select m.household_id, h.name, h.membership_epoch
    into v_hid, v_hname, v_epoch
    from public.household_members m
    join public.households h on h.id = m.household_id
   where m.user_id = v_uid
     and m.role = 'guardian'
     and m.status = 'active'
     and m.deleted_at is null
   order by m.created_at, m.household_id
   limit 1;

  with
  ch as (
    select c.sync_seq, 'children'::text as src,
           jsonb_build_object(
             'id', c.id, 'household_id', c.household_id, 'display_alias', c.display_alias,
             'avatar', c.avatar, 'level_code', c.level_code, 'reading_mode', c.reading_mode,
             'daily_limit_min', c.daily_limit_min, 'sync_seq', c.sync_seq,
             'deleted_at', private.iso(c.deleted_at)
           ) as obj
      from public.children c
     where v_hid is not null and c.household_id = v_hid and c.sync_seq > v_since
     order by c.sync_seq
     limit v_limit + 1
  ),
  su as (
    select s.sync_seq, 'subjects'::text as src,
           jsonb_build_object(
             'id', s.id, 'slug', s.slug, 'name', s.name, 'kind', s.kind,
             'curriculum_source', s.curriculum_source, 'icon', s.icon, 'colour', s.colour,
             'sort', s.sort, 'sync_seq', s.sync_seq,
             -- an inactive subject disappears from the app like a deleted one
             'deleted_at', private.iso(case when s.deleted_at is not null then s.deleted_at
                                            when not s.active then now() end)
           ) as obj
      from public.subjects s
     where s.sync_seq > v_since
     order by s.sync_seq
     limit v_limit + 1
  ),
  un as (
    select u.sync_seq, 'units'::text as src,
           jsonb_build_object(
             'id', u.id, 'subject_id', sc.subject_id, 'chapter_number', cp.number,
             'chapter_title', cp.title, 'unit_no', u.unit_no, 'week_no', u.week_no, 'kind', u.kind,
             'title', u.title, 'objective', u.objective, 'stage', u.stage,
             'level_code', sc.level_code, 'term', sc.term, 'sync_seq', u.sync_seq,
             'deleted_at', private.iso(
               case when u.deleted_at is null and cp.deleted_at is null
                         and exists (select 1 from public.published_units p
                                      where p.unit_id = u.id and p.pack_manifest_path is not null
                                        and private.pack_is_serving(p.unit_id, p.version_no))
                    then null
                    else coalesce(u.deleted_at, cp.deleted_at, now()) end)
           ) as obj
      from public.units u
      join public.chapters cp on cp.id = u.chapter_id
      join public.schemes sc on sc.id = cp.scheme_id
     where u.sync_seq > v_since
       and exists (select 1 from public.published_units p
                    where p.unit_id = u.id and p.pack_manifest_path is not null)
     order by u.sync_seq
     limit v_limit + 1
  ),
  pu as (
    select p.sync_seq, 'published'::text as src,
           jsonb_build_object(
             'unit_id', p.unit_id, 'version_no', p.version_no, 'schema_version', p.schema_version,
             'min_app_version', p.min_app_version, 'content_hash', p.content_hash,
             'pack_manifest_path', p.pack_manifest_path, 'sync_seq', p.sync_seq,
             'deleted_at', private.iso(
               case when private.pack_is_serving(p.unit_id, p.version_no) then null
                    else coalesce(p.deleted_at, now()) end)
           ) as obj
      from public.published_units p
     where p.pack_manifest_path is not null and p.sync_seq > v_since
     order by p.sync_seq
     limit v_limit + 1
  ),
  up as (
    select p.sync_seq, 'unit_progress'::text as src,
           jsonb_build_object(
             'child_id', p.child_id, 'unit_id', p.unit_id, 'status', p.status,
             'mastery_score', p.mastery_score, 'attempts', p.attempts, 'last_section', p.last_section,
             'updated_at', private.iso(p.updated_at), 'sync_seq', p.sync_seq,
             'deleted_at', private.iso(p.deleted_at)
           ) as obj
      from public.unit_progress p
      join public.children c on c.id = p.child_id and c.deleted_at is null
     where v_hid is not null and p.household_id = v_hid and p.sync_seq > v_since
     order by p.sync_seq
     limit v_limit + 1
  ),
  merged as (
    select * from ch
    union all select * from su
    union all select * from un
    union all select * from pu
    union all select * from up
  ),
  pg as (
    select m.*, row_number() over (order by m.sync_seq) as rn
      from (select * from merged order by sync_seq limit v_limit + 1) m
  )
  select jsonb_build_object(
           'epoch', coalesce(v_epoch, 0),
           'next_seq', coalesce(max(pg.sync_seq) filter (where pg.rn <= v_limit), v_since),
           'has_more', count(*) > v_limit,
           'server_time', private.iso(now()),
           'household', case when v_hid is null then null
                             else jsonb_build_object('id', v_hid, 'name', v_hname) end,
           'children', coalesce(jsonb_agg(pg.obj order by pg.sync_seq)
                                  filter (where pg.src = 'children' and pg.rn <= v_limit), '[]'::jsonb),
           'subjects', coalesce(jsonb_agg(pg.obj order by pg.sync_seq)
                                  filter (where pg.src = 'subjects' and pg.rn <= v_limit), '[]'::jsonb),
           'units', coalesce(jsonb_agg(pg.obj order by pg.sync_seq)
                               filter (where pg.src = 'units' and pg.rn <= v_limit), '[]'::jsonb),
           'published', coalesce(jsonb_agg(pg.obj order by pg.sync_seq)
                                   filter (where pg.src = 'published' and pg.rn <= v_limit), '[]'::jsonb),
           'unit_progress', coalesce(jsonb_agg(pg.obj order by pg.sync_seq)
                                       filter (where pg.src = 'unit_progress' and pg.rn <= v_limit),
                                     '[]'::jsonb)
         )
    into v_result
    from pg;

  return v_result;
end;
$$;

revoke all on function private.sync_pull(bigint, int) from public, anon, authenticated;
grant execute on function private.sync_pull(bigint, int) to authenticated;

create or replace function public.sync_pull(p_since_seq bigint, p_limit int)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.sync_pull(p_since_seq, p_limit); $$;

revoke all on function public.sync_pull(bigint, int) from public, anon, authenticated;
grant execute on function public.sync_pull(bigint, int) to authenticated;

comment on function public.sync_pull(bigint, int) is
  'Learner pull (wire.ts PullResponse): the caller''s primary guardian household (children, derived unit_progress), all subjects and the flattened units with a built pack, plus built pack rows, with sync_seq > p_since_seq in ascending order, at most p_limit (clamped to 500) rows. Tombstones carry deleted_at. epoch changes when access changes (the client re-pulls from 0). One snapshot; sync_seq is assigned in commit order.';
