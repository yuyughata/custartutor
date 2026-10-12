import { describe, expect, it, vi } from 'vitest';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  handle,
  json,
  readJsonObject,
  rpcErrorToHttp,
} from './http';
import { parsePackSource, parsePublishRequest } from './pack-source';

const post = (
  body: string,
  headers: Record<string, string> = { Authorization: 'Bearer abc.def.ghi' },
) => new Request('https://x.supabase.co/functions/v1/f', { method: 'POST', body, headers });

describe('rpcErrorToHttp', () => {
  it('passes the stable messages of the RPCs through with the right status', () => {
    expect(rpcErrorToHttp({ code: '42501', message: 'not_authenticated' })).toMatchObject({
      status: 401,
      code: 'not_authenticated',
    });
    expect(rpcErrorToHttp({ code: '42501', message: 'not_a_household_member' })).toMatchObject({
      status: 403,
      code: 'not_a_household_member',
    });
    expect(rpcErrorToHttp({ code: '42501', message: 'admin_role_required' })).toMatchObject({
      status: 403,
      code: 'admin_role_required',
    });
    expect(rpcErrorToHttp({ code: 'P0002', message: 'pack_not_found' })).toMatchObject({
      status: 404,
      code: 'pack_not_found',
    });
    expect(rpcErrorToHttp({ code: '22023', message: 'invalid_pack_request' })).toMatchObject({
      status: 400,
      code: 'invalid_pack_request',
    });
    expect(rpcErrorToHttp({ code: '22023', message: 'pack_info_already_set' })).toMatchObject({
      status: 409,
      code: 'pack_info_already_set',
    });
    expect(rpcErrorToHttp({ code: 'PGRST301', message: 'JWT expired' })).toMatchObject({
      status: 401,
      code: 'invalid_jwt',
    });
  });

  it('never leaks a Postgres message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      rpcErrorToHttp({
        code: '42501',
        message: 'permission denied for function authorize_pack_download',
      }),
    ).toMatchObject({ status: 403, code: 'forbidden' });
    expect(
      rpcErrorToHttp({ code: '57014', message: 'canceling statement due to statement timeout' }),
    ).toMatchObject({ status: 500, code: 'internal_error' });
    expect(rpcErrorToHttp({ message: 'fetch failed: ECONNRESET to 10.0.0.3' })).toMatchObject({
      status: 500,
      code: 'internal_error',
    });
  });
});

describe('handle', () => {
  it('answers a CORS preflight without needing a token', async () => {
    const res = await handle(new Request('https://x', { method: 'OPTIONS' }), async () =>
      json(200, {}),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('accepts POST with a bearer token only', async () => {
    const ok = await handle(post('{}'), async () => json(200, { ok: true }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const noAuth = await handle(post('{}', {}), async () => json(200, {}));
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({
      error: { code: 'not_authenticated', message: 'not_authenticated' },
    });

    const basic = await handle(post('{}', { Authorization: 'Basic abc' }), async () =>
      json(200, {}),
    );
    expect(basic.status).toBe(401);

    const get = await handle(
      new Request('https://x', { method: 'GET', headers: { Authorization: 'Bearer a.b.c' } }),
      async () => json(200, {}),
    );
    expect(get.status).toBe(405);
  });

  it('turns thrown errors into JSON, and hides unknown ones', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const known = await handle(post('{}'), async () => {
      throw new HttpError(404, 'pack_not_found');
    });
    expect(known.status).toBe(404);
    expect(await known.json()).toEqual({
      error: { code: 'pack_not_found', message: 'pack_not_found' },
    });
    const unknown = await handle(post('{}'), async () => {
      throw new Error('secret connection string postgres://...');
    });
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain('postgres://');
  });

  it('has json/errorResponse helpers that always carry CORS headers', () => {
    expect(json(201, { a: 1 }).headers.get('Content-Type')).toBe('application/json');
    expect(errorResponse(new HttpError(400, 'x')).headers.get('Access-Control-Allow-Headers')).toBe(
      corsHeaders['Access-Control-Allow-Headers'],
    );
  });
});

describe('readJsonObject', () => {
  it('reads an object and refuses everything else', async () => {
    expect(await readJsonObject(post('{"a":1}'))).toEqual({ a: 1 });
    await expect(readJsonObject(post('[1]'))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_json',
    });
    await expect(readJsonObject(post('null'))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonObject(post('{oops'))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_json',
    });
    await expect(readJsonObject(post(' '.repeat(20000)))).rejects.toMatchObject({ status: 413 });
  });
});

describe('publish-pack request and source', () => {
  const row = {
    published_unit_id: '9a000001-0000-4000-8000-000000000001',
    unit_id: 'ab000001-0000-4000-8000-000000000001',
    version_no: 2,
    schema_version: 1,
    min_app_version: '1.0.0',
    is_current: true,
    deleted: false,
    content: { kind: 'lesson' },
    pack_manifest_path: null,
    content_hash: null,
  };

  it('parses the request', () => {
    expect(parsePublishRequest({ published_unit_id: row.published_unit_id.toUpperCase() })).toBe(
      row.published_unit_id,
    );
    expect(() => parsePublishRequest({})).toThrow(HttpError);
    expect(() => parsePublishRequest({ published_unit_id: 'x' })).toThrow(HttpError);
  });

  it('parses the snapshot returned by get_pack_source and refuses a malformed one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parsePackSource(row)).toMatchObject({
      unitId: row.unit_id,
      versionNo: 2,
      minAppVersion: '1.0.0',
      isCurrent: true,
      deleted: false,
      packManifestPath: null,
      contentHash: null,
    });
    const built = {
      ...row,
      pack_manifest_path: 'units/x/2/manifest.json',
      content_hash: 'a'.repeat(64),
    };
    expect(parsePackSource(built)).toMatchObject({
      packManifestPath: built.pack_manifest_path,
      contentHash: built.content_hash,
    });
    for (const bad of [
      null,
      { ...row, version_no: 0 },
      { ...row, unit_id: 'nope' },
      { ...row, min_app_version: 'latest' },
      { ...row, content: null },
      { ...row, is_current: 'yes' },
      { ...row, content_hash: 'abc' },
    ]) {
      expect(() => parsePackSource(bad)).toThrow(HttpError);
    }
  });
});
