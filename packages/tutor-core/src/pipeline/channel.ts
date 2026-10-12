// Two tiny async primitives for the pipeline. Platform neutral, no timers, deterministic.
//
// `createChannel` is a single-consumer queue that can fail: the tutor stream is pumped into one so its tokens can
// be HELD (nobody reads yet) until the moderation verdict has arrived, then drained in order.

export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  /** The consumer gets the error after the values already queued. */
  fail(error: unknown): void;
}

export function createChannel<T>(): Channel<T> {
  const values: T[] = [];
  let waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null =
    null;
  let closed = false;
  let failure: { error: unknown } | null = null;

  const wake = (): void => {
    if (!waiting) return;
    const consumer = waiting;
    if (values.length > 0) {
      waiting = null;
      consumer.resolve({ value: values.shift() as T, done: false });
    } else if (failure) {
      waiting = null;
      consumer.reject(failure.error);
    } else if (closed) {
      waiting = null;
      consumer.resolve({ value: undefined, done: true });
    }
  };

  return {
    push(value) {
      if (closed || failure) return;
      values.push(value);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    fail(error) {
      if (closed || failure) return;
      failure = { error };
      wake();
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () =>
          new Promise<IteratorResult<T>>((resolve, reject) => {
            waiting = { resolve, reject };
            wake();
          }),
        return: () => {
          closed = true;
          values.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/** The `events` of a turn run: an unbounded channel the pipeline writes to, whether or not anyone reads. */
export function createEventQueue<T>(): Channel<T> {
  return createChannel<T>();
}
