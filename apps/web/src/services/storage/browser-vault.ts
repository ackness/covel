import {
  applySessionCommit as reduceSessionCommit,
  validateBrowserCheckpoint,
  validateSessionCommit,
  type BrowserCheckpoint,
  type SessionCommit,
  type WorldRecord,
} from "@covel/store/browser-sync";
import Dexie, { type Table } from "dexie";

export interface ApplySessionCommitResult {
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly checkpoint: BrowserCheckpoint;
}

export interface BrowserVaultSession {
  readonly sessionId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface BrowserVaultOptions {
  readonly dbName?: string;
}

export const BROWSER_VAULT_DB_NAME = "covel-browser-vault";
export const BROWSER_VAULT_SCHEMA_VERSION = 2;

export class BrowserVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserVaultError";
  }
}

export class BrowserVaultSecretError extends BrowserVaultError {
  constructor(path: string) {
    super(`Secrets are not allowed in browser checkpoints (${path})`);
    this.name = "BrowserVaultSecretError";
  }
}

export class BrowserVaultConflictError extends BrowserVaultError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserVaultConflictError";
  }
}

interface CheckpointRecord {
  sessionId: string;
  revision: number;
  checkpoint: BrowserCheckpoint;
  committedAt: string;
}

interface CommitRecord {
  id: string;
  sessionId: string;
  actionId: string;
  baseRevision: number;
  revision: number;
  checkpointDigest: string;
  committedAt: string;
}

class BrowserVaultDatabase extends Dexie {
  checkpoints!: Table<CheckpointRecord, string>;
  commits!: Table<CommitRecord, string>;
  worlds!: Table<WorldRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(BROWSER_VAULT_SCHEMA_VERSION).stores({
      checkpoints: "sessionId, revision, committedAt",
      commits: "id, sessionId, actionId, revision, [sessionId+actionId]",
      worlds: "id, createdAt, updatedAt",
    });
  }
}

const SECRET_KEY_NAMES = new Set([
  "accessToken",
  "apiKey",
  "apiKeys",
  "authorization",
  "bearerToken",
  "clientSecret",
  "credentials",
  "operatorToken",
  "ownerToken",
  "password",
  "privateKey",
  "refreshToken",
  "secret",
  "secrets",
  "sessionToken",
]);

function isSecretKey(key: string): boolean {
  if (SECRET_KEY_NAMES.has(key)) return true;
  const normalized = key.replace(/[_.-]/g, "").toLowerCase();
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("apikeys") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("clientsecret")
  );
}

