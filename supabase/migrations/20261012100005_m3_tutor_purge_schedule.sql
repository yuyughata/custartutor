-- 26 M3 tutor, part 5: run the retention purge every night with pg_cron, when the extension can be installed.
--
-- private.tutor_purge_expired() (migration m3_tutor_rpcs) deletes the tutor messages that are past tutor.retention_days
-- (flagged ones follow their safeguarding case), empty sessions, old case excerpts and old daily counters. This migration
-- schedules it at 02:17 UTC (03:17 in Lagos) under the job name `tutor-purge-expired`.
--
-- GUARDED. pg_cron is not part of every stack (`supabase start` may lack it, and a project may not have enabled it). If the
-- extension cannot be installed or the job cannot be scheduled, this migration still succeeds with a NOTICE and the purge
-- is simply not scheduled: the owner then does the one manual step in supabase/migrations/README.md ("Tutor retention
-- purge"). Re-running is harmless: scheduling a job under an existing name replaces it.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: schedule private.tutor_purge_expired() by hand (see supabase/migrations/README.md)';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('tutor-purge-expired', '17 2 * * *', 'select private.tutor_purge_expired()');
  exception when others then
    raise notice 'pg_cron could not be set up (%): schedule private.tutor_purge_expired() by hand (see supabase/migrations/README.md)', sqlerrm;
  end;
end
$$;
