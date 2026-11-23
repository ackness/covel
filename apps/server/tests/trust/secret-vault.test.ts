import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTANCE_ID_FILENAME,
  loadOrCreateHostId,
} from "../../src/trust/host-id.js";
import {
  createSecretVault,
  SecretVaultError,
} from "../../src/trust/secret-vault.js";

describe("loadOrCreateHostId", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-host-id-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a stable UUID on first call and keeps it across restarts", async () => {
    const first = await loadOrCreateHostId(dir);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const second = await loadOrCreateHostId(dir);
    expect(second).toBe(first);

    const disk = await readFile(path.join(dir, INSTANCE_ID_FILENAME), "utf8");
    expect(disk.trim()).toBe(first);
    if (process.platform !== "win32") {
      const info = await stat(path.join(dir, INSTANCE_ID_FILENAME));
      expect(info.mode & 0o777).toBe(0o600);
    }
  });
});

describe("SecretVault", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-secret-vault-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists secrets with 0700/0600 modes, non-disclosing list(), and plugin isolation", async () => {
    const vault = createSecretVault({ configDir: dir });
    const entry = await vault.set("plugin-a", "oauth", {
      accessToken: "secret-abc",
      expiresAt: 12345,
    });
    expect(entry.generation).toBe(1);
    expect(await vault.get("plugin-a", "oauth")).toEqual(entry);
    expect(await vault.get("plugin-b", "oauth")).toBeNull();

    const updated = await vault.set("plugin-a", "oauth", {
      accessToken: "secret-def",
    });
    expect(updated.generation).toBe(2);

    await vault.set("plugin-a", "alpha", "tok");
    const summaries = await vault.list("plugin-a");
    expect(
      summaries.map((s) => ({ key: s.key, generation: s.generation })),
    ).toEqual([
      { key: "alpha", generation: 1 },
      { key: "oauth", generation: 2 },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("secret-def");
    expect(JSON.stringify(summaries)).not.toContain("tok");

    if (process.platform !== "win32") {
      const secretsStat = await stat(path.join(dir, "secrets"));
      expect(secretsStat.mode & 0o777).toBe(0o700);
      const pluginStat = await stat(path.join(dir, "secrets", "plugin-a"));
      expect(pluginStat.mode & 0o777).toBe(0o700);
      const fileStat = await stat(
        path.join(dir, "secrets", "plugin-a", "oauth.json"),
      );
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    expect(await vault.delete("plugin-a", "alpha")).toBe(true);
    expect(await vault.delete("plugin-a", "alpha")).toBe(false);
    expect(await vault.deletePlugin("plugin-a")).toBe(1);
    expect(await vault.list("plugin-a")).toEqual([]);
  });

  it("rejects path traversal and unsafe key/pluginId names", async () => {
    const vault = createSecretVault({ configDir: dir });
    for (const bad of ["", "../escape", "a/b", "a\\b", ".hidden", "a..b"]) {
      await expect(vault.set("plugin-a", bad, "v")).rejects.toMatchObject({
        code: "invalid_key",
      });
      await expect(vault.set(bad, "key", "v")).rejects.toMatchObject({
        code: "invalid_key",
      });
    }
  });

  it("encrypts at rest with credentialsKey and detects tampering or wrong keys", async () => {
    const vault = createSecretVault({
      configDir: dir,
      credentialsKey: "master-passphrase-1",
    });
    await vault.set("plugin-a", "api-key", { token: "sk-live-999" });

    const filePath = path.join(dir, "secrets", "plugin-a", "api-key.json");
    const rawText = await readFile(filePath, "utf8");
    expect(rawText).not.toContain("sk-live-999");
    const rawJson = JSON.parse(rawText) as {
      encrypted: boolean;
      alg: string;
      ciphertext: string;
    };
    expect(rawJson.encrypted).toBe(true);
    expect(rawJson.alg).toBe("aes-256-gcm");

    const sameKeyVault = createSecretVault({
      configDir: dir,
      credentialsKey: "master-passphrase-1",
    });
    expect(await sameKeyVault.get("plugin-a", "api-key")).toMatchObject({
      value: { token: "sk-live-999" },
      generation: 1,
    });

    const noKeyVault = createSecretVault({ configDir: dir });
    await expect(noKeyVault.get("plugin-a", "api-key")).rejects.toMatchObject({
      code: "decrypt_failed",
    });

    const wrongKeyVault = createSecretVault({
      configDir: dir,
      credentialsKey: "wrong-passphrase",
    });
    await expect(
      wrongKeyVault.get("plugin-a", "api-key"),
    ).rejects.toMatchObject({
      code: "decrypt_failed",
    });

    // Tamper ciphertext byte
    const tampered = {
      ...rawJson,
      ciphertext: Buffer.from("tampered-data").toString("base64"),
    };
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(filePath, JSON.stringify(tampered), "utf8"),
    );
    await expect(
      sameKeyVault.get("plugin-a", "api-key"),
    ).rejects.toBeInstanceOf(SecretVaultError);
    await expect(sameKeyVault.get("plugin-a", "api-key")).rejects.toMatchObject(
      {
        code: "decrypt_failed",
      },
    );
  });

  it("supports compareAndSwap optimistic concurrency", async () => {
    const vault = createSecretVault({ configDir: dir });
    const miss = await vault.compareAndSwap("plugin-a", "cred", 1, "nope");
    expect(miss).toEqual({
      ok: false,
      reason: "generation_mismatch",
      current: null,
    });

    const created = await vault.compareAndSwap("plugin-a", "cred", null, {
      refresh: "r1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected ok");
    expect(created.entry.generation).toBe(1);

    const stale = await vault.compareAndSwap("plugin-a", "cred", null, {
      refresh: "r2",
    });
    expect(stale).toEqual({
      ok: false,
      reason: "generation_mismatch",
      current: created.entry,
    });

    const swapped = await vault.compareAndSwap(
      "plugin-a",
      "cred",
      created.entry.generation,
      { refresh: "r2" },
    );
    expect(swapped.ok).toBe(true);
    if (swapped.ok) {
      expect(swapped.entry.generation).toBe(2);
    }
  });

  it("serializes concurrent withLock callers without deadlocking re-entrant CAS", async () => {
    const vault = createSecretVault({ configDir: dir });
    await vault.set("plugin-a", "oauth", {
      access: "expired",
      refreshCount: 0,
    });

    let refreshCalls = 0;
    const ensureFresh = () =>
      vault.withLock("plugin-a", "oauth", async (current) => {
        const val = current?.value as
          { access: string; refreshCount: number } | undefined;
        if (val?.access === "fresh") {
          return val;
        }
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        const res = await vault.compareAndSwap(
          "plugin-a",
          "oauth",
          current?.generation ?? null,
          { access: "fresh", refreshCount: refreshCalls },
        );
        if (!res.ok) throw new Error("unexpected CAS mismatch inside withLock");
        return res.entry.value;
      });

    const results = await Promise.all([
      ensureFresh(),
      ensureFresh(),
      ensureFresh(),
      ensureFresh(),
    ]);
    expect(refreshCalls).toBe(1);
    for (const result of results) {
      expect(result).toEqual({ access: "fresh", refreshCount: 1 });
    }
  });

  it("enforces live authorize() checks on forPlugin()", async () => {
    const vault = createSecretVault({ configDir: dir });
    let allowed = true;
    const scoped = vault.forPlugin("plugin-a", () => allowed);

    const entry = await scoped.set("tok", { secret: 1 });
    expect(entry.generation).toBe(1);
    expect(await scoped.get("tok")).toEqual(entry);

    allowed = false;
    await expect(scoped.get("tok")).rejects.toMatchObject({
      code: "capability_denied",
    });
    await expect(scoped.list()).rejects.toMatchObject({
      code: "capability_denied",
    });
    await expect(scoped.set("tok", { secret: 2 })).rejects.toMatchObject({
      code: "capability_denied",
    });
    await expect(scoped.delete("tok")).rejects.toMatchObject({
      code: "capability_denied",
    });
    await expect(
      scoped.compareAndSwap("tok", 1, { secret: 2 }),
    ).rejects.toMatchObject({
      code: "capability_denied",
    });
    await expect(
      scoped.withLock("tok", async () => "ok"),
    ).rejects.toMatchObject({
      code: "capability_denied",
    });
  });
});
