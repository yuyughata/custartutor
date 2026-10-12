import { SyncApiError } from '../api';
import type { SyncApi } from '../api';
import { MASTERY_THRESHOLD, deriveUnitProgress } from '../mastery';
import { MAX_PULL_LIMIT, MAX_PUSH_BATCH, WireEvent } from '../wire';
import type {
  ChildRow,
  HouseholdRow,
  PackDownload,
  PublishedRow,
  PullResponse,
  PushResult,
  SubjectRow,
  UnitProgressRow,
  UnitRow,
} from '../wire';
import type { UrlResolver } from './fake-downloader';
import type { BuiltPack } from './pack-builder';

export type FakeApiMethod =
  'pushEvents' | 'pull' | 'getPackDownload' | 'elevateGrownup' | 'setGrownupPin';

export interface FakeSyncApiOptions {
  /** Milliseconds since the epoch; default `Date.now`. Pass a `ManualClock`'s `now` for deterministic tests. */
  now?: () => number;
  /** Where signed pack URLs point. Default `https://packs.fake.custar.test`. */
  baseUrl?: string;
}

type NewRow<T> = Omit<T, 'sync_seq' | 'deleted_at'>;

const WEAK_PINS = new Set(['0123', '1234', '4321', '12345', '54321', '123456', '654321']);

/**
 * An in-memory SERVER that implements `SyncApi` the way the Supabase RPCs in `wire.ts` behave: one global
 * `sync_seq`, tombstones, a household membership epoch, idempotent event ingest with per-row results, derived
 * `unit_progress`, signed pack URLs, and a server-side grown-up PIN with lockout.
 *
 * Use it in unit tests and in the app's demo mode. Mutators such as `addChild`, `deleteChild` or
 * `bumpEpoch` play the part of "something changed on the server". Failure knobs: `setOffline`, `failNext`,
 * `failOnCall`, `rejectEventsWhere` (a poison row), `loseNextPushResponse`, `expireSignedUrls`.
 */
export class FakeSyncApi implements SyncApi, UrlResolver {
  // ---- the "database" --------------------------------------------------------------------------
  private seq = 0;
  private epoch = 1;
  private household: HouseholdRow | null = null;
  private readonly children = new Map<string, ChildRow>();
  private readonly subjects = new Map<string, SubjectRow>();
  private readonly units = new Map<string, UnitRow>();
  private readonly published = new Map<string, PublishedRow>();
  private readonly progress = new Map<string, UnitProgressRow>();
  private readonly events = new Map<string, WireEvent>();
  private readonly packs = new Map<string, BuiltPack>();
  private readonly hiddenChildren = new Set<string>();

  // ---- knobs and logs --------------------------------------------------------------------------
  readonly calls: Record<FakeApiMethod, number> = {
    pushEvents: 0,
    pull: 0,
    getPackDownload: 0,
    elevateGrownup: 0,
    setGrownupPin: 0,
  };
  /** Every batch that reached `pushEvents`, as received. */
  readonly pushBatches: WireEvent[][] = [];
  /** Every `pull` request. */
  readonly pullRequests: { sinceSeq: number; limit: number }[] = [];
  readonly elevations: { deviceId: string; at: number }[] = [];
  private offline = false;
  private authExpired = false;
  private loseNextPush = false;
  private readonly plans: { method: FakeApiMethod; call: number; error: SyncApiError }[] = [];
  private readonly poison: { match: (event: WireEvent) => boolean; reason: string }[] = [];
  private generation = 1;
  private minValidGeneration = 1;
  private urlsBroken = false;

  // ---- PIN ------------------------------------------------------------------------------------
  private pin: string | null = null;
  private pinFailures = 0;
  private pinLockedUntil = 0;
  private elevatedUntil = 0;

  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(options: FakeSyncApiOptions = {}) {
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl ?? 'https://packs.fake.custar.test';
  }

