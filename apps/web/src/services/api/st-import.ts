import { stImportResultSchema, type StImportResult } from "@covel/shared";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import { request } from "./request.js";

export function importStContent(input: {
  files: readonly File[];
  locale: string;
  name?: string;
  preview: boolean;
}): Promise<StImportResult> {
  const form = new FormData();
  for (const file of input.files) form.append("file", file, file.name);
  form.append("locale", input.locale);
  if (input.name) form.append("name", input.name);
  form.append("preview", String(input.preview));
  return request("/api/install/st-import", {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    body: form,
    operatorAuth: true,
    schema: stImportResultSchema,
  });
}
