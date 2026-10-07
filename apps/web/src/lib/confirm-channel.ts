/**
 * Global confirm channel — dependency-free request/response pub/sub for
 * approval prompts raised outside the React tree (store actions).
 *
 * Mirrors toast-channel, with one difference: a confirm needs an answer back,
 * so `requestConfirm()` returns a promise the host settles once the player
 * picks. Only one host may answer — a second subscriber would double-resolve
 * the same request — so the channel keeps a single slot rather than a list.
 */

/** One entry of a prompt that asks about several things at once. */
export interface ConfirmChoice {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  /**
   * Readable name of what the request acts on (the save, the world). Shown on
   * its own line so the player can check it before approving.
   */
  readonly subject?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** The approval cannot be undone; the host marks its button as such. */
  readonly destructive?: boolean;
  /** When present, the player ticks which entries the approval covers. */
  readonly choices?: readonly ConfirmChoice[];
}

export interface PendingConfirm extends ConfirmRequest {
  /** Monotonic id used as the React key. */
  readonly id: number;
  /** `chosen` carries the ticked ids when the request has `choices`. */
  readonly resolve: (value: boolean, chosen?: readonly string[]) => void;
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
      typeof window === "undefined"
        ? false
        : window.confirm(nativeText(request)),
    );
  }
  return new Promise<boolean>((resolve) => {
    current({ ...request, id: nextId++, resolve });
  });
}

/** The native dialog has one text: the message, then what it applies to. */
function nativeText(request: ConfirmRequest): string {
  return request.subject
    ? `${request.message}\n\n${request.subject}`
    : request.message;
}

/**
 * Ask the player to approve several things in one prompt. Resolves with the
 * ids left ticked; an empty list means the prompt was declined.
 *
 * The native fallback cannot offer checkboxes, so it names every entry and
 * approves all of them or none.
 */
export function requestChoices(
  request: ConfirmRequest & { readonly choices: readonly ConfirmChoice[] },
): Promise<readonly string[]> {
  const all = request.choices.map((choice) => choice.id);
  const current = subscriber;
  if (!current) {
    const text = [
      nativeText(request),
      ...request.choices.map((choice) => `• ${choice.label}`),
    ].join("\n");
    return Promise.resolve(
      typeof window !== "undefined" && window.confirm(text) ? all : [],
    );
  }
  return new Promise<readonly string[]>((resolve) => {
    current({
      ...request,
      id: nextId++,
      resolve: (approved, chosen) => resolve(approved ? (chosen ?? all) : []),
    });
  });
}

export function subscribeConfirm(cb: Subscriber): () => void {
  subscriber = cb;
  return () => {
    if (subscriber === cb) subscriber = null;
  };
}
