import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobApi, JobKind, JobParams, JobRow } from '@custar/authoring-core';
import {
  JobController,
  type JobControllerOptions,
  type JobControllerState,
} from '../jobs/JobController';

export interface JobHandle extends JobControllerState {
  start: <K extends JobKind>(
    kind: K,
    params: JobParams[K],
    idempotencyKey?: string,
  ) => Promise<JobRow | undefined>;
  resume: (jobId: string) => Promise<JobRow | undefined>;
  cancel: () => Promise<void>;
  reset: () => void;
}

/**
 * A job driven by this screen. Leaving the screen stops watching but does NOT cancel the job; opening it
 * again and calling `resume(jobId)` continues it.
 */
export function useJob(
  api: JobApi,
  pollMs: number,
  callbacks: Pick<JobControllerOptions, 'onCreated' | 'onFinished'> = {},
): JobHandle {
  const controller = useMemo(() => new JobController({ api, pollMs }), [api, pollMs]);
  const [state, setState] = useState<JobControllerState>(controller.state);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    controller.attach();
    controller.configure({
      onCreated: (job) => callbacksRef.current.onCreated?.(job),
      onFinished: (job) => callbacksRef.current.onFinished?.(job),
    });
    setState(controller.state);
    const off = controller.subscribe(setState);
    return () => {
      off();
      controller.dispose();
    };
  }, [controller]);

  const start = useCallback<JobHandle['start']>((kind, params, key) => controller.start(kind, params, key), [controller]);
  const resume = useCallback((jobId: string) => controller.resume(jobId), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);
  const reset = useCallback(() => controller.reset(), [controller]);
  return { ...state, start, resume, cancel, reset };
}
