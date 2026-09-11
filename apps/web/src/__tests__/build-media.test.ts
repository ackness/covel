// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("build-media script", () => {
  let root: string;
  let mediaDir: string;
  let script: string;
  let preloader: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "covel-build-media-"));
    const scriptsDir = path.join(root, "apps/web/scripts");
    mediaDir = path.join(root, "apps/web/public/media");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(mediaDir, { recursive: true });
    mkdirSync(path.join(root, ".assets/images"), { recursive: true });
    script = path.join(scriptsDir, "build-media.mjs");
    cpSync(
      path.resolve(import.meta.dirname, "../../scripts/build-media.mjs"),
      script,
    );
    writeFileSync(path.join(root, ".assets/images/demo.gif"), "original gif");
    writeFileSync(path.join(mediaDir, "demo.mp4"), "original video");
    writeFileSync(path.join(mediaDir, "demo-poster.jpg"), "original poster");
    preloader = path.join(root, "mock-ffmpeg.mjs");
    writeFileSync(
      preloader,
      `
import childProcess from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const failAt = Number(readFileSync(new URL("./fail-at.txt", import.meta.url), "utf8"));
let calls = 0;
childProcess.execFileSync = (command, args) => {
  if (command !== "ffmpeg") throw new Error("Unexpected subprocess");
  const output = args.at(-1);
  const inputs = args.filter((_, index) => args[index - 1] === "-i");
  if (inputs.includes(output)) throw new Error("Cannot edit in place");
  if (++calls === failAt) throw new Error("Conversion failed");
  writeFileSync(output, "converted asset");
};
syncBuiltinESMExports();
`,
      "utf8",
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(args: string[] = [], failConversion = "") {
    writeFileSync(
      path.join(root, "fail-at.txt"),
      failConversion || "0",
      "utf8",
    );
    return spawnSync(
      process.execPath,
      ["--import", preloader, script, ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  }

  it.each([[], ["apps/web/public/media/demo.mp4"]])(
    "converts an existing output used as input: %j",
    (...args) => {
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(path.join(root, ".assets/images/demo.gif"), "utf8"),
      ).toBe("converted asset");
      expect(readFileSync(path.join(mediaDir, "demo.mp4"), "utf8")).toBe(
        "converted asset",
      );
      expect(readdirSync(mediaDir).sort()).toEqual([
        "demo-poster.jpg",
        "demo.mp4",
      ]);
    },
  );

  it("preserves existing assets if a later conversion fails", () => {
    expect(run([], "4").status).toBe(1);
    expect(
      readFileSync(path.join(root, ".assets/images/demo.gif"), "utf8"),
    ).toBe("original gif");
    expect(readFileSync(path.join(mediaDir, "demo.mp4"), "utf8")).toBe(
      "original video",
    );
    expect(readFileSync(path.join(mediaDir, "demo-poster.jpg"), "utf8")).toBe(
      "original poster",
    );
    expect(readdirSync(mediaDir).sort()).toEqual([
      "demo-poster.jpg",
      "demo.mp4",
    ]);
  });

  it("rejects a missing explicit source instead of using a fallback", () => {
    const result = run(["missing.mp4"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing.mp4");
    expect(readFileSync(path.join(mediaDir, "demo.mp4"), "utf8")).toBe(
      "original video",
    );
  });
});
