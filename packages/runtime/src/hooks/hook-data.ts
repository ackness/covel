const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;

/**
 * Own hook data without dropping non-enumerable execution artifacts. Native
 * structuredClone drops symbol keys; spreading would keep nested aliases.
 * Callable/accessor capabilities and shared memory are not hook payload data.
 */
export function cloneHookData<T>(value: T): T {
  const seen = new Map<object, object>();

  function clone(current: unknown): unknown {
    if (typeof current === "function") {
      throw new TypeError("Hook data cannot contain functions");
    }
    if (current === null || typeof current !== "object") return current;
    const previous = seen.get(current);
    if (previous) return previous;
    const properties = Reflect.ownKeys(current).map((key) => {
      const property = Object.getOwnPropertyDescriptor(current, key)!;
      if (!("value" in property)) {
        throw new TypeError("Hook data cannot contain accessors");
      }
      return [key, property] as const;
    });
    if (
      typeof SharedArrayBuffer !== "undefined" &&
      (current instanceof SharedArrayBuffer ||
        (ArrayBuffer.isView(current) &&
          (current instanceof DataView
            ? dataViewBuffer
            : typedArrayBuffer
          ).call(current) instanceof SharedArrayBuffer))
    ) {
      throw new TypeError("Hook data cannot contain shared memory");
    }
    const prototype = Object.getPrototypeOf(current);
    const nativeData =
      current instanceof Date ||
      current instanceof RegExp ||
      current instanceof ArrayBuffer ||
      ArrayBuffer.isView(current);
    if (
      !Array.isArray(current) &&
      !(current instanceof Map) &&
      !(current instanceof Set) &&
      prototype !== Object.prototype &&
      prototype !== null &&
      !nativeData
    ) {
      throw new TypeError(
        "Hook data must contain data records or supported native values",
      );
    }
    const copied: object = Array.isArray(current)
      ? new Array(current.length)
      : current instanceof Map
        ? new Map()
        : current instanceof Set
          ? new Set()
          : prototype === Object.prototype || prototype === null
            ? Object.create(prototype)
            : structuredClone(current);
    seen.set(current, copied);

    if (current instanceof Map && copied instanceof Map) {
      for (const [key, entry] of Map.prototype.entries.call(current))
        copied.set(clone(key), clone(entry));
    } else if (current instanceof Set && copied instanceof Set) {
      for (const entry of Set.prototype.values.call(current))
        copied.add(clone(entry));
    }

    for (const [key, property] of properties) {
      if (Array.isArray(current) && key === "length") continue;
      // Native cloning already owns typed-array contents. Custom properties,
      // including execution-artifact symbols, still use the graph copy below.
      if (
        ArrayBuffer.isView(current) &&
        !(current instanceof DataView) &&
        typeof key === "string" &&
        /^(0|[1-9]\d*)$/.test(key)
      )
        continue;
      const value = clone(property.value);
      const existing = Object.getOwnPropertyDescriptor(copied, key);
      if (existing && !existing.configurable) {
        if (existing.writable) Object.defineProperty(copied, key, { value });
        continue;
      }
      Object.defineProperty(copied, key, {
        value,
        enumerable: property.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return copied;
  }

  return clone(value) as T;
}
