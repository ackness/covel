import { Ajv } from "ajv";

/** Bounded structural cache: SQL reads return a new schema object each time. */
export function createResumeValidator(capacity = 256) {
  const ajv = new Ajv({ allErrors: false, strict: false });
  const cache = new Map<string, ReturnType<typeof ajv.compile>>();
  return (data: unknown, schema: unknown): string | null => {
    if (!schema || typeof schema !== "object") return null;
    const key = JSON.stringify(schema);
    let validate = cache.get(key);
    if (!validate) {
      try {
        validate = ajv.compile(schema as Record<string, unknown>);
      } catch (error) {
        console.warn(
          "[resume] resumeSchema failed to compile:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      } finally {
        // Ajv keeps its own strong-reference cache; only our bounded map owns
        // compiled plugin schemas after this call, including failed compiles.
        ajv.removeSchema(schema as object);
      }
      if (cache.size >= capacity) cache.delete(cache.keys().next().value!);
    } else {
      cache.delete(key);
    }
    cache.set(key, validate);
    return validate(data)
      ? null
      : (validate.errors ?? [])
          .map(
            (error) =>
              `${error.instancePath || "$"} ${error.message ?? "invalid"}`,
          )
          .join("; ");
  };
}

export const validateResumeData = createResumeValidator();
