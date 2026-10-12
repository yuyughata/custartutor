// Errors of the model port that are not part of the contract: programmer errors (a request that could never
// succeed) and the usage a failed call still consumed.
import { LlmError } from '../contract';
import type { LlmUsage } from '../contract';

/**
 * A request that is wrong by construction (prefill, empty text, a schema structured outputs cannot express).
 * Deliberately NOT an `LlmError`: retrying cannot help, and the step engine must surface it as an internal
 * bug rather than as a model failure. Messages name the label and the field, never the prompt text.
 */
export class LlmRequestError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmRequestError';
  }
}

/**
 * An `LlmError` for a call the API answered (refusal, truncation, a reply that failed the schema). Those
 * calls are billed, so the error carries what they consumed and the engine can still log it to `ai_usage`
 * and count it against the budgets. Transport failures have no usage and stay plain `LlmError`s.
 */
export class LlmCallError extends LlmError {
  readonly usage: LlmUsage;
  /** The model the API reports it used. */
  readonly model: string;
  readonly stopReason: string | null;

  constructor(
    code: ConstructorParameters<typeof LlmError>[0],
    message: string,
    call: { usage: LlmUsage; model: string; stopReason: string | null },
    options: ConstructorParameters<typeof LlmError>[2] = {},
  ) {
    super(code, message, options);
    this.usage = call.usage;
    this.model = call.model;
    this.stopReason = call.stopReason;
  }
}

/** What a failed call consumed, when the failure came after the API answered. */
export function usageOfError(
  error: unknown,
): { usage: LlmUsage; model: string; stopReason: string | null } | undefined {
  return error instanceof LlmCallError
    ? { usage: error.usage, model: error.model, stopReason: error.stopReason }
    : undefined;
}
