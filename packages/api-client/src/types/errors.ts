export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(message, 0, "NETWORK_ERROR", details);
    this.name = "NetworkError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(message, 404, "NOT_FOUND", details);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(message, 401, "UNAUTHORIZED", details);
    this.name = "UnauthorizedError";
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(message, 422, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
  }
}
