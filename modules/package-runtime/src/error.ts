export type PackageRuntimeErrorCode =
  | "DUPLICATE_CONTRIBUTION"
  | "INVALID_PACKAGE_MANIFEST"
  | "PACKAGE_NOT_FOUND"
  | "PATH_TRAVERSAL_BLOCKED";

export interface PackageRuntimeErrorOptions {
  code: PackageRuntimeErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class PackageRuntimeError extends Error {
  readonly code: PackageRuntimeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(options: PackageRuntimeErrorOptions) {
    super(options.message);
    this.name = "PackageRuntimeError";
    this.code = options.code;
    this.details = options.details;
  }
}
