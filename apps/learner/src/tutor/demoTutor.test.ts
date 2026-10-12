import { beforeEach, describe, expect, it } from 'vitest';
import { DownloadManager } from '@custar/learner-core';
import {
  DEMO_IDS,
  FakeDownloader,
  FakeNetwork,
  createDemoServer,
} from '@custar/learner-core/fakes';
import { createTestPorts, type TestPorts } from '@custar/learner-core/testing';
import { CURRENT_TUTOR_CONSENT_VERSION, type TutorStreamEvent } from '@custar/tutor-core/client';
import { createDemoTutor } from './demoTutor';
import { buildTurnRequest } from './turnRunner';
import { transcriptLines } from '../consent/transcript';

// The demo TutorApi wired the way demo mode wires it: the lesson comes from the downloaded pack on the phone.

const CHILD = DEMO_IDS.childAda;
const UNIT = DEMO_IDS.unitEnvironment;

let ports: TestPorts;
let elevated = true;
let n = 0;
const turnId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function setup() {
  ports = await createTestPorts({ seed: 'demo-tutor' });
  const demo = await createDemoServer();
  // a phone with the lesson downloaded, signed in to the demo household
  ports.api.setHousehold({ id: DEMO_IDS.household, name: 'Demo' });
  ports.api.addChild({
    id: CHILD,
    household_id: DEMO_IDS.household,
    display_alias: 'Ada',
    avatar: null,
    level_code: 'P1',
    reading_mode: 'reader',
    daily_limit_min: null,
  });
  await ports.db.run(
    `INSERT INTO child (id, household_id, display_alias, level_code, reading_mode) VALUES (?, ?, 'Ada', 'P1', 'reader')`,
    [CHILD, DEMO_IDS.household],
  );
  const downloads = new DownloadManager({
    ports: {
      ...ports,
      downloader: new FakeDownloader(ports.files, demo.api),
    },
    api: demo.api,
    network: new FakeNetwork(),
    appVersion: '1.0.0',
  });
  await downloads.downloadUnit(UNIT, 1, { wifiOnly: false });
  return createDemoTutor({ ports, appVersion: '1.0.0', isElevated: () => elevated });
}

const ask = (text: string, sessionId?: string) =>
  buildTurnRequest(
    { childId: CHILD, unitId: UNIT, versionNo: 1, ...(sessionId ? { sessionId } : {}) },
    text,
    turnId(),
  );

beforeEach(() => {
  elevated = true;
});

describe('demo tutor wiring', () => {
  it('starts with consent off, grants it with the current wording, and withdraws it', async () => {
    const tutor = await setup();
    expect(await tutor.consent(CHILD)).toEqual({
      granted: false,
      version: null,
      required_version: CURRENT_TUTOR_CONSENT_VERSION,
    });
    await tutor.setConsent(CHILD, 'grant');
    expect((await tutor.consent(CHILD)).granted).toBe(true);
    await tutor.setConsent(CHILD, 'withdraw');
    expect((await tutor.consent(CHILD)).granted).toBe(false);
  });

  it('refuses to grant without an elevation, and a turn without consent', async () => {
    const tutor = await setup();
    elevated = false;
    await expect(tutor.setConsent(CHILD, 'grant')).rejects.toMatchObject({
      code: 'elevation_required',
    });
    elevated = true;
    await expect(tutor.sendTurn(ask('Hello'), () => undefined)).rejects.toMatchObject({
      code: 'consent_required',
    });
  });

  it('streams a labelled demo reply for the downloaded lesson', async () => {
    const tutor = await setup();
    await tutor.setConsent(CHILD, 'grant');
    const seen: TutorStreamEvent[] = [];
    const result = await tutor.sendTurn(ask('Where do we learn?'), (e) => seen.push(e));
    expect(seen.some((e) => e.type === 'delta')).toBe(true);
    expect(seen.at(-1)?.type).toBe('done');
    expect(result.reply).toMatch(/^Demo tutor \(not Claude\):/);
    expect(result.status).toBe('complete');
    // a repeat of the same turn id returns the stored result
    const request = ask('Where do we learn?');
    const first = await tutor.sendTurn(request, () => undefined);
    expect(await tutor.fetchTurn(CHILD, request.client_turn_id)).toEqual(first);
  });

  it('says the lesson is unknown when it is not downloaded', async () => {
    const tutor = await setup();
    await tutor.setConsent(CHILD, 'grant');
    const request = buildTurnRequest(
      { childId: CHILD, unitId: DEMO_IDS.unitMarket, versionNo: 1 },
      'Hello',
      turnId(),
    );
    await expect(tutor.sendTurn(request, () => undefined)).rejects.toMatchObject({
      code: 'unit_not_found',
    });
  });

  it('answers a crisis sentence with the fixed safe reply, and holds that turn back from the transcript', async () => {
    const tutor = await setup();
    await tutor.setConsent(CHILD, 'grant');
    const first = await tutor.sendTurn(ask('Where do we learn?'), () => undefined);
    const crisis = await tutor.sendTurn(
      ask('I want to hurt myself', first.session_id),
      () => undefined,
    );
    expect(crisis.status).toBe('safe_reply');
    expect(crisis.safety_action).toBe('safe_reply');
    expect(crisis.reply).toMatch(/grown-up you trust/);
    expect(crisis.reply).not.toMatch(/Demo tutor/); // the fixed text is the real one

    const sessions = await tutor.listSessions(CHILD);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.has_withheld).toBe(true);
    const lines = transcriptLines(await tutor.getTranscript(first.session_id));
    const held = lines.filter((line) => line.withheld);
    expect(held).toHaveLength(2);
    const everything = JSON.stringify(lines);
    expect(everything).not.toMatch(/hurt myself/i);
    expect(everything).not.toMatch(/grown-up you trust/);
  });

  it('redacts a phone number before it is stored', async () => {
    const tutor = await setup();
    await tutor.setConsent(CHILD, 'grant');
    const result = await tutor.sendTurn(ask('My number is 08031234567'), () => undefined);
    const messages = await tutor.getTranscript(result.session_id);
    expect(JSON.stringify(messages)).not.toContain('08031234567');
    expect(messages.some((m) => m.role === 'child' && m.text.includes('My number is'))).toBe(true);
  });

  it('needs an elevation to list sessions or read a transcript', async () => {
    const tutor = await setup();
    await tutor.setConsent(CHILD, 'grant');
    const result = await tutor.sendTurn(ask('Hello'), () => undefined);
    elevated = false;
    await expect(tutor.listSessions(CHILD)).rejects.toMatchObject({ code: 'elevation_required' });
    await expect(tutor.getTranscript(result.session_id)).rejects.toMatchObject({
      code: 'elevation_required',
    });
  });

  it('stops quietly when aborted while streaming back', async () => {
    const tutor = await setup();
    await tutor.setConsent(CHILD, 'grant');
    const controller = new AbortController();
    const run = tutor.sendTurn(
      ask('Where do we learn?'),
      (e) => {
        if (e.type === 'meta') controller.abort();
      },
      controller.signal,
    );
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});
