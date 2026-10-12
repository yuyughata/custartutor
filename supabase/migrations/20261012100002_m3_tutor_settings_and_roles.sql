-- 23 M3 tutor, part 2: the tutor settings, the `safeguarding` admin role and the gate that keeps the tutor off.
--
--   app_settings.key           also accepts the TUTOR_SETTING_KEYS of packages/tutor-core/src/contract.ts
--   set_app_setting            validates the SHAPE of every new key (TutorSettings in the contract); `tutor.enabled` is
--                              refused here: the switch is `set_tutor_enabled`, which has the owner gate
--   admin_users.role           gains `safeguarding` (the reviewers of the safeguarding queue)
--   set_tutor_enabled          super_admin at aal2. Enabling is REFUSED (`safeguarding_owner_required`) unless a named
--                              `safeguarding.owner` with `confirmed_at` exists (docs/safeguarding-protocol.md). Audited.
--   tutor_get_settings         service_role only: the assembled TutorSettings, defaults for missing keys. `enabled` is
--                              the EFFECTIVE switch (stored switch AND a confirmed owner) and `owner` is null until
--                              confirmed, so a tutor can never run without a named, confirmed owner even if a row was
--                              written around the RPCs.
--   tutor_get_ai_settings      service_role only: the part of the content-engine settings the tutor needs (models, kill
--                              switch, effort, prompt version). `get_ai_settings` is for content staff and cannot be
--                              called by the service role.
--
-- The tutor is NOT enabled by this migration. Nothing here writes a setting.

-- the key list and the new role --------------------------------------------------------------------------------------
alter table public.app_settings drop constraint app_settings_key_check;
alter table public.app_settings add constraint app_settings_key_check check (
  key in (
    'ai.models', 'ai.kill_switch', 'ai.budget', 'ai.prices', 'ai.effort', 'ai.prompt_version',
    'tutor.enabled', 'tutor.daily_turns_per_child', 'tutor.retention_days', 'tutor.output_check',
    'tutor.max_history_turns', 'tutor.max_reply_tokens', 'tutor.persona_name', 'tutor.safe_replies',
    'tutor.helpline', 'safeguarding.owner', 'safeguarding.sla_hours', 'safeguarding.guardian_visible_categories'
  )
);

alter table public.admin_users drop constraint admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check check (
  role in ('super_admin', 'content_editor', 'reviewer', 'support', 'analyst', 'safeguarding')
);

-- defaults (DEFAULT_TUTOR_SETTINGS in the contract; a Vitest test keeps the two equal) -------------------------------------
create or replace function private.tutor_setting_default(p_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_key
    when 'tutor.enabled' then 'false'::jsonb
    when 'tutor.daily_turns_per_child' then '40'::jsonb
    when 'tutor.retention_days' then '90'::jsonb
    when 'tutor.output_check' then 'true'::jsonb
    when 'tutor.max_history_turns' then '12'::jsonb
    when 'tutor.max_reply_tokens' then '400'::jsonb
    when 'tutor.persona_name' then 'null'::jsonb
    when 'tutor.safe_replies' then
      '{"self_harm":"I am really glad you told me. What you feel matters a lot. Please tell a grown-up you trust right now, like your mum, your dad, an aunty, an uncle or your teacher. If you feel you might hurt yourself, go to a grown-up straight away. You are not alone.",
        "abuse":"Thank you for telling me. You were brave. It is not your fault. Please tell a grown-up you trust, like a teacher or someone in your family who makes you feel safe. You deserve to be safe.",
        "distress":"I am sorry you feel this way. It is okay to feel sad or scared. Please tell a grown-up you trust how you feel. We can come back to our lesson when you are ready.",
        "blocked":"That is not something I can talk about. Let us go back to our lesson. If something is worrying you, please tell a grown-up you trust.",
        "redirect":"I am here to help you with your lesson. Let us go back to it together."}'::jsonb
    when 'tutor.helpline' then 'null'::jsonb
    when 'safeguarding.owner' then 'null'::jsonb
    when 'safeguarding.sla_hours' then '{"high":4,"medium":24,"low":72}'::jsonb
    when 'safeguarding.guardian_visible_categories' then
      '["jailbreak","off_topic","personal_info_shared","sexual","violence"]'::jsonb
  end;
$$;

