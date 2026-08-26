import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStoredProxyConfig,
  writeStoredProxyConfig,
} from "../../src/lib/proxy-config.js";

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe("stored proxy TOML", () => {
  it("reads legal single-quoted strings and inline comments", () => {
    tempHome = mkdtempSync(join(tmpdir(), "covel-proxy-config-"));
    writeFileSync(
      join(tempHome, "config.toml"),
      [
        "# operator-authored config",
        "[network] # proxy selection",
        "proxy_mode = 'http' # legal TOML comment",
        "proxy_url = 'http://127.0.0.1:7890'",
        "",
      ].join("\n"),
      "utf-8",
    );

    expect(readStoredProxyConfig(tempHome)).toEqual({
      mode: "http",
      url: "http://127.0.0.1:7890",
    });
  });

  it("updates the network keys without discarding unrelated TOML", () => {
    tempHome = mkdtempSync(join(tmpdir(), "covel-proxy-config-"));
    const file = join(tempHome, "config.toml");
    writeFileSync(file, "[paths]\ndata_root = '/tmp/covel'\n", "utf-8");

    writeStoredProxyConfig(tempHome, {
      mode: "socks",
      url: "socks5://127.0.0.1:7891",
    });

    expect(readFileSync(file, "utf-8")).toContain("data_root = '/tmp/covel'");
    expect(readStoredProxyConfig(tempHome)).toEqual({
      mode: "socks",
      url: "socks5://127.0.0.1:7891",
    });
  });

  it("preserves comments and refuses to overwrite malformed TOML", () => {
    tempHome = mkdtempSync(join(tmpdir(), "covel-proxy-config-"));
    const file = join(tempHome, "config.toml");
    const valid = [
      "# keep operator note",
      "schema_version = 1",
      "[network]",
      "proxy_mode = 'direct' # keep mode note",
      "proxy_url = ''",
      "[custom]",
      "value = 'keep'",
      "",
    ].join("\n");
    writeFileSync(file, valid, "utf-8");

    writeStoredProxyConfig(tempHome, {
      mode: "http",
      url: "http://127.0.0.1:7890",
    });
    const updated = readFileSync(file, "utf-8");
    expect(updated).toContain("# keep operator note");
    expect(updated).toContain('proxy_mode = "http" # keep mode note');
    expect(updated).toContain("[custom]\nvalue = 'keep'");

    const corrupt = "[network\nproxy_mode = 'direct'\n";
    writeFileSync(file, corrupt, "utf-8");
    expect(() =>
      writeStoredProxyConfig(tempHome!, {
        mode: "socks",
        url: "socks5://127.0.0.1:7891",
      }),
    ).toThrow();
    expect(readFileSync(file, "utf-8")).toBe(corrupt);
  });
});
