import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDesktopConfig,
  patchDesktopConfigFile,
  patchDesktopConfigSource,
  readDesktopConfigFile,
  writeDesktopConfigFileAtomic,
} from "../src/desktop-config/node-file.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("desktop config schema", () => {
  it("treats a missing schema_version as v1 and preserves unknown data", () => {
    expect(
      parseDesktopConfig(
        [
          "operator = 'local'",
          "[paths]",
          "data_root = 'portable-data'",
          "extra = true",
          "[custom]",
          "answer = 42",
        ].join("\n"),
      ),
    ).toMatchObject({
      schema_version: 1,
      operator: "local",
      paths: { data_root: "portable-data", extra: true },
      custom: { answer: 42 },
    });
  });

  it("rejects unsupported versions and invalid known field types", () => {
    expect(() => parseDesktopConfig("schema_version = 2\n")).toThrow();
    expect(() => parseDesktopConfig("[logging]\nmax_size_mb = 0\n")).toThrow();
    expect(() =>
      parseDesktopConfig("[network]\nproxy_mode = 'automatic'\n"),
    ).toThrow();
  });
});

describe("desktop config text patching", () => {
  it("preserves comments, unknown sections, CRLF, and hashes inside strings", () => {
    const source = [
      "# operator-authored config",
      "[paths]",
      "data_root = 'old' # keep this note",
      "custom_path_key = 'keep'",
      "",
      "[custom] # untouched",
      "endpoint = 'https://example.test/#fragment'",
      "",
    ].join("\r\n");

    const next = patchDesktopConfigSource(source, {
      paths: { data_root: "/new/data" },
      network: {
        proxy_mode: "http",
        proxy_url: "http://127.0.0.1:7890/#route",
      },
    });

    expect(next).toContain(
      "data_root = \"/new/data\" # keep this note\r\ncustom_path_key = 'keep'",
    );
    expect(next).toContain(
      "[custom] # untouched\r\nendpoint = 'https://example.test/#fragment'",
    );
    expect(next).toContain('proxy_url = "http://127.0.0.1:7890/#route"');
    expect(parseDesktopConfig(next).network).toMatchObject({
      proxy_mode: "http",
      proxy_url: "http://127.0.0.1:7890/#route",
    });
  });

  it("does not insert owned keys into a following array-of-tables entry", () => {
    const source = [
      "[network]",
      "proxy_mode = 'direct'",
      "",
      "[[operator_routes]]",
      "name = 'primary'",
      "",
    ].join("\n");

    const next = patchDesktopConfigSource(source, {
      network: { proxy_url: "" },
    });

    expect(next.indexOf('proxy_url = ""')).toBeLessThan(
      next.indexOf("[[operator_routes]]"),
    );
    expect(parseDesktopConfig(next).operator_routes).toEqual([
      { name: "primary" },
    ]);
  });

  it("strictly rejects a corrupt source before applying a patch", () => {
    expect(() =>
      patchDesktopConfigSource("[paths\ndata_root = 'broken'\n", {
        paths: { data_root: "/replacement" },
      }),
    ).toThrow();
  });

  it("comments out data_root when restoring the default", () => {
    const next = patchDesktopConfigSource(
      "[paths]\ndata_root = '/old/data' # external drive\n",
      { paths: { data_root: null } },
    );
    expect(next).toContain("# data_root = '/old/data' # external drive");
    expect(parseDesktopConfig(next).paths?.data_root).toBeUndefined();
  });
});

describe("desktop config file writes", () => {
  it("atomically patches with mode 0600 and keeps a corrupt file unchanged", () => {
    tempDir = mkdtempSync(join(tmpdir(), "covel-desktop-config-"));
    const file = join(tempDir, "config.toml");
    writeFileSync(file, "[paths]\ndata_root = 'old'\n", "utf-8");

    patchDesktopConfigFile(file, {
      logging: { max_size_mb: 12, max_files: 7 },
    });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readDesktopConfigFile(file).logging).toEqual({
      max_size_mb: 12,
      max_files: 7,
    });

    const corrupt = "[paths\ndata_root = 'recover-me'\n";
    writeFileSync(file, corrupt, "utf-8");
    expect(() =>
      patchDesktopConfigFile(file, { paths: { data_root: "/lost" } }),
    ).toThrow();
    expect(readFileSync(file, "utf-8")).toBe(corrupt);
  });

  it("cleans its same-directory temp file when rename fails", () => {
    tempDir = mkdtempSync(join(tmpdir(), "covel-desktop-config-"));
    const destination = join(tempDir, "occupied");
    // A non-empty directory cannot be replaced by renameSync on supported
    // desktop platforms, forcing the cleanup branch after the temp is written.
    writeFileSync(join(tempDir, "marker"), "keep", "utf-8");
    mkdirSync(destination);
    writeFileSync(join(destination, "child"), "keep", "utf-8");

    expect(() =>
      writeDesktopConfigFileAtomic(destination, "schema_version = 1\n"),
    ).toThrow();
    expect(readdirSync(tempDir).sort()).toEqual(["marker", "occupied"]);
  });
});
