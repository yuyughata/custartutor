-- 01 foundations: private schema, deny-by-default privileges, global sync sequence.
--
-- Conventions for the whole migration set (see supabase/migrations/README.md):
--   * `public` is the only schema exposed to PostgREST. `private` holds SECURITY DEFINER helpers
--     and RPC implementations and is never exposed.
--   * Every table has RLS enabled in the same migration that creates it.
--   * `anon` gets nothing, anywhere. `authenticated` gets only what policies need.

create schema if not exists private;

comment on schema private is
  'Not exposed to PostgREST. SECURITY DEFINER helpers, RPC implementations and trigger functions.';

-- USAGE is needed so that policies/views/wrappers can resolve private.* functions as the calling role.
-- Individual functions are still locked down with explicit EXECUTE grants.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Supabase's default ACLs hand ALL privileges on new public tables/sequences/functions to anon and
-- authenticated. Remove that so new objects are deny-by-default; migrations grant explicitly.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- Sync support ------------------------------------------------------------------------------------
-- The client pull cursor is `sync_seq` (NOT updated_at: commits can land out of order and device
-- clocks are unreliable). Removal on syncable tables is a tombstone (`deleted_at`), never a hard
-- delete, so offline clients can purge. Because a transaction that drew a lower sync_seq can commit
-- after one that drew a higher value, clients must re-pull with a small overlap (cursor minus a
-- safety margin) and treat upserts idempotently.
create sequence if not exists public.sync_seq_global as bigint;
revoke all on sequence public.sync_seq_global from public, anon, authenticated;

comment on sequence public.sync_seq_global is
  'Global monotonically increasing sync cursor, stamped by private.set_sync_seq() on syncable tables.';

create or replace function private.set_sync_seq()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- SECURITY DEFINER so that callers never need privileges on the sequence.
  new.sync_seq := nextval('public.sync_seq_global');
  return new;
end;
$$;

revoke all on function private.set_sync_seq() from public, anon, authenticated;
