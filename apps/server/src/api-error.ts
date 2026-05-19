export interface ApiErrorBody<Code extends string = string> {
  readonly error: string;
  readonly code: Code;
}

export function apiError<Code extends string>(
  code: Code,
  message: string,
): ApiErrorBody<Code> {
  return { error: message, code };
}