-- the stored value, or the default; a stored object is laid over the default object (a partial row keeps defaults)
create or replace function private.tutor_setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when s.value is null then private.tutor_setting_default(p_key)
    when jsonb_typeof(s.value) = 'object' and jsonb_typeof(private.tutor_setting_default(p_key)) = 'object'
      then private.tutor_setting_default(p_key) || s.value
    else s.value
  end
  from (select (select a.value from public.app_settings a where a.key = p_key) as value) s;
$$;

-- a named safeguarding owner whose confirmation is recorded
create or replace function private.tutor_owner_confirmed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.app_settings s
     where s.key = 'safeguarding.owner'
       and jsonb_typeof(s.value) = 'object'
       and nullif(btrim(s.value ->> 'name'), '') is not null
       and nullif(btrim(s.value ->> 'contact'), '') is not null
       and nullif(btrim(s.value ->> 'confirmed_at'), '') is not null
  );
$$;

-- the assembled TutorSettings (contract.ts) ---------------------------------------------------------------------------------
create or replace function private.tutor_settings_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', (private.tutor_setting('tutor.enabled') = 'true'::jsonb and private.tutor_owner_confirmed()),
    'daily_turns_per_child', private.tutor_setting('tutor.daily_turns_per_child'),
    'retention_days', private.tutor_setting('tutor.retention_days'),
    'output_check', private.tutor_setting('tutor.output_check'),
    'max_history_turns', private.tutor_setting('tutor.max_history_turns'),
    'max_reply_tokens', private.tutor_setting('tutor.max_reply_tokens'),
    'persona_name', private.tutor_setting('tutor.persona_name'),
    'safe_replies', private.tutor_setting('tutor.safe_replies'),
    'helpline', private.tutor_setting('tutor.helpline'),
    'owner', case
      when private.tutor_owner_confirmed() then (
        select jsonb_strip_nulls(jsonb_build_object(
          'name', o.value ->> 'name',
          'role', o.value ->> 'role',
          'contact', o.value ->> 'contact',
          'confirmed_at', o.value ->> 'confirmed_at'
        ))
        from (select private.tutor_setting('safeguarding.owner') as value) o
      )
      else 'null'::jsonb
    end,
    'sla_hours', private.tutor_setting('safeguarding.sla_hours'),
    'guardian_visible_categories', private.tutor_setting('safeguarding.guardian_visible_categories')
  );
$$;