function assertNoSecrets(value: unknown, path = "checkpoint"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) throw new BrowserVaultSecretError(`${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new BrowserVaultError("Browser checkpoint must contain JSON data");
  }
  return serialized;
}

function commitKey(sessionId: string, actionId: string): string {
  return `${sessionId}\0${actionId}`;
}

function cloneCheckpoint(checkpoint: BrowserCheckpoint): BrowserCheckpoint {
  return structuredClone(checkpoint);
}

/**
 * Browser-authoritative durable storage.
 *
 * Only the latest full checkpoint is retained. Historical recovery belongs to
 * the checkpoint's explicit `snapshots` domain; storing a complete checkpoint
 * after every action would otherwise grow quadratically with session length.
 * Small commit metadata remains append-only to make action retries idempotent.
 */
export class BrowserVault {
  private readonly db: BrowserVaultDatabase;

  constructor(options: BrowserVaultOptions = {}) {
    this.db = new BrowserVaultDatabase(options.dbName ?? BROWSER_VAULT_DB_NAME);
  }

  async saveCheckpoint(value: BrowserCheckpoint): Promise<BrowserCheckpoint> {
    const checkpoint = validateBrowserCheckpoint(value);
    assertNoSecrets(checkpoint);

    return this.db.transaction(
      "rw",
      this.db.checkpoints,
      this.db.worlds,
      async () => {
        const current = await this.db.checkpoints.get(checkpoint.sessionId);
        if (current) {
          if (checkpoint.revision < current.revision) {
            throw new BrowserVaultConflictError(
              `Stale checkpoint revision ${checkpoint.revision} for session ${checkpoint.sessionId}; current revision is ${current.revision}`,
            );
          }
          if (checkpoint.revision === current.revision) {
            if (stableJson(checkpoint) !== stableJson(current.checkpoint)) {
              throw new BrowserVaultConflictError(
                `Checkpoint revision ${checkpoint.revision} already exists for session ${checkpoint.sessionId}`,
              );
            }
            return cloneCheckpoint(current.checkpoint);
          }
        }

        await this.db.checkpoints.put({
          sessionId: checkpoint.sessionId,
          revision: checkpoint.revision,
          checkpoint: cloneCheckpoint(checkpoint),
          committedAt: checkpoint.committedAt,
        });
        if (checkpoint.world) {
          await this.db.worlds.put(structuredClone(checkpoint.world));
        }
        return cloneCheckpoint(checkpoint);
      },
    );
  }

  async applySessionCommit(
    value: SessionCommit,
  ): Promise<ApplySessionCommitResult> {
    const commit = validateSessionCommit(value);
    assertNoSecrets(commit.checkpoint);
    const digest = stableJson(commit.checkpoint);

    return this.db.transaction(
      "rw",
      this.db.checkpoints,
      this.db.commits,
      this.db.worlds,
      async () => {
        const id = commitKey(commit.checkpoint.sessionId, commit.actionId);
        const existingCommit = await this.db.commits.get(id);
        if (existingCommit) {
          if (
            existingCommit.baseRevision !== commit.baseRevision ||
            existingCommit.revision !== commit.revision ||
            existingCommit.checkpointDigest !== digest
          ) {
            throw new BrowserVaultConflictError(
              `actionId ${commit.actionId} was already committed with different data`,
            );
          }
          const current = await this.db.checkpoints.get(
            commit.checkpoint.sessionId,
          );
          if (!current) {
            throw new BrowserVaultError(
              `Session ${commit.checkpoint.sessionId} has commit metadata but no checkpoint`,
            );
          }
          return {
            applied: false,
            duplicate: true,
            checkpoint: cloneCheckpoint(current.checkpoint),
          };
        }

        const current = await this.db.checkpoints.get(
          commit.checkpoint.sessionId,
        );
        const next = reduceSessionCommit(current?.checkpoint ?? null, commit);
        await this.db.checkpoints.put({
          sessionId: next.sessionId,
          revision: next.revision,
          checkpoint: cloneCheckpoint(next),
          committedAt: next.committedAt,
        });
        await this.db.commits.add({
          id,
          sessionId: next.sessionId,
          actionId: commit.actionId,
          baseRevision: commit.baseRevision,
          revision: commit.revision,
          checkpointDigest: digest,
          committedAt: next.committedAt,
        });
        if (next.world) await this.db.worlds.put(structuredClone(next.world));
        return {
          applied: true,
          duplicate: false,
          checkpoint: cloneCheckpoint(next),
        };
      },
    );
  }

  async getCheckpoint(sessionId: string): Promise<BrowserCheckpoint | null> {
    const record = await this.db.checkpoints.get(sessionId);
    return record ? cloneCheckpoint(record.checkpoint) : null;
  }

  async getLatestCheckpoint(
    sessionId: string,
  ): Promise<BrowserCheckpoint | null> {
    return this.getCheckpoint(sessionId);
  }

  async listCheckpoints(
    sessionId: string,
  ): Promise<readonly BrowserCheckpoint[]> {
    const checkpoint = await this.getCheckpoint(sessionId);
    return checkpoint ? [checkpoint] : [];
  }

  async getSession(sessionId: string): Promise<BrowserVaultSession | null> {
    const record = await this.db.checkpoints.get(sessionId);
    return record
      ? {
          sessionId,
          revision: record.revision,
          updatedAt: record.committedAt,
        }
      : null;
  }

  async listSessions(): Promise<readonly BrowserVaultSession[]> {
    const records = await this.db.checkpoints.orderBy("sessionId").toArray();
    return records.map((record) => ({
      sessionId: record.sessionId,
      revision: record.revision,
      updatedAt: record.committedAt,
    }));
  }

  async listWorlds(): Promise<readonly WorldRecord[]> {
    const worlds = await this.db.worlds.orderBy("createdAt").toArray();
    return worlds.map((world) => structuredClone(world));
  }

  async getWorld(id: string): Promise<WorldRecord | null> {
    const world = await this.db.worlds.get(id);
    return world ? structuredClone(world) : null;
  }

  async upsertWorld(world: WorldRecord): Promise<void> {
    assertNoSecrets(world, "world");
    await this.db.worlds.put(structuredClone(world));
  }

  async deleteWorld(id: string): Promise<void> {
    await this.db.worlds.delete(id);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.transaction(
      "rw",
      this.db.checkpoints,
      this.db.commits,
      async () => {
        await Promise.all([
          this.db.checkpoints.delete(sessionId),
          this.db.commits.where("sessionId").equals(sessionId).delete(),
        ]);
      },
    );
  }

  async clear(): Promise<void> {
    await this.db.transaction(
      "rw",
      this.db.checkpoints,
      this.db.commits,
      this.db.worlds,
      async () => {
        await Promise.all([
          this.db.checkpoints.clear(),
          this.db.commits.clear(),
          this.db.worlds.clear(),
        ]);
      },
    );
  }

  close(): void {
    this.db.close();
  }

  async deleteDatabase(): Promise<void> {
    this.db.close();
    await this.db.delete();
  }
}

export type {
  BrowserCheckpoint,
  SessionCommit,
} from "@covel/store/browser-sync";
