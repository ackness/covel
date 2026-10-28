/**
 * The local model relay's HTTP side (see `src/model-relay/registry.ts`).
 *
 * - `GET  /api/model-relay/stream` keeps the browser's channel open (SSE).
 * - `POST /api/model-relay/requests/:id/head|chunk|end|fail` carry the answer.
 *
 * Every route needs the browser's channel ID in `X-Model-Relay`, and a post
 * is accepted only for a request sent to that channel. The routes exist on
 * every server; only a shared host (`credentials.modelRelay`) answers them.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { readRuntimeEnv } from "@covel/shared";
import { errorBody } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { streamOwnedSSE } from "../../application-work.js";
import { hostProfileOf } from "../../host-profile.js";
import {
  parseModelRelayChannel,
  type ModelRelayAnswer,
  type ModelRelayEvent,
  type ModelRelayRegistry,
} from "../../model-relay/registry.js";

/** Below the proxies' idle limits, so an open channel is not cut. */
const HEARTBEAT_MS = 15_000;

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A header value or reason phrase: no line breaks or other control bytes. */
const FIELD_TEXT = /^[\t\x20-\x7e\x80-\xff]*$/;

const headSchema = z.strictObject({
  status: z.number().int().min(200).max(599),
  statusText: z.string().max(200).regex(FIELD_TEXT).optional(),
  headers: z
    .record(
      z.string().max(200).regex(HEADER_NAME),
      z
        .string()
        .max(8 * 1024)
        .regex(FIELD_TEXT),
    )
    .refine((headers) => Object.keys(headers).length <= 100),
});

const failSchema = z.strictObject({ message: z.string().min(1).max(500) });

/** One printable line, so a browser's message cannot forge log lines. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

function answer(c: Context, result: ModelRelayAnswer): Response {
  switch (result) {
    case "ok":
      return c.body(null, 204);
    case "unknown":
      return c.json(
        errorBody("No such relay request on this channel", {
          code: "model_relay_request_unknown",
        }),
        404,
      );
    case "too-large":
      return c.json(
        errorBody("The relayed answer is too large", {
          code: "model_relay_too_large",
        }),
        413,
      );
    case "out-of-order":
      return c.json(
        errorBody("Relay messages arrived out of order", {
          code: "model_relay_out_of_order",
        }),
        409,
      );
    case "invalid":
      return c.json(
        errorBody("The relayed answer is not a valid HTTP response", {
          code: "model_relay_invalid_answer",
        }),
        400,
      );
  }
}

export function createModelRelayRoutes(registry: ModelRelayRegistry): Hono<{
  Variables: { modelRelayChannel: string };
}> {
  const app = new Hono<{ Variables: { modelRelayChannel: string } }>();

  app.use("*", async (c, next) => {
    if (!hostProfileOf(c).credentials.modelRelay) {
      return c.json(
        errorBody("This server reaches local models itself", {
          code: "model_relay_unavailable",
        }),
        404,
      );
    }
    const channel = parseModelRelayChannel(c.req.header("x-model-relay"));
    if (!channel) {
      return c.json(
        errorBody("X-Model-Relay must name the browser's relay channel", {
          code: "model_relay_channel_required",
        }),
        400,
      );
    }
    c.set("modelRelayChannel", channel);
    await next();
  });

  // Rate-limited like the event stream: reconnects otherwise have no ceiling.
  app.get(
    "/stream",
    rateLimiter({ max: readRuntimeEnv().rateLimitRpm }),
    (c) => {
      const channel = c.get("modelRelayChannel");
      if (!registry.canAttach(channel)) {
        return c.json(
          errorBody("Too many relay channels are open on this server", {
            code: "model_relay_busy",
          }),
          503,
        );
      }
      return streamOwnedSSE(c, async (stream) => {
        // Writes stay in order: a request is never overtaken by its cancel.
        let writing = Promise.resolve();
        const sink = (event: ModelRelayEvent) => {
          writing = writing
            .then(() =>
              stream.writeSSE({
                event: event.type,
                data: JSON.stringify(event),
              }),
            )
            .catch(() => {});
        };
        // A newer stream for the same channel ends this one.
        const detach = registry.attach(channel, sink, () => stream.abort());
        if (!detach) return; // the channel limit was reached meanwhile
        stream.onAbort(detach);
        try {
          await stream.writeSSE({ event: "ready", data: "{}" });
          while (!stream.aborted && !stream.closed) {
            await stream.sleep(HEARTBEAT_MS);
            await stream.write(": ping\n\n");
          }
        } finally {
          detach();
        }
      });
    },
  );

  app.post("/requests/:id/head", async (c) => {
    const parsed = headSchema.safeParse(
      await c.req.json<unknown>().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json(errorBody("Invalid relay head"), 400);
    }
    return answer(
      c,
      registry.head(c.get("modelRelayChannel"), c.req.param("id"), parsed.data),
    );
  });

  app.post("/requests/:id/chunk", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return answer(
      c,
      registry.chunk(c.get("modelRelayChannel"), c.req.param("id"), bytes),
    );
  });

  app.post("/requests/:id/end", (c) =>
    answer(c, registry.end(c.get("modelRelayChannel"), c.req.param("id"))),
  );

  app.post("/requests/:id/fail", async (c) => {
    const parsed = failSchema.safeParse(
      await c.req.json<unknown>().catch(() => undefined),
    );
    const message =
      (parsed.success ? oneLine(parsed.data.message) : "") ||
      "your browser reported a failure.";
    return answer(
      c,
      registry.fail(c.get("modelRelayChannel"), c.req.param("id"), message),
    );
  });

  return app;
}