-- shape validation of the tutor keys (mirrors TutorSettings in contract.ts, a little stricter where safety asks for it) ------
create or replace function private.tutor_setting_value_ok(p_key text, p_value jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text;
begin
  if p_value is null or p_key is null then
    return false;
  end if;

  if p_key = 'tutor.enabled' or p_key = 'tutor.output_check' then
    return jsonb_typeof(p_value) = 'boolean';
  elsif p_key = 'tutor.daily_turns_per_child' then
    return private.json_int(p_value, 1, 500) is not null;
  elsif p_key = 'tutor.retention_days' then
    return private.json_int(p_value, 1, 3650) is not null;
  elsif p_key = 'tutor.max_history_turns' then
    return private.json_int(p_value, 0, 40) is not null;
  elsif p_key = 'tutor.max_reply_tokens' then
    return private.json_int(p_value, 64, 2000) is not null;

  elsif p_key = 'tutor.persona_name' then
    -- null (no name) or 1-40 characters; goes into the system prompt, so no control characters, markup or brackets
    if jsonb_typeof(p_value) = 'null' then
      return true;
    end if;
    return private.json_text(p_value, 40) is not null
       and (p_value #>> '{}') !~ '[\x01-\x1F\x7F<>{}\[\]`\\]';

  elsif p_key = 'tutor.helpline' then
    -- null or free text up to 600 characters (the owner supplies verified numbers); line breaks allowed, markup not
    if jsonb_typeof(p_value) = 'null' then
      return true;
    end if;
    if jsonb_typeof(p_value) <> 'string' then
      return false;
    end if;
    v_text := p_value #>> '{}';
    return char_length(v_text) <= 600 and v_text !~ '[\x01-\x08\x0B-\x1F\x7F<>]';

  elsif p_key = 'tutor.safe_replies' then
    -- exactly the five fixed replies, each 1-600 characters of plain text
    if jsonb_typeof(p_value) <> 'object' or (select count(*) from jsonb_object_keys(p_value)) <> 5 then
      return false;
    end if;
    return not exists (
      select 1
        from unnest(array['self_harm', 'abuse', 'distress', 'blocked', 'redirect']) as k(key)
       where private.json_text(p_value -> k.key, 600) is null
          or (p_value ->> k.key) ~ '[\x01-\x08\x0B-\x1F\x7F<>]'
    );

  elsif p_key = 'safeguarding.owner' then
    -- null (no owner) or {name, contact, role?, confirmed_at?}; an owner without confirmed_at is named but not confirmed
    if jsonb_typeof(p_value) = 'null' then
      return true;
    end if;
    if jsonb_typeof(p_value) <> 'object' then
      return false;
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_value) k where k not in ('name', 'contact', 'role', 'confirmed_at')
    ) then
      return false;
    end if;
    if private.json_text(p_value -> 'name', 120) is null or private.json_text(p_value -> 'contact', 200) is null then
      return false;
    end if;
    if p_value ? 'role' and jsonb_typeof(p_value -> 'role') <> 'null' and private.json_text(p_value -> 'role', 80) is null then
      return false;
    end if;
    if p_value ? 'confirmed_at' and jsonb_typeof(p_value -> 'confirmed_at') <> 'null' then
      if private.json_text(p_value -> 'confirmed_at', 64) is null then
        return false;
      end if;
      begin
        perform (p_value ->> 'confirmed_at')::timestamptz;
      exception when others then
        return false;
      end;
    end if;
    return true;

  elsif p_key = 'safeguarding.sla_hours' then
    -- exactly high, medium and low: hours in (0, 720], and a more severe case is never given MORE time
    if jsonb_typeof(p_value) <> 'object' or (select count(*) from jsonb_object_keys(p_value)) <> 3 then
      return false;
    end if;
    if not (private.json_number_ok(p_value -> 'high', true)
            and private.json_number_ok(p_value -> 'medium', true)
            and private.json_number_ok(p_value -> 'low', true)) then
      return false;
    end if;
    return (p_value ->> 'low')::numeric <= 720
       and (p_value ->> 'high')::numeric <= (p_value ->> 'medium')::numeric
       and (p_value ->> 'medium')::numeric <= (p_value ->> 'low')::numeric;

  elsif p_key = 'safeguarding.guardian_visible_categories' then
    -- known categories only, no duplicates. self_harm and abuse_disclosure can NEVER be guardian-visible: the risk can be
    -- inside the household (ADR 0008). Distress may be listed if the owner decides so.
    if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) > 6 then
      return false;
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_value) e
       where jsonb_typeof(e) <> 'string'
          or (e #>> '{}') not in ('distress', 'sexual', 'violence', 'personal_info_shared', 'jailbreak', 'off_topic')
    ) then
      return false;
    end if;
    return (select count(distinct e) from jsonb_array_elements_text(p_value) e) = jsonb_array_length(p_value);
  end if;

  return false;
end;
$$;

-- set_app_setting: the M2 function, now also for the tutor keys -------------------------------------------------------------
-- super_admin at aal2. Same contract as before (known keys only, the value is validated by shape, an unchanged value writes
-- nothing, the audit trigger of app_settings records old and new). New: `tutor.enabled` is refused (`use_set_tutor_enabled`),
-- and replacing the safeguarding owner by one that is not confirmed switches the tutor off.
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
     or p_key not in (
       'ai.models', 'ai.kill_switch', 'ai.budget', 'ai.prices', 'ai.effort', 'ai.prompt_version',
       'tutor.enabled', 'tutor.daily_turns_per_child', 'tutor.retention_days', 'tutor.output_check',
       'tutor.max_history_turns', 'tutor.max_reply_tokens', 'tutor.persona_name', 'tutor.safe_replies',
       'tutor.helpline', 'safeguarding.owner', 'safeguarding.sla_hours', 'safeguarding.guardian_visible_categories'
     ) then
    raise exception 'invalid_setting_key' using errcode = '22023';
  end if;
  if p_key = 'tutor.enabled' then
    raise exception 'use_set_tutor_enabled' using errcode = '22023';
  end if;
  if not (case
            when p_key like 'tutor.%' or p_key like 'safeguarding.%' then private.tutor_setting_value_ok(p_key, p_value)
            else private.app_setting_value_ok(p_key, p_value)
          end) then
    raise exception 'invalid_setting_value' using errcode = '22023';
  end if;

  insert into public.app_settings as s (key, value, updated_by)
  values (p_key, p_value, v_uid)
  on conflict (key) do update
    set value = excluded.value, updated_by = excluded.updated_by
    where s.value is distinct from excluded.value;

  -- the tutor never keeps running without a named, confirmed owner
  if p_key = 'safeguarding.owner' and not private.tutor_owner_confirmed() then
    update public.app_settings s
       set value = 'false'::jsonb, updated_by = v_uid
     where s.key = 'tutor.enabled' and s.value is distinct from 'false'::jsonb;
  end if;
