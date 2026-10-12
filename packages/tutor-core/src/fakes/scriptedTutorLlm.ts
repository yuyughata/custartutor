// A scripted TutorLlm for tests and demos. Platform neutral. It replays hand-written events, can wait on a gate (to
// make the classifier arrive before or after the tutor's tokens), can fail on demand, honours the AbortSignal
// like the real adapter, and records every request it receives. A call nobody scripted throws, so a test cannot
// pass by accident on an empty script.
import { DEFAULT_MODELS, LlmCallError, LlmError } from '@custar/authoring-core';
import type { LlmUsage } from '@custar/authoring-core';
import type { TutorLlm, TutorLlmEvent, TutorLlmRequest } from '../contract';

export interface Gate {
  /** Resolves when `open()` is called. */
  readonly opened: Promise<void>;
  open(): void;
}

export function createGate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

export type ScriptStep =
  | TutorLlmEvent
  /** Pauses the stream until the gate opens (or the call is aborted). */
  | { type: 'wait'; gate: Gate }
  /** Throws this error from the stream. */
  | { type: 'fail'; error: unknown };

export interface TutorScriptTurn {
  steps: ScriptStep[];
}

export const SCRIPTED_USAGE: LlmUsage = {
  input_tokens: 200,
  output_tokens: 40,
  cache_read_tokens: 150,
  cache_creation_tokens: 0,
};

export function doneStep(options: { usage?: Partial<LlmUsage>; model?: string; stopReason?: string } = {}): TutorLlmEvent {
  return {
    type: 'done',
    usage: { ...SCRIPTED_USAGE, ...options.usage },
    model: options.model ?? DEFAULT_MODELS.tutor,
    stopReason: options.stopReason ?? 'end_turn',
  };
}

/** `text` split into small `text` events, as a stream would deliver it. */
export function textSteps(text: string, chunkSize = 7): TutorLlmEvent[] {
  const steps: TutorLlmEvent[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    steps.push({ type: 'text', text: text.slice(i, i + chunkSize) });
  }
  return steps;
}

/** A normal reply: the text, optional tool calls, then `done`. */
export function replyTurn(
  text: string,
  options: { tools?: Array<{ name: string; input: unknown }>; stopReason?: string; usage?: Partial<LlmUsage> } = {},
): TutorScriptTurn {
  return {
    steps: [
      ...textSteps(text),
      ...(options.tools ?? []).map((tool): TutorLlmEvent => ({ type: 'tool', name: tool.name, input: tool.input })),
      doneStep({
        ...(options.stopReason ? { stopReason: options.stopReason } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
      }),
    ],
  };
}

/** A call the API answered and billed, then refused. */
export function refusalTurn(prefix = ''): TutorScriptTurn {
  return {
    steps: [
      ...(prefix === '' ? [] : textSteps(prefix)),
      {
        type: 'fail',
        error: new LlmCallError(
          'refusal',
          'The model declined this request',
          { usage: SCRIPTED_USAGE, model: DEFAULT_MODELS.tutor, stopReason: 'refusal' },
          { retryable: false },
        ),
      },
    ],
  };
}

export type TutorScript = TutorScriptTurn[] | ((request: TutorLlmRequest, index: number) => TutorScriptTurn);

export class ScriptedTutorLlm implements TutorLlm {
  /** Every request received, in order. */
  readonly requests: TutorLlmRequest[] = [];
  /** How many of those streams ran to the end, and how many were cut short by an abort. */
  completed = 0;
  aborted = 0;

  constructor(private readonly script: TutorScript = []) {}

  stream(request: TutorLlmRequest): AsyncIterable<TutorLlmEvent> {
    const index = this.requests.length;
    this.requests.push(request);
    const turn = typeof this.script === 'function' ? this.script(request, index) : this.script[index];
    if (!turn) {
      throw new Error(`ScriptedTutorLlm: nothing scripted for call ${index + 1} ("${request.label}")`);
    }
    const markAborted = (): LlmError => {
      this.aborted += 1;
      return new LlmError('aborted', 'The model call was aborted', { retryable: true });
    };
    const markCompleted = (): void => {
      this.completed += 1;
    };
    return (async function* () {
      for (const step of turn.steps) {
        if (request.signal?.aborted) throw markAborted();
        if (step.type === 'wait') {
          await new Promise<void>((resolve) => {
            void step.gate.opened.then(resolve);
            request.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          if (request.signal?.aborted) throw markAborted();
          continue;
        }
        if (step.type === 'fail') throw step.error;
        yield step;
        // let the consumer run between events, as a network stream would
        await Promise.resolve();
      }
      markCompleted();
    })();
  }
}
