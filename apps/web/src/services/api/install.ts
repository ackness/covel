import { z } from "zod";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import { request } from "./request.js";

export type InstallKind = "plugin" | "world";

const installResultSchema = z
  .object({
    ok: z.literal(true),
    kind: z.enum(["plugin", "world"]),
    id: z.string().min(1),
    restartRequired: z.boolean(),
  })
  .strict();

export type InstallResult = z.infer<typeof installResultSchema>;

/** Install one plugin or world zip through the canonical multipart endpoint. */
export function installPackage(
  kind: InstallKind,
  file: File,
): Promise<InstallResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return request(`/api/install/${kind}`, {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    body: form,
    operatorAuth: true,
    schema: installResultSchema,
  });
}
