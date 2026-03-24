import { normalize, posix, sep } from "node:path";

export interface ArtifactPathInput {
  sessionId: string;
  artifactId: string;
  fileName: string;
}

export interface ArtifactPathPolicy {
  toArtifactPath(input: ArtifactPathInput): string;
}

function assertSafeSegment(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Unsafe path segment for ${label}.`);
  }

  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    posix.isAbsolute(value) ||
    normalize(value).startsWith(`..${sep}`)
  ) {
    throw new Error(`Unsafe path segment for ${label}.`);
  }
}

export function createArtifactPathPolicy(): ArtifactPathPolicy {
  return {
    toArtifactPath({ sessionId, artifactId, fileName }) {
      assertSafeSegment(sessionId, "sessionId");
      assertSafeSegment(artifactId, "artifactId");
      assertSafeSegment(fileName, "fileName");

      return posix.join("sessions", sessionId, "artifacts", artifactId, fileName);
    }
  };
}
