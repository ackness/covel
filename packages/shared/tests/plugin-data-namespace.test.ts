import { describe, expect, it } from "vitest";
import {
  hiddenPluginDataNamespace,
  isHiddenPluginDataNamespace,
  pluginCodeNamespaceWriteError,
  reservedPluginDataNamespaceError,
} from "../src/utils/plugin-data-namespace.js";

describe("plugin-data namespace guards", () => {
  it("recognizes non-empty _hidden.* namespaces and rejects bare _hidden.", () => {
    expect(isHiddenPluginDataNamespace(hiddenPluginDataNamespace("secrets"))).toBe(
      true,
    );
    expect(isHiddenPluginDataNamespace("_hidden.a")).toBe(true);
    expect(isHiddenPluginDataNamespace("_hidden.")).toBe(false);
    expect(isHiddenPluginDataNamespace("_hidden")).toBe(false);
    expect(isHiddenPluginDataNamespace("public")).toBe(false);
  });

  it("allows plugin code writes only to non-empty hidden buckets or non-reserved namespaces", () => {
    expect(pluginCodeNamespaceWriteError("notes")).toBeNull();
    expect(pluginCodeNamespaceWriteError("_hidden.secrets")).toBeNull();
    expect(pluginCodeNamespaceWriteError("_hidden.")).not.toBeNull();
    expect(pluginCodeNamespaceWriteError("_runtime_jobs")).not.toBeNull();
    expect(reservedPluginDataNamespaceError("_hidden.secrets")).not.toBeNull();
  });
});
