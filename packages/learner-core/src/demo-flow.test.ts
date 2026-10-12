import { describe, expect, it } from 'vitest';
import { getOrCreateDeviceId } from './db/meta';
import { listChildProgress } from './db/progress';
import { listChildren, listSubjects, listUnits } from './db/reference';
import { outboxCounts, listPendingEvents } from './db/outbox';
import { DEMO_IDS, DEMO_PIN, FakeDownloader, correctResponse, createDemoServer } from './fakes';
import { effectiveProgress, unlockStates } from './mastery';
import { DownloadManager, packStatuses } from './packs';
import { PinGate } from './pin';
import { LessonSession } from './session';
import { SyncEngine } from './sync';
import { createTestPorts, createTrustedClock } from './testing';

/**
 * The whole learner journey on the in-memory server, wired the way the app wires the ports. It is both an
 * integration test and a worked example (see the README).
 */
describe('demo journey: sync, download, play offline, master, sync, unlock', () => {
  it('works end to end', async () => {
    const base = await createTestPorts({ seed: 'journey' });
    const demo = await createDemoServer({ now: () => base.clock.now() });
    const trusted = await createTrustedClock(base);
    // the app's ports: the trusted clock replaces the raw device clock, the downloader talks to the demo server
    const ports = { ...base, clock: trusted, downloader: new FakeDownloader(base.files, demo.api) };

    const sync = new SyncEngine({ ports, api: demo.api, trustedClock: trusted });
    const downloads = new DownloadManager({
      ports,
      api: demo.api,
      network: base.network,
      appVersion: '1.0.0',
    });

    // 1. first sync brings the household, children, curriculum and the list of packs
    const first = await sync.syncOnce();
    expect(first.ok).toBe(true);
    expect((await listChildren(ports.db)).map((c) => c.display_alias).sort()).toEqual([
      'Ada',
      'Tobi',
    ]);
    expect(await listSubjects(ports.db)).toHaveLength(2);
    expect(await listUnits(ports.db)).toHaveLength(3);
    expect((await packStatuses(ports.db)).every((s) => s.availability === 'not_downloaded')).toBe(
      true,
    );
    expect(trusted.offlineGraceValid()).toBe(true);

    // 2. only the first unit of the Basic Science chain is open
    const chain = await listUnits(ports.db, {
      subjectId: DEMO_IDS.subjectScience,
      levelCode: 'P1',
    });
    expect(chain.map((u) => u.id)).toEqual([DEMO_IDS.unitEnvironment, DEMO_IDS.unitColours]);
    const none = new Map<string, { status: 'in_progress' | 'mastered' }>();
    expect([...unlockStates(chain, none).values()]).toEqual(['available', 'locked']);

    // 3. download the lesson (and see the shared picture stored once)
    const report = await downloads.downloadUnit(DEMO_IDS.unitEnvironment, 1, { wifiOnly: true });
    expect(report.filesDownloaded).toBe(3); // learner.json, grownup.json, one picture
    expect(
      (await packStatuses(ports.db)).find((s) => s.unitId === DEMO_IDS.unitEnvironment),
    ).toMatchObject({
      availability: 'up_to_date',
    });

    // 4. airplane mode: play the whole lesson and pass the mastery check
    demo.api.setOffline(true);
    base.network.online = false;
    const lesson = await downloads.loadActiveLesson(DEMO_IDS.unitEnvironment);
    const session = new LessonSession({
      unit: lesson.unit,
      unitId: lesson.unitId,
      versionNo: lesson.versionNo,
      childId: DEMO_IDS.childAda,
      ports,
    });
    for (const section of lesson.unit.sections) {
      await session.completeSection(section.id);
      base.clock.advance(20_000);
    }
    for (const question of Object.values(lesson.unit.questions)) {
      await session.answer(question.id, correctResponse(question));
    }
    expect((await session.submitMasteryCheck()).passed).toBe(true);

    // offline: the server cannot be reached, nothing is lost, the lesson still opens
    const offline = await sync.syncOnce();
    expect(offline).toMatchObject({ ok: false, retryable: true });
    const pending = await outboxCounts(ports.db);
    expect(pending.pending).toBeGreaterThan(20);
    expect(trusted.canPlayOffline()).toBe(true);
    await expect(downloads.loadActiveLesson(DEMO_IDS.unitEnvironment)).resolves.toBeDefined();

    // the UI already shows the pending pass (effective progress), and unlocks nothing yet on the server's word
    const pendingEvents = await listPendingEvents(
      ports.db,
      DEMO_IDS.childAda,
      DEMO_IDS.unitEnvironment,
    );
    const shown = effectiveProgress(null, pendingEvents);
    expect(shown).toMatchObject({ status: 'mastered', has_pending: true });

    // 5. back online: push, then pull the server-derived progress
    demo.api.setOffline(false);
    base.network.online = true;
    const online = await sync.syncOnce();
    expect(online.ok).toBe(true);
    expect((await outboxCounts(ports.db)).pending).toBe(0);
    expect(demo.api.acceptedEvents().some((e) => e.event_type === 'mastery_check_completed')).toBe(
      true,
    );
    const progress = await listChildProgress(ports.db, DEMO_IDS.childAda);
    expect(progress.get(DEMO_IDS.unitEnvironment)).toMatchObject({
      status: 'mastered',
      attempts: 1,
    });
    expect((await listChildProgress(ports.db, DEMO_IDS.childTobi)).size).toBe(0);
    expect(effectiveProgress(progress.get(DEMO_IDS.unitEnvironment) ?? null, [])).toMatchObject({
      status: 'mastered',
      has_pending: false,
    });

    // 6. mastering the lesson opens the project
    expect([...unlockStates(chain, progress).values()]).toEqual(['mastered', 'available']);
    await downloads.downloadUnit(DEMO_IDS.unitColours, 1);
    const project = await downloads.loadActiveUnit(DEMO_IDS.unitColours);
    expect(project.unit.kind).toBe('mini_project');
    expect(await downloads.loadGrownupContent(DEMO_IDS.unitColours)).toBeNull();
    await downloads.downloadUnit(DEMO_IDS.unitMarket, 1);
    expect(base.files.list('blobs/')).toHaveLength(1); // the shared picture is stored once

    // 7. a guardian on this device enters the household PIN once; later the offline gate works
    const gate = new PinGate({
      secure: ports.secure,
      hasher: ports.hasher,
      clock: ports.clock,
      random: ports.random,
      api: demo.api,
      deviceId: () => getOrCreateDeviceId(ports.db, ports.random),
      rounds: 20,
    });
    await gate.adoptServerPin(DEMO_PIN);
    demo.api.setOffline(true);
    expect(await gate.verifyLocal(DEMO_PIN)).toBe(true);
    expect(await gate.verifyLocal('0000')).toBe(false);
  });
});
