import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ArtifactPathPolicy } from "./artifact-path-policy.js";

export interface ArtifactBlobMetadata {
  artifactId: string;
  sessionId: string;
  kind: string;
  mediaType: string;
  fileName: string;
  createdAt: string;
  byteLength: number;
  checksum?: string;
  path?: string;
}

export interface StoredArtifact {
  artifactId: string;
  path: string;
}

export interface LocalArtifactStore {
  put(input: { metadata: ArtifactBlobMetadata; content: Uint8Array }): Promise<StoredArtifact>;
  readMetadata(artifactId: string): Promise<ArtifactBlobMetadata | null>;
  readContent(artifactId: string): Promise<Buffer | null>;
}

export interface LocalArtifactStoreOptions {
  rootDirectory: string;
  pathPolicy: ArtifactPathPolicy;
}

function buildMetadataPath(rootDirectory: string, artifactId: string): string {
  return resolve(rootDirectory, ".metadata", `${artifactId}.json`);
}

function assertInsideRoot(rootDirectory: string, targetPath: string): void {
  const root = resolve(rootDirectory);
  const target = resolve(targetPath);

  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error("Resolved artifact path is outside the artifact root.");
  }
}

function toBuffer(content: Uint8Array): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

export function createLocalArtifactStore({
  rootDirectory,
  pathPolicy
}: LocalArtifactStoreOptions): LocalArtifactStore {
  return {
    async put({ metadata, content }) {
      const path = pathPolicy.toArtifactPath(metadata);
      const absoluteArtifactPath = resolve(rootDirectory, path);
      const absoluteMetadataPath = buildMetadataPath(rootDirectory, metadata.artifactId);
      const buffer = toBuffer(content);

      assertInsideRoot(rootDirectory, absoluteArtifactPath);
      assertInsideRoot(rootDirectory, absoluteMetadataPath);

      await mkdir(dirname(absoluteArtifactPath), { recursive: true });
      await mkdir(dirname(absoluteMetadataPath), { recursive: true });
      await writeFile(absoluteArtifactPath, buffer);

      const storedMetadata: ArtifactBlobMetadata = {
        ...metadata,
        byteLength: buffer.byteLength,
        checksum:
          metadata.checksum ?? `sha256:${createHash("sha256").update(buffer).digest("hex")}`,
        path
      };

      await writeFile(absoluteMetadataPath, JSON.stringify(storedMetadata, null, 2));

      return {
        artifactId: metadata.artifactId,
        path
      };
    },
    async readMetadata(artifactId) {
      const absoluteMetadataPath = buildMetadataPath(rootDirectory, artifactId);

      assertInsideRoot(rootDirectory, absoluteMetadataPath);

      try {
        const payload = await readFile(absoluteMetadataPath, "utf8");
        return JSON.parse(payload) as ArtifactBlobMetadata;
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }

        throw error;
      }
    },
    async readContent(artifactId) {
      const metadata = await this.readMetadata(artifactId);

      if (metadata === null || metadata.path === undefined) {
        return null;
      }

      const absoluteArtifactPath = resolve(rootDirectory, metadata.path);
      assertInsideRoot(rootDirectory, absoluteArtifactPath);

      try {
        return await readFile(absoluteArtifactPath);
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }

        throw error;
      }
    }
  };
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
