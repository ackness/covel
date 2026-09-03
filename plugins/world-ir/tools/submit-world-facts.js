import { validateWorldIRV1, worldIRV1Schema } from "@covel/shared";

function validationPath(path) {
  if (path === "(root)") return [];
  return path.split(".").map((part) => {
    const index = Number(part);
    return Number.isInteger(index) && String(index) === part ? index : part;
  });
}

export default function ({ tool }) {
  const parameters = worldIRV1Schema.superRefine((value, ctx) => {
    const validation = validateWorldIRV1(value);
    if (validation.valid) return;
    for (const error of validation.errors) {
      ctx.addIssue({
        code: "custom",
        path: validationPath(error.path),
        message: error.message,
      });
    }
  });

  return tool({
    name: "submit-world-facts",
    description:
      "Submit the people, relationships, events, and explicit knowledge extracted from this story turn. The arguments become the complete World IR output; put non-contract details inside attributes.",
    parameters,
    execute: async (facts) => facts,
  });
}
