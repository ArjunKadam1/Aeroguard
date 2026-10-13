import type { EventCreateRequest } from "../api/types";

export type EventSubmitter = (event: EventCreateRequest) => Promise<unknown>;
export type EventErrorReporter = (error: unknown) => void;

export interface EventQueue {
  emit(event: EventCreateRequest): void;
  flush(): Promise<unknown>;
}

/**
 * Serialize event submission so SESSION_COMPLETED lands before /complete.
 * A failed submission must not break later events, but it also must not be
 * silent: the caller reports it to the trainee because a dropped event can
 * change the score.
 */
export function createEventQueue(
  submit: EventSubmitter,
  onError: EventErrorReporter,
): EventQueue {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    emit(event) {
      chain = chain.then(() => submit(event)).catch((error) => {
        onError(error);
      });
    },
    flush() {
      return chain;
    },
  };
}
