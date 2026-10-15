/**
 * Author warnings `validate:plugin` prints for a package that loads: a field
 * written with the value it has by default or that the loader works out, a
 * declaration that has a shorter form, and a missing version where setup
 * reruns depend on it. They read the frontmatter as written, before the
 * schemas fill in their defaults.
 */
import path from "node:path";
import {
  DEFAULT_FUNCTION_HANDLER,
  DEFAULT_PLUGIN_ENTRY,
  DEFAULT_RUNTIME_VISIBILITY,
  authoringSourceKind,
  defaultAgentLoop,
  defaultAgentModel,
  type RuntimeVisibility,
} from "@covel/shared";
import { isDerivedTag } from "./package-defaults.js";
import type { ParsedPluginMd, ParsedRuntimeMd } from "./types.js";

type Raw = Readonly<Record<string, unknown>>;

function record(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collects `<file>: <field>: <value> is the default value; remove it`. */
class Findings {
  readonly messages: string[] = [];
  constructor(private readonly file: string) {}
  check(field: string, value: unknown, defaultValue: unknown): void {
    if (value !== undefined && value === defaultValue)
      this.messages.push(
        `${this.file}: ${field}: ${JSON.stringify(value)} is the default value; remove it`,
      );
  }
  derived(field: string, value: unknown, from: string): void {
    this.messages.push(
      `${this.file}: ${field}: ${JSON.stringify(value)} is worked out from ${from}; remove it`,
    );
  }
  shorter(field: string, advice: string): void {
    this.messages.push(`${this.file}: ${field}: ${advice}; it means the same`);
  }
}

/** Whether `value` has exactly these keys, given or not. */
function onlyKeys(value: Raw, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function runtimeWarnings(runtime: Raw, prefix: string, out: Findings): void {
  const at = (field: string) => `${prefix}${field}`;
  const schedule = record(runtime.schedule);
  out.check(
    at("schedule.trigger.type"),
    record(schedule?.trigger)?.type,
    "auto",
  );
  out.check(at("schedule.every"), schedule?.every, 1);
  out.check(at("schedule.background"), schedule?.background, false);
  out.check(at("schedule.detached"), schedule?.detached, false);
  out.check(
    at("schedule.detached.settle"),
    record(schedule?.detached)?.settle,
    false,
  );
  const io = record(runtime.io);
  out.check(
    at("function.handler"),
    record(runtime.function)?.handler,
    DEFAULT_FUNCTION_HANDLER,
  );
  out.check(at("io.visibility"), io?.visibility, DEFAULT_RUNTIME_VISIBILITY);
  for (const [name, value] of Object.entries(record(io?.inputs) ?? {})) {
    const binding = record(value);
    out.check(
      at(`io.inputs.${name}.from.cardinality`),
      record(binding?.from)?.cardinality,
      "one",
    );
    out.check(at(`io.inputs.${name}.required`), binding?.required, true);
    out.check(at(`io.inputs.${name}.scope`), binding?.scope, "turn");
  }
  for (const [index, value] of list(io?.selfData).entries()) {
    const entry = record(value);
    out.check(at(`io.selfData[${index}].format`), entry?.format, "summary");
    out.check(at(`io.selfData[${index}].maxEntries`), entry?.maxEntries, 50);
  }
  if (runtime.function !== undefined) return;
  const visibility: RuntimeVisibility =
    io?.visibility === "story" ? "story" : DEFAULT_RUNTIME_VISIBILITY;
  const agent = record(runtime.agent);
  out.check(at("agent.model"), agent?.model, defaultAgentModel(visibility));
  out.check(at("agent.reasoning"), agent?.reasoning, true);
  if (agent?.finishWith !== undefined)
    out.check(at("agent.toolChoice"), agent.toolChoice, "required");
  const completion = record(agent?.completion);
  const afterTools = list(completion?.afterTools);
  const [onlyTool] = afterTools;
  if (
    completion?.require === "tool-use" &&
    afterTools.length === 1 &&
    typeof onlyTool === "string" &&
    onlyKeys(completion, ["require", "afterTools"]) &&
    agent?.toolChoice === "required"
  )
    out.shorter(
      at("agent.completion"),
      `write finishWith: ${onlyTool} in place of completion and toolChoice`,
    );
  const loop = record(agent?.loop);
  const defaults = defaultAgentLoop(visibility);
  for (const field of ["timeoutMs", "callTimeoutMs", "maxRetries"] as const)
    out.check(at(`agent.loop.${field}`), loop?.[field], defaults[field]);
}

/**
 * Warnings for one package. Every message names the file and the field; the
 * package is valid either way.
 */
export function authoringWarnings(
  packageManifest: ParsedPluginMd,
  manifests: readonly ParsedRuntimeMd[],
): string[] {
  const pluginFile = packageManifest.sourcePath ?? "PLUGIN.md";
  const plugin = new Findings(pluginFile);
  const raw = packageManifest.rawFrontmatter;
  plugin.check(
    "id",
    raw.id,
    path.basename(path.dirname(packageManifest.sourcePath ?? "")),
  );
  plugin.check("kind", raw.kind, "plugin");
  plugin.check("entry", raw.entry, DEFAULT_PLUGIN_ENTRY);
  for (const [index, tag] of list(raw.tags).entries())
    if (typeof tag === "string" && isDerivedTag(tag))
      plugin.derived(
        `tags[${index}]`,
        tag,
        "the package's panels and runtimes; a written one is ignored",
      );
  const outputs = new Set(
    manifests.flatMap(({ manifest }) =>
      manifest.outputContract ? [manifest.outputContract] : [],
    ),
  );
  for (const [index, entry] of list(raw.provides).entries())
    if (typeof entry === "string" && outputs.has(entry))
      plugin.derived(
        `provides[${index}]`,
        entry,
        "the io.output.contract of a runtime",
      );
  const contributes = record(raw.contributes);
  for (const [index, value] of list(contributes?.hooks).entries()) {
    const hook = record(value);
    if (!hook) continue;
    plugin.check(`contributes.hooks[${index}].enforce`, hook.enforce, "normal");
    if (
      typeof hook.event === "string" &&
      hook.enforce === undefined &&
      onlyKeys(hook, ["event"])
    )
      plugin.shorter(`contributes.hooks[${index}]`, `write ${hook.event}`);
  }
  for (const [index, value] of list(contributes?.extensions).entries()) {
    const extension = record(value);
    if (!extension) continue;
    plugin.check(`contributes.extensions[${index}].order`, extension.order, 0);
    if (
      typeof extension.point === "string" &&
      typeof extension.id === "string" &&
      onlyKeys(extension, ["point", "id"])
    )
      plugin.shorter(
        `contributes.extensions[${index}]`,
        `write ${extension.point}/${extension.id}`,
      );
  }
  for (const [namespace, value] of Object.entries(
    record(contributes?.data) ?? {},
  )) {
    plugin.check(
      `contributes.data.${namespace}.version`,
      record(value)?.version,
      1,
    );
    const source = record(record(record(value)?.authoring)?.source);
    if (typeof source?.path === "string")
      plugin.check(
        `contributes.data.${namespace}.authoring.source.key`,
        source.key,
        authoringSourceKind(source.path) === "media" ? "filename" : "id",
      );
  }
  for (const [index, value] of list(contributes?.prompt).entries())
    plugin.check(
      `contributes.prompt[${index}].role`,
      record(value)?.role,
      "system",
    );
  const messages = [...plugin.messages];
  for (const parsed of manifests) {
    const inline = parsed.manifest.name === packageManifest.plugin.id;
    const runtime = record(
      inline ? parsed.rawFrontmatter.runtime : parsed.rawFrontmatter,
    );
    if (!runtime) continue;
    const findings = new Findings(parsed.sourcePath ?? pluginFile);
    runtimeWarnings(runtime, inline ? "runtime." : "", findings);
    messages.push(...findings.messages);
  }
  // Setup reruns for existing sessions only when the version changes, and an
  // entry module changes what the package does; a package with either should
  // say which version it is.
  const hasSetup = manifests.some(
    (parsed) => parsed.manifest.stage === "setup",
  );
  if (
    !packageManifest.plugin.version &&
    (packageManifest.plugin.entry || hasSetup)
  )
    messages.push(
      `${pluginFile}: version: missing; a package without one counts as 0.0.0, and setup reruns for existing sessions only when the version changes. Add a version and raise it with each release`,
    );
  return messages;
}
