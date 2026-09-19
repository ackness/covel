/** One activation publishes synchronously, after all entry factories succeed. */
export class EntryRegistrationBatch {
  private open = true;
  private readonly pending: Array<() => void> = [];
  private readonly disposers: Array<() => void> = [];

  stage(register: () => void): void {
    if (!this.open) throw new Error("plugin entry registration is closed");
    this.pending.push(register);
  }

  track(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  commit(): void {
    this.open = false;
    for (const register of this.pending) register();
    this.pending.length = 0;
  }

  rollback(): void {
    this.dispose();
  }

  /** Successful publication transfers these registrations to the host lifetime. */
  dispose(): void {
    this.open = false;
    this.pending.length = 0;
    const errors: unknown[] = [];
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "plugin entry registration cleanup failed",
      );
    }
  }
}
