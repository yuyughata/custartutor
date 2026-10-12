-- 17 M2 content engine, part 4: the private `scheme-uploads` bucket (schemes of work as PDF, DOCX or text).
--
-- Layout: <auth.uid()>/<anything>. Content staff at aal2 may upload (insert) and read (select) ONLY under their own
-- user-id prefix; nobody else sees the bucket, and no client may update or delete an object (no policy for those
-- commands: an uploaded scheme is kept as the source of the extraction; the admin app uploads under a fresh name each
-- time). The `ai-job` edge function reads the file with the CALLER's JWT, so the same policy decides: a job can only
-- read what its creator uploaded.
--   insert  super_admin, content_editor (the roles that can start an ingest job)
--   select  super_admin, content_editor, reviewer
--
-- storage.objects belongs to Supabase (supabase_storage_admin): nothing here alters the table, only plain
-- `create policy` statements. Guarded like the `packs` bucket: on a fresh local stack (`supabase start`) the storage
-- schema is created after the project migrations, so there the bucket comes from [storage.buckets.scheme-uploads]
-- in supabase/config.toml, and the two policies are created only when storage.objects already exists.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'scheme-uploads', 'scheme-uploads', false, 20971520,
      array['application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain']
    )
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute $policy$
      create policy scheme_uploads_insert on storage.objects
        for insert to authenticated
        with check (
          bucket_id = 'scheme-uploads'
          and name like (select auth.uid())::text || '/%'
          and (select private.has_admin_role(array['super_admin', 'content_editor']))
        )
    $policy$;
    execute $policy$
      create policy scheme_uploads_select on storage.objects
        for select to authenticated
        using (
          bucket_id = 'scheme-uploads'
          and name like (select auth.uid())::text || '/%'
          and (select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']))
        )
    $policy$;
  end if;
end
$$;
