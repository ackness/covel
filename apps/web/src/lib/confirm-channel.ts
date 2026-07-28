/**
 * Global confirm channel — dependency-free request/response pub/sub for
 * approval prompts raised outside the React tree (store actions).
 *
 * Mirrors toast-channel, with one difference: a confirm needs an answer back,
 * so `requestConfirm()` returns a promise the host settles once the player
 * picks. Only one host may answer — a second subscriber would double-resolve
 * the same request — so the channel keeps a single slot rather than a list.
 */

export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export interface PendingConfirm extends ConfirmRequest {
  /** Monotonic id used as the React key. */
  readonly id: number;
  readonly resolve: (value: boolean) => void;
}

type Subscriber = (pending: PendingConfirm) => void;

let subscriber: Subscriber | null = null;
let nextId = 1;

/**
 * Ask the player to approve an action. Resolves `true` on approval.
 *
 * With no host mounted (tests, early boot) it falls back to the native dialog
 * so the decision still reaches the user — silently denying, or leaving the
 * promise pending forever, would strand the caller mid-flow.
 */
export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  const current = subscriber;
  if (!current) {
    return Promise.resolve(
      typeof window === "undefined" ? false : window.confirm(request.message),
    );
  }
  return new Promise<boolean>((resolve) => {
    current({ ...request, id: nextId++, resolve });
  });
}

export function subscribeConfirm(cb: Subscriber): () => void {
  subscriber = cb;
  return () => {
    if (subscriber === cb) subscriber = null;
  };
}
