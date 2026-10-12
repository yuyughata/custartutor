-- 20 M2 content engine, part 7: take the inert 5-argument ai_job_fail_step out of the way.
--
-- The previous migration added the 6-argument ai_job_fail_step (p_usage defaults to '[]') and made the old
-- 5-argument pair inert (no role may execute it). A call with five positional arguments is then ambiguous
-- between the two ("function is not unique"), so the old pair is renamed: `ai_job_fail_step` is again a single
-- function, and a five-argument call resolves to the new one with an empty usage. The renamed stubs have no
-- privileges and no callers; migrations/README.md lists the statements that remove them (the migration tooling
-- holds back anything that removes an object).
alter function public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean)
  rename to ai_job_fail_step_deprecated;
alter function private.ai_job_fail_step(uuid, uuid, text, jsonb, boolean)
  rename to ai_job_fail_step_deprecated;
