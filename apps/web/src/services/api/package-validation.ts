import {
  packageValidationReportSchema,
  type PackageValidationReport,
} from "@covel/shared";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import { request } from "./request.js";

export function validatePackage(
  kind: "plugin" | "world",
  source: { kind: "installed"; id: string } | { kind: "upload"; file: File },
): Promise<PackageValidationReport> {
  let body: FormData | string;
  if (source.kind === "upload") {
    body = new FormData();
    body.append("file", source.file, source.file.name);
  } else body = JSON.stringify({ source });
  return request(`/api/install/validate/${kind}`, {
    method: "POST",
    body,
    headers: getDesktopRestAuthHeaders(),
    operatorAuth: true,
    schema: packageValidationReportSchema,
    silentErrors: true,
  });
}
