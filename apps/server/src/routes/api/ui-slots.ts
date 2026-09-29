import { Hono } from "hono";
import { uiSlotNameSchema } from "@covel/shared";
import { resolveSessionParam } from "./session/session-guard.js";
import { errorBody, listBody } from "../../api-error.js";

export const uiSlotRoutes = new Hono();
uiSlotRoutes.get("/:id/ui-slots", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const slot = c.req.query("slot");
  const parsed =
    slot === undefined ? undefined : uiSlotNameSchema.safeParse(slot);
  if (parsed && !parsed.success)
    return c.json(errorBody("Unknown UI slot"), 400);
  const host = c.get("uiSlots");
  if (!host) return c.json(listBody([]));
  const result = await host.get(guard.session.id, {
    ...(parsed?.success ? { slot: parsed.data } : {}),
    ...(c.req.query("prefix") ? { prefix: c.req.query("prefix") } : {}),
    ...(c.req.query("key") ? { key: c.req.query("key") } : {}),
  });
  return c.json(listBody(result));
});
