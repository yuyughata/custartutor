import type { WireEvent } from './wire';

/** Builders for wire events in tests. Not exported from the package. */

export const CHILD_A = '00000000-0000-4000-8000-00000000c1a0';
export const CHILD_B = '00000000-0000-4000-8000-00000000c1b0';
export const UNIT_1 = '00000000-0000-4000-8000-0000000000a1';
export const UNIT_2 = '00000000-0000-4000-8000-0000000000a2';
export const DEVICE = 'device-test';

let counter = 0;

export function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface Base {
  client_event_id?: string;
  child_id?: string;
  unit_id?: string;
  device_id?: string;
  device_seq?: number;
  occurred_at?: string;
}

function base(o: Base): Omit<WireEvent, 'event_type' | 'payload'> {
  counter += 1;
  return {
    client_event_id: o.client_event_id ?? uuidN(10_000 + counter),
    child_id: o.child_id ?? CHILD_A,
    unit_id: o.unit_id ?? UNIT_1,
    device_id: o.device_id ?? DEVICE,
    device_seq: o.device_seq ?? counter,
    occurred_at: o.occurred_at ?? new Date(Date.UTC(2026, 9, 12, 8, 0, counter)).toISOString(),
  };
}

export const startedEvent = (o: Base = {}): WireEvent => ({
  ...base(o),
  event_type: 'unit_started',
  payload: {},
});

export const sectionEvent = (sectionId: string, o: Base = {}): WireEvent => ({
  ...base(o),
  event_type: 'section_completed',
  payload: { section_id: sectionId },
});

export const answeredEvent = (
  questionId: string,
  result: 'correct' | 'incorrect' | 'partial' | 'ungraded',
  o: Base = {},
): WireEvent => ({
  ...base(o),
  event_type: 'question_answered',
  payload: {
    question_id: questionId,
    result,
    score: result === 'correct' ? 1 : result === 'ungraded' ? null : 0,
    attempt: 1,
  },
});

export const masteryEvent = (score: number, passed: boolean, o: Base = {}): WireEvent => ({
  ...base(o),
  event_type: 'mastery_check_completed',
  payload: { score, passed, question_count: 3, version_no: 1 },
});

export const completedEvent = (o: Base = {}): WireEvent => ({
  ...base(o),
  event_type: 'unit_completed',
  payload: {},
});

/** Deterministic Fisher-Yates using a tiny LCG, so failures reproduce. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
