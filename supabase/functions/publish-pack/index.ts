// publish-pack: POST { published_unit_id } -> builds the pack of a published snapshot (ADR 0004), uploads it
// to the private `packs` bucket and switches it on. verify_jwt = true.
//
//   1. get_pack_source (caller's JWT)   admin (super_admin, content_editor, reviewer) at aal2, else 403
//   2. build the pack (pure: _shared/pack-builder.ts), files first, manifest last
//   3. upload with the service role     the only use of the service role; only after step 1 succeeded
//   4. set_pack_info (caller's JWT)     flips the pack on; write-once, so the whole function is idempotent:
//                                       a snapshot whose pack is already built returns the same hashes
//                                       without touching storage, and a crashed run is simply re-run
//                                       (uploads overwrite identical bytes).

import { serviceClient, userClient } from '../_shared/clients.ts';
import { HttpError, handle, json, readJsonObject, rpcErrorToHttp } from '../_shared/http.ts';
import { buildPack } from '../_shared/pack-builder.ts';
import { PACKS_BUCKET } from '../_shared/pack-layout.ts';
import { parsePackSource, parsePublishRequest } from '../_shared/pack-source.ts';

Deno.serve((req: Request) =>
  handle(req, async () => {
    const publishedUnitId = parsePublishRequest(await readJsonObject(req));
    const user = userClient(req);

    // 1. who may publish is decided by the database, with the caller's own JWT
    const source = await user.rpc('get_pack_source', { p_published_unit_id: publishedUnitId });
    if (source.error) throw rpcErrorToHttp(source.error);
    const snapshot = parsePackSource(source.data);

    if (snapshot.packManifestPath && snapshot.contentHash) {
      return json(200, {
        published_unit_id: snapshot.publishedUnitId,
        unit_id: snapshot.unitId,
        version_no: snapshot.versionNo,
        manifest_path: snapshot.packManifestPath,
        content_hash: snapshot.contentHash,
        already_built: true,
      });
    }
    if (snapshot.deleted || !snapshot.isCurrent) throw new HttpError(409, 'not_current');

    // 2. build (throws on content that does not parse: the snapshot is not packable)
    let built;
    try {
      built = await buildPack({
        unitId: snapshot.unitId,
        versionNo: snapshot.versionNo,
        minAppVersion: snapshot.minAppVersion,
        content: snapshot.content,
      });
    } catch (error) {
      console.error('pack build failed', error);
      throw new HttpError(422, 'content_not_packable');
    }

    // 3. upload (service role, private bucket); the manifest is the last object
    const storage = serviceClient().storage.from(PACKS_BUCKET);
    for (const object of built.objects) {
      const { error } = await storage.upload(object.storagePath, object.bytes, {
        contentType: object.contentType,
        cacheControl: '31536000',
        upsert: true,
      });
      if (error) {
        console.error('upload failed', object.storagePath, error);
        throw new HttpError(502, 'upload_failed');
      }
    }

    // 4. switch the pack on
    const done = await user.rpc('set_pack_info', {
      p_published_unit_id: snapshot.publishedUnitId,
      p_manifest_path: built.manifestPath,
      p_content_hash: built.contentHash,
    });
    if (done.error) throw rpcErrorToHttp(done.error);

    return json(200, {
      published_unit_id: snapshot.publishedUnitId,
      unit_id: snapshot.unitId,
      version_no: snapshot.versionNo,
      manifest_path: built.manifestPath,
      content_hash: built.contentHash,
      files: built.objects.length,
      already_built: false,
    });
  }),
);
