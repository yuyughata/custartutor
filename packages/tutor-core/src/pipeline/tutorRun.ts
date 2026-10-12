// One tutor model call, started in the background and pumped into a channel, so the pipeline can HOLD its tokens
// until the moderation verdict has arrived and can abort the call when the verdict says the model must not reply.
// It records the call's usage as soon as it is known (the `done` event, or the usage a failed call carries), so a
// call that is aborted after it finished, or that the API billed and then refused, is still counted.
import type { UsageRecord } from '@custar/authoring-core';
import type { TutorLlm, TutorLlmEvent, TutorLlmRequest } from '../contract';
import { usageRecord, usageRecordOfError } from '../usage';
import { createChannel } from './channel';
import type { Channel } from './channel';

export interface TutorRun {
  events: Channel<TutorLlmEvent>;
  /** Stops the model call. Safe to call more than once. */
  abort(): void;
  /** Settles when the call ended (naturally, with an error, or because it was aborted). Never rejects. */
  settled: Promise<void>;
  usage(): UsageRecord | null;
  model(): string | null;
}

export function startTutorRun(
  tutorLlm: TutorLlm,
  request: TutorLlmRequest,
  options: { signal?: AbortSignal | undefined; now: () => Date },
): TutorRun {
  const controller = new AbortController();
  const outer = options.signal;
  const forward = (): void => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', forward, { once: true });

  const events = createChannel<TutorLlmEvent>();
  let record: UsageRecord | null = null;
  let model: string | null = null;
  const started = options.now().getTime();

  const settled = (async (): Promise<void> => {
    try {
      for await (const event of tutorLlm.stream({ ...request, signal: controller.signal })) {
        if (event.type === 'done') {
          model = event.model;
          record = usageRecord({
            label: request.label,
            task: 'tutor',
            model: event.model,
            usage: event.usage,
            stopReason: event.stopReason,
            startedMs: started,
            endedMs: options.now().getTime(),
          });
        }
        events.push(event);
      }
      events.close();
    } catch (error) {
      const billed = usageRecordOfError(error, {
        label: request.label,
        task: 'tutor',
        startedMs: started,
        endedMs: options.now().getTime(),
      });
      if (billed) {
        record = billed;
        model = billed.model;
      }
      events.fail(error);
    } finally {
      outer?.removeEventListener('abort', forward);
    }
  })();

  return {
    events,
    abort: () => controller.abort(),
    settled,
    usage: () => record,
    model: () => model,
  };
}
