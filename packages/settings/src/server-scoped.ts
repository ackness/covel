import type { ServerSettingInfo } from "@covel/shared";
import { sameSettingValue } from "./versioned-persistence.js";
import type {
  ServerSettingState,
  ServerSettingsChannel,
  SettingKey,
} from "./types.js";

interface PendingWrite {
  readonly key: SettingKey;
  /** `null` drops the stored value. */
  readonly value: unknown;
}

/**
 * The values of `scope: "server"` settings. The server holds them, says which
 * value is in force and whether the player may change it; nothing here goes to
 * the device's own storage. Until the server has answered, a key reads its
 * default and is not settable, so a control never offers a choice the server
 * then refuses.
 */
export class ServerScopedSettings {
  private status: ServerSettingState["status"];
  private confirmed = new Map<SettingKey, ServerSettingInfo>();
  private readonly pending: PendingWrite[] = [];
  /** `state()` hands out the same object until the state changes. */
  private readonly states = new Map<SettingKey, ServerSettingState>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly channel: ServerSettingsChannel | undefined,
    private readonly defaultOf: (key: SettingKey) => unknown,
    private readonly registeredKeys: () => readonly SettingKey[],
    private readonly notify: (key: SettingKey) => void,
  ) {
    this.status = channel ? "pending" : "unavailable";
  }

  state(key: SettingKey): ServerSettingState {
    const next = this.compute(key);
    const previous = this.states.get(key);
    if (
      previous &&
      previous.status === next.status &&
      previous.source === next.source &&
      previous.settable === next.settable &&
      sameSettingValue(previous.value, next.value)
    ) {
      return previous;
    }
    this.states.set(key, next);
    return next;
  }

  private compute(key: SettingKey): ServerSettingState {
    const confirmed = this.confirmed.get(key);
    if (!confirmed) {
      return {
        status: this.status,
        value: this.defaultOf(key),
        source: undefined,
        settable: false,
      };
    }
    const write = this.pending.filter((item) => item.key === key).at(-1);
    if (!write) return { status: "ready", ...confirmed };
    return write.value === null
      ? {
          status: "ready",
          value: this.defaultOf(key),
          source: "default",
          settable: true,
        }
      : {
          status: "ready",
          value: write.value,
          source: "setting",
          settable: true,
        };
  }

  /** Ask the server again. A failure keeps the values already known. */
  refresh(): Promise<void> {
    const channel = this.channel;
    if (!channel) return Promise.resolve();
    return this.enqueue(async () => {
      try {
        this.adopt(await channel.load());
      } catch (error) {
        if (this.status === "pending") {
          this.status = "unavailable";
          for (const key of this.registeredKeys()) this.notify(key);
        }
        throw error;
      }
    });
  }

  /**
   * Send one value to the server (`null` drops the stored one). The new value
   * is visible at once; a refused or failed write puts the earlier one back.
   */
  write(key: SettingKey, value: unknown): Promise<void> {
    const channel = this.channel;
    const current = this.state(key);
    if (!channel || current.status !== "ready") {
      return Promise.reject(
        new Error(`The server has not reported ${key}; it cannot be changed`),
      );
    }
    if (!current.settable) {
      return Promise.reject(
        new Error(`${key} is fixed by the server and cannot be changed here`),
      );
    }
    const write: PendingWrite = { key, value: structuredClone(value) };
    this.pending.push(write);
    this.notify(key);
    return this.enqueue(async () => {
      try {
        const snapshot = await channel.save({ [key]: write.value });
        this.pending.splice(this.pending.indexOf(write), 1);
        this.adopt(snapshot);
      } catch (error) {
        this.pending.splice(this.pending.indexOf(write), 1);
        this.notify(key);
        throw error;
      }
    });
  }

  private adopt(snapshot: Readonly<Record<SettingKey, ServerSettingInfo>>) {
    const keys = new Set([
      ...this.confirmed.keys(),
      ...Object.keys(snapshot),
      ...this.registeredKeys(),
    ]);
    const before = new Map([...keys].map((key) => [key, this.state(key)]));
    this.confirmed = new Map(Object.entries(structuredClone(snapshot)));
    this.status = "ready";
    for (const key of keys) {
      if (this.state(key) !== before.get(key)) this.notify(key);
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
