/** Owns one plugin activation's registrations and factory-created resources. */
export class PluginEntryScope {
  private open = true;
  private readonly controller = new AbortController();
  private readonly pending: Array<() => void> = [];
  private readonly registrations: Array<() => void> = [];
  private readonly resources: Array<() => void | Promise<void>> = [];
  private closing: Promise<void> | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private assertOpen(): void {
    if (!this.open) throw new Error("plugin entry registration is closed");
  }

  stage(register: () => void): void {
    this.assertOpen();
    this.pending.push(register);
  }

  /** Called by the host while synchronously publishing registrations. */
  track(dispose: () => void): void {
    this.registrations.push(dispose);
  }

  /** Track acquired resources immediately, including before publication. */
  onDispose(dispose: () => void | Promise<void>): void {
    this.assertOpen();
    if (typeof dispose !== "function")
      throw new TypeError("onDispose expects a cleanup function");
    this.resources.push(dispose);
  }

  commit(): void {
    this.assertOpen();
    this.open = false;
    for (const register of this.pending) register();
    this.pending.length = 0;
  }

  /** Interrupt cooperative initialization before the host waits for it. */
  abort(reason?: unknown): void {
    this.open = false;
    this.pending.length = 0;
    this.controller.abort(reason);
  }

  /** Unpublish first, then release resources, continuing after cleanup errors. */
  dispose(reason?: unknown): Promise<void> {
    if (this.closing) return this.closing;
    // Assign before abort listeners or cleanup callbacks can re-enter disposal.
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const closing = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.closing = closing;
    this.abort(reason);
    const errors: unknown[] = [];
    for (const unregister of this.registrations.splice(0).reverse()) {
      try {
        unregister();
      } catch (error) {
        errors.push(error);
      }
    }
    const resources = this.resources.splice(0).reverse();
    void (async () => {
      for (const dispose of resources) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "plugin entry cleanup failed");
    })().then(resolve, reject);
    return closing;
  }
}
