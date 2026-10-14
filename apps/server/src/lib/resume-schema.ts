import { Ajv } from "ajv";

export interface ResumeValidationError {
  readonly code: "resume_schema_invalid" | "resume_data_invalid";
  readonly message: string;
}

/** Bounded structural cache: SQL reads return a new schema object each time. */
export function createResumeValidator(capacity = 256) {
  const ajv = new Ajv({ allErrors: false, strict: false });
  const cache = new Map<string, ReturnType<typeof ajv.compile>>();
  return (data: unknown, schema: unknown): ResumeValidationError | null => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      return {
        code: "resume_schema_invalid",
        message: "resumeSchema must be a JSON Schema object",
      };
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
        return {
          code: "resume_schema_invalid",
          message:
            "resumeSchema could not be compiled; correct the plugin schema and create a new suspension",
        };
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
      : {
          code: "resume_data_invalid",
          message: (validate.errors ?? [])
            .map(
              (error) =>
                `${error.instancePath || "$"} ${error.message ?? "invalid"}`,
            )
            .join("; "),
        };
  };
}

export const validateResumeData = createResumeValidator();
