-- 25 M3 tutor, part 4: the safeguarding queue (docs/safeguarding-protocol.md, ADR 0008).
--
--   list_safeguarding_cases(p_status, p_limit)                         the queue
--   get_safeguarding_case(p_id)                                        one case with its redacted excerpt
--   update_safeguarding_case(p_id, p_status, p_decision, p_notes)      take a case, then decide it
--
-- WHO. Only the roles `safeguarding` and `super_admin`, and only at aal2 (private.has_admin_role). content_editor, reviewer,
-- support and analyst are refused (`admin_role_required`); so is a safeguarding user at aal1.
--
-- EVERY CALL IS AUDITED. list and get write an audit_log row each time they succeed (who read which case, when); update
-- writes one per change. audit_log is readable by super_admin only. A call that is refused or fails writes nothing (its
-- transaction rolls back), which is why the role check comes first.
--
-- WHAT A REVIEWER SEES. The child's ALIAS and level, the category, severity and due time, the REDACTED excerpt (the last
-- messages, already stripped of names, numbers and addresses) and opaque ids. Never an e-mail address, a name of a guardian
-- or any profile data: no function here joins profiles or auth.users.
--
-- THE STATUS MACHINE. open -> in_review -> resolved, forward only. A decision (release | keep_withheld | contact_guardian |
-- escalated | no_action) is recorded when the case is resolved, never before, and a resolved case cannot change. Only
-- `release` lets the guardian read the held turns (released_at); the other decisions keep them withheld. The system never
-- contacts a household or an agency by itself.
--
-- Stable snake_case messages; SQLSTATE 42501 = not allowed, P0002 = not found, 22023 = refused / invalid.

-- the case as a reviewer sees it ------------------------------------------------------------------------------------------------
create or replace function private.safeguarding_case_view(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'session_id', c.session_id,
    'unit_id', s.unit_id,
    'child_id', c.child_id,
    'household_id', c.household_id,
    'child_alias', ch.display_alias,
    'level_code', ch.level_code,
    'category', c.category,
    'severity', c.severity,
    'status', c.status,
    'excerpt', c.excerpt,
    'excerpt_cleared_at', c.excerpt_cleared_at,
    'due_at', c.due_at,
    'overdue', (c.status <> 'resolved' and c.due_at < now()),
    'assigned_to', c.assigned_to,
    'decision', c.decision,
    'notes', c.notes,
    'created_at', c.created_at,
    'in_review_at', c.in_review_at,
    'resolved_at', c.resolved_at,
    'released_at', c.released_at
  )
  from public.safeguarding_cases c
  join public.children ch on ch.id = c.child_id
  left join public.tutor_sessions s on s.id = c.session_id
  where c.id = p_id;
$$;

revoke all on function private.safeguarding_case_view(uuid) from public, anon, authenticated, service_role;

-- list_safeguarding_cases -----------------------------------------------------------------------------------------------------------
-- p_status null: every status. Open and in-review cases first (most overdue first), then resolved ones (newest first).
-- Items: {id, category, severity, status, due_at, overdue, created_at, assigned_to, decision, child_alias, level_code}.
-- Writes an audit row {status, count} on every successful call.
create or replace function private.list_safeguarding_cases(p_status text default null, p_limit int default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['safeguarding', 'super_admin']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('open', 'in_review', 'resolved') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(x.item order by x.rank, x.sort_at, x.created_at), '[]'::jsonb)
    into v_rows
    from (
      select
        case when c.status = 'resolved' then 1 else 0 end as rank,
        case when c.status = 'resolved' then now() - c.created_at else c.due_at - now() end as sort_at,
        c.created_at,
        jsonb_build_object(
          'id', c.id,
          'category', c.category,
          'severity', c.severity,
          'status', c.status,
          'due_at', c.due_at,
          'overdue', (c.status <> 'resolved' and c.due_at < now()),
          'created_at', c.created_at,
          'assigned_to', c.assigned_to,
          'decision', c.decision,
          'child_alias', ch.display_alias,
          'level_code', ch.level_code
        ) as item
        from public.safeguarding_cases c
        join public.children ch on ch.id = c.child_id
       where p_status is null or c.status = p_status
       order by case when c.status = 'resolved' then 1 else 0 end,
                case when c.status = 'resolved' then now() - c.created_at else c.due_at - now() end,
                c.created_at
       limit p_limit
    ) x;

  perform private.write_audit(
    'safeguarding_queue_read', 'safeguarding_cases', null,
    jsonb_build_object('status', p_status, 'count', jsonb_array_length(v_rows))
  );
  return v_rows;
end;
$$;

