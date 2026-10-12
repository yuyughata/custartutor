// Checks every `LlmRequest` must pass before it leaves the process. Shared by the Anthropic adapter and by
// `FakeLlm`, so a request the real API would reject also fails in tests.
import type { LlmContentPart, LlmRequest } from '../contract';
import { LlmRequestError } from './errors';

/**
 * Throws `LlmRequestError` for a request that can never succeed. Messages name the label and the field and
 * never include prompt text.
 */
export function assertValidRequest(request: LlmRequest<unknown>): void {
  const where = `LLM request "${request.label}"`;
  if (request.label.trim() === '') throw new LlmRequestError('LLM request has no label');
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
    throw new LlmRequestError(`${where}: maxTokens must be a positive integer`);
  }
  if (request.schemaName.trim() === '') {
    throw new LlmRequestError(`${where}: schemaName must not be empty`);
  }

  request.system.forEach((block, index) => {
    if (isBlank(block.text)) {
      throw new LlmRequestError(`${where}: system block ${index} has no text`);
    }
  });

  const { messages } = request;
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (first === undefined || last === undefined) {
    throw new LlmRequestError(`${where}: messages must not be empty`);
  }
  if (first.role !== 'user') {
    throw new LlmRequestError(`${where}: the first message must have role "user"`);
  }
  // These models reject a trailing assistant turn (prefill). Structured outputs replace it.
  if (last.role !== 'user') {
    throw new LlmRequestError(
      `${where}: the last message must have role "user" (assistant prefill is not supported)`,
    );
  }
  messages.forEach((message, index) => {
    if (typeof message.content === 'string') {
      if (isBlank(message.content)) {
        throw new LlmRequestError(`${where}: message ${index} has no text`);
      }
      return;
    }
    if (message.content.length === 0) {
      throw new LlmRequestError(`${where}: message ${index} has no content`);
    }
    message.content.forEach((part, partIndex) => assertValidPart(where, index, partIndex, part));
  });
}

function assertValidPart(
  where: string,
  messageIndex: number,
  partIndex: number,
  part: LlmContentPart,
): void {
  const at = `${where}: message ${messageIndex} part ${partIndex}`;
  if (part.type === 'text') {
    if (isBlank(part.text)) throw new LlmRequestError(`${at} has no text`);
  } else if (part.base64.length === 0) {
    throw new LlmRequestError(`${at} is a pdf with no data`);
  }
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}
