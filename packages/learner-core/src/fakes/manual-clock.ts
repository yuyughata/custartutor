import type { Clock } from '../ports';

/** A clock that only moves when told to. Starts at 2026-10-12 08:00 UTC unless given a time. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(startMs: number = Date.UTC(2026, 9, 12, 8, 0, 0)) {
    this.ms = startMs;
  }

  now(): number {
    return this.ms;
  }

  set(ms: number): void {
    this.ms = ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
