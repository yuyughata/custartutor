// get-pack-download: POST { p_unit_id, p_version_no } -> PackDownload { manifest, urls, expires_at }
// (packages/learner-core/src/wire.ts). verify_jwt = true.
//
// Authorisation is the DATABASE's: the RPC `authorize_pack_download` runs with the CALLER's JWT (any active
// household member or granted tutor, for a built, non-tombstoned, serving pack version). Nothing in the body
// is trusted beyond the two ids. Only after that succeeds is the service role used, and only to read the
// authorised manifest from the private `packs` bucket and to sign URLs for the files that manifest lists;
// the storage paths are derived from the validated unit id, version and file hashes, never from the manifest
// text. Signed URLs live two hours and honour Range requests (Supabase Storage).

import { serviceClient, userClient } from '../_shared/clients.ts';
import { HttpError, handle, json, readJsonObject, rpcErrorToHttp } from '../_shared/http.ts';
import {
  URL_TTL_SECONDS,
  buildDownload,
  parseAuthorizedPack,
  parseDownloadRequest,
  parseStoredManifest,
  signedPathsOf,
} from '../_shared/pack-download.ts';
import { PACKS_BUCKET } from '../_shared/pack-layout.ts';

Deno.serve((req: Request) =>
  handle(req, async () => {
    const { unitId, versionNo } = parseDownloadRequest(await readJsonObject(req));

    // 1. the caller's own permissions decide
    const { data, error } = await userClient(req).rpc('authorize_pack_download', {
      p_unit_id: unitId,
      p_version_no: versionNo,
    });
    if (error) throw rpcErrorToHttp(error);
    const authorised = parseAuthorizedPack(data, unitId, versionNo);

    // 2. the service role reads the authorised manifest and signs its files
    const storage = serviceClient().storage.from(PACKS_BUCKET);
    const file = await storage.download(authorised.manifest_path);
    if (file.error || !file.data) {
      console.error('manifest download failed', file.error);
      throw new HttpError(502, 'pack_unavailable');
    }
    const manifest = parseStoredManifest(await file.data.text(), authorised, unitId, versionNo);

    const signed = await storage.createSignedUrls(signedPathsOf(manifest), URL_TTL_SECONDS);
    if (signed.error || !signed.data) {
      console.error('signing failed', signed.error);
      throw new HttpError(502, 'pack_unavailable');
    }
    return json(200, buildDownload(manifest, signed.data, URL_TTL_SECONDS, Date.now()));
  }),
);
