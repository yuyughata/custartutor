// Voice framework: the interfaces only (plan section 7). Text-first milestones ship a read-aloud implementation
// and a no-op recognizer; STT/TTS providers are chosen later. Voice turns are audio -> transcript (+ confidence)
// -> the same tutor pipeline, so the server only ever sees text plus `input_mode`.

export interface SpeakOptions {
  /** BCP 47 tag, for example `en-NG`. */
  lang?: string;
  /** 1 is normal speed; young children and pre-readers start slower. */
  rate?: number;
}

export interface SpeechSynthesizer {
  /** False when the device has no usable voice. Callers hide read-aloud buttons then. */
  isAvailable(): Promise<boolean>;
  /** Resolves when the speech finishes or is stopped. `**bold**` markers are stripped before speaking. */
  speak(text: string, options?: SpeakOptions): Promise<void>;
  stop(): Promise<void>;
}

export interface Transcript {
  text: string;
  /** 0 to 1 when the engine reports one. */
  confidence?: number;
}

export interface SpeechRecognizer {
  isAvailable(): Promise<boolean>;
  /** Listens once and resolves with the transcript, or null if nothing was heard. */
  listen(options?: { lang?: string; signal?: AbortSignal }): Promise<Transcript | null>;
}

/** The recognizer of the text-first milestones: never available, never listens. */
export const noopRecognizer: SpeechRecognizer = {
  isAvailable: () => Promise.resolve(false),
  listen: () => Promise.resolve(null),
};

/** Removes the `**bold**` markers of lesson text so a synthesizer does not read them out. */
export function plainForSpeech(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}
