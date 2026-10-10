import type { DataStore } from "@covel/store";
import { createInteractionSubmitter } from "../src/interaction/interaction-submission.js";
import type { ValidatePluginForm } from "../src/rpc/form-validator.js";

/**
 * Check an answer and store it at once. The action route does the same under
 * the session lock, storing in the transaction that starts the follow-up turn.
 */
export function submitAndStore(
  validatePluginForm: ValidatePluginForm | undefined,
  store: DataStore,
) {
  const submit = createInteractionSubmitter(validatePluginForm, store);
  return async (...args: Parameters<typeof submit>) => {
    const prepared = await submit(...args);
    await prepared.persist(store);
    return prepared;
  };
}
