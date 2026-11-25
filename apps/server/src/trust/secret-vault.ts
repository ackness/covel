/**
 * Managed file-backed per-plugin secret vault (`<configDir>/secrets/<pluginId>/<key>.json`).
 *
 * Security invariants:
 * - Secrets NEVER enter SQLite, PostgreSQL, MemoryStore, session checkpoints,
 *   traces, or `/api/config/raw/*`.
 * - Every directory uses 0700 and every secret file uses 0600 + atomic rename.
 * - Optional AES-256-GCM encryption via `COVEL_CREDENTIALS_KEY` (AAD binds
 *   `pluginId:key:generation` so ciphertext cannot be transplanted across keys,
 *   plugins, or generations).
 * - `withLock(key, fn)` uses a re-entrant per-`(pluginId, key)` mutex via
 *   `AsyncLocalStorage`, so inner `get`/`set`/`compareAndSwap`/`delete` calls do
 *   not deadlock while concurrent callers serialize strictly.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PluginAPI } from "@covel/runtime";
import { z } from "zod";

export type PluginSecretStoreView = NonNullable<PluginAPI["secrets"]>;
export type SecretJsonValue = Parameters<PluginSecretStoreView["set"]>[1];

export interface SecretEntry<T extends SecretJsonValue = SecretJsonValue> {
  readonly value: T;
  readonly generation: number;
  readonly updatedAt: string;
}

export interface SecretSummary {
  readonly key: string;
  readonly generation: number;
  readonly updatedAt: string;
}

export type SecretCasResult<T extends SecretJsonValue = SecretJsonValue> =
  | { readonly ok: true; readonly entry: SecretEntry<T> }
  | {
      readonly ok: false;
      readonly reason: "generation_mismatch";
      readonly current: SecretEntry<SecretJsonValue> | null;
    };

export type SecretVaultErrorCode =
  "invalid_key" | "capability_denied" | "decrypt_failed" | "corrupt_entry";

export class SecretVaultError extends Error {
  constructor(
    readonly code: SecretVaultErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecretVaultError";
  }
}

export interface SecretVault {
  get<T extends SecretJsonValue = SecretJsonValue>(
    pluginId: string,
    key: string,
  ): Promise<SecretEntry<T> | null>;
  list(pluginId: string): Promise<readonly SecretSummary[]>;
  set<T extends SecretJsonValue = SecretJsonValue>(
    pluginId: string,
    key: string,
    value: T,
  ): Promise<SecretEntry<T>>;
  delete(pluginId: string, key: string): Promise<boolean>;
  compareAndSwap<T extends SecretJsonValue = SecretJsonValue>(
    pluginId: string,
    key: string,
    expectedGeneration: number | null,
    nextValue: T,
  ): Promise<SecretCasResult<T>>;
  withLock<TResult>(
    pluginId: string,
    key: string,
    fn: (current: SecretEntry<SecretJsonValue> | null) => Promise<TResult>,
  ): Promise<TResult>;
  deletePlugin(pluginId: string): Promise<number>;
  forPlugin(
    pluginId: string,
    authorize: () => boolean | Promise<boolean>,
  ): PluginSecretStoreView;
}

export interface CreateSecretVaultOptions {
  readonly configDir: string;
  readonly credentialsKey?: string;
}

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
} as const;
const MAX_DERIVED_KEY_CACHE = 256;

const encryptedEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  encrypted: z.literal(true),
  alg: z.literal("aes-256-gcm"),
  kdf: z.literal("scrypt"),
  salt: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string().min(1),
  generation: z.number().int().min(1),
  updatedAt: z.string().min(1),
});

const plaintextEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  encrypted: z.literal(false),
  generation: z.number().int().min(1),
  updatedAt: z.string().min(1),
  value: z.unknown(),
});

type SecretEnvelope =
  | z.infer<typeof encryptedEnvelopeSchema>
  | z.infer<typeof plaintextEnvelopeSchema>;

function deriveScryptKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      passphrase,
      salt,
      SCRYPT_KEY_BYTES,
      SCRYPT_OPTIONS,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function isNodeErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function assertSafeSegment(kind: "pluginId" | "key", value: string): string {
  if (
    typeof value !== "string" ||
    !SAFE_SEGMENT_RE.test(value) ||
    value.includes("..")
  ) {
    throw new SecretVaultError(
      "invalid_key",
      `Invalid secret ${kind}: "${String(value)}"`,
    );
  }
  return value;
}

function assertSubpath(root: string, target: string, message: string): void {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SecretVaultError("invalid_key", message);
  }
}

function normalizeJsonValue<T extends SecretJsonValue>(value: T): T {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new SecretVaultError(
      "invalid_key",
      "Secret value must be JSON-serializable",
      { cause: error },
    );
  }
  if (encoded === undefined) {
    throw new SecretVaultError(
      "invalid_key",
      "Secret value must be JSON-serializable",
    );
  }
  return JSON.parse(encoded) as T;
}

function parseEnvelope(rawText: string): SecretEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new SecretVaultError(
      "corrupt_entry",
      "Secret file is not valid JSON",
      {
        cause: error,
      },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretVaultError(
      "corrupt_entry",
      "Secret envelope must be an object",
    );
  }
  const encryptedFlag = (parsed as { encrypted?: unknown }).encrypted;
  if (encryptedFlag === true) {
    const res = encryptedEnvelopeSchema.safeParse(parsed);
    if (!res.success) {
      throw new SecretVaultError(
        "corrupt_entry",
        "Malformed encrypted secret envelope",
      );
    }
    return res.data;
  }
  if (encryptedFlag === false && "value" in parsed) {
    const res = plaintextEnvelopeSchema.safeParse(parsed);
    if (!res.success || res.data.value === undefined) {
      throw new SecretVaultError(
        "corrupt_entry",
        "Malformed plaintext secret envelope",
      );
    }
    return res.data;
  }
  throw new SecretVaultError("corrupt_entry", "Unknown secret envelope format");
}

async function decryptEnvelopeValue(
  envelope: SecretEnvelope,
  pluginId: string,
  key: string,
  deriveKey: ((salt: Buffer) => Promise<Buffer>) | null,
): Promise<SecretJsonValue> {
  if (!envelope.encrypted) {
    if (deriveKey !== null) {
      throw new SecretVaultError(
        "decrypt_failed",
        `Secret "${pluginId}/${key}" is stored in plaintext, but COVEL_CREDENTIALS_KEY requires encrypted secrets`,
      );
    }
    return normalizeJsonValue(envelope.value as SecretJsonValue);
  }
  if (deriveKey === null) {
    throw new SecretVaultError(
      "decrypt_failed",
      `Secret "${pluginId}/${key}" is encrypted, but COVEL_CREDENTIALS_KEY is not configured`,
    );
  }
  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (
      salt.length !== SCRYPT_SALT_BYTES ||
      iv.length !== GCM_IV_BYTES ||
      tag.length !== GCM_TAG_BYTES
    ) {
      throw new Error("Invalid AES-256-GCM envelope parameter length");
    }
    const encryptionKey = await deriveKey(salt);
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(
      Buffer.from(`${pluginId}:${key}:${envelope.generation}`, "utf8"),
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as SecretJsonValue;
  } catch (error) {
    throw new SecretVaultError(
      "decrypt_failed",
      `Failed to decrypt secret "${pluginId}/${key}"`,
      { cause: error },
    );
  }
}

async function encodeEnvelope(
  pluginId: string,
  key: string,
  generation: number,
  updatedAt: string,
  value: SecretJsonValue,
  deriveKey: ((salt: Buffer) => Promise<Buffer>) | null,
): Promise<SecretEnvelope> {
  if (deriveKey === null) {
    return {
      version: 1,
      encrypted: false,
      generation,
      updatedAt,
      value,
    };
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const encryptionKey = await deriveKey(salt);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(`${pluginId}:${key}:${generation}`, "utf8"));
  const serialized = JSON.stringify(value);
  const ciphertext = Buffer.concat([
    cipher.update(serialized, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    encrypted: true,
    alg: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    generation,
    updatedAt,
  };
}

export function createSecretVault(
  options: CreateSecretVaultOptions,
): SecretVault {
  const secretsRoot = path.resolve(options.configDir, "secrets");
  const trimmedKey = options.credentialsKey?.trim();
  const passphrase = trimmedKey && trimmedKey.length > 0 ? trimmedKey : null;
  const derivedKeyCache = new Map<string, Buffer>();

  const deriveKeyForSalt: ((salt: Buffer) => Promise<Buffer>) | null =
    passphrase === null
      ? null
      : async (salt: Buffer): Promise<Buffer> => {
          const cacheKey = salt.toString("base64");
          const cached = derivedKeyCache.get(cacheKey);
          if (cached) return cached;
          const derived = await deriveScryptKey(passphrase, salt);
          if (derivedKeyCache.size >= MAX_DERIVED_KEY_CACHE) {
            const oldest = derivedKeyCache.keys().next().value;
            if (oldest !== undefined) derivedKeyCache.delete(oldest);
          }
          derivedKeyCache.set(cacheKey, derived);
          return derived;
        };

  const lockContext = new AsyncLocalStorage<ReadonlySet<string>>();
  const keyTails = new Map<string, Promise<void>>();
  const pluginDeleteTails = new Map<string, Promise<void>>();

  const runWithKeyLock = async <TResult>(
    pluginId: string,
    key: string,
    fn: () => Promise<TResult>,
  ): Promise<TResult> => {
    const lockId = `${pluginId}\0${key}`;
    const held = lockContext.getStore();
    if (held?.has(lockId)) {
      return fn();
    }
    while (pluginDeleteTails.has(pluginId)) {
      await pluginDeleteTails.get(pluginId)?.catch(() => {});
    }
    const previous = keyTails.get(lockId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = previous.then(
      () => current,
      () => current,
    );
    keyTails.set(lockId, nextTail);
    await previous.catch(() => {});
    const nextHeld = new Set(held ?? []);
    nextHeld.add(lockId);
    try {
      return await lockContext.run(nextHeld, fn);
    } finally {
      release();
      if (keyTails.get(lockId) === nextTail) {
        keyTails.delete(lockId);
      }
    }
  };

  const resolvePluginDir = (pluginId: string): string => {
    const safePlugin = assertSafeSegment("pluginId", pluginId);
    const pluginDir = path.resolve(secretsRoot, safePlugin);
    assertSubpath(secretsRoot, pluginDir, `Invalid plugin path: "${pluginId}"`);
    return pluginDir;
  };

  const resolveEntryPath = (
    pluginId: string,
    key: string,
  ): {
    readonly pluginDir: string;
    readonly filePath: string;
    readonly safePlugin: string;
    readonly safeKey: string;
  } => {
    const safePlugin = assertSafeSegment("pluginId", pluginId);
    const safeKey = assertSafeSegment("key", key);
    const pluginDir = path.resolve(secretsRoot, safePlugin);
    assertSubpath(secretsRoot, pluginDir, `Invalid plugin path: "${pluginId}"`);
    const filePath = path.resolve(pluginDir, `${safeKey}.json`);
    assertSubpath(pluginDir, filePath, `Invalid secret key path: "${key}"`);
    return { pluginDir, filePath, safePlugin, safeKey };
  };

  const ensureDirPrivate = async (dirPath: string): Promise<void> => {
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(dirPath, 0o700).catch(() => {});
    }
  };

  const readEntryUnlocked = async <T extends SecretJsonValue = SecretJsonValue>(
    pluginId: string,
    key: string,
  ): Promise<SecretEntry<T> | null> => {
    const { filePath, safePlugin, safeKey } = resolveEntryPath(pluginId, key);
    let rawText: string;
    try {
      rawText = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeErrno(error, "ENOENT")) return null;
      throw error;
    }
    const envelope = parseEnvelope(rawText);
    const value = (await decryptEnvelopeValue(
      envelope,
      safePlugin,
      safeKey,
      deriveKeyForSalt,
    )) as T;
    return {
      value,
      generation: envelope.generation,
      updatedAt: envelope.updatedAt,
    };
  };

  const writeEntryUnlocked = async <
    T extends SecretJsonValue = SecretJsonValue,
  >(
    pluginId: string,
    key: string,
    value: T,
    generation: number,
  ): Promise<SecretEntry<T>> => {
    const { pluginDir, filePath, safePlugin, safeKey } = resolveEntryPath(
      pluginId,
      key,
    );
    const normalized = normalizeJsonValue(value);
    const updatedAt = new Date().toISOString();
    const envelope = await encodeEnvelope(
      safePlugin,
      safeKey,
      generation,
      updatedAt,
      normalized,
      deriveKeyForSalt,
    );
    await ensureDirPrivate(secretsRoot);
    await ensureDirPrivate(pluginDir);
    const tmpPath = path.join(pluginDir, `.${safeKey}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmpPath, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmpPath, filePath);
      if (process.platform !== "win32") {
        await chmod(filePath, 0o600).catch(() => {});
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    return {
      value: normalized,
      generation,
      updatedAt,
    };
  };

  const vault: SecretVault = {
    async get<T extends SecretJsonValue = SecretJsonValue>(
      pluginId: string,
      key: string,
    ): Promise<SecretEntry<T> | null> {
      const { safePlugin, safeKey } = resolveEntryPath(pluginId, key);
      return runWithKeyLock(safePlugin, safeKey, () =>
        readEntryUnlocked<T>(safePlugin, safeKey),
      );
    },

    async list(pluginId: string): Promise<readonly SecretSummary[]> {
      const safePlugin = assertSafeSegment("pluginId", pluginId);
      const pluginDir = resolvePluginDir(safePlugin);
      let fileNames: string[];
      try {
        fileNames = await readdir(pluginDir);
      } catch (error) {
        if (isNodeErrno(error, "ENOENT")) return [];
        throw error;
      }
      const summaries: SecretSummary[] = [];
      for (const name of fileNames) {
        if (name.startsWith(".") || !name.endsWith(".json")) continue;
        const key = name.slice(0, -".json".length);
        if (!SAFE_SEGMENT_RE.test(key) || key.includes("..")) continue;
        let rawText: string;
        try {
          rawText = await readFile(path.join(pluginDir, name), "utf8");
        } catch (error) {
          if (isNodeErrno(error, "ENOENT")) continue;
          throw error;
        }
        const envelope = parseEnvelope(rawText);
        summaries.push({
          key,
          generation: envelope.generation,
          updatedAt: envelope.updatedAt,
        });
      }
      return summaries.sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      );
    },

    async set<T extends SecretJsonValue = SecretJsonValue>(
      pluginId: string,
      key: string,
      value: T,
    ): Promise<SecretEntry<T>> {
      const { safePlugin, safeKey } = resolveEntryPath(pluginId, key);
      return runWithKeyLock(safePlugin, safeKey, async () => {
        const current = await readEntryUnlocked(safePlugin, safeKey).catch(
          (error) => {
            // Let set() rotate/replace an undecryptable or corrupt secret cleanly.
            if (
              error instanceof SecretVaultError &&
              (error.code === "decrypt_failed" ||
                error.code === "corrupt_entry")
            ) {
              return null;
            }
            throw error;
          },
        );
        const nextGeneration = (current?.generation ?? 0) + 1;
        return writeEntryUnlocked(safePlugin, safeKey, value, nextGeneration);
      });
    },

    async delete(pluginId: string, key: string): Promise<boolean> {
      const { safePlugin, safeKey, filePath } = resolveEntryPath(pluginId, key);
      return runWithKeyLock(safePlugin, safeKey, async () => {
        try {
          await unlink(filePath);
          return true;
        } catch (error) {
          if (isNodeErrno(error, "ENOENT")) return false;
          throw error;
        }
      });
    },

    async compareAndSwap<T extends SecretJsonValue = SecretJsonValue>(
      pluginId: string,
      key: string,
      expectedGeneration: number | null,
      nextValue: T,
    ): Promise<SecretCasResult<T>> {
      const { safePlugin, safeKey } = resolveEntryPath(pluginId, key);
      return runWithKeyLock(safePlugin, safeKey, async () => {
        const current = await readEntryUnlocked(safePlugin, safeKey);
        const matches =
          (current === null && expectedGeneration === null) ||
          (current !== null && current.generation === expectedGeneration);
        if (!matches) {
          return {
            ok: false,
            reason: "generation_mismatch",
            current,
          };
        }
        const nextGeneration = (current?.generation ?? 0) + 1;
        const entry = await writeEntryUnlocked(
          safePlugin,
          safeKey,
          nextValue,
          nextGeneration,
        );
        return { ok: true, entry };
      });
    },

    async withLock<TResult>(
      pluginId: string,
      key: string,
      fn: (current: SecretEntry<SecretJsonValue> | null) => Promise<TResult>,
    ): Promise<TResult> {
      const { safePlugin, safeKey } = resolveEntryPath(pluginId, key);
      return runWithKeyLock(safePlugin, safeKey, async () => {
        const current = await readEntryUnlocked(safePlugin, safeKey);
        return fn(current);
      });
    },

    async deletePlugin(pluginId: string): Promise<number> {
      const safePlugin = assertSafeSegment("pluginId", pluginId);
      const pluginDir = resolvePluginDir(safePlugin);
      const previousDelete =
        pluginDeleteTails.get(safePlugin) ?? Promise.resolve();
      let releaseDelete!: () => void;
      const currentDelete = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const nextDeleteTail = previousDelete.then(
        () => currentDelete,
        () => currentDelete,
      );
      pluginDeleteTails.set(safePlugin, nextDeleteTail);
      try {
        await previousDelete.catch(() => {});
        const keyPrefix = `${safePlugin}\0`;
        const pendingKeyLocks: Promise<void>[] = [];
        for (const [lockId, tail] of keyTails) {
          if (lockId.startsWith(keyPrefix)) {
            pendingKeyLocks.push(tail);
          }
        }
        if (pendingKeyLocks.length > 0) {
          await Promise.allSettled(pendingKeyLocks);
        }
        let count = 0;
        try {
          const names = await readdir(pluginDir);
          count = names.filter(
            (name) => !name.startsWith(".") && name.endsWith(".json"),
          ).length;
        } catch (error) {
          if (isNodeErrno(error, "ENOENT")) return 0;
          throw error;
        }
        await rm(pluginDir, { recursive: true, force: true });
        return count;
      } finally {
        releaseDelete();
        if (pluginDeleteTails.get(safePlugin) === nextDeleteTail) {
          pluginDeleteTails.delete(safePlugin);
        }
      }
    },

    forPlugin(
      pluginId: string,
      authorize: () => boolean | Promise<boolean>,
    ): PluginSecretStoreView {
      const safePlugin = assertSafeSegment("pluginId", pluginId);
      const requireAuthorized = async (): Promise<void> => {
        const allowed = await authorize();
        if (!allowed) {
          throw new SecretVaultError(
            "capability_denied",
            `Capability "secrets.own" is not allowed for plugin "${safePlugin}"`,
          );
        }
      };

      const authorized = async <TResult>(
        run: () => Promise<TResult>,
      ): Promise<TResult> => {
        await requireAuthorized();
        return run();
      };

      return {
        get: <T extends SecretJsonValue = SecretJsonValue>(key: string) =>
          authorized(() => vault.get<T>(safePlugin, key)),
        list: () => authorized(() => vault.list(safePlugin)),
        set: <T extends SecretJsonValue = SecretJsonValue>(
          key: string,
          value: T,
        ) => authorized(() => vault.set<T>(safePlugin, key, value)),
        delete: (key: string) =>
          authorized(() => vault.delete(safePlugin, key)),
        compareAndSwap: <T extends SecretJsonValue = SecretJsonValue>(
          key: string,
          expectedGeneration: number | null,
          nextValue: T,
        ) =>
          authorized(() =>
            vault.compareAndSwap<T>(
              safePlugin,
              key,
              expectedGeneration,
              nextValue,
            ),
          ),
        withLock: <TResult>(
          key: string,
          fn: (
            current: SecretEntry<SecretJsonValue> | null,
          ) => Promise<TResult>,
        ) => authorized(() => vault.withLock(safePlugin, key, fn)),
      };
    },
  };

  return vault;
}
