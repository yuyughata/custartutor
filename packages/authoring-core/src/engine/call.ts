// The one place a step talks to the model: time the call, turn LlmResult.usage into a UsageRecord, map every
// model-port failure to a StepError, and give a reply that fails validation exactly one repair retry.
import type { z } from 'zod';
import {
  LlmError,
  StepError,
  type LlmErrorCode,
  type LlmMessage,
  type LlmResult,
  type LlmSystemBlock,
  type StepDeps,
  type UsageRecord,
} from '../contract';
import { usageOfError } from '../llm/errors';
import type { AuthoringSchemaName } from '../prompts/schemas';
import { effortFor, maxTokensFor } from './settings';
import { isRecord, scrubSecrets, truncate } from './util';

export interface ModelCall<T> {
  /** The step name, for StepError. */
  step: string;
  /** Step family for settings: `unit_generate:section`. */
  family: string;
  /** Label for logs and `ai_usage`: `unit_generate:section:concept_1`. */
  label: string;
  schemaName: AuthoringSchemaName;
  schema: z.ZodType<T>;
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  /**
   * Semantic checks on a reply the adapter already validated against `schema` (ids that must exist, counts,
   * the grouping the model must not change). A non-empty list triggers the repair retry.
   */
  check?: (value: T) => string[];
}

const LLM_CODES: readonly string[] = ['refusal', 'schema', 'truncated', 'transport', 'aborted'];

/** `instanceof` is not enough when the adapter is bundled separately, so also accept the same shape. */
function asLlmError(error: unknown): LlmError | null {
  if (error instanceof LlmError) return error;
  if (
    isRecord(error) &&
    error['name'] === 'LlmError' &&
    typeof error['code'] === 'string' &&
    LLM_CODES.includes(error['code'])
  ) {
    return error as unknown as LlmError;
  }
  return null;
}

/**
 * Maps a model-port failure to a StepError. `usage` is what the step already spent (successful calls, plus the
 * failed call itself when the API answered and billed it): a refusal or a bad reply still costs tokens, and the
 * budgets must count them.
 */
export function mapModelError(step: string, error: unknown, usage: UsageRecord[] = []): StepError {
  if (error instanceof StepError) {
    return usage.length === 0
      ? error
      : new StepError(error.step, error.code, error.message, {
          retryable: error.retryable,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          usage: [...usage, ...error.usage],
          cause: error,
        });
  }
  const llm = asLlmError(error);
  if (!llm) {
    const message = error instanceof Error ? error.message : String(error);
    return new StepError(step, 'internal', message, { usage, cause: error });
  }
  const code = llm.code as LlmErrorCode;
  switch (code) {
    case 'transport':
      return new StepError(step, 'transport', llm.message, {
        retryable: llm.retryable,
        ...(llm.retryAfterMs !== undefined ? { retryAfterMs: llm.retryAfterMs } : {}),
        usage,
        cause: error,
      });
    case 'aborted':
      return new StepError(step, 'aborted', llm.message, { usage, cause: error });
    case 'refusal':
      return new StepError(step, 'refusal', llm.message, { retryable: false, usage, cause: error });
    case 'truncated':
      return new StepError(step, 'truncated', llm.message, {
        retryable: false,
        usage,
        cause: error,
      });
    case 'schema':
      return new StepError(step, 'schema', llm.message, { retryable: false, usage, cause: error });
  }
}

/** Adds text to the final user message (or adds a user message). */
export function withExtraUserText(messages: LlmMessage[], text: string): LlmMessage[] {
  const copy = messages.map((message) => ({ ...message }));
  const last = copy[copy.length - 1];
  if (!last || last.role !== 'user') return [...copy, { role: 'user', content: text }];
  last.content =
    typeof last.content === 'string'
      ? `${last.content}\n\n${text}`
      : [...last.content, { type: 'text', text }];
  return copy;
}

const MAX_ECHO_CHARS = 24_000;

function repairMessages(
  original: LlmMessage[],
  previousReply: string | undefined,
  problems: string,
): LlmMessage[] {
  const instruction =
    `Your previous reply was rejected by the checker.\n\nProblems:\n${truncate(scrubSecrets(problems), 3500)}\n\n` +
    'Reply again with the COMPLETE corrected JSON object. Fix every problem listed and change nothing else. ' +
    'Do not explain or apologise.';
  if (previousReply && previousReply.length > 0 && previousReply.length <= MAX_ECHO_CHARS) {
    return [
      ...original,
      { role: 'assistant', content: scrubSecrets(previousReply) },
      { role: 'user', content: instruction },
    ];
  }
  return withExtraUserText(original, instruction);
}

function bulletList(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

/**
 * Runs one structured call. At most two model calls happen: the first, and one repair retry when the reply
 * fails the adapter's schema validation (LlmError 'schema') or the step's own `check`.
 */
export async function callModel<T>(
  deps: StepDeps,
  spec: ModelCall<T>,
): Promise<{ value: T; usage: UsageRecord[] }> {
  const usage: UsageRecord[] = [];
  let messages = spec.messages;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (deps.signal?.aborted) {
      throw new StepError(spec.step, 'aborted', 'The step ran out of time before the model call.', {
        usage,
      });
    }
    const started = deps.now().getTime();
    let result: LlmResult<T>;
    try {
      result = await deps.llm.generate<T>({
        task: 'authoring',
        label: spec.label,
        system: spec.system,
        messages,
        schema: spec.schema,
        schemaName: spec.schemaName,
        effort: effortFor(deps.settings, spec.family),
        maxTokens: maxTokensFor(spec.family),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    } catch (error) {
      const finished = deps.now().getTime();
      // a call the API answered (refusal, truncation, a reply that failed the schema) was billed: count it
      const spent = usageOfError(error);
      if (spent) {
        usage.push({
          label: spec.label,
          task: 'authoring',
          model: spent.model,
          input_tokens: spent.usage.input_tokens,
          output_tokens: spent.usage.output_tokens,
          cache_read_tokens: spent.usage.cache_read_tokens,
          cache_creation_tokens: spent.usage.cache_creation_tokens,
          stop_reason: spent.stopReason,
          duration_ms: Math.max(0, Math.round(finished - started)),
        });
      }
      const llm = asLlmError(error);
      if (llm && llm.code === 'schema' && attempt === 1) {
        messages = repairMessages(
          spec.messages,
          llm.raw,
          bulletList(llm.message.split('\n').filter((line) => line.trim() !== '')),
        );
        continue;
      }
      throw mapModelError(spec.step, error, usage);
    }
    const finished = deps.now().getTime();
    usage.push({
      label: spec.label,
      task: 'authoring',
      model: result.model,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_read_tokens: result.usage.cache_read_tokens,
      cache_creation_tokens: result.usage.cache_creation_tokens,
      stop_reason: result.stopReason,
      duration_ms: Math.max(0, Math.round(finished - started)),
    });

    const problems = spec.check ? spec.check(result.value) : [];
    if (problems.length === 0) return { value: result.value, usage };
    if (attempt === 2) {
      throw new StepError(
        spec.step,
        'schema',
        `The model's reply is still invalid after one repair attempt: ${problems.slice(0, 8).join(' | ')}`,
        { retryable: false, usage },
      );
    }
    messages = repairMessages(spec.messages, JSON.stringify(result.value), bulletList(problems));
  }
  throw new StepError(spec.step, 'internal', 'unreachable', { usage });
}
