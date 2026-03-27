import process from "node:process";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Ignore missing local env files in CI and shared environments.
  }
}

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.has(key) ? entries.get(key) ?? null : null;
    },
    key(index) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(String(key), String(value));
    }
  };
}

if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createMemoryStorage()
  });
}