-- get_safeguarding_case -----------------------------------------------------------------------------------------------------------------
-- One case: {id, session_id, unit_id, child_id, household_id, child_alias, level_code, category, severity, status, excerpt,
-- excerpt_cleared_at, due_at, overdue, assigned_to, decision, notes, created_at, in_review_at, resolved_at, released_at}.
-- Writes an audit row on EVERY successful call.
create or replace function private.get_safeguarding_case(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_view jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['safeguarding', 'super_admin']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  v_view := private.safeguarding_case_view(p_id);
  if v_view is null then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  perform private.write_audit(
    'safeguarding_case_read', 'safeguarding_cases', p_id::text,
    jsonb_build_object('status', v_view ->> 'status', 'category', v_view ->> 'category')
  );
  return v_view;
end;
$$;

-- update_safeguarding_case ---------------------------------------------------------------------------------------------------------------
-- p_status in_review: take the case (open -> in_review; the caller becomes assigned_to) or save notes (in_review -> in_review).
-- p_status resolved: only from in_review, and p_decision is required. A decision with any other status is refused
-- (`invalid_decision`), a missing one is `decision_required`. p_notes (at most 2000 characters) replaces the notes when given.
-- A resolved case cannot change (`illegal_status_move`). The decision `release` sets released_at: the guardian can then read
-- the held turns. Audited. Returns the case as get_safeguarding_case does (without a read audit row).
create or replace function private.update_safeguarding_case(p_id uuid, p_status text, p_decision text, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_case public.safeguarding_cases%rowtype;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['safeguarding', 'super_admin']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('in_review', 'resolved') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_decision is not null and p_decision not in ('release', 'keep_withheld', 'contact_guardian', 'escalated', 'no_action') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'invalid_notes' using errcode = '22023';
  end if;

  select * into v_case from public.safeguarding_cases c where c.id = p_id for update;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if v_case.status = 'resolved' then
    raise exception 'illegal_status_move' using errcode = '22023';
  end if;
  if p_status = 'in_review' then
    if p_decision is not null then
      raise exception 'invalid_decision' using errcode = '22023';
    end if;
  else
    if v_case.status <> 'in_review' then
      raise exception 'illegal_status_move' using errcode = '22023';
    end if;
    if p_decision is null then
      raise exception 'decision_required' using errcode = '22023';
    end if;
  end if;

  update public.safeguarding_cases c
     set status = p_status,
         assigned_to = case when c.status = 'open' then v_uid else c.assigned_to end,
         in_review_at = coalesce(c.in_review_at, now()),
         resolved_at = case when p_status = 'resolved' then now() end,
         decision = case when p_status = 'resolved' then p_decision end,
         released_at = case when p_status = 'resolved' and p_decision = 'release' then now() end,
         notes = coalesce(v_notes, c.notes)
   where c.id = p_id;

  perform private.write_audit(
    'safeguarding_case_updated', 'safeguarding_cases', p_id::text,
    jsonb_build_object('from', v_case.status, 'to', p_status, 'decision', p_decision,
                       'notes_length', coalesce(char_length(v_notes), 0))
  );
  return private.safeguarding_case_view(p_id);
end;
$$;

-- grants ---------------------------------------------------------------------------------------------------------------------------------
revoke all on function
  private.list_safeguarding_cases(text, int),
  private.get_safeguarding_case(uuid),
  private.update_safeguarding_case(uuid, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function
  private.list_safeguarding_cases(text, int),
  private.get_safeguarding_case(uuid),
  private.update_safeguarding_case(uuid, text, text, text)
  to authenticated;

create or replace function public.list_safeguarding_cases(p_status text default null, p_limit int default 100)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.list_safeguarding_cases(p_status, p_limit); $$;

create or replace function public.get_safeguarding_case(p_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.get_safeguarding_case(p_id); $$;

create or replace function public.update_safeguarding_case(p_id uuid, p_status text, p_decision text, p_notes text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.update_safeguarding_case(p_id, p_status, p_decision, p_notes); $$;

revoke all on function
  public.list_safeguarding_cases(text, int),
  public.get_safeguarding_case(uuid),
  public.update_safeguarding_case(uuid, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function
  public.list_safeguarding_cases(text, int),
  public.get_safeguarding_case(uuid),
  public.update_safeguarding_case(uuid, text, text, text)
  to authenticated;

comment on function public.list_safeguarding_cases(text, int) is
  'Roles safeguarding and super_admin at aal2. The queue (optionally one status), unresolved cases first. Writes an audit row on every call.';
comment on function public.get_safeguarding_case(uuid) is
  'Roles safeguarding and super_admin at aal2. One case with its REDACTED excerpt (child alias only, never an e-mail). Writes an audit row on every call.';
comment on function public.update_safeguarding_case(uuid, text, text, text) is
  'Roles safeguarding and super_admin at aal2. open -> in_review -> resolved with a decision (release | keep_withheld | contact_guardian | escalated | no_action); only release lets the guardian read the held turns. Audited.';