  private stamp(): number {
    this.seq += 1;
    return this.seq;
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // =============================================================================================
  // Server-side mutators (what an admin or another device does)
  // =============================================================================================

  setHousehold(household: HouseholdRow | null): void {
    this.household = household;
  }

  addChild(input: NewRow<ChildRow>): ChildRow {
    const row: ChildRow = { ...input, sync_seq: this.stamp(), deleted_at: null };
    this.children.set(row.id, row);
    return row;
  }

  updateChild(id: string, patch: Partial<NewRow<ChildRow>>): ChildRow {
    const current = this.children.get(id);
    if (!current) throw new Error(`No child ${id}`);
    const row: ChildRow = { ...current, ...patch, sync_seq: this.stamp() };
    this.children.set(id, row);
    return row;
  }

  /** Soft delete: the row stays as a tombstone for clients to learn about. */
  deleteChild(id: string): void {
    const current = this.children.get(id);
    if (!current) throw new Error(`No child ${id}`);
    this.children.set(id, { ...current, sync_seq: this.stamp(), deleted_at: this.iso() });
  }

  /**
   * Access revoked (tutor grant removed): the child silently disappears for this caller and the membership
   * epoch bumps, which tells clients to wipe and resync. No tombstone is sent.
   */
  revokeChild(id: string): void {
    this.hiddenChildren.add(id);
    this.bumpEpoch();
  }

  bumpEpoch(): void {
    this.epoch += 1;
  }

  addSubject(input: NewRow<SubjectRow>): SubjectRow {
    const row: SubjectRow = { ...input, sync_seq: this.stamp(), deleted_at: null };
    this.subjects.set(row.id, row);
    return row;
  }

  addUnit(input: NewRow<UnitRow>): UnitRow {
    const row: UnitRow = { ...input, sync_seq: this.stamp(), deleted_at: null };
    this.units.set(row.id, row);
    return row;
  }

  deleteUnit(id: string): void {
    const current = this.units.get(id);
    if (!current) throw new Error(`No unit ${id}`);
    this.units.set(id, { ...current, sync_seq: this.stamp(), deleted_at: this.iso() });
  }

  /**
   * Publishes a built pack as the unit's current version. Earlier versions of that unit that were current are
   * tombstoned, as the wire contract describes.
   */
  publishPack(pack: BuiltPack): PublishedRow {
    const { manifest } = pack;
    for (const [key, row] of this.published) {
      if (row.unit_id === manifest.unit_id && row.deleted_at === null) {
        this.published.set(key, { ...row, sync_seq: this.stamp(), deleted_at: this.iso() });
      }
    }
    const row: PublishedRow = {
      unit_id: manifest.unit_id,
      version_no: manifest.version_no,
      schema_version: manifest.schema_version,
      min_app_version: manifest.min_app_version,
      content_hash: manifest.content_hash,
      pack_manifest_path: `packs/${manifest.unit_id}/${manifest.version_no}/manifest.json`,
      sync_seq: this.stamp(),
      deleted_at: null,
    };
    this.published.set(`${manifest.unit_id}:${manifest.version_no}`, row);
    this.packs.set(`${manifest.unit_id}:${manifest.version_no}`, pack);
    return row;
  }

  unpublish(unitId: string, versionNo: number): void {
    const key = `${unitId}:${versionNo}`;
    const row = this.published.get(key);
    if (!row) throw new Error(`No published ${key}`);
    this.published.set(key, { ...row, sync_seq: this.stamp(), deleted_at: this.iso() });
  }

  // =============================================================================================
  // Inspection
  // =============================================================================================

  /** Events stored by the server, in arrival order. */
  acceptedEvents(): WireEvent[] {
    return [...this.events.values()];
  }

  progressRow(childId: string, unitId: string): UnitProgressRow | undefined {
    return this.progress.get(`${childId}:${unitId}`);
  }

  currentSyncSeq(): number {
    return this.seq;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  // =============================================================================================
  // Failure injection
  // =============================================================================================

  setOffline(offline: boolean): void {
    this.offline = offline;
  }

  setAuthExpired(expired: boolean): void {
    this.authExpired = expired;
  }

  /** The `call`-th call (1-based, counted per method since creation) of `method` fails with `error`. */
  failOnCall(method: FakeApiMethod, call: number, error?: SyncApiError): void {
    this.plans.push({ method, call, error: error ?? new SyncApiError('offline', 'Network lost') });
  }

  /** The next call of `method` fails. */
  failNext(method: FakeApiMethod, error?: SyncApiError): void {
    this.failOnCall(method, this.calls[method] + 1, error);
  }

  /** Rows matching `match` are always rejected with `reason` (a poison row). */
  rejectEventsWhere(match: (event: WireEvent) => boolean, reason = 'invalid_payload'): void {
    this.poison.push({ match, reason });
  }

  /** The next push is processed by the server, but the response never reaches the client. */
  loseNextPushResponse(): void {
    this.loseNextPush = true;
  }

  /** Invalidates every signed URL issued so far; new `getPackDownload` calls return working ones. */
  expireSignedUrls(): void {
    this.generation += 1;
    this.minValidGeneration = this.generation;
  }

  /** While true even freshly signed URLs answer 403. */
  breakSignedUrls(broken: boolean): void {
    this.urlsBroken = broken;
  }

  private enter(method: FakeApiMethod): void {
    this.calls[method] += 1;
    if (this.offline) throw new SyncApiError('offline', 'No connection');
    if (this.authExpired)
      throw new SyncApiError('unauthenticated', 'Session expired', { status: 401 });
    const index = this.plans.findIndex((p) => p.method === method && p.call === this.calls[method]);
    if (index >= 0) {
      const [plan] = this.plans.splice(index, 1);
      if (plan) throw plan.error;
    }
  }

  // =============================================================================================
  // SyncApi
  // =============================================================================================

  private childVisible(id: string): boolean {
    const child = this.children.get(id);
    return child !== undefined && child.deleted_at === null && !this.hiddenChildren.has(id);
  }

  async pushEvents(events: WireEvent[]): Promise<PushResult[]> {
    this.enter('pushEvents');
    if (events.length > MAX_PUSH_BATCH) {
      throw new SyncApiError('server', `Batch of ${events.length} exceeds ${MAX_PUSH_BATCH}`);
    }
    this.pushBatches.push(events.map((event) => ({ ...event })));
    const results = events.map((event) => this.ingest(event));
    if (this.loseNextPush) {
      this.loseNextPush = false;
      throw new SyncApiError('offline', 'Connection reset before the response arrived');
    }
    return Promise.resolve(results);
  }

  private ingest(raw: WireEvent): PushResult {
    const clientEventId = typeof raw.client_event_id === 'string' ? raw.client_event_id : 'unknown';
    const reject = (reason: string): PushResult => ({
      client_event_id: clientEventId,
      status: 'rejected',
      reason,
    });
    const parsed = WireEvent.safeParse(raw);
    if (!parsed.success) return reject('invalid_event');
    const event = parsed.data;
    if (!this.childVisible(event.child_id)) return reject('no_access_to_child');

    const key = `${event.child_id}:${event.client_event_id}`;
    if (this.events.has(key)) return { client_event_id: clientEventId, status: 'duplicate' };

    const poisoned = this.poison.find((p) => p.match(event));
    if (poisoned) return reject(poisoned.reason);

    if (event.event_type === 'mastery_check_completed') {
      const { score, passed, question_count: count } = event.payload;
      if (passed !== (count > 0 && score >= MASTERY_THRESHOLD))
        return reject('inconsistent_mastery');
    }

    this.events.set(key, event);
    this.recomputeProgress(event.child_id, event.unit_id);
    return { client_event_id: clientEventId, status: 'accepted' };
  }

  private recomputeProgress(childId: string, unitId: string): void {
    const events = [...this.events.values()].filter(
      (e) => e.child_id === childId && e.unit_id === unitId,
    );
    const derived = deriveUnitProgress(events);
    if (!derived) return;
    this.progress.set(`${childId}:${unitId}`, {
      child_id: childId,
      unit_id: unitId,
      ...derived,
      sync_seq: this.stamp(),
      deleted_at: null,
    });
  }

  async pull(sinceSeq: number, limit: number): Promise<PullResponse> {
    this.enter('pull');
    this.pullRequests.push({ sinceSeq, limit });
    const size = Math.max(1, Math.min(limit, MAX_PULL_LIMIT));

    type Tagged =
      | { seq: number; table: 'children'; row: ChildRow }
      | { seq: number; table: 'subjects'; row: SubjectRow }
      | { seq: number; table: 'units'; row: UnitRow }
      | { seq: number; table: 'published'; row: PublishedRow }
      | { seq: number; table: 'unit_progress'; row: UnitProgressRow };

    const all: Tagged[] = [];
    for (const row of this.children.values()) {
      if (!this.hiddenChildren.has(row.id)) all.push({ seq: row.sync_seq, table: 'children', row });
    }
    for (const row of this.subjects.values())
      all.push({ seq: row.sync_seq, table: 'subjects', row });
    for (const row of this.units.values()) all.push({ seq: row.sync_seq, table: 'units', row });
    for (const row of this.published.values())
      all.push({ seq: row.sync_seq, table: 'published', row });
    for (const row of this.progress.values()) {
      if (!this.hiddenChildren.has(row.child_id)) {
        all.push({ seq: row.sync_seq, table: 'unit_progress', row });
      }
    }
    const newer = all.filter((item) => item.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
    const page = newer.slice(0, size);

    const response: PullResponse = {
      epoch: this.epoch,
      next_seq: page.length > 0 ? (page[page.length - 1]?.seq ?? sinceSeq) : sinceSeq,
      has_more: newer.length > page.length,
      server_time: this.iso(),
      household: this.household,
      children: [],
      subjects: [],
      units: [],
      published: [],
      unit_progress: [],
    };
    for (const item of page) {
      switch (item.table) {
        case 'children':
          response.children.push(item.row);
          break;
        case 'subjects':
          response.subjects.push(item.row);
          break;
        case 'units':
          response.units.push(item.row);
          break;
        case 'published':
          response.published.push(item.row);
          break;
        case 'unit_progress':
          response.unit_progress.push(item.row);
          break;
      }
    }
    return Promise.resolve(JSON.parse(JSON.stringify(response)) as PullResponse);
  }

  // ---- packs -----------------------------------------------------------------------------------

  async getPackDownload(unitId: string, versionNo: number): Promise<PackDownload> {
    this.enter('getPackDownload');
    const key = `${unitId}:${versionNo}`;
    const row = this.published.get(key);
    const pack = this.packs.get(key);
    if (!row || row.deleted_at !== null || !pack) {
      throw new SyncApiError('forbidden', `No published pack ${key}`, { status: 403 });
    }
    const urls: Record<string, string> = {};
    for (const file of pack.manifest.files) {
      urls[file.path] = `${this.baseUrl}/${unitId}/${versionNo}/${file.path}?g=${this.generation}`;
    }
    const manifest = JSON.parse(JSON.stringify(pack.manifest)) as PackDownload['manifest'];
    return { manifest, urls, expires_at: this.iso(this.now() + 3_600_000) };
  }

  /** Answers a signed URL like the storage server: 200 with bytes, 403 when expired, 404 when unknown. */
  resolveUrl(url: string): { status: number; body?: Uint8Array } {
    if (!url.startsWith(`${this.baseUrl}/`)) return { status: 404 };
    const [pathPart = '', query = ''] = url.slice(this.baseUrl.length + 1).split('?');
    const [unitId = '', version = '', ...rest] = pathPart.split('/');
    const generation = Number(/(?:^|&)g=(\d+)/.exec(query)?.[1]);
    if (this.urlsBroken || !(generation >= this.minValidGeneration)) return { status: 403 };
    const body = this.packs.get(`${unitId}:${version}`)?.files.get(rest.join('/'));
    return body ? { status: 200, body } : { status: 404 };
  }

  // ---- grown-up PIN ----------------------------------------------------------------------------

  async elevateGrownup(deviceId: string, pin: string): Promise<{ expires_at: string }> {
    this.enter('elevateGrownup');
    const now = this.now();
    if (this.pin === null) throw new SyncApiError('forbidden', 'pin_not_set');
    if (this.pinLockedUntil > now) throw new SyncApiError('invalid_pin', 'locked');
    if (pin !== this.pin) {
      this.pinFailures += 1;
      if (this.pinFailures >= 5) {
        const seconds = Math.min(30 * 2 ** Math.min(this.pinFailures - 5, 12), 21_600);
        this.pinLockedUntil = now + seconds * 1000;
      }
      throw new SyncApiError('invalid_pin', 'wrong pin');
    }
    this.pinFailures = 0;
    this.pinLockedUntil = 0;
    this.elevatedUntil = now + 10 * 60_000;
    this.elevations.push({ deviceId, at: now });
    return { expires_at: this.iso(this.elevatedUntil) };
  }

  async setGrownupPin(pin: string): Promise<void> {
    this.enter('setGrownupPin');
    if (!/^\d{4,6}$/.test(pin) || /^(\d)\1+$/.test(pin) || WEAK_PINS.has(pin)) {
      throw new SyncApiError('weak_pin', 'weak_pin');
    }
    if (this.pin !== null && this.elevatedUntil <= this.now()) {
      throw new SyncApiError('elevation_required', 'elevation_required');
    }
    this.pin = pin;
    this.pinFailures = 0;
    this.pinLockedUntil = 0;
  }

  /** Test shortcut: set a PIN without the elevation rule. */
  seedPin(pin: string): void {
    this.pin = pin;
  }

  hasPin(): boolean {
    return this.pin !== null;
  }
}
