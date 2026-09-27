/** Owns one plugin activation's registrations and factory-created resources. */
export class PluginEntryScope {
  private open = true;
  private readonly controller = new AbortController();
  private readonly pending: Array<() => void> = [];
  private readonly registrations: Array<() => void> = [];
  private readonly resources: Array<() => void | Promise<void>> = [];
  private closing: Promise<void> | undefined;
  private holders = 0;
  private draining = false;
  private unregistered = false;
  private readonly idle = new Set<() => void>();

  /** Keep factory resources alive across a captured execution or late handler. */
  retain(): () => void {
    if (this.controller.signal.aborted || (this.draining && this.holders === 0))
      throw new Error("Plugin entry generation is disposed");
    this.holders++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holders === 0) for (const resolve of this.idle) resolve();
    };
  }

  async invoke<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = this.retain();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Stop new lookups immediately; captured holders retain the old handlers. */
  unpublish(): void {
    if (this.unregistered) return;
    this.unregistered = true;
    const errors: unknown[] = [];
    for (const unregister of this.registrations.splice(0).reverse()) {
      try {
        unregister();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "plugin entry unpublish failed");
  }

  /** Graceful replacement does not abort work still using this generation. */
  drain(): Promise<void> {
    this.draining = true;
    this.unpublish();
    return this.waitForIdle().then(() => this.dispose());
  }

  private waitForIdle(): Promise<void> {
    return this.holders === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.idle.add(resolve);
        });
  }

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
    try {
      this.unpublish();
    } catch (error) {
      errors.push(error);
    }
    const resources = this.resources.splice(0).reverse();
    void (async () => {
      if (this.holders > 0) await this.waitForIdle();
      this.idle.clear();
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
