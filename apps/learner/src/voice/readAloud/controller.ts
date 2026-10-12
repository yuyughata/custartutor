import { plainForSpeech } from '@custar/tutor-core/client';
import type { SpeechSynthesizer } from '@custar/tutor-core/client';

export interface ReadAloudSnapshot {
  /** Whether the device can speak. `null` until the first check has finished (buttons stay hidden). */
  available: boolean | null;
  /** The key of what is being read right now, or null when nothing is. */
  speakingKey: string | null;
}

export interface ReadAloudRun {
  /** Identifies this run; `stopIfCurrent(token)` ends it only if nothing newer has started. */
  token: number;
  /** Resolves when the speech finishes or is stopped. Never rejects. */
  done: Promise<void>;
}

export interface ReadAloudOptions {
  /** Which speaker button (or caller) this is, so each button shows its own idle / speaking state. */
  key?: string;
  lang?: string;
  rate?: number;
}

/**
 * The state of read-aloud, shared by every speaker button on screen: whether it is available and what is being
 * read. One voice at a time: starting a new reading stops the old one. Pure TypeScript (no React), so it is tested
 * with a fake synthesizer; `useReadAloud` subscribes to it.
 */
export class ReadAloudController {
  private snapshot: ReadAloudSnapshot = { available: null, speakingKey: null };
  private readonly listeners = new Set<() => void>();
  private token = 0;
  private checking: Promise<boolean> | null = null;

  constructor(private readonly synthesizer: SpeechSynthesizer) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadAloudSnapshot => this.snapshot;

  private update(patch: Partial<ReadAloudSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.available === this.snapshot.available && next.speakingKey === this.snapshot.speakingKey)
      return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Asks the synthesizer whether it can speak (once at a time; a "no" is asked again on the next call). */
  checkAvailability(): Promise<boolean> {
    this.checking ??= this.synthesizer
      .isAvailable()
      .catch(() => false)
      .then((available) => {
        this.update({ available });
        return available;
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /** Reads `text` aloud (bold markers removed). Empty text does nothing. */
  speak(text: string, options: ReadAloudOptions = {}): ReadAloudRun {
    const token = ++this.token;
    const clean = plainForSpeech(text);
    if (clean === '') {
      this.update({ speakingKey: null });
      return { token, done: Promise.resolve() };
    }
    this.update({ speakingKey: options.key ?? 'default' });
    const done = this.synthesizer
      .speak(clean, {
        ...(options.lang ? { lang: options.lang } : {}),
        ...(options.rate !== undefined ? { rate: options.rate } : {}),
      })
      .catch(() => undefined)
      .then(() => {
        if (this.token === token) this.update({ speakingKey: null });
      });
    return { token, done };
  }

  /** Stops whatever is being read. */
  async stop(): Promise<void> {
    this.token += 1;
    this.update({ speakingKey: null });
    try {
      await this.synthesizer.stop();
    } catch {
      // nothing to do
    }
  }

  /** Stops only if `token` is still the newest reading (a screen leaving must not cut off another's speech). */
  stopIfCurrent(token: number): void {
    if (this.token === token && this.snapshot.speakingKey !== null) void this.stop();
  }
}

const controllers = new WeakMap<SpeechSynthesizer, ReadAloudController>();

/** The one controller of a synthesizer: every hook and button on screen shares it. */
export function controllerFor(synthesizer: SpeechSynthesizer): ReadAloudController {
  let controller = controllers.get(synthesizer);
  if (!controller) {
    controller = new ReadAloudController(synthesizer);
    controllers.set(synthesizer, controller);
  }
  return controller;
}
