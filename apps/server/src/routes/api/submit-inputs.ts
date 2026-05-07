/**
 * API submit-inputs route.
 *
 * **PR-3 alias**: this route now forwards into the framework default
 * `submit-form` RPC handler. The actual logic (template fill, persistence,
 * validation) lives in `@covel/runtime/rpc-defaults/submit-form.ts` so it
 * is reachable from both the legacy route and the new
 * `POST /api/sessions/:id/plugin-rpc` channel.
 *
 * Backwards-compat response shape: when a single legacy `{ formId, values }`
 * payload comes in, the old single-form response is returned. Multi-form
 * `submissions[]` callers see the new `{ accepted, results }` shape.
 *
 * The route stays mounted at `POST /api/sessions/:id/submit-inputs` so any
 * existing client (frontend, e2e scripts, third-party tooling) keeps
 * working without changes.
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { RpcExecutor } from "@covel/runtime";
import { RpcDispatchError, RpcValidationError } from "@covel/runtime";

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    rpcExecutor: RpcExecutor;
  };
};

export const submitInputsRoutes = new Hono<Env>();

interface LegacyBody {
  readonly turnId: string;
  readonly submissions?: ReadonlyArray<unknown>;
  readonly formId?: string;
  readonly values?: Record<string, unknown>;
}

submitInputsRoutes.post("/:id/submit-inputs", async (c) => {
  const store = c.get("store");
  const executor = c.get("rpcExecutor");
  const sessionId = c.req.param("id");

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: `Session "${sessionId}" not found` }, 404);
  }

  let body: LegacyBody;
  try {
    body = await c.req.json<LegacyBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  try {
    const dispatch = await executor.dispatch(
      {
        // The framework default handler is registered under the framework
        // namespace and is independent of any actual plugin's pluginId.
        // We pass an empty pluginId — the dispatcher falls through to
        // `getFrameworkDefault` because there's no plugin entry.
        pluginId: "framework",
        action: "submit-form",
        payload: body,
      },
      { sessionId, store },
    );

    const result = dispatch.result as {
      accepted: boolean;
      results: ReadonlyArray<{
        submissionId: string;
        interactionId: string;
        filledNarrative: string;
        accepted: boolean;
      }>;
    };

    // Backwards-compat: single legacy { formId, values } payload returns the
    // old flat shape, not the new { accepted, results } envelope.
    if (body.formId && !body.submissions && result.results.length === 1) {
      const only = result.results[0];
      return c.json({
        submissionId: only.submissionId,
        formId: body.formId,
        filledNarrative: only.filledNarrative,
        accepted: true,
      });
    }

    return c.json(result);
  } catch (err) {
    if (err instanceof RpcValidationError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof RpcDispatchError) {
      return c.json({ error: err.message, code: err.code }, 500);
    }
    return c.json(
      { error: err instanceof Error ? err.message : "submit-inputs failed" },
      500,
    );
  }
});
