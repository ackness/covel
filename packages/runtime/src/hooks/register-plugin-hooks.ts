/**
 * Register plugin-declared lifecycle hooks with the HookPipeline.
 *
 * Plugins declare hooks in their PLUGIN.md frontmatter
 * (`hooks: [{ event, handler, match?, timeoutMs? }]`). The handler
 * field is a path relative to the plugin root; we lazy-import it on
 * first invocation so a broken handler module never crashes server
 * boot.
 *
 * This helper replaces an inline 65-line block that previously lived
 * in `apps/server/src/routes/api/bootstrap.ts`. Keeping it next to
 * the pipeline itself aligns the "register plugin hooks" concern with
 * the "execute plugin hooks" concern, and keeps the composition root
 * small.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HookDeclaration, HookHandler } from "./types.js";
import type { HookPipeline } from "./pipeline.js";

/** Minimal shape of a parsed PLUGIN.md as the hook registrar needs it. */
export interface PluginHookSource {
  /** Stable plugin id used for trace / abort reasons. */
  readonly pluginId: string;
  /** Absolute directory the plugin lives in — handler paths resolve relative to it. */
  readonly rootPath: string;
  /** Parsed `hooks:` frontmatter entries (already schema-validated). */
  readonly hooks: readonly HookDeclaration[];
  /**
   * Trust gate. When true the source's handlers stay DORMANT: an
   * invocation before `activateDeferredPluginHooks(pipeline, pluginId)` is a
   * no-op `continue` and — critically — does NOT `import()` the handler
   * module, so unapproved community code never executes. The registrar caller
   * sets this from the plugin's trust info (`!trust.autoLoad`), mirroring the
   * deferred entry / local-tool / wire boot paths.
   */
  readonly deferred?: boolean;
}

/**
 * Per-pipeline set of plugin ids whose deferred legacy hooks are activated.
 * Keyed on the pipeline instance so parallel pipelines (tests, multiple
 * bootstraps in one process) never leak activation into each other.
 */
const deferredActivations = new WeakMap<HookPipeline, Set<string>>();

/**
 * Unlock a deferred (community) plugin's legacy hook handlers on `pipeline`.
 * Called from the community activation seam (`ensurePluginEntry`) once the
 * player has approved the plugin. Idempotent.
 */
export function activateDeferredPluginHooks(
  pipeline: HookPipeline,
  pluginId: string,
): void {
  let activated = deferredActivations.get(pipeline);
  if (!activated) {
    activated = new Set();
    deferredActivations.set(pipeline, activated);
  }
  activated.add(pluginId);
}

export interface RegisterPluginHooksOptions {
  /**
   * Optional hook invoked once per bad registration (module not found,
   * path escape, malformed match). Defaults to `console.warn`.
   */
  readonly onWarn?: (message: string) => void;
  /**
   * Session-level authorization check for deferred community hooks. The
   * global activation flag permits importing the module after first approval;
   * this predicate keeps every subsequent invocation scoped to its session.
   */
  readonly isDeferredAuthorized?: (
    sessionId: string,
    pluginId: string,
  ) => boolean;
}

/**
 * Safe path check: reject any `handler` path that resolves outside the
 * declared plugin root. Uses `path.relative` so we catch both literal
 * `..` escapes and absolute paths that happen to live in sibling dirs.
 */
function escapesRoot(rootPath: string, absPath: string): boolean {
  if (absPath === rootPath) return false;
  const rel = path.relative(rootPath, absPath);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * Build a match function from the shallow `{ key: string | number }` map
 * the frontmatter schema permits.
 */
function buildMatchFn(
  matchSpec: Readonly<Record<string, string | number>> | undefined,
): ((payload: unknown) => boolean) | undefined {
  if (!matchSpec) return undefined;
  const entries = Object.entries(matchSpec);
  return (payload: unknown): boolean => {
    if (!payload || typeof payload !== "object") return false;
    const p = payload as Record<string, unknown>;
    for (const [key, value] of entries) {
      if (p[key] !== value) return false;
    }
    return true;
  };
}

/**
 * Register every `hooks:` entry from every source with the pipeline.
 *
 * Returns the number of handlers successfully registered. Malformed
 * entries are skipped with a warning; a single bad plugin cannot
 * bring down the others.
 */
export function registerPluginHooks(
  pipeline: HookPipeline,
  sources: Iterable<PluginHookSource>,
  opts: RegisterPluginHooksOptions = {},
): number {
  // eslint-disable-next-line no-console
  const warn = opts.onWarn ?? ((msg: string) => console.warn(msg));
  let registered = 0;

  for (const source of sources) {
    const rootPath = path.resolve(source.rootPath);
    const { pluginId, deferred } = source;
    for (let i = 0; i < source.hooks.length; i++) {
      const decl = source.hooks[i];
      const absPath = path.resolve(rootPath, decl.handler);

      if (escapesRoot(rootPath, absPath)) {
        warn(
          `[plugin-loader] hook handler "${decl.handler}" escapes plugin root for "${pluginId}" — skipping`,
        );
        continue;
      }

      // Lazy handler — defer the import until the first invocation so a
      // broken handler module cannot crash server boot. Cache the loaded
      // handler for subsequent calls.
      let cached: HookHandler<unknown> | undefined;
      const lazyHandler: HookHandler<unknown> = async (ctx, payload) => {
        // Trust gate: a deferred source's handler must not run — or
        // even be import()'d — until the plugin is approved and activated.
        if (deferred && !deferredActivations.get(pipeline)?.has(pluginId)) {
          return { action: "continue" };
        }
        if (
          deferred &&
          (!opts.isDeferredAuthorized ||
            !opts.isDeferredAuthorized(ctx.sessionId, pluginId))
        ) {
          return { action: "continue" };
        }
        if (!cached) {
          try {
            const mod = (await import(pathToFileURL(absPath).href)) as {
              default?: HookHandler<unknown>;
            };
            if (typeof mod.default !== "function") {
              throw new Error(
                `hook handler at ${decl.handler} has no default export function`,
              );
            }
            cached = mod.default;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return { action: "abort", reason: `hook import failed: ${reason}` };
          }
        }
        return cached(ctx, payload);
      };

      const matchFn = buildMatchFn(decl.match);

      pipeline.register({
        // Handler path is stable across reorderings of `hooks[]`, which
        // makes trace / audit logs less noisy than an index-based id.
        id: `${source.pluginId}:${decl.event}:${decl.handler}`,
        event: decl.event,
        pluginId: source.pluginId,
        handler: lazyHandler,
        ...(matchFn ? { match: matchFn } : {}),
        ...(typeof decl.timeoutMs === "number"
          ? { timeoutMs: decl.timeoutMs }
          : {}),
        ...(decl.enforce ? { enforce: decl.enforce } : {}),
      });
      registered += 1;
    }
  }

  return registered;
}
