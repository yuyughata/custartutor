-- 07 audit triggers. audit_log is written ONLY by SECURITY DEFINER triggers/functions (no client
-- INSERT privilege or policy) and read only by super_admin at aal2.
--
-- Audited tables: household_members, child_access, admin_users, published_units (as required) and
-- unit_versions (who approved what). Large/noisy columns (content, lint_report) and the sync cursor
-- are stripped from the recorded row images; an UPDATE that changes nothing else is not logged.

create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_id text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new) - 'content' - 'lint_report' - 'sync_seq';
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old) - 'content' - 'lint_report' - 'sync_seq';
  else
    v_old := to_jsonb(old) - 'content' - 'lint_report' - 'sync_seq';
    v_new := to_jsonb(new) - 'content' - 'lint_report' - 'sync_seq';
    if v_old = v_new then
      return null;
    end if;
  end if;

  v_row := coalesce(v_new, v_old);
  v_id := case tg_table_name
    when 'household_members' then (v_row ->> 'household_id') || ':' || (v_row ->> 'user_id')
    when 'admin_users' then v_row ->> 'user_id'
    else v_row ->> 'id'
  end;

  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (
    (select auth.uid()),
    lower(tg_op),
    tg_table_name,
    v_id,
    jsonb_build_object('old', v_old, 'new', v_new)
  );
  return null;
end;
$$;

revoke all on function private.audit_row_change() from public, anon, authenticated;

create trigger household_members_audit after insert or update or delete on public.household_members
  for each row execute function private.audit_row_change();
create trigger child_access_audit after insert or update or delete on public.child_access
  for each row execute function private.audit_row_change();
create trigger admin_users_audit after insert or update or delete on public.admin_users
  for each row execute function private.audit_row_change();
create trigger published_units_audit after insert or update or delete on public.published_units
  for each row execute function private.audit_row_change();
create trigger unit_versions_audit after insert or update or delete on public.unit_versions
  for each row execute function private.audit_row_change();