end;
$$;

-- set_tutor_enabled -------------------------------------------------------------------------------------------------------------
-- super_admin at aal2. Disabling always works. Enabling needs a safeguarding owner with a name, a contact and a
-- confirmed_at (`safeguarding_owner_required`, 22023): the owner is a business decision, not a default. The change is
-- audited twice on purpose: the app_settings row trigger (old and new value) and a semantic row `tutor_enabled_set`.
create or replace function private.set_tutor_enabled(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_before jsonb;
  v_changed boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'invalid_setting_value' using errcode = '22023';
  end if;
  if p_enabled and not private.tutor_owner_confirmed() then
    raise exception 'safeguarding_owner_required' using errcode = '22023';
  end if;

  select s.value into v_before from public.app_settings s where s.key = 'tutor.enabled';
  v_changed := coalesce(v_before, 'false'::jsonb) is distinct from to_jsonb(p_enabled);

  insert into public.app_settings as s (key, value, updated_by)
  values ('tutor.enabled', to_jsonb(p_enabled), v_uid)
  on conflict (key) do update
    set value = excluded.value, updated_by = excluded.updated_by
    where s.value is distinct from excluded.value;

  perform private.write_audit(
    'tutor_enabled_set', 'app_settings', 'tutor.enabled',
    jsonb_build_object('enabled', p_enabled, 'changed', v_changed)
  );
  return jsonb_build_object('enabled', p_enabled);
end;
$$;

-- service role: the settings the edge function runs on -------------------------------------------------------------------------
create or replace function private.tutor_get_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select private.tutor_settings_json(); $$;

create or replace function private.tutor_get_ai_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'models', private.ai_setting('ai.models'),
    'kill_switch', private.ai_setting('ai.kill_switch'),
    'effort', private.ai_setting('ai.effort'),
    'prompt_version', private.ai_setting('ai.prompt_version')
  );
$$;

-- grants: private implementations --------------------------------------------------------------------------------------------------
revoke all on function
  private.tutor_setting_default(text),
  private.tutor_setting(text),
  private.tutor_owner_confirmed(),
  private.tutor_settings_json(),
  private.tutor_setting_value_ok(text, jsonb),
  private.set_tutor_enabled(boolean),
  private.tutor_get_settings(),
  private.tutor_get_ai_settings()
  from public, anon, authenticated, service_role;

grant execute on function private.set_tutor_enabled(boolean) to authenticated;
grant execute on function private.tutor_get_settings(), private.tutor_get_ai_settings() to service_role;

-- public wrappers (SECURITY INVOKER) ---------------------------------------------------------------------------------------------------
create or replace function public.set_tutor_enabled(p_enabled boolean)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.set_tutor_enabled(p_enabled); $$;

create or replace function public.tutor_get_settings()
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.tutor_get_settings(); $$;

create or replace function public.tutor_get_ai_settings()
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.tutor_get_ai_settings(); $$;

revoke all on function
  public.set_tutor_enabled(boolean),
  public.tutor_get_settings(),
  public.tutor_get_ai_settings()
  from public, anon, authenticated, service_role;

grant execute on function public.set_tutor_enabled(boolean) to authenticated;
grant execute on function public.tutor_get_settings(), public.tutor_get_ai_settings() to service_role;

comment on function public.set_tutor_enabled(boolean) is
  'super_admin at aal2. Switches the AI tutor on or off. Enabling is refused (safeguarding_owner_required) unless safeguarding.owner has a name, a contact and confirmed_at. Audited.';
comment on function public.tutor_get_settings() is
  'service_role only (tutor-chat). The assembled TutorSettings with the contract defaults for missing keys. `enabled` is the effective switch (stored switch and a confirmed owner); `owner` is null until confirmed.';
comment on function public.tutor_get_ai_settings() is
  'service_role only (tutor-chat). {models, kill_switch, effort, prompt_version} of the content-engine settings; get_ai_settings is content staff only.';
