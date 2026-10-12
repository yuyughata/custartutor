// Turning a model call into the UsageRecord that `ai_usage` stores (tokens only, never text). Shared by the
// classifier, the tutor call and the output check so the three agree on how a billed failure is counted.
import { usageOfError } from '@custar/authoring-core';
import type { LlmTask, LlmUsage, UsageRecord } from '@custar/authoring-core';

export const EMPTY_USAGE: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

export interface UsageParts {
  label: string;
  task: LlmTask;
  model: string;
  usage: LlmUsage;
  stopReason: string | null;
  startedMs: number;
  endedMs: number;
}

export function usageRecord(parts: UsageParts): UsageRecord {
  return {
    label: parts.label,
    task: parts.task,
    model: parts.model,
    input_tokens: parts.usage.input_tokens,
    output_tokens: parts.usage.output_tokens,
    cache_read_tokens: parts.usage.cache_read_tokens,
    cache_creation_tokens: parts.usage.cache_creation_tokens,
    stop_reason: parts.stopReason,
    duration_ms: Math.max(0, Math.round(parts.endedMs - parts.startedMs)),
  };
}

/**
 * The record for a call that failed AFTER the API answered (a refusal, a reply that failed the schema): it was
 * billed, so it must be counted. Transport failures carry no usage and give null.
 */
export function usageRecordOfError(
  error: unknown,
  parts: Pick<UsageParts, 'label' | 'task' | 'startedMs' | 'endedMs'>,
): UsageRecord | null {
  const spent = usageOfError(error);
  if (!spent) return null;
  return usageRecord({
    ...parts,
    model: spent.model,
    usage: spent.usage,
    stopReason: spent.stopReason,
  });
}

/** A plain description of a failure for logs and results: no prompt text, no raw model output. */
export interface FailureInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export function describeFailure(error: unknown): FailureInfo {
  if (typeof error === 'object' && error !== null) {
    const { code, message, retryable } = error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    return {
      code: typeof code === 'string' ? code : 'internal',
      message: typeof message === 'string' ? message.slice(0, 300) : 'unknown error',
      retryable: typeof retryable === 'boolean' ? retryable : false,
    };
  }
  return { code: 'internal', message: 'unknown error', retryable: false };
}
