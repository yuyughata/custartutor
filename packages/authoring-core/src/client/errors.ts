// Client-side failures of the `ai-job` protocol. Not part of the contract file, which only lists the codes.
import { AI_JOB_ERROR_CODES } from '../contract';
import type { AiJobErrorCode } from '../contract';

/**
 * A rejected request to the job API. The live `JobApi` throws it from the `AiJobErrorBody` the edge function
 * answers with; the in-memory API throws it for the same situations. `runJob` retries every other failure
 * (network errors, 5xx) but gives up at once on one of these: asking again cannot change the answer.
 */
export class AiJobApiError extends Error {
  readonly code: AiJobErrorCode;
  readonly status?: number;

  constructor(
    code: AiJobErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiJobApiError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

const PERMANENT_CODES: ReadonlySet<string> = new Set(
  AI_JOB_ERROR_CODES.filter((code) => code !== 'internal'),
);

/** True for an error that carries a protocol `code` other than `internal`. Duck-typed on `code`. */
export function isPermanentJobApiError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PERMANENT_CODES.has(code);
}

/** `runJob` stopped because its `AbortSignal` fired. The job itself is untouched and keeps its state. */
export class JobAbortedError extends Error {
  constructor(message = 'Stopped watching the job; the job itself was not cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

/** `runJob` gave up: the job was asked to step several times in a row and nothing changed. */
export class JobStalledError extends Error {
  readonly jobId: string;

  constructor(jobId: string, steps: number) {
    super(`Job ${jobId} did not advance after ${steps} step requests`);
    this.name = 'JobStalledError';
    this.jobId = jobId;
  }
}
