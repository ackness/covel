import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createArtifactPathPolicy,
  createLocalArtifactStore,
  type ArtifactBlobMetadata
} from "../src/index.js";

describe("createArtifactPathPolicy", () => {
  it("builds stable relative paths from safe segments", () => {
    const policy = createArtifactPathPolicy();

    expect(
      policy.toArtifactPath({
        sessionId: "session-1",
        artifactId: "artifact-1",
        fileName: "map.png"
      })
    ).toBe("sessions/session-1/artifacts/artifact-1/map.png");
  });

  it("rejects traversal and absolute path attempts", () => {
    const policy = createArtifactPathPolicy();

    expect(() =>
      policy.toArtifactPath({
        sessionId: "../escape",
        artifactId: "artifact-1",
        fileName: "map.png"
      })
    ).toThrowError(/unsafe path segment/i);

    expect(() =>
      policy.toArtifactPath({
        sessionId: "session-1",
        artifactId: "artifact-1",
        fileName: "/tmp/map.png"
      })
    ).toThrowError(/unsafe path segment/i);
  });
});

describe("createLocalArtifactStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0, roots.length).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function createStore() {
    const root = await mkdtemp(join(tmpdir(), "covel-storage-"));
    roots.push(root);

    return createLocalArtifactStore({
      rootDirectory: root,
      pathPolicy: createArtifactPathPolicy()
    });
  }

  function createMetadata(overrides: Partial<ArtifactBlobMetadata> = {}): ArtifactBlobMetadata {
    return {
      artifactId: "artifact-1",
      sessionId: "session-1",
      kind: "image",
      mediaType: "image/png",
      fileName: "map.png",
      createdAt: "2026-01-01T00:00:00.000Z",
      byteLength: 4,
      checksum: "sha256:deadbeef",
      ...overrides
    };
  }

  it("writes and reads artifact metadata and content", async () => {
    const store = await createStore();
    const content = Buffer.from([1, 2, 3, 4]);
    const metadata = createMetadata();

    const stored = await store.put({
      metadata,
      content
    });

    await expect(store.readMetadata(stored.artifactId)).resolves.toEqual({
      ...metadata,
      path: stored.path
    });
    await expect(store.readContent(stored.artifactId)).resolves.toEqual(content);
  });

  it("returns null for missing artifacts", async () => {
    const store = await createStore();

    await expect(store.readMetadata("missing")).resolves.toBeNull();
    await expect(store.readContent("missing")).resolves.toBeNull();
  });

  it("refuses writes that resolve outside the configured root", async () => {
    const store = await createStore();

    await expect(
      store.put({
        metadata: createMetadata({ fileName: "../../escape.txt" }),
        content: Buffer.from("bad")
      })
    ).rejects.toThrowError(/outside the artifact root|unsafe path segment/i);
  });
});
